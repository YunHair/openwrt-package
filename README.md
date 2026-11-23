# luci-app-ctstat

按客户端统计流量的 LuCI 插件，**在 NSS/ECM 硬件加速开启时依然准确**。

## 为什么需要它

常见的客户端流量统计（OAF、wrtbwmon、nlbwmon 的部分模式）依赖 netfilter 钩子逐包累加 `skb->len`。一旦流量被 NSS/PPE 卸载到硬件转发，报文不再进入 Linux 协议栈，钩子收不到任何数据——**流量越大漏得越多**，而且每个客户端的偏差比例不同，无法事后校准。

本插件走另一条路：直接读 conntrack 的字节计数器。

QCA 的 NSS 前端会把硬件转发路径上的计数**回写**到 conntrack：

```c
/* qca-nss-ecm/frontends/nss/ecm_nss_ipv4.c */
acct = nf_conn_acct_find(ct)->counter;
if (acct) {
    atomic64_add(sync->flow_rx_packet_count,   &acct[flow_dir].packets);
    atomic64_add(sync->flow_rx_byte_count,     &acct[flow_dir].bytes);
    atomic64_add(sync->return_rx_packet_count, &acct[return_dir].packets);
    atomic64_add(sync->return_rx_byte_count,   &acct[return_dir].bytes);
}
```

因此 `/proc/net/nf_conntrack` 里的 `bytes=` 在硬件加速下依然完整，只是数据来源从软件栈变成了 NSS 固件。

## 实现

每 `interval` 秒采样一次 `/proc/net/nf_conntrack`：

1. 解析每条连接的原始方向（`src/dst/sport/dport`）唯一标识它；
2. 判断哪一端属于 LAN，确定上行/下行；
3. 与该连接上一轮的字节数做**差分**，累加到对应 IP；
4. 差分用 `state.db` 保存基线——conntrack 条目过期消失时不需要额外结算，因为最后一段增量在上一轮已经记过；
5. 端口复用导致计数回落时，按新连接的全量计入。

输出：

| 文件 | 内容 |
|---|---|
| `/tmp/ctstat/clients.db` | `ip mac 总上行 总下行 日期 今日上行 今日下行 主机名` |
| `/tmp/ctstat/state.db` | 连接基线（差分用） |
| `/tmp/ctstat/usage.json` | 页面消费的 JSON |
| `/etc/ctstat/clients.db` | 累计表持久化，重启不丢 |

## 精度边界

| 项 | 情况 |
|---|---|
| 硬件加速流量 | **准确**（NSS 回写 conntrack acct） |
| 软件转发流量 | 准确 |
| 同步延迟 | 1 至数秒，对分钟级统计无影响 |
| 生命周期短于采样间隔的连接 | 可能漏计（DNS 等小包可忽略） |
| IPv6 | **暂不支持**，仅统计 IPv4 |
| 多 IP 设备 | 按 IP 分行显示 |

前提：内核 `CONFIG_NF_CONNTRACK_PROCFS` 打开，且 `nf_conntrack_acct=1`（OpenWrt 默认）。页面「运行诊断」会显示这两项。

## 安装

```sh
opkg install luci-app-ctstat_*.ipk
# 或
apk add --allow-untrusted luci-app-ctstat-*.apk
```

装完刷新菜单：

```sh
rm -f /tmp/luci-indexcache.* && rm -rf /tmp/luci-modulecache/ && /etc/init.d/rpcd reload
```

## 配置

```
config ctstat 'config'
	option enabled '1'
	option interval '3'
	option lan_prefix ''
	option refresh '5'
```

| 项 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `interval` | 采样间隔，1–60 秒，默认 3。越小越准，越大越省 CPU |
| `lan_prefix` | LAN 网段，空格分隔多个，如 `192.168.3.1/24 10.0.0.1/8`。留空自动探测 `br-*` 接口 |
| `refresh` | 页面刷新间隔 |

命令行：

```sh
uci set ctstat.config.interval='3'
uci commit ctstat
/etc/init.d/ctstat restart
```

## 诊断

```sh
/usr/libexec/ctstat-call info
/usr/libexec/ctstat-call status
/usr/libexec/ctstat-call reset     # 清零累计（保留基线，不重算历史）
```

手工核对：

```sh
R0=$(cat /sys/class/net/br-lan/statistics/rx_bytes)
# ……跑一段流量……
R1=$(cat /sys/class/net/br-lan/statistics/rx_bytes)
echo "br-lan 增量: $(( (R1-R0)/1048576 )) MB"
/usr/libexec/ctstat-call status | head -c 400
```

LAN 侧总接收应与所有客户端下行之和接近（差值来自广播、路由自身流量）。

## CPU 开销

IPQ6000 上，1000 条连接时单次采样约 50–100 ms，3 秒间隔约占单核 2–3%。连接数更多时建议把 `interval` 调到 5 秒。

## 许可

GPL-2.0
