# collect.awk — conntrack 差分采集核心
# 由 collector.sh 调用，每轮一次。
#
# 入参 (-v):
#   statef      上轮连接快照 (key up down)
#   clientsf    累计表 (ip mac up down day dayup daydown)
#   stateout    本轮新快照输出路径
#   clientsout  本轮新累计表输出路径
#   jsonout     页面用 JSON 输出路径
#   today       当期日期 YYYYMMDD
#   interval    采样间隔（秒）
#   lanpfx      LAN 网段列表，空格分隔，形如 "192.168.3.1/24 10.0.0.1/8"
#   neighf      IP->MAC 映射文件 (ip mac)
#
# 输入数据：/proc/net/nf_conntrack

function ip2i(s,   a) {
	split(s, a, ".")
	return ((a[1]*256 + a[2])*256 + a[3])*256 + a[4]
}

# 不依赖 math 库（部分 busybox awk 未编入 ^ / exp / log）
function pow2(n,   v, i) {
	v = 1
	for (i = 0; i < n; i++) v *= 2
	return v
}

function is_lan(ip,   i, v) {
	if (ip == "") return 0
	if (index(ip, ":") > 0) return 0      # IPv6 暂不处理
	v = ip2i(ip)
	for (i = 1; i <= npfx; i++)
		if (int(v / pfx_div[i]) == pfx_net[i]) return 1
	return 0
}

BEGIN {
	npfx = split(lanpfx, _p, " ")
	for (_i = 1; _i <= npfx; _i++) {
		split(_p[_i], _q, "/")
		_b = _q[2] + 0
		pfx_div[_i] = pow2(32 - _b)
		pfx_net[_i] = int(ip2i(_q[1]) / pfx_div[_i])
	}

	while ((getline _line < neighf) > 0) {
		split(_line, _f, " ")
		if (_f[1] != "" && _f[2] != "") {
			nei[_f[1]] = _f[2]
			if (_f[3] != "" && _f[3] != "-") hn[_f[1]] = _f[3]
		}
	}
	close(neighf)

	while ((getline _line < statef) > 0) {
		if (split(_line, _f, " ") < 3) continue
		su[_f[1]] = _f[2] + 0
		sd[_f[1]] = _f[3] + 0
	}
	close(statef)

	ncl = 0
	while ((getline _line < clientsf) > 0) {
		if (split(_line, _f, " ") < 7) continue
		_cip = _f[1]
		if (!(_cip in cidx)) { ncl++; cidx[_cip] = ncl; corder[ncl] = _cip }
		_i = cidx[_cip]
		c_mac[_i] = _f[2]
		c_up[_i]  = _f[3] + 0
		c_dn[_i]  = _f[4] + 0
		c_day[_i] = _f[5]
		c_dup[_i] = _f[6] + 0
		c_ddn[_i] = _f[7] + 0
		c_host[_i] = (_f[8] == "") ? "-" : _f[8]
	}
	close(clientsf)
}

{
	if (NF < 5) next

	fam = $1
	proto = $3
	t = 0
	src1 = ""; dst1 = ""; sp1 = ""; dp1 = ""
	by1 = 0; by2 = 0

	for (i = 1; i <= NF; i++) {
		f = $i
		if (f ~ /^src=/) {
			t++
			split(f, x, "=")
			if (t == 1) src1 = x[2]
		} else if (f ~ /^dst=/) {
			split(f, x, "=")
			if (t == 1) dst1 = x[2]
		} else if (f ~ /^sport=/) {
			split(f, x, "=")
			if (t == 1) sp1 = x[2]
		} else if (f ~ /^dport=/) {
			split(f, x, "=")
			if (t == 1) dp1 = x[2]
		} else if (f ~ /^id=/) {
			split(f, x, "=")
			if (t == 1) sp1 = "i" x[2]
		} else if (f ~ /^bytes=/) {
			split(f, x, "=")
			if (t == 1) by1 = x[2] + 0
			else if (t == 2) by2 = x[2] + 0
		}
	}

	if (src1 == "" || dst1 == "") next
	if (fam == "ipv6") next

	if (is_lan(src1))      { u = by1; d = by2; cip = src1 }
	else if (is_lan(dst1)) { u = by2; d = by1; cip = dst1 }
	else next

	key = fam "|" proto "|" src1 "|" sp1 "|" dst1 "|" dp1

	pu = (key in su) ? su[key] : 0
	pd = (key in sd) ? sd[key] : 0
	du = u - pu
	dd = d - pd
	if (du < 0) du = u          # 端口复用/重建，按新连接的全量计入
	if (dd < 0) dd = d

	nsu[key] = u
	nsd[key] = d

	if (!(cip in cidx)) { ncl++; cidx[cip] = ncl; corder[ncl] = cip }
	i = cidx[cip]

	if (c_day[i] != today) { c_day[i] = today; c_dup[i] = 0; c_ddn[i] = 0 }
	c_up[i] += du
	c_dn[i] += dd
	c_dup[i] += du
	c_ddn[i] += dd
	r_up[i] += du
	r_dn[i] += dd
	if (cip in nei) c_mac[i] = nei[cip]
	if (cip in hn)  c_host[i] = hn[cip]
}

END {
	for (k in nsu) {
		s = sprintf("%s %.0f %.0f", k, nsu[k], nsd[k])
		print s > stateout
	}
	close(stateout)

	for (j = 1; j <= ncl; j++) {
		m = (c_mac[j] == "") ? "-" : c_mac[j]
		h = (c_host[j] == "") ? "-" : c_host[j]
		s = sprintf("%s %s %.0f %.0f %s %.0f %.0f %s", corder[j], m, c_up[j], c_dn[j], c_day[j], c_dup[j], c_ddn[j], h)
		print s > clientsout
	}
	close(clientsout)

	s = sprintf("{\"ts\":%.0f,\"interval\":%.0f,\"clients\":[", ts, interval)
	for (j = 1; j <= ncl; j++) {
		m = (c_mac[j] == "") ? "-" : c_mac[j]
		h = (c_host[j] == "") ? "-" : c_host[j]
		if (j > 1) s = s ","
		s = s sprintf("{\"ip\":\"%s\",\"mac\":\"%s\",\"host\":\"%s\",\"up\":%.0f,\"down\":%.0f,\"day_up\":%.0f,\"day_down\":%.0f,\"rate_up\":%.0f,\"rate_down\":%.0f}",
			corder[j], m, h, c_up[j], c_dn[j], c_dup[j], c_ddn[j], r_up[j], r_dn[j])
	}
	s = s "]}"
	print s > jsonout
	close(jsonout)
}
