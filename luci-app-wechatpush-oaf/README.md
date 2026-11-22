## 简介

[![Lastest Release](https://img.shields.io/github/release/tty228/luci-app-wechatpush.svg?style=flat)](https://github.com/tty228/luci-app-wechatpush/releases)
[![GitHub All Releases](https://img.shields.io/github/downloads/tty228/luci-app-wechatpush/total)](https://github.com/tty228/luci-app-wechatpush/releases)

[中文文档](README.md) | [English](README_en.md)

这是一款用于 OpenWRT 路由器上进行 微信、Telegram、邮件 通知的插件。

主要功能：
- [x] 路由 IP、IPv6 变动推送
- [x] 设备 上线、离线 推送
- [x] 设备在线列表及流量使用情况
- [x] CPU 负载、温度监视、PVE 宿主机温度监控
- [x] 路由运行状态定时推送
- [x] 路由 Web、SSH 登录提示，自动拉黑、端口敲门
- [x] 无人值守任务

自动封禁启用后，黑名单默认拦截访问路由器的流量；可另外开启“阻止黑名单 IP 的转发流量”，拦截经过路由器转发的所有流量（包括访问端口映射的下级设备、局域网客户端访问互联网）。开启转发封禁且已安装 conntrack 时，封禁还会尝试清理该 IP 的连接跟踪记录，以断开已有的流量卸载连接；未安装时跳过该步骤，新连接仍按黑名单规则拦截。关闭该选项或关闭自动封禁后，转发拦截规则会在下一次检测循环中被移除；与访问路由器的拦截规则一样，停止插件服务不会立即移除已生效的规则，它们会在防火墙重载或重启后消失，并在插件运行时于下一次检测循环中恢复。fw4 定时封禁按最近记录的剩余时长恢复。黑名单时间设置为 `0` 时永久封禁，手动清除黑名单后解除。

通知服务支持列表：
| 推送应用 | 方式 | 接口说明 |
| :-------- | :----- | :----- |
| 微信 | Server酱 | https://sct.ftqq.com/
| 微信 | 推送加 | http://www.pushplus.plus/
| 微信等 | WPUSH | https://wpush.cn/
| 微信 | WxPusher | https://wxpusher.zjiecode.com/docs
| 企业微信 | 应用推送 | https://work.weixin.qq.com/api/doc/90000/90135/90248
| Telegram | bot | https://t.me/BotFather
| Mail | msmtp | https://marlam.de/msmtp/

精力有限，如需要钉钉推送、飞书推送、Bark 推送等请尝试另一个分支 https://github.com/zzsj0928/luci-app-pushbot ，或使用自定义 API 设置

v2.06.2 之后的版本不再支持 LuCI 18.06，如需编译，请使用 openwrt-18.06 分支，拉取源码时请使用 `git clone -b openwrt-18.06 https://github.com/tty228/luci-app-wechatpush.git` 命令

## 说明

**关于安装：**

插件依赖 iputils-arping + curl + jq + bash，对于内存有限的路由器，请酌情安装，**在安装之前，请先运行 `opkg update` 命令，以便在安装过程中安装依赖。**

基于 X86 OpenWrt v23.05.0 制作，不同系统不同设备，可能会遇到各种问题，**如获取到错误的温度信息、页面显示错误、报错等，自行适配**

**关于主机名：**

对于设备未宣告主机名、光猫拨号上网、OpenWrt 作为旁路网关等各类情况导致的获取主机名失败，可以通过以下方式设置主机名

- 使用设备名备注
- 在高级设置处配置从光猫、小米路由器、ROS 获取
- 开启 MAC 设备数据库
- 安装 samba*-server 或 samba*-client，使程序可以通过 NetBIOS 查询主机名


**关于设备在线状态：**

默认使用 ping/arping 来主动探测设备在线状态，以对抗 Wi-Fi 休眠机制，主动探测较为耗时但可以获得较为精准的设备在线状态

- 如遇设备休眠频繁，请在高级设置处自行调整超时设置
- 如果不需要太过精准的设备在线信息，只需要其余功能，可以在高级设置中关闭主动探测

**关于流量统计信息：**

本分支支持两种流量数据来源，可在「基本设置 → 流量数据来源」中选择：

1. **wrtbwmon**：原版行为，依赖 wrtbwmon，通过 iptables 建链计数。**该插件与 Routing/NAT、Flow Offloading、代理上网等插件冲突，且会在 firewall4/nftables 系统中产生「旧版 iptables 规则」警告。**
2. **OAF / OpenAppFilter（推荐用于 nftables 系统）**：通过 `ubus call fwx common` 的 `get_user_stat` 读取**全部设备**的 `m`(MAC)/`uf`(上传)/`df`(下载)，**不创建任何 iptables 规则，可与 firewall4/nftables 共存**。需已安装并启用 `luci-app-oaf` / `open-app-filter`（OAF 的流量统计需开启）。

   **口径说明（重要）**：OAF 的按设备流量是**当天累计、每天零点自动归零**，与本插件「每天零点重置」选项吻合。OAF 界面那个「近 30 天」图表是**所有设备合计的全局流量**（`get_history_traffic_stats`），不区分单台设备；而按设备的历史明细 OAF 虽有存盘但未通过 ubus 暴露（源码里 `load_history_stat_from_file()` 是空实现），因此**无法直接推送单台设备的跨天流量**——需要开启下面的「跨天累计」。旧版 OAF 若无 `get_user_stat`，会自动回退到 `get_daily_top_users`（该接口只返回流量最高的 8 台）。

   **精度前提（必读）**：OAF 的计数钩子挂在 netfilter 的 `NF_INET_FORWARD` 上，**一旦开启软件/硬件流量卸载（flow offloading、HNAT、ECM、PPE 等），被卸载的连接会绕过该钩子，单设备流量会显著少计甚至只统计到每条连接的前几个包**。若发现 OAF 的数字远小于实际，请用 `nft list flowtable inet fw4`、`/proc/net/dev` 对比核对；OAF 自带 `fwx.advanced.disable_hnat=1` 可关闭部分平台的卸载（代价是吞吐/CPU）。
3. **自动**：已安装 wrtbwmon 时用 wrtbwmon，否则用 OAF（新装默认值）。

选择 OAF 时，编译期无需勾选 `Enable Traffic Monitoring (wrtbwmon)`，避免把 wrtbwmon 编进固件。运行时插件会自动检测 ubus 上的 `fwx` 对象判断 OAF 是否可用；显式选择 OAF 时即使开机瞬间 `fwx` 还没注册，也会在之后每个周期自动重试，不会退回 wrtbwmon。

**跨天累计总流量（OAF 专用）**：选 OAF 时默认显示当天流量（零点归零）。若希望像 wrtbwmon 那样显示**累计总流量**，勾选「跨天累计总流量」选项：wechatpush 会自行维护一个累计基线（存于 `/usr/share/wechatpush/usage_accum.db`，重启不丢），每次刷新检测到当天值比上次小（即零点归零或 OAF 重启）时，把上一天的流量并入基线，展示值 = 基线 + 当天值。精度取决于刷新间隔（默认 60 秒）。注意：

- 开启累计后请**关闭**「每天零点重置流量数据」，否则零点会删除显示用的 `usage.db`（不影响基线，但会造成显示瞬断）。
- wrtbwmon 自身即累计，此选项对其无效果。
- 想重新从零累计，停止服务后删除 `/usr/share/wechatpush/usage_accum.db` 即可。
- 基线文件每个刷新周期都会写一次（默认每天 1440 次），介意闪存写入的设备可把 `sleeptime` 调大。

> 说明：OAF 数据源通过标准 ubus 接口只读获取流量数据，不修改 OAF 本身；若 OAF 某次调用失败，本次跳过更新并**保留上一份 `usage.db`**，不会清空数据。只有 `traffic_source=auto` 时才允许回退到 wrtbwmon——显式选 OAF 时不会混用两种口径（否则两套累计值来回跳变会误触发「设备异常流量」推送）。

**关于硬盘信息：**

当 OpenWrt 系统或远程主机（PVE）未安装 lsblk 时，硬盘容量信息可能与实际不一致

当 OpenWrt 系统或远程主机（PVE）未安装 smartctl 时，硬盘温度、通电时间、健康度等信息不可用

**关于 bug 提交：**

提交 bug 时请尽量带上以下信息

- 设备信息及插件版本号
- 执行 `/usr/share/wechatpush/wechatpush` 后的提示信息
- 报错后的日志信息、`/tmp/wechatpush/` 目录下的文件信息
- `bash -x /usr/share/wechatpush/wechatpush t1` 的详细运行信息


## 下载

| 支持的 OpenWrt 版本 | 下载地址 |
| :-------- | :----- |
| openwrt-19.07.0 ... latest | [![Lastest Release](https://img.shields.io/github/release/tty228/luci-app-wechatpush.svg?style=flat)](https://github.com/tty228/luci-app-wechatpush/releases)
| openwrt-18.06 | [![Release v2.06.2](https://img.shields.io/badge/release-v2.06.2-lightgrey.svg)](https://github.com/tty228/luci-app-wechatpush/releases/tag/v2.06.2)


## 捐赠

如果你觉得此项目对你有帮助，请捐助我们，使项目能持续发展和更加完善。

![image](https://github.com/tty228/luci-app-wechatpush/blob/master/.github/others/20260303202537_34_664.png)
