#!/bin/sh
# ctstat 采集守护进程
#
# 数据源：/proc/net/nf_conntrack（含 packets= / bytes=）
# 在 NSS/ECM 硬件加速下，QCA 的 NSS 前端会把硬件转发计数回写到 conntrack acct
# （qca-nss-ecm/frontends/nss/ecm_nss_ipv4.c 中 nf_conn_acct_find(ct)->counter 累加），
# 因此本采集器在开/关加速两种情况下都能拿到真实字节数。
#
# 输出：
#   /tmp/ctstat/state.db    上轮连接快照（用于差分）
#   /tmp/ctstat/clients.db  按 IP 的累计表
#   /tmp/ctstat/usage.json  页面消费的 JSON
#   /etc/ctstat/clients.db  累计表持久化（重启不丢）

. /lib/functions.sh

STATE_DIR=/tmp/ctstat
STATE=$STATE_DIR/state.db
CLIENTS=$STATE_DIR/clients.db
JSON=$STATE_DIR/usage.json
NEIGH=$STATE_DIR/neigh.db
LOCK=$STATE_DIR/lock
PERSIST_DIR=/etc/ctstat
PERSIST=$PERSIST_DIR/clients.db

mkdir -p "$STATE_DIR" "$PERSIST_DIR"

# 单实例
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
	echo "ctstat: already running (pid $(cat "$LOCK"))" >&2
	exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"; exit 0' INT TERM EXIT

# 从持久化恢复
if [ ! -f "$CLIENTS" ]; then
	[ -f "$PERSIST" ] && cp "$PERSIST" "$CLIENTS"
fi
[ -f "$STATE" ] || : > "$STATE"
[ -f "$CLIENTS" ] || : > "$CLIENTS"

cfg_get() {
	uci -q get "ctstat.config.$1" 2>/dev/null
}

# 自动探测 LAN 网段：优先 br-* 接口的 IPv4 地址，兜底读 uci network.lan
detect_lan() {
	local out="" d ifn a
	for d in /sys/class/net/br-* /sys/class/net/lan*; do
		[ -e "$d" ] || continue
		ifn="${d##*/}"
		a=$(ip -4 addr show dev "$ifn" 2>/dev/null | awk '/inet /{print $2}')
		[ -n "$a" ] && out="$out $a"
	done
	if [ -z "$out" ]; then
		a=$(uci -q get network.lan.ipaddr)
		if [ -n "$a" ]; then
			local m
			m=$(uci -q get network.lan.netmask)
			case "$m" in
				255.255.255.0) a="$a/24" ;;
				255.255.0.0)   a="$a/16" ;;
				255.0.0.0)     a="$a/8" ;;
				255.255.255.128) a="$a/25" ;;
				255.255.255.192) a="$a/26" ;;
				*) a="$a/24" ;;
			esac
			out="$a"
		fi
	fi
	echo "$out" | sed 's/^ *//;s/ *$//'
}

# 刷新 IP -> MAC / 主机名
refresh_neigh() {
	local tmp="$NEIGH.tmp" ifn
	: > "$tmp"
	for ifn in br-lan br-*; do
		[ -e "/sys/class/net/$ifn" ] || continue
		ip neigh show dev "$ifn" 2>/dev/null | awk '
			/lladdr/ {
				ip = $1; mac = ""; host = "-"
				for (i = 1; i <= NF; i++)
					if ($i == "lladdr") mac = $(i+1)
				if (mac != "") print ip, mac, host
			}'
	done >> "$tmp"
	# dhcp 租约补主机名
	if [ -f /tmp/dhcp.leases ]; then
		awk 'NF>=4 {
			ip = $3; host = ($4 == "*") ? "-" : $4
			print ip, host
		}' /tmp/dhcp.leases > "$tmp.host"
		awk -v hf="$tmp.host" '
			BEGIN {
				while ((getline l < hf) > 0) {
					split(l, f, " ")
					if (f[1] != "") hn[f[1]] = f[2]
				}
				close(hf)
			}
			{
				ip = $1; mac = $2; host = (ip in hn) ? hn[ip] : "-"
				print ip, mac, host
			}' "$tmp" > "$tmp.h2"
		[ -s "$tmp.h2" ] && mv "$tmp.h2" "$tmp"
		rm -f "$tmp.host" "$tmp.h2"
	fi
	mv "$tmp" "$NEIGH" 2>/dev/null
}

INTERVAL=$(cfg_get interval)
case "$INTERVAL" in
	''|*[!0-9]*) INTERVAL=3 ;;
esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=3
[ "$INTERVAL" -gt 60 ] && INTERVAL=60

LANPFX=$(cfg_get lan_prefix)
[ -z "$LANPFX" ] && LANPFX=$(detect_lan)

CONNTRACK=/proc/net/nf_conntrack
[ -r "$CONNTRACK" ] || CONNTRACK=/proc/net/ip_conntrack

echo "ctstat: interval=${INTERVAL}s lan='$LANPFX' conntrack=$CONNTRACK" >&2

tick=0
save_every=$((300 / INTERVAL))      # 约 5 分钟落盘一次
neigh_every=$((30 / INTERVAL))      # 约 30 秒刷新一次 ARP
[ "$save_every" -lt 1 ] && save_every=1
[ "$neigh_every" -lt 1 ] && neigh_every=1

while :; do
	if [ "$(cfg_get enabled)" = "0" ]; then
		sleep 30
		continue
	fi

	# 页面点了清零：只清累计表，保留 state 基线，避免历史连接被重算
	if [ -f "$STATE_DIR/.reset" ]; then
		: > "$CLIENTS"
		: > "$PERSIST"
		rm -f "$STATE_DIR/.reset"
	fi

	# 配置热更新
	_new_int=$(cfg_get interval)
	case "$_new_int" in
		''|*[!0-9]*) ;;
		*) [ "$_new_int" -ge 1 ] && [ "$_new_int" -le 60 ] && INTERVAL="$_new_int" ;;
	esac
	_new_pfx=$(cfg_get lan_prefix)
	if [ "$_new_pfx" != "$LANPFX" ]; then
		LANPFX="$_new_pfx"
		[ -z "$LANPFX" ] && LANPFX=$(detect_lan)
	fi

	if [ ! -r "$CONNTRACK" ]; then
		echo "ctstat: $CONNTRACK not readable (CONFIG_NF_CONNTRACK_PROCFS?)" >&2
		sleep 30
		continue
	fi

	if [ $((tick % neigh_every)) -eq 0 ]; then
		refresh_neigh
	fi

	awk -f /usr/share/ctstat/collect.awk \
		-v statef="$STATE" \
		-v clientsf="$CLIENTS" \
		-v stateout="$STATE.new" \
		-v clientsout="$CLIENTS.new" \
		-v jsonout="$JSON.new" \
		-v today="$(date +%Y%m%d)" \
		-v interval="$INTERVAL" \
		-v ts="$(date +%s)" \
		-v lanpfx="$LANPFX" \
		-v neighf="$NEIGH" \
		"$CONNTRACK" 2>/dev/null

	if [ $? -eq 0 ] && [ -f "$CLIENTS.new" ]; then
		mv -f "$STATE.new" "$STATE"
		mv -f "$CLIENTS.new" "$CLIENTS"
		mv -f "$JSON.new" "$JSON"
	fi
	rm -f "$STATE.new" "$CLIENTS.new" "$JSON.new"

	if [ "$save_every" -gt 0 ] && [ $((tick % save_every)) -eq 0 ]; then
		cp -f "$CLIENTS" "$PERSIST.tmp" 2>/dev/null && mv -f "$PERSIST.tmp" "$PERSIST"
	fi

	tick=$((tick + 1))
	sleep "$INTERVAL"
done
