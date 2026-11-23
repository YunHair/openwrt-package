include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wechatpush-oaf
# OAF 定制分支，包名与 LuCI 应用名统一为 luci-app-wechatpush-oaf。
# apk (OpenWrt 25.12+) 的版本号只接受 数字[.数字]*[-r数字]，故实际包版本为 1.0-r1。
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=tty228 <tty228@yeah.net>
PKG_CONFIG_DEPENDS:= \
        CONFIG_PACKAGE_$(PKG_NAME)_Enable_Traffic_Monitoring \
        CONFIG_PACKAGE_$(PKG_NAME)_Enable_OAF_Traffic \
        CONFIG_PACKAGE_$(PKG_NAME)_Enable_Local_Disk_Information_Detection \
        CONFIG_PACKAGE_$(PKG_NAME)_Enable_Host_Information_Detection

LUCI_TITLE:=LuCI support for WeChat push (OAF)
LUCI_PKGARCH:=all
LUCI_DEPENDS:=+iputils-arping +curl +jq +bash +luci-lua-runtime \
        +PACKAGE_$(PKG_NAME)_Enable_Traffic_Monitoring:wrtbwmon \
        +PACKAGE_$(PKG_NAME)_Enable_Local_Disk_Information_Detection:lsblk \
        +PACKAGE_$(PKG_NAME)_Enable_Local_Disk_Information_Detection:smartmontools \
        +PACKAGE_$(PKG_NAME)_Enable_Local_Disk_Information_Detection:smartmontools-drivedb \
        +PACKAGE_$(PKG_NAME)_Enable_Host_Information_Detection:openssh-client \
        +PACKAGE_$(PKG_NAME)_Enable_Host_Information_Detection:openssh-keygen

define Package/$(PKG_NAME)/config
config PACKAGE_$(PKG_NAME)_Enable_Traffic_Monitoring
        bool "Enable Traffic Monitoring (wrtbwmon)"
        help
                The traffic statistics feature relies on the wrtbwmon package. This plugin may conflict with Routing/NAT, Flow Offloading, and proxy internet access plugins, potentially leading to an inability to retrieve traffic information.
                NOTE: If you use OAF (OpenAppFilter) for traffic statistics, leave this OFF and select the OAF traffic source in the plugin settings instead.
        select PACKAGE_wrtbwmon
        depends on PACKAGE_$(PKG_NAME)
        default n
config PACKAGE_$(PKG_NAME)_Enable_OAF_Traffic
        bool "Enable OAF traffic source support"
        help
                Pull per-client traffic from OAF (OpenAppFilter) via ubus instead of wrtbwmon.
                Requires appfilter/luci-app-oaf (ubus object "fwx") to be installed and running.
                Works with firewall4/nftables and does NOT create legacy iptables rules.
                Select "oaf" or "auto" as traffic source in the plugin settings.
                NOTE: this is a build-time marker only; it does not pull in luci-app-oaf
                automatically (that package lives in the oaf feed and may not exist in all trees).
        depends on PACKAGE_$(PKG_NAME)
        default n
config PACKAGE_$(PKG_NAME)_Local_Disk_Information_Detection
        bool "Local Disk Information Detection"
        help
                If the lsblk package is not installed, the total disk capacity information might be inconsistent with actual values. When smartctl is not installed, information about disk temperature, power-on time, health status, and more will be unavailable. If you are using a virtual machine or have not installed a physical disk, this feature is typically unnecessary.
        select PACKAGE_lsblk
        select PACKAGE_smartmontools
        select PACKAGE_smartmontools-drivedb
        depends on PACKAGE_$(PKG_NAME)
        default n
config PACKAGE_$(PKG_NAME)_Host_Information_Detection
        bool "Host Information Detection"
        help
                When using a virtual machine and requiring information about the host machine's temperature and disk details, you need to install openssh-client and openssh-keygen for SSH connections.
        select PACKAGE_openssh-client
        select PACKAGE_openssh-keygen
        depends on PACKAGE_$(PKG_NAME)
        default n
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/wechatpush
/usr/share/wechatpush/api/diy.json
/usr/share/wechatpush/api/logo.jpg
/usr/share/wechatpush/api/ipv4.list
/usr/share/wechatpush/api/ipv6.list
/usr/share/wechatpush/api/device_aliases.list
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
