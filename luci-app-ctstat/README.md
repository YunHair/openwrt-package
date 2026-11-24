# luci-app-ctstat 1.5.0（纯 fw4）

OpenWrt LuCI 实时流量统计：按**应用 / 设备 / 目标地址**统计流量，展示最繁忙的连接、整形器健康状态（丢包、ECN、队列积压）以及 24 小时 / 周 / 月 / 年历史曲线，历史可持久化到 U 盘、SD 卡或内置闪存。

本仓库是 [m0g13r/luci-app-traffic-chart](https://github.com/m0g13r/luci-app-traffic-chart) 的 fork：**YunHair/luci-app-ctstat**。1.2.0 及更早版本叫 `luci-app-traffic-chart`，1.3.0 起包名、配置名、服务名、rpcd 对象与 SQM 分类器统一改为 `ctstat`（connection statistics），安装时自动迁移旧设置与历史。当前版本 **1.5.0-r1**，架构 `all`。

[更新记录](CHANGELOG.md) | [许可](LICENSE)

---

## 一、实现了什么功能

插件分成两个页面：**流量图表**（只读，查看实时与历史数据）与**设置**（管理，控制采集、命名、归因、存储和 SQM）。

### 1. 流量图表：五个视角

| 标签页 | 内容 |
| :--- | :--- |
| **应用** | 按应用（或 `协议/端口`）统计，下载 / 上传各一张圆环图；图例可悬停、点击固定、与圆环联动高亮 |
| **设备** | 按局域网设备统计，同样分上下行；**每台设备独占一行和一个扇区**，不会把长尾设备折叠成「其他」（显示上限 256 台） |
| **目标** | 按目标 IP / 域名统计，可看到每个目标对应的 top 应用与设备 |
| **连接** | 最繁忙的 25 条连接：设备、应用、目标、端口、下载、上传、总量，带速率背景条 |
| **历史** | 24 小时 / 周 / 月 / 年曲线，三级精度；支持与上一周期对比、告警标记、JSON / CSV 导出 |

- 三个「圆环 + 图例」面板共用一套交互：悬停显示明细、点击固定、按颜色联动过滤；数值为最近 `rate_win` 秒的平均速率。
- 「连接」页单元格带 `data-label`，手机端自动转成一张张卡片。
- 历史曲线支持悬停读数、点击固定、按维度切换曲线，并按数据新鲜度自动调整刷新间隔（5 分钟桶 60 秒、小时桶 5 分钟、天桶 15 分钟）。

### 2. 设置：可调的部分

- **采集**：启停、轮询间隔（默认 4 秒，负载高时自动拉长）、WAN 设备、速率平均窗口、后端（`auto` / `nss` / `generic`）、链路层开销。
- **命名**：netifyd 应用名、tcpdump 明文 DNS 域名（可多网卡）、v2fly 服务库分组告警与自定义关键词。
- **归因**：路由器代理流量回算到设备、端口白名单 / 排除表、时间窗与容差、候选应用 / 设备数量。
- **存储**：按 5 分钟 / 小时 / 天分别选择多个持久化目录（U 盘、SD 卡、网络挂载或 `/etc/ctstat-data`），写盘间隔与访问超时；多目录互为镜像，缺失后回补。
- **SQM / 系统**：`nss-ctstat.qos` 分类器选项、DNS 重定向、TTL 规整、内存守护、「跳过未变化连接」。
- 保存设置会重启聚合进程：**累计总量归零，历史保留**。

---

## 二、特色与实现要点

### 1. conntrack 增量记账：硬件加速下仍然可信

flow offload / NSS PPE 会让已建立的连接绕过 netfilter 钩子，靠数包统计应用流量会严重偏小。ctstat 避开这条路：

```
内核连接跟踪（nf_conntrack_acct=1）
        │  每条连接的 bytes / packets
        ▼
ctstat-agg 每 4 秒扫描 /proc/net/nf_conntrack，只累加「本次 - 上次」的增量
        │            （连接断开也不会把已记的字节减掉）
        ├── 应用 / 设备 / 目标三维聚合
        └── 写入 /var/run/ctstat/classes.json + history*.json
                     │
                     ▼
        rpcd 只读转发 JSON，不参与采集/聚合；多开标签页不增加采集成本
```

- 流量判定：LAN → 非本地目标、路由器 → WAN、WAN 主动访问 LAN（端口映射 / IPv6 入站）；LAN↔LAN 与 LAN → 路由器不算 WAN 流量。
- 速率来自同一轮读取的 `tc` qdisc 计数器；`tc` 总量减去 conntrack 已归属量（扣除链路层头部）显示为**「未归属」**——对应路由器自身服务、组播、被丢弃的入站包等。
- 不依赖 SQM / qosmate 配置，也不依赖任何包标记、DSCP 或端口清单；整形器从内核 `tc qdisc / filter` 直接探测，支持 `auto` / `nss` / `generic`。
- 自适应轮询与 `fastpath`：跳过自上次扫描后字节数没变的连接，普通网络下聚合器 CPU 可降到原来的 1/3～1/2，结果完全一致。

### 2. 双通道应用与域名识别

- **netifyd 通道**（`socat` + netifyd JSON socket）：只取应用名 / 主机名，**字节数始终来自 conntrack**，避免 NSS 加速后 netifyd 抓不到后续包导致少计。
- **DNS 通道**（`tcpdump` 监听 `br-lan` 等网卡）：按「客户端 IP + 端口 + DNS id」把明文 DNS 应答关联回查询，生成 `IP → 域名 / 应用` 映射，不依赖 dnsmasq / AdGuard Home 的接口；可自动发现 DHCP option 6 / IPv6 RDNSS 宣告的解析器，让 Pi-hole 等中心解析器的查询也能归到真实客户端。
- **v2fly 服务库**：下载 `dlc.dat_plain.yml` 并校验，生成域名后缀→应用 / 分类表；命中 `alert_groups`（默认 `category-porn`）或 `alert_keywords` 时，在图例、连接表与历史曲线上打 ⚠ 标记。更新器按 **GitHub → ghfast → ghproxy → gh-proxy → moeyy** 顺序回退，各下载器带超时（uclient-fetch / wget 25 秒，curl 连接 8 秒、总 30 秒，外层 40 秒硬上限），并逐项报告失败原因；支持固定镜像和自定义 URL（含内网 HTTP）。

### 3. 设备身份与「代理流量归因」

- 设备以 **MAC** 为身份：IPv4 和该设备的所有 IPv6（含隐私地址）归到同一台；路由器自身 WAN 流量单独记为 `Router`。
- 对 NSS 加速后 IPv6 邻居表丢失的情况，会把有流量却无邻居项的 IPv6 地址写入 `unresolved_v6` 并主动 ping 触发邻居发现，避免设备被拆成多个条目。
- **代理归因**（`attr_totals=1`，默认开）：路由器代设备发起的 DNS、代理、LuCI 下载等流量通过 `via_in` / `via_out` 回算到客户端；按端口、时间窗、容量比例与最小字节数筛选候选，避免误归。

### 4. 整形器健康与 NSS SQM 分类器

- 同一轮读取 qdisc 的丢弃包、ECN 标记和 backlog，绘制成小型 sparkline；能识别 NSS 的 `nsstbl/nssfq_codel` 与普通内核 qdisc，多 WAN 分别显示。
- 随包安装 `/usr/lib/sqm/nss-ctstat.qos`：面向高通 NSS 硬件卸载（nsstbl + nssfq_codel）的 SQM 脚本，**只用 nftables**（`inet qos_custom` 表），只使用标记低字节（保留 mwan3 等其他位），按端口划分类别（PRIO / VOIP / GAME / WEB / STREAM / BULK / P2P / BE / VPN / MAIL / NTP / FTP / REMOTE / DB / MGMT / CONTAINER / IOT）。仅支持一个 SQM 实例，队列算法选 `fq_codel`。
- 该分类器是**可选**的：主程序和图表不依赖 SQM，不装 SQM 也能正常统计。

### 5. 三级历史、多目标持久化与告警标记

- 历史桶：5 分钟（24 小时）、小时（周 / 月）、天（年）；多个分辨率各自保留数量可配。
- 无存储路径时只存内存，重启即丢；配置 `persist_target` 行可给每个目录单独勾选 5 分钟 / 小时 / 天，多个目录**并行镜像写入**，某个目录掉线后恢复时会自动补齐。内置闪存建议只勾「天」（约每天一次写入）。
- 历史页可对比上一周期，命中告警分组 / 关键词的桶会显示 ⚠；导出 JSON / CSV 时**只导出当前选中的时间范围**（含全部桶和应用 / 设备 / 目标维度）。

### 6. 手机端布局：不靠 `@media` 碰运气

- 图例列模板由 JavaScript **以内联样式写入**（手机 `minmax(0, 1fr)`，桌面 `repeat(auto-fit, minmax(250px, 1fr))`），并在 `resize` / `orientationchange` 时重算；Android「桌面版网站」按 980px 排版或浏览器缓存旧 CSS 时依然单列。
- 手机识别同时用 `(pointer: coarse)`、`screen.width`、`maxTouchPoints`，不只依赖视口宽度；另加一层 `@media (pointer: coarse) and (max-width: 1024px)` 兜底。
- 圆环与图例上下排列、标签栏横向滑动、导出按钮整行、整形器信息自动换行、连接表变卡片——每条连接一张卡，字段左值右。

### 7. 轻量与长时间稳定

- rpcd 插件只把聚合器写好的 JSON 交给页面，**自身不做任何计算**；页面开得越多也不会增加采集开销。
- `fastpath` 跳过空闲连接；`mem_guard` 监控聚合器 / DNS / 应用识别后台进程，内存比启动时增长超过阈值（默认 48 MB）就重启对应进程（DNS 与应用名会自然重建，聚合器重启会清零累计但保留历史）。检测到 `gawk` 时自动优先使用，规避 BusyBox awk 的内存泄漏。
- 数据超过 `2 × interval + 5` 秒未更新时，页面明确提示「数据过期 / 聚合器需重启」，不会静默显示旧值。

### 8. 改名与自动迁移

`ctstat-migrate` 在 postinst 阶段：

1. 停用并禁用旧 `/etc/init.d/trafficchart`；
2. `/etc/config/trafficchart` → `/etc/config/ctstat`（改写 section 类型，两者都存在时保留备份）；
3. `/etc/trafficchart-*` → `/etc/ctstat-*`，内置闪存存储路径改指 `/etc/ctstat-data`，`/mnt` 下的自定义路径保持原名以免丢历史；
4. 删除旧菜单、ACL、视图目录、sysctl 文件和 libexec 脚本，避免重复菜单与两个聚合进程；
5. 把 `/etc/config/sqm` 里的 `nss-rk.qos` / `nss-trafficchart.qos` 改成 `nss-ctstat.qos`（**SQM 需手动重启**）。

---

## 三、运行要求与安装

- **OpenWrt 22.03+ / firewall4 + nftables**；依赖闭包中没有 `iptables`、`ip6tables`、`libxtables*`、`tc-mod-iptables` 或 `firewall3`。fw3 系统（21.02 及更早）不支持。
- 硬依赖：`luci-base rpcd firewall4 nftables conntrack jsonfilter tc-tiny ip-tiny gawk tcpdump uclient-fetch ca-bundle`。
- 可选：`socat` + `netifyd`（应用名，需 `/etc/netifyd.conf` 里配置 `listen_path`）、`sqm-scripts`（使用它自带的 NSS 分类器时）。注意 23.05 的 `sqm-scripts` 自身依赖 iptables，纯 fw4 环境若不想引入 iptables 就不要装 SQM。

```sh
opkg update
opkg install luci-app-ctstat_1.5.0-r1_all.ipk
opkg install luci-i18n-ctstat-zh-cn_1.5.0-r1_all.ipk   # 可选
```

25.12+ / apk：`apk add --allow-untrusted luci-app-ctstat-1.5.0-r1.apk`。安装后 postinst 自动迁移旧配置、启用并启动服务、重载 rpcd；刷新 LuCI 即可。

菜单：

```
服务 (Services)
└── 流量监控 (Traffic Monitor)
    ├── 流量图表  应用 / 设备 / 目标 / 连接 / 历史（只读 ACL luci-app-ctstat）
    └── 设置      采集、DNS、告警、历史存储、SQM、内存守护（管理 ACL luci-app-ctstat-admin）
```

从旧包升级（推荐先删翻译包，再删主包，再装新包）：

```sh
opkg remove luci-i18n-traffic-chart-zh-cn luci-i18n-traffic-chart-zh-tw
opkg remove luci-app-traffic-chart
opkg install luci-app-ctstat_1.5.0-r1_all.ipk
```

即使不卸载，迁移脚本也会处理；之后仍建议执行一次 `opkg remove luci-app-traffic-chart` 让 opkg 数据库一致。

---

## 四、配置项速查

配置文件 `/etc/config/ctstat` 的 `global` 段，或 LuCI **流量监控 → 设置**。完整列表以界面为准；下表是最常用项。

| 分组 | 选项（默认值） | 含义 |
| :--- | :--- | :--- |
| 采集 | `enabled`=1、`interval`=4、`rate_win`、`backend`=auto、`wan_dev`=auto | 启停、扫描间隔、速率窗口、整形器后端、WAN 设备 |
| 命名 | `apps`=1、`dns_names`=1、`dns_iface`=br-lan、`sock` | netifyd 应用名、tcpdump 域名、抓取网卡、netifyd socket |
| DNS 归属 | `dns_auto_resolvers`=1、`dns_resolvers`、`dns_any_client`=1 | 从 DHCP 自动发现解析器、补充解析器、复用其他客户端的域名 |
| 归因 | `attr_totals`=1、`attr_ports`、`attr_skip_ports`、`attr_win`=60、`attr_tol`=0.6、`attr_share`=0.25、`attr_max_devices`=64 | 路由器代理流量回算到设备的过滤与容量参数 |
| 告警 | `alert_groups`=category-porn、`alert_keywords` | v2fly 分类与自定义关键词，命中处显示 ⚠ |
| 服务库 | `domain_auto_update`=1、`domain_update_days`=7、`domain_source`=auto、`domain_url` | 自动更新、更新间隔、下载源（含自定义 URL） |
| 历史 | `hist_sec`=300、`hist_keep`=288、`hist_hour_keep`=744、`hist_day_keep`=400、`hist_detail`=1 | 三级桶长度与保留量、历史提示详情 |
| 存储 | `persist_target` 行（`path` + `tier_5m/1h/1d`）、`persist_sec`=3600、`persist_timeout`=10 | 多目录镜像持久化、写盘间隔、访问超时 |
| 表格 | `app_max`=400、`host_max`=200、`row_keep`=40、`tooltips`=1 | 各表上限、单独列出的行数、详细提示 |
| 性能 | `fastpath`=1、`mem_guard`=1、`mem_limit_mb`=48、`l2_overhead`=auto | 空闲连接跳过、内存守护、链路层头部 |
| SQM | `bulk_bytes`=314572800、`reset_ct_marks`=1、`dns_redirect`=0、`dns_redirect_exclude`、`ttl_fix`=0 | `nss-ctstat.qos` 的 BULK 阈值、标记重置、DNS 重定向、TTL 规整 |

---

## 五、排障速查

- **提示聚合器未运行 / 数据过期**：`/etc/init.d/ctstat restart`，然后 `logread | grep ctstat`。
- **没有应用名**：检查 `socat`、`netifyd` 与 `/etc/netifyd.conf` 的 `listen_path`；没有 netifyd 时仍可用 DNS 抓包得到域名。
- **「未归属」偏高**：整形器计数包含但 conntrack 未计入的部分（路由器自身服务、组播、被丢弃入站包）；`l2_overhead=auto` 会自动测量链路层头部。
- **服务库更新失败**：在 **设置 → 下载源** 换镜像或填自定义 URL；状态行写明每个镜像的失败原因，日志在 `/var/run/ctstat/domains-update.log`。
- **nft 规则检查**：`nft list table inet qos_custom`；生成文件 `/tmp/nss-ctstat-qos.nft` 可用 `nft -c -f` 校验。
- **确认 fw4**：`fw4 print` 正常、`/sbin/fw4` 存在；只有 fw3 时本包不工作。
- **升级 SQM 脚本后**：手动执行 `/etc/init.d/sqm restart`（自动重启 nssifb 可能导致路由器崩溃）。

## 六、构建

```sh
echo 'src-git ctstat https://github.com/YunHair/luci-app-ctstat.git' >> feeds.conf
./scripts/feeds update ctstat
./scripts/feeds install -a -p ctstat
make menuconfig    # LuCI → Applications → luci-app-ctstat
make package/luci-app-ctstat/compile V=s
```

`po/zh_Hans`、`po/zh_Hant` 由 `luci.mk` 编译为 `luci-i18n-ctstat-zh-cn` / `zh-tw`。发布前校验：所有 shell 脚本 `sh -n`、awk 程序可解析、JSON 合法、LuCI JS `node --check`、生成的 nft 规则集通过 `nft -c`（默认 / PPPoE / FTP helper / DNS 重定向 / TTL 改写）、`.lmo` 可用。

## 七、许可与来源

GPL-2.0-or-later，见 [LICENSE](LICENSE)。原始作者 m0g13r，本 fork 由 YunHair 维护；完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。
