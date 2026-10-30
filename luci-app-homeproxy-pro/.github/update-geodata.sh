#!/bin/bash

BASE_DIR="$(cd "$(dirname $0)"; pwd)"
RESOURCES_DIR="$BASE_DIR/../root/etc/homeproxy/resources"

TEMP_DIR="$(mktemp -d -p $BASE_DIR)"

check_list_update() {
	local listtype="$1"
	local listrepo="$2"
	local listref="$3"
	local listname="$4"
	# v4 / v6 when the upstream file holds both families and has to be split;
	# empty when it is already exactly what this listtype wants.  Kept in step
	# with install_download() in root/etc/homeproxy/scripts/update_resources.sh,
	# which does the same split on the router.
	local family="${5:-}"
	# Where the file is inside the repo, for the commits?path= filter.  Same
	# value as $listname for every root-level list; a source that keeps its
	# list in a subdirectory needs it spelled out or the query matches no
	# commit and returns [].  Downloaded as $listname regardless.
	local api_path="${6:-$listname}"

	local list_info="$(gh api "repos/$listrepo/commits?sha=$listref&path=$api_path&per_page=1")"
	local list_sha="$(echo -e "$list_info" | jq -r ".[].sha")"
	local list_date="$(echo -e "$list_info" | jq -r ".[].commit.committer.date" | cut -d 'T' -f1)"
	if [ -z "$list_sha" ]; then
		echo -e "[${listtype^^}] Failed to get the latest version, please retry later."
		return 1
	fi
	local list_ver="${list_date:+$list_date }$list_sha"

	local local_list_ver="$(cat "$RESOURCES_DIR/$listtype.ver" 2>"/dev/null" || echo "NOT_FOUND")"
	local local_list_sha="${local_list_ver##* }"
	local local_list_disp="${local_list_ver%% *}"
	if [ "$local_list_sha" = "$list_sha" ]; then
		echo -e "[${listtype^^}] Current version: $local_list_disp."
		echo -e "[${listtype^^}] You're already at the latest version."
		return 3
	else
		echo -e "[${listtype^^}] Local version: $local_list_disp, latest version: ${list_ver%% *}."
	fi

	if ! curl -fsSL "https://raw.githubusercontent.com/$listrepo/$list_sha/$api_path" -o "$TEMP_DIR/$listname" || [ ! -s "$TEMP_DIR/$listname" ]; then
		rm -f "$TEMP_DIR/$listname"
		echo -e "[${listtype^^}] Update failed."
		return 1
	fi

	# cn.list is one file carrying both address families, so the two IP lists
	# are split out of it instead of moved.  That also overrides the
	# "$listtype.<upstream extension>" naming, which would install cn.list as
	# china_ip4.list while every reader expects .txt.  Written through a temp
	# file and renamed, and an empty half is a failure rather than an empty
	# list: firewall_post.ut reads a zero prefix count in china_ip6.txt as
	# "IPv6 cannot be classified" and turns v6 handling off.
	if [ -n "$family" ]; then
		local dest="$RESOURCES_DIR/$listtype.txt"
		awk -v want="$family" '
			NF == 0 { next }
			{ if ((index($1, ":") > 0) == (want == "v6")) print }
		' "$TEMP_DIR/$listname" > "$dest.hp-new"
		if [ ! -s "$dest.hp-new" ]; then
			rm -f "$dest.hp-new"
			echo -e "[${listtype^^}] Conversion failed; $listname carries no $family entries."
			rm -f "$TEMP_DIR/$listname"
			return 1
		fi
		mv -f "$dest.hp-new" "$dest"
		rm -f "$TEMP_DIR/$listname"
	elif ! mv -f "$TEMP_DIR/$listname" "$RESOURCES_DIR/$listtype.${listname##*.}"; then
		rm -f "$TEMP_DIR/$listname"
		echo -e "[${listtype^^}] Update failed."
		return 1
	fi
	echo -e "$list_ver" > "$RESOURCES_DIR/$listtype.ver"
	echo -e "[${listtype^^}] Successfully updated."

	return 0
}

# Upstream is MetaCubeX/meta-rules-dat's cn.list rather than the
# 1715173329/IPCIDR-CHINA pair r46 shipped.  Measured against the APNIC
# delegated statistics, the old lists missed 62,927,616 CN IPv4 addresses
# against cn.list's 1,519,872; the two largest gaps were the Beijing Telecom
# backbone blocks 59.192.0.0/21 and 175.48.0.0/21, so destinations resolving
# into them missed the mainland rule and went to the proxy.  cn.list is also
# slightly *more* precise (99.22% of what it lists is CN, against 98.92%).  It
# stays pure CIDR text so the nft set and the generated route rule-set keep
# reading one file, and it is a file in a git repository so the router's
# blob-id check still applies.
#
# CORRECTION (2026-10-08): the numbers above were measured against the APNIC
# delegated file, and that file is NOT the authority - its `cc` column is a
# coarse registry summary that loses sub-allocations (it reports 8.128.0.0/10 as
# SG where RDAP says CN/ALICLOUD).  Do not reuse those figures, and do not use
# that file as a yardstick; use RDAP (https://rdap.apnic.net/ip/<address>).
# Measured that way, this source still beats the r46 pair on both axes, and the
# delegated statistics were rejected as a *replacement* source precisely because
# deriving from them drops ~100 million addresses this list carries correctly.
check_list_update "china_ip4" "MetaCubeX/meta-rules-dat" "meta" "cn.list" "v4" "geo/geoip/cn.list"
check_list_update "china_ip6" "MetaCubeX/meta-rules-dat" "meta" "cn.list" "v6" "geo/geoip/cn.list"
check_list_update "gfw_list" "Loyalsoldier/v2ray-rules-dat" "release" "gfw.txt"

# The upstream direct-list is not a dnsmasq domain list: `full:` marks an exact
# match and `regexp:` lines are regular expressions, which the consumer
# (runtime/dns.sh renders `server=/<domain>/...`) cannot express.  Strip the
# prefix and drop the regex lines, through a temporary file: `sed -i -e` is a
# GNU form that BSD sed - i.e. macOS, where this maintenance script normally
# runs - rejects with "sed: -e: No such file or directory".  The upload had
# already replaced the file by then, so the failure shipped a raw direct-list
# in a package whose every other script converter was written portably for
# exactly that reason.
if check_list_update "china_list" "Loyalsoldier/v2ray-rules-dat" "release" "direct-list.txt"; then
	if ! sed -e "s/full://g" -e "/:/d" "$RESOURCES_DIR/china_list.txt" > "$RESOURCES_DIR/china_list.txt.hp-new" \
	   || ! mv -f "$RESOURCES_DIR/china_list.txt.hp-new" "$RESOURCES_DIR/china_list.txt"; then
		rm -f "$RESOURCES_DIR/china_list.txt.hp-new"
		echo -e "[CHINA_LIST] Conversion failed; the file may still be in the upstream format."
		exit 1
	fi
fi

rm -rf "$TEMP_DIR"
