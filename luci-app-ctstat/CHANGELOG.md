# Changelog

## 1.5.0-r1 — cleaner chart toolbar
- Removed the gear **Settings** button from the chart toolbar (its URL returned 404).
- Export JSON / Export CSV buttons now match the active theme's tab height and vertical offset.

## 1.4.0-r2 — fix packaged shell scripts
- Normalise all packaged files to LF line endings. The r1 packages were built on
  Windows with CRLF, so `/usr/libexec/rpcd/luci.ctstat` had a `#!/bin/sh\r` shebang
  and rpcd failed to register `luci.ctstat` (`Object not found` on the chart page).
- Same UI changes as r1 (back link and both page headings removed).

## 1.4.0-r1 — cleaner page headings
- Removed the “← Charts” back link row from the **Settings** page; navigation stays in the sidebar/menu.
- Removed the `Traffic Monitor Settings` map heading (`h2`) from the **Settings** page.
- Removed the `Traffic Monitor` heading (`h2`) from the **Charts** page.
- No dependency changes versus 1.3.0-r1.

## 1.3.0-r1 — renamed to luci-app-ctstat
- **The whole project is now `ctstat`.** Package `luci-app-traffic-chart` →
  `luci-app-ctstat`, translation packages → `luci-i18n-ctstat-*`, repository →
  `YunHair/luci-app-ctstat`. Everything inside follows: UCI config
  `/etc/config/ctstat`, service `/etc/init.d/ctstat`, helpers
  `/usr/libexec/ctstat-*`, rpcd object `luci.ctstat`, ACL `luci-app-ctstat(-admin)`,
  views `view/ctstat/{chart,settings}.js`, menu `admin/services/ctstat`,
  SQM classifier `nss-ctstat.qos`, po/lmo `ctstat.po` / `ctstat.*.lmo`.
- **Automatic migration from the old package.** `ctstat-migrate` now also
  - stops and disables `/etc/init.d/trafficchart`,
  - moves `/etc/config/trafficchart` to `/etc/config/ctstat` (rewriting the
    section type) and keeps a backup when both files exist,
  - moves `/etc/trafficchart-*` (domain database, history) to `/etc/ctstat-*`
    and follows `/etc/trafficchart-data` storage targets to `/etc/ctstat-data`
    (user paths under `/mnt` keep their name so the stored history is not lost),
  - removes the old menu, ACL, view directory, sysctl file and libexec helpers so
    no duplicate menu entry or second aggregator survives.
- **Service-database downloads work behind a filtered network.** The updater used
  to try only `github.com` and, on failure, print a misleading
  “HTTPS needs ca-bundle” hint. It now falls back through four public mirrors
  (`ghfast.top`, `ghproxy.net`, `gh-proxy.com`, `github.moeyy.xyz`), skips the
  remaining downloaders after a DNS/timeout failure, caps each mirror at 25 s,
  and reports one reason per mirror (`github: timeout, ghfast: dns`). New options
  `domain_source` (auto / a fixed mirror / custom) and `domain_url` let the user
  point at a mirror that is reachable.
- **Warning-group labels cleaned up.** The fallback option no longer reads
  “Adult content — fallback; update database…”; it is simply 成人内容 / Adult
  content, with the “update the database first” advice moved to the field
  description.
- Checksum, parser and empty-list failures now have readable messages in the
  status line instead of the raw English text.

## 1.2.0-r5
- **Menu moved under Services.** The package now registers `admin/services/ctstat`
  (`Traffic Monitor` / 流量监控) with the two children `Traffic Charts` (流量图表) and
  `Settings` (设置), instead of a top-level entry named `ctstat`.
- **Every device gets its own row.** The device view reserves `ATTR_MAX_DEVICES` (64) slots and
  no longer folds the tail into an “Other” bucket, so all devices reported by the collector are
  listed and drawn as separate donut segments. Applications and destinations keep the 22-row view.
- **V2Fly warning groups are labelled in Chinese.** `category-*` names are mapped to readable
  labels (`category-porn` → 成人内容 / Adult content, `category-ads-all` → 广告（全部列表）, …);
  unknown categories still fall back to a title-cased name. The blunt literal translation
  “色情” is gone from both the selector and the fallback option.
- **Remaining English UI strings translated:** legend `Total … packets`, `total: x%`, `via …`,
  the link-rate line (`%s of %s Mbit/s configured`), shaper diagnostics (`tc_diag`), the domain
  database status/messages, and the rpcd “aggregator not running / empty / unreadable / stale”
  errors.
- Menu titles, page headings and the settings map title now use “Traffic Monitor” consistently.
- No dependency or packaging changes versus 1.2.0-r4.

## 1.2.0-r4
- **Legend lists are forced to one entry per row on phones.** The r1–r3 builds relied on
  `@media (max-width: 760px)` to collapse the legend grid; on Android browsers that lay the page
  out at a 980 px "desktop site" viewport (and on WebViews that ignore the media query), the
  applications / devices / destinations lists still rendered two entries side by side.
  - The column template is now written **inline by JavaScript** (`minmax(0, 1fr)` on phones,
    `repeat(auto-fit, minmax(250px, 1fr))` on desktop), so CSS ordering or a stale stylesheet can
    no longer leave two entries on one line. It is re-evaluated on `resize` / `orientationchange`.
  - Phone detection no longer depends on the viewport width alone: `(pointer: coarse)` plus
    `screen.width` / `maxTouchPoints` is used as a width-independent signal (up to 1024 px).
  - Added the same single-column rules under `@media (pointer: coarse) and (max-width: 1024px)`
    as a second line of defence.
  - Applied to all three live views (Applications, Devices, Destinations), which share the
    same panel builder.
- No dependency or packaging changes versus 1.2.0-r3.

## 1.2.0-r3
- **Removed the transitive iptables dependency.** The package hard-depended on `sqm-scripts`,
  which itself depends on `iptables`, `iptables-mod-ipopt` and `kmod-sched-cake`; the `tc`
  dependency was resolved to `tc-full`, which pulls `libxtables12` and `tc-mod-iptables`. On a
  pure fw4 system without iptables this made `opkg install` fail with
  `satisfy_dependencies_for: ... iptables`.
  - `sqm-scripts` is no longer a dependency. `nss-ctstat.qos` is still installed to
    `/usr/lib/sqm/`; install SQM separately if you want to use it.
  - `tc` -> `tc-tiny` (no `libxtables12`) and `ip` -> `ip-tiny` (no `libbpf`); both still
    provide the `tc` / `ip` commands used by the collector.
- The dependency closure of the package now contains no `iptables`, `ip6tables`, `libxtables*`,
  `tc-mod-iptables` or `firewall3` package.

## 1.2.0-r2
- **Fixed the `.ipk` container format.** The r1 packages were built as Debian `ar` archives, but
  OpenWrt's opkg expects a gzip'ed outer tar (`./debian-binary`, `./data.tar.gz`,
  `./control.tar.gz`), exactly like `scripts/ipkg-build`. On a router this surfaced as
  `pkg_init_from_file: Malformed package file`. The builder now emits GNU tar + `gzip -n`, and
  `Installed-Size` is the compressed `data.tar.gz` size, matching upstream `ipkg-build`.
  Verified end-to-end with the real opkg from OpenWrt 23.05.5 (x86_64 rootfs).
- No source changes versus 1.2.0-r1.

## 1.2.0-r1 (YunHair fork)
- **fw4 only**: removed every legacy firewall3/iptables dependency. The package now hard-depends on
  `firewall4` + `nftables` and the postinstall warns when `/sbin/fw4` is missing. The bundled
  `nss-ctstat.qos` classifier only writes nftables (`inet qos_custom`); no `iptables`, `ip6tables`,
  `luci-app-firewall` or `fw3` include script is used anywhere.
- **Unified menu**: one top-level LuCI menu `ctstat` with the submenus `Charts` and `Settings`.
  The old `Network -> Traffic Chart` entry and the hidden settings view are gone; the views moved to
  `view/ctstat/chart.js` and `view/ctstat/settings.js`.
- **Mobile layout**: on screens up to 760 px every item occupies its own row. The donut and its legend
  are stacked, the legend becomes a single column, the tab bar scrolls horizontally, the toolbar buttons
  share one full-width row, shaper health lines wrap instead of being clipped, and the busiest-flows table
  turns into one card per flow with a `label: value` line per field.
- **Translations**: new `po/zh_Hans` and `po/zh_Hant` catalogs, built as `luci-i18n-ctstat-zh-cn`
  and `luci-i18n-ctstat-zh-tw`.
- Version bumped to 1.2.0, package architecture `all`.

## 1.1.0-r21
- Corrected package dependencies for the intended OpenWrt 21 release: luci-base, rpcd, sqm-scripts, conntrack, jsonfilter, tc, gawk, ip, tcpdump, uclient-fetch and ca-bundle.
- Renamed the SQM script `nss-rk.qos` -> `nss-ctstat.qos` (version 0.9.4). SQM entries in
  `/etc/config/sqm` are migrated by the postinstall (`ctstat-migrate`); SQM must be restarted by hand.
- Temporary nft file is now `/tmp/nss-ctstat-qos.nft`.
- License: GPL-2.0-or-later, maintainer M0g13r. Added LICENSE, README, SPDX headers.
- Package Makefile with correct file modes, conffile `/etc/config/ctstat`, enable/start on install,
  stop/disable on removal.

## 1.1.0-r11
- Previous state (no packaging).
