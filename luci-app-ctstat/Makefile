include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ctstat
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=YunHair

LUCI_TITLE:=LuCI app for per-client traffic statistics via conntrack
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# 兜底修复执行权限（部分拉取方式会丢失 0755）
define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -f $${IPKG_INSTROOT}/etc/init.d/ctstat ] && chmod 0755 $${IPKG_INSTROOT}/etc/init.d/ctstat
[ -f $${IPKG_INSTROOT}/usr/share/ctstat/collector.sh ] && chmod 0755 $${IPKG_INSTROOT}/usr/share/ctstat/collector.sh
[ -f $${IPKG_INSTROOT}/usr/libexec/ctstat-call ] && chmod 0755 $${IPKG_INSTROOT}/usr/libexec/ctstat-call
[ -f $${IPKG_INSTROOT}/etc/uci-defaults/luci-ctstat ] && chmod 0755 $${IPKG_INSTROOT}/etc/uci-defaults/luci-ctstat
exit 0
endef

# call BuildPackage - OpenWrt buildroot signature
