# Introduction

[![Lastest Release](https://img.shields.io/github/release/tty228/luci-app-wechatpush.svg?style=flat)](https://github.com/tty228/luci-app-wechatpush/releases)
[![GitHub All Releases](https://img.shields.io/github/downloads/tty228/luci-app-wechatpush/total)](https://github.com/tty228/luci-app-wechatpush/releases)

[中文文档](README.md) | [English](README_en.md)

**OpenWrt Notification Plugin – Send Alerts to WeChat or Telegram**

This OpenWrt plugin delivers real-time router notifications to your mobile device via **WeChat** or **Telegram** or **Mail**. Monitor your network with alerts for:

- [x] IP changes (IPv4/IPv6)
- [x] Device connections (online/offline)
- [x] Online client list & traffic usage
- [x] CPU load & temperature (including virtualized hosts like PVE)
- [x] Router status reports
- [x] Security alerts (failed web/SSH logins with auto blacklist)
- [x] Port knocking & automated tasks

Auto-banning blocks blacklisted IPs from accessing the router. Optionally block all forwarded traffic from blacklisted IPs, including access to port-forwarded downstream devices and Internet access by LAN clients. With forwarded-traffic blocking enabled and conntrack installed, banning also attempts to clear that IP's existing connection-tracking entries to interrupt offloaded flows; without conntrack, this step is skipped while new connections remain blocked by the blacklist rules. Turning the option off, or turning auto-ban off, removes the forwarded-traffic drop rules on the next detection cycle; like the router-access drop rules, they are not removed by stopping the service, disappear after a firewall reload or reboot, and are restored on the plugin's next detection cycle while it runs. fw4 timed bans are restored with their last recorded remaining duration. Set the blacklist duration to `0` for permanent bans; remove the IP from the blacklist to lift the ban.

Supported services:
| Push application | Method | description |
| :-------- | :----- | :----- |
| WeChat | Server Chan | https://sct.ftqq.com/
| WeChat | PushPlus | http://www.pushplus.plus/
| WeChat etc. | WPUSH | https://wpush.cn/
| WeChat | WxPusher | https://wxpusher.zjiecode.com/docs
| WeChat for Enterprise | Application Push | https://work.weixin.qq.com/api/doc/90000/90135/90248
| Telegram | bot | https://t.me/BotFather
| Mail | msmtp | https://marlam.de/msmtp/

Limited resources are available. If you need services such as DingTalk push, Feishu push, Bark push, etc., please try another branch at https://github.com/zzsj0928/luci-app-pushbot, or use **custom API settings**.

## Instructions

**Regarding Installation:**

The plugin requires dependencies on iputils-arping + curl + jq + bash. For routers with limited memory, please consider the installation carefully. **Before installing, please run the opkg update command to install dependencies during the installation process.**

Developed based on X86 OpenWrt v23.05.0, different systems and devices may encounter various issues. **If you encounter errors in temperature information retrieval, display errors, or other issues, please adapt accordingly.**

**Regarding Hostnames:**

For devices that do not declare hostnames, devices connected via optical modem dial-up, OpenWrt used as a bypass gateway, and other scenarios where hostname retrieval fails, you can set the hostname using the following methods:

- Use device name remarks.
- Configure to obtain the hostname from the optical modem in advanced settings.
- Enable MAC device database.
- Install samba*-server or samba*-client to enable the program to query hostnames via NetBIOS.


**Regarding Device Online Status:**

By default, ping/arping is used to actively detect device online status to counter Wi-Fi sleep mechanism. Active detection takes more time but provides more accurate device online status.

- If devices frequently go into sleep mode, please adjust the timeout settings in advanced settings.
- If you don't require highly precise device online information and only need other features, you can disable active detection in advanced settings.


**Regarding Traffic Statistics:**

This branch supports two traffic data sources, selectable under "Basic Settings → Traffic Data Source":

1. **wrtbwmon**: original behavior, relies on wrtbwmon and counts via iptables. **Conflicts with Routing/NAT, Flow Offloading and proxy plugins, and produces "legacy iptables rules" warnings on firewall4/nftables systems.**
2. **OAF / OpenAppFilter (recommended for nftables)**: reads per-client `m` (MAC) / `uf` (upload) / `df` (download) for **all clients** via `ubus call fwx common {"api":"get_user_stat"}`. **Creates no iptables rules and coexists with firewall4/nftables.** Requires `luci-app-oaf` / `open-app-filter` installed and traffic stats enabled. OAF reports **daily traffic that resets at midnight**.

   **Accuracy caveat (important)**: OAF counts packets in the netfilter `NF_INET_FORWARD` hook. Once software/hardware flow offloading (flowtable, HNAT, ECM, PPE, …) is enabled, offloaded flows bypass that hook and per-client traffic is **significantly undercounted**. Cross-check with `nft list flowtable inet fw4` and `/proc/net/dev`; OAF ships `fwx.advanced.disable_hnat=1` to disable offloading on some platforms (at the cost of throughput/CPU).
3. **Auto**: uses wrtbwmon when installed, otherwise OAF (new default).

When using OAF you can leave "Enable Traffic Monitoring (wrtbwmon)" off at build time. At runtime the plugin detects the `fwx` ubus object; with an explicit OAF selection it keeps retrying every cycle instead of falling back permanently if `fwx` is not registered yet at boot. OAF data is read-only via standard ubus; if a call fails that update is skipped and the previous `usage.db` is kept (never cleared). Falling back to wrtbwmon only happens with `traffic_source=auto`, because mixing the two accounting models makes totals jump and can raise bogus "abnormal traffic" alerts.

**About Hard Drive Information:**

When the OpenWrt system or remote host (PVE) does not have lsblk installed, the hard drive capacity information may be inconsistent with the actual capacity.

When the OpenWrt system or remote host (PVE) does not have smartctl installed, information such as hard drive temperature, uptime, and health status will not be available.

**Regarding Bug Submissions:**

When submitting a bug, please provide the following information if possible:

- Device information and plugin version number.
- Prompt information after executing `/usr/share/wechatpush/wechatpush`.
- Log information and file information in the `/tmp/wechatpush/` directory after encountering an error.
- Detailed execution information of `bash -x /usr/share/wechatpush/wechatpush t1`.

## DownLoad

| Supported OpenWrt Versions | Download Link |
| :-------- | :----- |
| openwrt-19.07.0 ... latest | [![Lastest Release](https://img.shields.io/github/release/tty228/luci-app-wechatpush.svg?style=flat)](https://github.com/tty228/luci-app-wechatpush/releases)
| openwrt-18.06 | [![Release v2.06.2](https://img.shields.io/badge/release-v2.06.2-lightgrey.svg)](https://github.com/tty228/luci-app-wechatpush/releases/tag/v2.06.2)

## Donate

If you feel that this project is helpful to you, please donate to us so that the project can continue to develop and be more perfect.

![image](https://github.com/tty228/luci-app-wechatpush/blob/master/.github/others/20260303202537_34_664.png)