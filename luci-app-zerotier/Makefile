# SPDX-License-Identifier: GPL-3.0-only AND Apache-2.0

include $(TOPDIR)/rules.mk

PKG_VERSION:=1.2.0
PKG_RELEASE:=16
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)
PKG_LICENSE:=GPL-3.0-only AND Apache-2.0 AND MIT
PKG_LICENSE_FILES:=LICENSES/qrcode-generator-MIT.txt

LUCI_TITLE:=LuCI support for ZeroTier and its embedded Controller
LUCI_DESCRIPTION:=Unified ZeroTier service, interface and self-hosted Controller management.
LUCI_DEPENDS:=+zerotier +curl +jq
LUCI_MAINTAINER:=Aimee <aimee@github.com>
LUCI_URL:=https://github.com/aimeeacker/luci-app-zerotier
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
