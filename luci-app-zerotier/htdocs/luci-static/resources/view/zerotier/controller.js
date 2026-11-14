/* SPDX-License-Identifier: Apache-2.0 */

'use strict';
'require view';
'require rpc';
'require zerotier.qrcode as qrcode';

/* Embedded ZeroTier Controller management view for ImmortalWrt/OpenWrt LuCI */

var callStatus = rpc.declare({
	object: 'zerotier-controller',
	method: 'status'
});

var callListNetworks = rpc.declare({
	object: 'zerotier-controller',
	method: 'list_networks'
});

var callGetNetworkInfo = rpc.declare({
	object: 'zerotier-controller',
	method: 'get_network_info',
	params: [ 'nwid' ]
});

var callCreateNetwork = rpc.declare({
	object: 'zerotier-controller',
	method: 'create_network',
	params: [ 'name', 'cidr' ]
});

var callUpdateIPPool = rpc.declare({
	object: 'zerotier-controller',
	method: 'update_ip_pool',
	params: [ 'nwid', 'cidr', 'old_cidr' ]
});

var callListMembers = rpc.declare({
	object: 'zerotier-controller',
	method: 'list_members',
	params: [ 'nwid', 'online_only' ]
});

var callAuthorizeMember = rpc.declare({
	object: 'zerotier-controller',
	method: 'authorize_member',
	params: [ 'nwid', 'nodeid', 'authorized' ]
});

var callChangeMemberIP = rpc.declare({
	object: 'zerotier-controller',
	method: 'change_member_ip',
	params: [ 'nwid', 'nodeid', 'ip_assignments' ]
});

var callRenameMember = rpc.declare({
	object: 'zerotier-controller',
	method: 'rename_member',
	params: [ 'nwid', 'nodeid', 'name' ]
});

var callAddRoute = rpc.declare({
	object: 'zerotier-controller',
	method: 'add_route',
	params: [ 'nwid', 'target', 'via' ]
});

var callDelRoute = rpc.declare({
	object: 'zerotier-controller',
	method: 'del_route',
	params: [ 'nwid', 'target' ]
});

var callDeleteMember = rpc.declare({
	object: 'zerotier-controller',
	method: 'delete_member',
	params: [ 'nwid', 'nodeid' ]
});

var callExportBackup = rpc.declare({
	object: 'zerotier-controller',
	method: 'export_backup',
	params: [ 'nwid' ]
});

var callImportBackup = rpc.declare({
	object: 'zerotier-controller',
	method: 'import_backup',
	params: [ 'backup_data', 'mode' ]
});

function rpcErrorMessage(res) {
	if (!res)
		return _('Empty response from controller service');

	var message = res.error || res.controllerError || _('Controller request failed');
	var httpStatus = res.http_status || res.controllerHttpStatus;
	if (httpStatus)
		message += ' (HTTP ' + httpStatus + ')';
	if (res.failed_member)
		message += ' — ' + _('Failed at member %s (%d of %d imported).').format(
			res.failed_member, res.restored_members || 0, res.total_members || 0);

	return message;
}

function requireRpcResult(res) {
	if (!res || res.error)
		throw new Error(rpcErrorMessage(res));

	return res;
}


function peerConnectionInfo(peer, now) {
	var paths = Array.isArray(peer && peer.paths) ? peer.paths : [];
	var activePaths = paths.filter(function(path) {
		return path && path.active === true;
	});
	var timestamps = [ Number(peer && peer.lastReceive) || 0, Number(peer && peer.lastSend) || 0 ];
	paths.forEach(function(path) {
		timestamps.push(Number(path && path.lastReceive) || 0, Number(path && path.lastSend) || 0);
	});
	var lastActivity = Math.max.apply(Math, timestamps);
	var latency = Number(peer && peer.latency);
	if (!isFinite(latency) || latency < 0)
		latency = -1;

	var direct = activePaths.length > 0;
	var online = direct || latency >= 0 || lastActivity > (now - 120000);

	return {
		online: online,
		mode: direct ? 'direct' : (online ? 'relay' : 'offline'),
		latency: latency
	};
}

function showNotification(message, type) {
	var host = document.getElementById('ztc-notifications');
	if (!host) {
		window.alert(message);
		return;
	}

	var toast = E('div', {
		'class': 'ztc-toast ztc-toast-' + (type || 'info'),
		'role': 'status'
	}, [
		E('span', {}, [ message ]),
		E('button', {
			'class': 'ztc-toast-close',
			'type': 'button',
			'title': _('Dismiss'),
			'click': function() { toast.remove(); }
		}, [ '\u00d7' ])
	]);

	host.appendChild(toast);
	window.setTimeout(function() {
		if (toast.parentNode)
			toast.parentNode.removeChild(toast);
	}, 5000);
}

function handleRpcError(err) {
	showNotification(_('Operation failed: ') + ((err && err.message) ? err.message : String(err)), 'error');
}

function ipv4FromNumber(value) {
	return [
		Math.floor(value / 16777216) % 256,
		Math.floor(value / 65536) % 256,
		Math.floor(value / 256) % 256,
		value % 256
	].join('.');
}

function ipv4ToNumber(value) {
	var match = String(value || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!match)
		return null;
	var octets = match.slice(1).map(Number);
	if (octets.some(function(octet) { return octet < 0 || octet > 255; }))
		return null;
	return octets[0] * 16777216 + octets[1] * 65536 + octets[2] * 256 + octets[3];
}

function parseIPv4CIDR(value) {
	var match = String(value || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
	if (!match)
		return null;

	var octets = match.slice(1, 5).map(Number);
	var prefix = Number(match[5]);
	if (octets.some(function(octet) { return octet < 0 || octet > 255; }) || prefix < 8 || prefix > 30)
		return null;

	var address = octets[0] * 16777216 + octets[1] * 65536 + octets[2] * 256 + octets[3];
	var blockSize = Math.pow(2, 32 - prefix);
	var network = Math.floor(address / blockSize) * blockSize;
	var broadcast = network + blockSize - 1;

	return {
		cidr: ipv4FromNumber(network) + '/' + prefix,
		start: ipv4FromNumber(network + 1),
		end: ipv4FromNumber(broadcast - 1),
		networkNumber: network,
		broadcastNumber: broadcast
	};
}


function managedPoolInfo(netInfo) {
	var configuredPool = (netInfo.ipAssignmentPools || [])[0] || {};
	var configuredPoolStart = ipv4ToNumber(configuredPool.ipRangeStart);
	var directIPv4Route = (netInfo.routes || []).find(function(route) {
		var parsedRoute = route && !route.via ? parseIPv4CIDR(route.target) : null;
		return parsedRoute && configuredPoolStart !== null &&
			configuredPoolStart >= parsedRoute.networkNumber && configuredPoolStart <= parsedRoute.broadcastNumber;
	}) || (netInfo.routes || []).find(function(route) {
		return route && !route.via && parseIPv4CIDR(route.target);
	});
	var cidr = directIPv4Route ? directIPv4Route.target : '';

	return {
		cidr: cidr,
		parsed: parseIPv4CIDR(cidr)
	};
}

function renderNetworkQRCode(nwid) {
	var url = 'https://joinzt.com/addnetwork?nwid=' + encodeURIComponent(nwid) + '&v=1';
	var qr = qrcode.create(0, 'M');
	qr.addData(url);
	qr.make();

	var host = E('div', {
		'class': 'ztc-qr-image',
		'role': 'img',
		'aria-label': _('Network join QR code')
	});
	host.innerHTML = qr.createSvgTag(4, 3, _('Network join QR code'), url);
	return host;
}

function dashboardStyles() {
	return [
		'.ztc-dashboard { --ztc-accent:var(--primary-color, #2563eb); --ztc-success:#16a34a; --ztc-danger:#dc2626; --ztc-warning:#d97706; --ztc-radius:12px; font-variant-numeric:tabular-nums; }',
		'.ztc-dashboard .ztc-hero { display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:center; gap:22px; margin:0 0 16px; padding:20px 22px; overflow:hidden; border-radius:16px; color:#fff; background:linear-gradient(135deg, #172554 0%, #1d4ed8 58%, #0891b2 100%); box-shadow:0 12px 30px rgba(30,64,175,.18); }',
		'.ztc-dashboard .ztc-hero-main { display:flex; align-items:flex-start; gap:15px; min-width:0; }',
		'.ztc-dashboard .ztc-brandmark { display:grid; place-items:center; flex:0 0 46px; width:46px; height:46px; border:1px solid rgba(255,255,255,.35); border-radius:13px; background:rgba(255,255,255,.14); font-size:17px; font-weight:800; letter-spacing:.06em; backdrop-filter:blur(8px); }',
		'.ztc-dashboard .ztc-controller-copy { min-width:0; }',
		'.ztc-dashboard .ztc-hero h2 { margin:0 0 3px; padding:0; border:0; color:#fff; font-size:clamp(20px, 2.5vw, 28px); }',
		'.ztc-dashboard .ztc-hero p { margin:0; color:rgba(255,255,255,.82); line-height:1.45; }',
		'.ztc-dashboard .ztc-controller-meta { display:flex; flex-wrap:wrap; align-items:baseline; gap:5px 9px; margin-top:9px; color:rgba(255,255,255,.78); font-size:12px; }',
		'.ztc-dashboard .ztc-controller-label { font-weight:600; }',
		'.ztc-dashboard .ztc-node-id { color:#fff; font-size:14px; font-weight:800; overflow-wrap:anywhere; }',
		'.ztc-dashboard .ztc-version { color:rgba(255,255,255,.70); font-size:12px; }',
		'.ztc-dashboard .ztc-controller-side { display:flex; flex-direction:column; align-items:flex-end; gap:9px; }',
		'.ztc-dashboard .ztc-count { flex:0 0 auto; padding:6px 11px; border:1px solid rgba(255,255,255,.28); border-radius:999px; background:rgba(255,255,255,.12); font-size:12px; font-weight:700; white-space:nowrap; }',
		'.ztc-dashboard .ztc-status-pills { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }',
		'.ztc-dashboard .ztc-pill { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; color:#fff; font-size:12px; font-weight:700; white-space:nowrap; }',
		'.ztc-dashboard .ztc-pill::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; box-shadow:0 0 0 3px rgba(255,255,255,.18); }',
		'.ztc-dashboard .ztc-pill-success { background:var(--ztc-success); }',
		'.ztc-dashboard .ztc-pill-danger { background:var(--ztc-danger); }',
		'.ztc-dashboard .ztc-pill-warning { background:var(--ztc-warning); }',
		'.ztc-dashboard .ztc-error { margin:10px 0 0; padding:9px 11px; border-radius:8px; color:#991b1b; background:rgba(254,226,226,.90); font-size:13px; }',
		'.ztc-dashboard .ztc-hero .ztc-error { color:#fff; background:rgba(127,29,29,.50); }',
		'.ztc-dashboard .ztc-card { margin:0 0 15px; padding:16px 17px; border:1px solid var(--border-color-medium, rgba(100,116,139,.22)); border-radius:var(--ztc-radius); background:var(--background-color-high, rgba(255,255,255,.98)); box-shadow:0 5px 18px rgba(15,23,42,.05); }',
		'.ztc-dashboard .ztc-card h3 { margin:0 0 13px; padding:0; border:0; font-size:16px; }',
		'.ztc-dashboard .ztc-heading-reset { margin:0 !important; }',
		'.ztc-dashboard .ztc-subtitle { display:block; margin-top:5px; color:var(--text-color-medium, #64748b); font-size:12px; line-height:1.45; }',
		'.ztc-dashboard .ztc-code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }',
		'.ztc-dashboard .ztc-layout { display:grid; grid-template-columns:minmax(0, 186px) minmax(0, 1fr); gap:16px; align-items:start; }',
		'.ztc-dashboard .ztc-sidebar { min-width:0; width:100%; position:sticky; top:12px; max-height:calc(100vh - 24px); overflow-y:auto; overflow-x:hidden; padding-right:2px; scrollbar-width:thin; }',
		'.ztc-dashboard .ztc-sidebar .ztc-card { min-width:0; padding:13px 12px; box-sizing:border-box; }',
		'.ztc-dashboard .ztc-sidebar .ztc-card h3 { font-size:15px; line-height:1.35; }',
		'.ztc-dashboard .ztc-sidebar .ztc-field { min-width:0; max-width:100%; overflow:hidden; }',
		'.ztc-dashboard .ztc-sidebar input[type="file"] { box-sizing:border-box; width:100%; max-width:100%; overflow:hidden; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }',
		'.ztc-dashboard .ztc-sidebar input[type="file"]::file-selector-button, .ztc-dashboard .ztc-sidebar input[type="file"]::-webkit-file-upload-button { max-width:100%; padding:2px 5px; font-size:11px; overflow:hidden; text-overflow:ellipsis; }',
		'.ztc-dashboard .ztc-network-list { display:grid; gap:8px; margin:0; padding:0; list-style:none; }',
		'.ztc-dashboard .ztc-network-button { display:flex; width:100%; padding:9px 11px; overflow:hidden; flex-direction:column; align-items:flex-start; gap:3px; border:1px solid rgba(37,99,235,.20); border-radius:8px; text-align:left; }',
		'.ztc-dashboard .ztc-network-name { display:block; width:100%; overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }',
		'.ztc-dashboard .ztc-network-id { display:block; width:100%; overflow:hidden; color:var(--text-color-medium, #64748b); font-size:11px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }',
		'.ztc-dashboard .ztc-network-button.is-active { border-color:var(--ztc-accent); color:#fff; background:var(--ztc-accent); box-shadow:0 5px 14px rgba(37,99,235,.22); }',
		'.ztc-dashboard .ztc-network-button.is-active .ztc-network-id { color:rgba(255,255,255,.78); }',
		'.ztc-dashboard .ztc-empty { display:grid; min-height:140px; place-items:center; padding:22px; border:1px dashed var(--border-color-medium, #cbd5e1); border-radius:var(--ztc-radius); color:var(--text-color-medium, #64748b); text-align:center; }',
		'.ztc-dashboard .ztc-empty-small { min-height:64px; padding:13px; }',
		'.ztc-dashboard .ztc-field { margin:0 0 10px; padding:0; }',
		'.ztc-dashboard .ztc-full { box-sizing:border-box; width:100%; max-width:none; }',
		'.ztc-dashboard .ztc-stack-input { margin-bottom:9px; }',
		'.ztc-dashboard input[type="text"], .ztc-dashboard input[type="file"], .ztc-dashboard select { box-sizing:border-box; max-width:none; border-radius:7px; }',
		'.ztc-dashboard .ztc-card button, .ztc-dashboard .ztc-card .btn { min-height:34px; border-radius:7px; }',
		'.ztc-dashboard button[disabled] { cursor:not-allowed; opacity:.55; }',
		'.ztc-dashboard .ztc-overview { display:flex; align-items:center; justify-content:space-between; gap:14px; }',
		'.ztc-dashboard .ztc-network-overview { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; align-items:center; gap:20px; }',
		'.ztc-dashboard .ztc-network-info { display:flex; flex-direction:column; gap:3px; min-width:0; }',
		'.ztc-dashboard .ztc-network-info h3 { margin:0 0 2px; padding:0; font-size:18px; font-weight:700; line-height:1.3; }',
		'.ztc-dashboard .ztc-network-info .ztc-subtitle { display:block; color:var(--text-color-medium, #64748b); font-size:12px; }',
		'.ztc-dashboard .ztc-network-info .ztc-qr-desc { display:block; margin-top:3px; color:var(--text-color-medium, #64748b); font-size:11px; }',
		'.ztc-dashboard .ztc-network-actions { display:flex; align-items:center; justify-content:flex-end; }',
		'.ztc-dashboard .ztc-qr-image { box-sizing:border-box; flex:0 0 108px; width:108px; height:108px; padding:4px; border:1px solid var(--border-color-medium, rgba(100,116,139,.2)); border-radius:10px; background:#fff; box-shadow:0 2px 8px rgba(15,23,42,.08); }',
		'.ztc-dashboard .ztc-qr-image svg { display:block; width:100%; height:100%; }',
		'.ztc-dashboard .ztc-qr-copy { max-width:160px; color:var(--text-color-medium, #64748b); font-size:11px; line-height:1.45; }',
		'.ztc-dashboard .ztc-qr-copy strong { display:block; margin-bottom:4px; color:var(--text-color-high, inherit); font-size:12px; }',
		'.ztc-dashboard .ztc-qr-network-id { display:block; margin-top:5px; overflow-wrap:anywhere; }',
		'.ztc-dashboard .ztc-network-share > .btn { flex:0 0 auto; }',
		'.ztc-dashboard .ztc-card-heading { margin-bottom:13px; }',
		'.ztc-dashboard .ztc-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:8px; }',
		'.ztc-dashboard .ztc-sidebar-form { display:grid; gap:9px; }',
		'.ztc-dashboard .ztc-sidebar-form label { display:block; margin-bottom:5px; font-size:12px; font-weight:700; }',
		'.ztc-dashboard .ztc-sidebar-preview { padding:9px 10px; border-radius:8px; color:var(--text-color-medium, #64748b); background:rgba(37,99,235,.07); font-size:11px; line-height:1.45; overflow-wrap:anywhere; }',
		'.ztc-dashboard .ztc-help { margin:7px 0 0; color:var(--text-color-medium, #64748b); font-size:12px; line-height:1.5; }',
		'.ztc-dashboard .ztc-filterbar { display:grid; grid-template-columns:minmax(180px, .48fr) minmax(280px, 1.52fr); gap:12px; margin-bottom:13px; padding:10px; border-radius:9px; background:rgba(100,116,139,.08); }',
		'.ztc-dashboard .ztc-filterfield { display:flex; align-items:center; gap:7px; min-width:0; }',
		'.ztc-dashboard .ztc-filterfield label { flex:0 0 auto; }',
		'.ztc-dashboard .ztc-filterfield select, .ztc-dashboard .ztc-filterfield input { min-width:0; }',
		'.ztc-dashboard .ztc-filterfield-grow { min-width:0; }',
		'.ztc-dashboard .ztc-member-wrap, .ztc-dashboard .ztc-route-wrap { overflow:auto; border:1px solid var(--border-color-medium, #dbe2ea); border-radius:9px; }',
		'.ztc-dashboard .ztc-member-wrap { max-height:590px; }',
		'.ztc-dashboard .ztc-members-table, .ztc-dashboard .ztc-route-table { display:table !important; width:100%; margin:0; table-layout:fixed; border-collapse:collapse; border-spacing:0; }',
		'.ztc-dashboard .ztc-members-table { min-width:940px; }',
		'.ztc-dashboard .ztc-members-table thead, .ztc-dashboard .ztc-route-table thead { display:table-header-group !important; }',
		'.ztc-dashboard .ztc-members-table tbody, .ztc-dashboard .ztc-route-table tbody { display:table-row-group !important; }',
		'.ztc-dashboard .ztc-members-table tfoot, .ztc-dashboard .ztc-route-table tfoot { display:table-footer-group !important; }',
		'.ztc-dashboard .ztc-members-table tr, .ztc-dashboard .ztc-route-table tr { display:table-row !important; }',
		'.ztc-dashboard .ztc-members-table th, .ztc-dashboard .ztc-members-table td, .ztc-dashboard .ztc-route-table th, .ztc-dashboard .ztc-route-table td { display:table-cell !important; box-sizing:border-box; vertical-align:middle !important; text-align:left !important; }',
		'.ztc-dashboard .ztc-members-table th, .ztc-dashboard .ztc-route-table th { padding:9px 8px !important; color:var(--text-color-high, inherit); background:rgba(100,116,139,.08); font-weight:700; white-space:nowrap; }',
		'.ztc-dashboard .ztc-members-table thead th { position:sticky; top:0; z-index:2; }',
		'.ztc-dashboard .ztc-members-table tbody td { padding:11px 8px !important; border-top:1px solid var(--border-color-medium, rgba(100,116,139,.18)); }',
		'.ztc-dashboard .ztc-members-table tbody tr:hover { background:rgba(37,99,235,.045); }',
		'.ztc-dashboard .ztc-members-table tfoot td { padding:10px 8px !important; border-top:1px solid var(--border-color-medium, rgba(100,116,139,.28)); background:rgba(100,116,139,.045); }',
		'.ztc-dashboard .ztc-member-node-col { width:13%; }',
		'.ztc-dashboard .ztc-member-name-col { width:18%; }',
		'.ztc-dashboard .ztc-member-ip-col { width:17%; }',
		'.ztc-dashboard .ztc-member-connection-col { width:12%; }',
		'.ztc-dashboard .ztc-member-latency-col { width:9%; }',
		'.ztc-dashboard .ztc-member-status-col { width:11%; }',
		'.ztc-dashboard .ztc-member-action-col { width:20%; }',
		'.ztc-dashboard .ztc-members-table input { box-sizing:border-box; width:100%; min-width:0; max-width:none; min-height:32px; padding-top:5px; padding-bottom:5px; }',
		'.ztc-dashboard .ztc-table-sort { cursor:pointer; user-select:none; }',
		'.ztc-dashboard .ztc-table-sort::after { content:"↕"; margin-left:4px; color:var(--text-color-medium, #64748b); font-size:9px; opacity:.60; }',
		'.ztc-dashboard .ztc-member-id { overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }',
		'.ztc-dashboard .ztc-link-mode, .ztc-dashboard .ztc-auth-badge { display:inline-flex; align-items:center; justify-content:center; min-width:52px; padding:3px 7px; border-radius:999px; font-size:10px; font-weight:800; letter-spacing:.035em; line-height:1.25; white-space:nowrap; }',
		'.ztc-dashboard .ztc-link-mode::before { content:""; width:6px; height:6px; margin-right:5px; border-radius:50%; background:currentColor; }',
		'.ztc-dashboard .ztc-link-direct { color:#047857; background:rgba(16,185,129,.14); }',
		'.ztc-dashboard .ztc-link-relay { color:#b45309; background:rgba(245,158,11,.16); }',
		'.ztc-dashboard .ztc-link-local { color:#1d4ed8; background:rgba(59,130,246,.14); }',
		'.ztc-dashboard .ztc-link-offline { color:#64748b; background:rgba(100,116,139,.14); }',
		'.ztc-dashboard .ztc-latency-cell { color:var(--text-color-medium, #64748b); font-size:11px; white-space:nowrap; }',
		'.ztc-dashboard .ztc-auth-authorized { color:#fff; background:var(--ztc-success); }',
		'.ztc-dashboard .ztc-auth-pending { color:#fff; background:#f59e0b; }',
		'.ztc-dashboard .ztc-member-actions { display:flex; flex-wrap:nowrap; align-items:center; gap:4px; white-space:nowrap; }',
		'.ztc-dashboard .ztc-member-actions .btn { flex:0 0 auto; min-width:0; min-height:30px !important; padding:3px 8px !important; font-size:11px; }',
		'.ztc-dashboard .ztc-member-editor label, .ztc-dashboard .ztc-route-table label { display:block; margin-bottom:6px; font-size:11px; font-weight:700; white-space:nowrap; }',
		'.ztc-dashboard .ztc-member-editor-note { color:var(--text-color-medium, #64748b); font-size:11px; line-height:1.45; }',
		'.ztc-dashboard .ztc-member-editor-note strong { display:block; margin-bottom:4px; color:var(--text-color-high, inherit); font-size:11px; }',
		'.ztc-dashboard .ztc-member-editor .ztc-member-add-button { width:auto; min-width:88px; min-height:32px !important; padding-left:10px !important; padding-right:10px !important; font-size:11px; }',
		'.ztc-dashboard .ztc-editor-action-label, .ztc-dashboard .ztc-route-action-label { visibility:hidden; }',
		'.ztc-dashboard .ztc-route-table { min-width:680px; }',
		'.ztc-dashboard .ztc-route-table th, .ztc-dashboard .ztc-route-table td { padding:9px 10px !important; }',
		'.ztc-dashboard .ztc-route-table tbody td { border-top:1px solid var(--border-color-medium, rgba(100,116,139,.18)); }',
		'.ztc-dashboard .ztc-route-table tfoot td { border-top:1px solid var(--border-color-medium, rgba(100,116,139,.25)); background:rgba(100,116,139,.035); }',
		'.ztc-dashboard .ztc-route-target-col { width:42%; }',
		'.ztc-dashboard .ztc-route-via-col { width:38%; }',
		'.ztc-dashboard .ztc-route-action-col { width:20%; }',
		'.ztc-dashboard .ztc-route-table input { box-sizing:border-box; width:100%; min-width:0; max-width:none; }',
		'.ztc-dashboard .ztc-route-table .ztc-route-button { width:100%; }',
		'.ztc-dashboard .ztc-route-empty { color:var(--text-color-medium, #64748b); }',
		'.ztc-toast-stack { position:fixed; z-index:10000; top:18px; right:18px; display:grid; gap:10px; width:min(390px, calc(100vw - 36px)); pointer-events:none; }',
		'.ztc-toast { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:13px 14px; border-left:4px solid #2563eb; border-radius:10px; color:#0f172a; background:#fff; box-shadow:0 14px 35px rgba(15,23,42,.22); pointer-events:auto; }',
		'.ztc-toast-success { border-left-color:var(--ztc-success); }',
		'.ztc-toast-warning { border-left-color:var(--ztc-warning); }',
		'.ztc-toast-error { border-left-color:var(--ztc-danger); }',
		'.ztc-toast-close { min-height:0 !important; padding:0 2px; border:0; color:#64748b; background:transparent; font-size:20px; line-height:1; cursor:pointer; }',
		'@media (max-width: 900px) { .ztc-dashboard .ztc-hero { grid-template-columns:1fr; } .ztc-dashboard .ztc-controller-side { align-items:flex-start; } .ztc-dashboard .ztc-status-pills { justify-content:flex-start; } .ztc-dashboard .ztc-layout { grid-template-columns:1fr; } .ztc-dashboard .ztc-sidebar { position:static; max-height:none; overflow:visible; padding-right:0; } .ztc-dashboard .ztc-sidebar .ztc-card { padding:16px 17px; } .ztc-dashboard .ztc-overview { align-items:flex-start; flex-direction:column; } .ztc-dashboard .ztc-network-overview { grid-template-columns:1fr; gap:14px; } .ztc-dashboard .ztc-network-actions { justify-content:flex-start; } .ztc-dashboard .ztc-actions { justify-content:flex-start; } }',
		'@media (max-width: 720px) { .ztc-dashboard .ztc-filterbar { grid-template-columns:1fr; } }',
		'@media (max-width: 560px) { .ztc-dashboard .ztc-hero { padding:18px; } .ztc-dashboard .ztc-brandmark, .ztc-dashboard .ztc-count { display:none; } .ztc-dashboard .ztc-card { padding:14px; } .ztc-dashboard .ztc-filterfield { align-items:stretch; flex-direction:column; gap:5px; } }'
	].join('\n');
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		return Promise.all([
			callStatus().catch(function(err) {
				return { online: false, controller: false, error: err.message || String(err) };
			}),
			callListNetworks().catch(function(err) {
				return { networks: [], error: err.message || String(err) };
			})
		]);
	},

	render: function(data) {
		var status = data[0] || {};
		var networksData = data[1] || {};
		var controllerReady = status.controller === true && status.databaseReady !== false;
		var controllerProblem = (status.error || status.controllerError) ? rpcErrorMessage(status) :
			(networksData.error ? rpcErrorMessage(networksData) : null);
		if (status.controllerHttpStatus === 404)
			controllerProblem = _('This ZeroTier build does not include the embedded Controller API.') + ' (HTTP 404)';

		var networks = Array.isArray(networksData) ? networksData :
			(networksData && Array.isArray(networksData.networks) ? networksData.networks : []);
		networks = networks.map(function(network) {
			var id = (typeof network === 'string') ? network : (network.id || network.nwid || '');
			return {
				id: id,
				name: (typeof network === 'object' && network) ? String(network.name || '') : ''
			};
		}).filter(function(network) {
			return /^[0-9a-f]{16}$/i.test(network.id);
		});
		var activeNwid = networks.length > 0 ? networks[0].id : null;
		var self = this;

		var storageWarning = null;
		if (status.storageWritable === false) {
			storageWarning = _('Warning: ZeroTier storage directory is not writable. Controller configuration changes cannot be saved.');
		} else if (status.tokenPresent === false) {
			storageWarning = _('Warning: ZeroTier authtoken.secret not found. Controller API authentication failed.');
		} else if (status.freeSpaceBytes !== undefined && status.freeSpaceBytes >= 0 && status.freeSpaceBytes < 1048576) {
			storageWarning = _('Warning: Low storage space on ZeroTier data directory (less than 1 MB available).');
		}

		var viewContainer = E('div', { 'class': 'cbi-map ztc-dashboard' }, [
			E('style', {}, [ dashboardStyles() ]),
			E('div', { 'id': 'ztc-notifications', 'class': 'ztc-toast-stack', 'aria-live': 'polite' }),
			E('div', { 'class': 'ztc-hero' }, [
				E('div', { 'class': 'ztc-hero-main' }, [
					E('div', { 'class': 'ztc-brandmark', 'aria-hidden': 'true' }, [ 'ZT' ]),
					E('div', { 'class': 'ztc-controller-copy' }, [
						E('h2', {}, [ _('ZeroTier Controller') ]),
						E('p', {}, [ _('Self-hosted network, member and route management for this router.') ]),
						E('div', { 'class': 'ztc-controller-meta' }, [
							E('span', { 'class': 'ztc-controller-label' }, [ _('Controller node') + ':' ]),
							E('strong', { 'class': 'ztc-node-id ztc-code' }, [ status.address || _('Unavailable') ]),
							E('span', { 'class': 'ztc-version' }, [ status.version ? 'v' + status.version : '' ])
						]),
						controllerProblem ? E('p', { 'class': 'ztc-error' }, [ controllerProblem ]) : ''
					])
				]),
				E('div', { 'class': 'ztc-controller-side' }, [
					E('span', { 'class': 'ztc-count' }, [ networks.length, ' ', networks.length === 1 ? _('network') : _('networks') ]),
					E('div', { 'class': 'ztc-status-pills' }, [
						E('span', { 'class': 'ztc-pill ' + (status.online === true ? 'ztc-pill-success' : 'ztc-pill-warning') }, [
							status.online === true ? _('Node Online') : _('Node Offline')
						]),
						E('span', { 'class': 'ztc-pill ' + (controllerReady ? 'ztc-pill-success' : 'ztc-pill-danger') }, [
							controllerReady ? _('Controller Active') : _('Controller Unavailable')
						])
					])
				])
			]),
			storageWarning ? E('div', { 'class': 'alert-message danger', 'style': 'margin:0 0 16px 0;' }, [ storageWarning ]) : '',
			E('div', { 'class': 'ztc-layout' }, [
				E('aside', { 'class': 'ztc-sidebar' }, [
					E('div', { 'class': 'cbi-section ztc-card' }, [
						E('h3', {}, [ _('Managed Networks') ]),
						E('div', { 'id': 'network-list-box' }, [
							networks.length === 0 ?
								E('p', { 'class': 'ztc-empty ztc-empty-small' }, [ _('No networks created yet.') ]) :
								E('ul', { 'class': 'ztc-network-list' }, networks.map(function(network) {
									return E('li', {}, [
										E('button', {
											'class': 'btn cbi-button-action ztc-network-button' + (network.id === activeNwid ? ' is-active' : ''),
											'data-nwid': network.id,
											'click': function(ev) {
												ev.preventDefault();
												self.loadNetworkDetails(network.id);
											}
										}, [
											E('span', { 'class': 'ztc-network-name' }, [ network.name || _('Unnamed Network') ]),
											E('span', { 'class': 'ztc-network-id ztc-code' }, [ network.id ])
										])
									]);
								}))
						])
					]),
					E('div', { 'id': 'sidebar-network-tools' }),
					E('div', { 'class': 'cbi-section ztc-card' }, [
						E('h3', {}, [ _('Create Network') ]),
						E('div', { 'class': 'ztc-sidebar-form' }, [
							E('div', {}, [
								E('label', { 'for': 'new-net-name' }, [ _('Network Name:') ]),
								E('input', { 'type': 'text', 'id': 'new-net-name', 'class': 'ztc-full', 'placeholder': _('Network Name') })
							]),
							E('div', {}, [
								E('label', { 'for': 'new-net-cidr' }, [ _('Network CIDR:') ]),
								E('input', { 'type': 'text', 'id': 'new-net-cidr', 'class': 'ztc-full ztc-code', 'placeholder': '10.16.0.0/24' })
							]),
							E('button', {
								'class': 'btn cbi-button-save ztc-full',
								'disabled': controllerReady ? null : 'disabled',
								'click': function(ev) {
									ev.preventDefault();
									var nameInput = document.getElementById('new-net-name');
									var cidrInput = document.getElementById('new-net-cidr');
									var name = String(nameInput && nameInput.value || '').trim() || 'new_network';
									var parsed = parseIPv4CIDR(cidrInput && cidrInput.value);
									if (!parsed) {
										showNotification(_('Enter a valid IPv4 CIDR using a prefix between /8 and /30.'), 'warning');
										return;
									}
									return callCreateNetwork(name, parsed.cidr).then(requireRpcResult).then(function(res) {
										var nwid = res.nwid || res.id;
										if (!nwid)
											throw new Error(_('Controller did not return a network ID'));
										showNotification(_('Created network: ') + nwid, 'success');
										window.setTimeout(function() { window.location.reload(); }, 700);
									}).catch(handleRpcError);
								}
							}, [ _('Create New Network') ])
						])
					]),
					E('div', { 'class': 'cbi-section ztc-card' }, [
						E('h3', {}, [ _('Import JSON Backup') ]),
						E('div', { 'class': 'cbi-value ztc-field' }, [
							E('input', { 'type': 'file', 'id': 'backup-file-input', 'class': 'ztc-full ztc-stack-input', 'accept': '.json' }),
							E('select', { 'id': 'backup-mode-select', 'class': 'ztc-full ztc-stack-input' }, [
								E('option', { 'value': 'restore' }, [ _('Restore (overwrite, keep original network ID)') ]),
								E('option', { 'value': 'migrate' }, [ _('Migrate (new network ID on this controller)') ])
							]),
							E('button', {
								'class': 'btn cbi-button-action ztc-full',
								'disabled': controllerReady ? null : 'disabled',
								'click': function(ev) {
									ev.preventDefault();
									var fileInput = document.getElementById('backup-file-input');
									var modeSelect = document.getElementById('backup-mode-select');
									var mode = (modeSelect && modeSelect.value === 'migrate') ? 'migrate' : 'restore';
									if (!fileInput.files || !fileInput.files[0]) {
										showNotification(_('Please select a JSON backup file.'), 'warning');
										return;
									}
									var file = fileInput.files[0];
									if (file.size > 2097152) {
										showNotification(_('Backup file is too large (maximum 2 MB allowed).'), 'warning');
										return;
									}
									var reader = new FileReader();
									reader.onload = function(e) {
										callImportBackup(e.target.result, mode).then(requireRpcResult).then(function(res) {
											if (!res.restored || !res.nwid)
												throw new Error(_('Controller did not return a network ID'));
											var message = (res.mode === 'migrate') ?
												_('Backup migrated to new network %s (from %s).').format(res.nwid, res.source_nwid || res.nwid) :
												_('Network backup restored successfully.') + ' (' + res.nwid + ')';
											showNotification(message, 'success');
											window.setTimeout(function() { window.location.reload(); }, 700);
										}).catch(handleRpcError);
									};
									reader.readAsText(fileInput.files[0]);
								}
							}, [ _('Import Backup') ]),
							E('p', { 'class': 'ztc-help' }, [
								_('Restore keeps the original network ID and only works on the controller that created the backup. Migrate imports the backup as a new network under this controller.')
							])
						])
					])
				]),
				E('div', { 'id': 'main-network-panel' }, [
					E('div', { 'class': 'ztc-empty' }, [
						E('p', {}, [ _('Select a network from the sidebar to view members and configuration.') ])
					])
				])
			])
		]);

		if (activeNwid) {
			window.setTimeout(function() {
				self.loadNetworkDetails(activeNwid);
			}, 100);
		}

		return viewContainer;
	},

	loadNetworkDetails: function(nwid, onlineOnlyParam) {
		var panel = document.getElementById('main-network-panel');
		var sidebarTools = document.getElementById('sidebar-network-tools');
		if (!panel)
			return;

		if (this.isRefreshing && this.activeNwid === nwid && onlineOnlyParam === undefined)
			return;

		this.isRefreshing = true;
		this.activeNwid = nwid;

		var statusFilterSelect = document.getElementById('status-filter-select');
		var onlineOnly = (onlineOnlyParam !== undefined) ? onlineOnlyParam :
			(statusFilterSelect ? statusFilterSelect.value === 'online' : true);

		var refreshBtn = document.getElementById('ztc-refresh-btn');
		if (refreshBtn) {
			refreshBtn.disabled = true;
			refreshBtn.textContent = _('Refreshing...');
		}

		document.querySelectorAll('.ztc-network-button').forEach(function(button) {
			button.classList.toggle('is-active', button.getAttribute('data-nwid') === nwid);
		});

		if (!panel.firstChild || !panel.querySelector('.ztc-network-overview')) {
			panel.innerHTML = '';
			panel.appendChild(E('div', { 'class': 'ztc-empty ztc-empty-small' }, [ _('Loading network details for ') + nwid + '...' ]));
		}

		var self = this;
		return Promise.all([
			callGetNetworkInfo(nwid),
			callListMembers(nwid, onlineOnly)
		]).then(function(res) {
			self.isRefreshing = false;
			var netInfo = requireRpcResult(res[0]);
			var membersRes = requireRpcResult(res[1]);
			var membersMap = (membersRes && membersRes.members) ? membersRes.members : {};
			var peersMap = (membersRes && Array.isArray(membersRes.peers)) ? membersRes.peers : [];
			var peerConnections = {};
			var now = Date.now();
			peersMap.forEach(function(peer) {
				if (peer && peer.address)
					peerConnections[String(peer.address).toLowerCase()] = peerConnectionInfo(peer, now);
			});

			var members = Array.isArray(membersMap) ? membersMap :
				(membersMap && typeof membersMap === 'object' ? Object.keys(membersMap).map(function(key) { return membersMap[key]; }) : []);

			if (sidebarTools) {
				sidebarTools.innerHTML = '';
				sidebarTools.appendChild(self.renderSidebarNetworkTools(nwid, netInfo));
			}
			panel.innerHTML = '';
			panel.appendChild(self.renderDashboardContent(nwid, netInfo, members, peerConnections));
			self.filterMembersTable();
		}).catch(function(err) {
			self.isRefreshing = false;
			var btn = document.getElementById('ztc-refresh-btn');
			if (btn) {
				btn.disabled = false;
				btn.textContent = _('Refresh');
			}
			panel.innerHTML = '';
			panel.appendChild(E('div', { 'class': 'alert-message warning' }, [ rpcErrorMessage({ error: err.message || String(err) }) ]));
		});
	},

	renderSidebarNetworkTools: function(nwid, netInfo) {
		var self = this;
		var poolInfo = managedPoolInfo(netInfo);
		var currentPoolCidr = poolInfo.cidr;
		var currentPool = poolInfo.parsed;

		return E('div', { 'class': 'cbi-section ztc-card' }, [
			E('h3', {}, [ _('Managed IPv4 Pool') ]),
			E('div', { 'class': 'ztc-sidebar-form' }, [
				E('div', {}, [
					E('label', { 'for': 'ip-pool-cidr' }, [ _('Network CIDR:') ]),
					E('input', {
						'type': 'text',
						'id': 'ip-pool-cidr',
						'value': currentPoolCidr,
						'placeholder': '10.16.0.0/24',
						'class': 'ztc-full ztc-code',
						'input': function(ev) {
							var preview = document.getElementById('ip-pool-preview');
							var parsed = parseIPv4CIDR(ev.target.value);
							if (preview) {
								preview.textContent = parsed ?
									_('Network: %s · Assignable: %s - %s').format(parsed.cidr, parsed.start, parsed.end) :
									_('Enter a valid IPv4 CIDR using a prefix between /8 and /30.');
							}
						}
					})
				]),
				E('div', { 'class': 'ztc-sidebar-preview', 'id': 'ip-pool-preview' }, [
					currentPool ?
						_('Network: %s · Assignable: %s - %s').format(currentPool.cidr, currentPool.start, currentPool.end) :
						_('No managed IPv4 pool is configured.')
				]),
				E('button', {
					'class': 'btn cbi-button-save ztc-full',
					'click': function(ev) {
						ev.preventDefault();
						var input = document.getElementById('ip-pool-cidr');
						var parsed = parseIPv4CIDR(input && input.value);
						if (!parsed) {
							showNotification(_('Enter a valid IPv4 CIDR using a prefix between /8 and /30.'), 'warning');
							return;
						}
						return callUpdateIPPool(nwid, parsed.cidr, currentPoolCidr)
							.then(requireRpcResult)
							.then(function(res) {
								showNotification(_('IP pool updated to ') + (res.cidr || parsed.cidr), 'success');
								self.loadNetworkDetails(nwid);
							})
							.catch(handleRpcError);
					}
				}, [ _('Save IP Pool') ])
			]),
			E('p', { 'class': 'ztc-help' }, [
				_('Changing the pool updates its direct managed route. Existing member IP assignments are kept until changed manually or reassigned by the Controller.')
			])
		]);
	},

	renderDashboardContent: function(nwid, netInfo, members, peerConnections) {
		var self = this;
		var pool = (netInfo.ipAssignmentPools || [])[0] || null;
		var routes = netInfo.routes || [];

		return E('div', { 'class': 'ztc-network-content' }, [
			E('div', { 'class': 'cbi-section ztc-card ztc-network-overview' }, [
				renderNetworkQRCode(nwid),
				E('div', { 'class': 'ztc-network-info' }, [
					E('h3', { 'class': 'ztc-heading-reset' }, [ netInfo.name || _('Unnamed Network') ]),
					E('span', { 'class': 'ztc-subtitle ztc-code' }, [ nwid ]),
					E('span', { 'class': 'ztc-subtitle' }, [
						_('IP Pool: '), pool ? (pool.ipRangeStart + ' - ' + pool.ipRangeEnd) : _('None')
					]),
					E('span', { 'class': 'ztc-qr-desc' }, [
						_('Scan with the ZeroTier app to join this network.')
					])
				]),
				E('div', { 'class': 'ztc-network-actions' }, [
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function(ev) {
							ev.preventDefault();
							return callExportBackup(nwid).then(requireRpcResult).then(function(backupData) {
								var blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
								var a = document.createElement('a');
								var objectUrl = window.URL.createObjectURL(blob);
								a.href = objectUrl;
								a.download = 'zt-backup-' + nwid + '.json';
								document.body.appendChild(a);
								a.click();
								a.remove();
								window.setTimeout(function() { window.URL.revokeObjectURL(objectUrl); }, 1000);
							}).catch(handleRpcError);
						}
					}, [ _('Export Backup (JSON)') ])
				])
			]),
			E('div', { 'class': 'cbi-section ztc-card' }, [
				E('div', { 'class': 'ztc-overview ztc-card-heading' }, [
					E('h3', { 'class': 'ztc-heading-reset' }, [ _('Network Members ('), members.length, ')' ]),
					E('div', { 'class': 'ztc-actions' }, [
						E('button', {
							'id': 'ztc-refresh-btn',
							'class': 'btn cbi-button-neutral',
							'click': function(ev) {
								ev.preventDefault();
								self.loadNetworkDetails(nwid);
							}
						}, [ _('Refresh') ])
					])
				]),
				E('div', { 'class': 'ztc-filterbar' }, [
					E('div', { 'class': 'ztc-filterfield' }, [
						E('label', { 'for': 'status-filter-select' }, [ _('Status:') ]),
						E('select', {
							'id': 'status-filter-select',
							'change': function(ev) {
								self.statusFilter = ev.target.value;
								var isOnlineOnly = self.statusFilter === 'online';
								self.loadNetworkDetails(nwid, isOnlineOnly);
							}
						}, [
							E('option', { 'value': 'online', 'selected': (self.statusFilter || 'online') === 'online' ? 'selected' : null }, [ _('Online Only') ]),
							E('option', { 'value': 'all', 'selected': self.statusFilter === 'all' ? 'selected' : null }, [ _('All Members') ]),
							E('option', { 'value': 'offline', 'selected': self.statusFilter === 'offline' ? 'selected' : null }, [ _('Offline Only') ])
						])
					]),
					E('div', { 'class': 'ztc-filterfield ztc-filterfield-grow' }, [
						E('label', {}, [ _('Search:') ]),
						E('input', { 'type': 'text', 'id': 'member-search-input', 'class': 'ztc-full', 'placeholder': _('Search Node ID, Name, or IP...'), 'keyup': this.filterMembersTable.bind(this) })
					])
				]),
				E('div', { 'class': 'ztc-member-wrap' }, [
					E('table', { 'class': 'ztc-members-table', 'id': 'members-table' }, [
						E('colgroup', {}, [
							E('col', { 'class': 'ztc-member-node-col' }),
							E('col', { 'class': 'ztc-member-name-col' }),
							E('col', { 'class': 'ztc-member-ip-col' }),
							E('col', { 'class': 'ztc-member-connection-col' }),
							E('col', { 'class': 'ztc-member-latency-col' }),
							E('col', { 'class': 'ztc-member-status-col' }),
							E('col', { 'class': 'ztc-member-action-col' })
						]),
						E('thead', {}, [
							E('tr', {}, [
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 0) }, [ _('Node ID') ]),
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 1) }, [ _('Name / Note') ]),
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 2) }, [ _('Assigned IP') ]),
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 3) }, [ _('Connection') ]),
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 4) }, [ _('Latency') ]),
								E('th', { 'class': 'ztc-table-sort', 'click': this.sortMembersTable.bind(this, 5) }, [ _('Status') ]),
								E('th', {}, [ _('Actions') ])
							])
						]),
						E('tbody', { 'id': 'members-tbody' }, members.map(function(member) {
							var memberId = String(member.id || '').toLowerCase();
							var isController = memberId === nwid.substring(0, 10).toLowerCase();
							var connection = isController ?
								{ online: true, mode: 'local', latency: -1 } :
								(peerConnections[memberId] || { online: false, mode: 'offline', latency: -1 });
							var modeLabel = { direct: 'DIRECT', relay: 'RELAY', local: 'LOCAL', offline: 'OFFLINE' }[connection.mode] || 'OFFLINE';
							var latencyLabel = connection.online && connection.latency >= 0 ? connection.latency + ' ms' : '—';

							return E('tr', {
								'data-online': connection.online ? 'true' : 'false',
								'data-search': (memberId + ' ' + (member.name || '') + ' ' + (member.ipAssignments || []).join(' ') + ' ' + modeLabel).toLowerCase()
							}, [
								E('td', { 'class': 'ztc-member-id ztc-code', 'title': memberId }, [ memberId ]),
								E('td', {}, [
									E('input', {
										'type': 'text',
										'value': member.name || '',
										'placeholder': _('Set Name'),
										'change': function(ev) {
											callRenameMember(nwid, memberId, ev.target.value).then(requireRpcResult).catch(handleRpcError);
										}
									})
								]),
								E('td', {}, [
									E('input', {
										'type': 'text',
										'class': 'ztc-code',
										'value': (member.ipAssignments || []).join(', '),
										'placeholder': _('e.g. 10.x.y.z'),
										'change': function(ev) {
											var ips = ev.target.value.split(',').map(function(value) { return value.trim(); }).filter(Boolean);
											callChangeMemberIP(nwid, memberId, ips).then(requireRpcResult).catch(handleRpcError);
										}
									})
								]),
								E('td', {}, [
									E('span', { 'class': 'ztc-link-mode ztc-link-' + connection.mode }, [ modeLabel ])
								]),
								E('td', { 'class': 'ztc-latency-cell', 'data-sort': String(connection.latency) }, [ latencyLabel ]),
								E('td', {}, [
									E('span', { 'class': 'ztc-auth-badge ' + (member.authorized ? 'ztc-auth-authorized' : 'ztc-auth-pending') }, [
										member.authorized ? _('Authorized') : _('Pending')
									])
								]),
								E('td', {}, [
									E('div', { 'class': 'ztc-member-actions' }, [
										E('button', {
											'class': (member.authorized ? 'btn cbi-button-reset' : 'btn cbi-button-save') + ' ztc-member-button',
											'title': member.authorized ? _('Deauth') : _('Authorize'),
											'click': function(ev) {
												ev.preventDefault();
												return callAuthorizeMember(nwid, memberId, !member.authorized).then(requireRpcResult).then(function() {
													self.loadNetworkDetails(nwid);
												}).catch(handleRpcError);
											}
										}, [ member.authorized ? _('Deauth') : _('Authorize') ]),
										E('button', {
											'class': 'btn cbi-button-remove ztc-member-button',
											'title': _('Delete'),
											'disabled': isController ? 'disabled' : null,
											'click': function(ev) {
												ev.preventDefault();
												if (confirm(_('Delete member ') + memberId + '?')) {
													return callDeleteMember(nwid, memberId).then(requireRpcResult).then(function() {
														self.loadNetworkDetails(nwid);
													}).catch(handleRpcError);
												}
											}
										}, [ _('Delete') ])
									])
								])
							]);
						})),
						E('tfoot', {}, [
							E('tr', { 'class': 'ztc-member-editor' }, [
								E('td', {}, [
									E('label', { 'for': 'add-nodeid' }, [ _('Node ID (10 chars):') ]),
									E('input', { 'type': 'text', 'id': 'add-nodeid', 'class': 'ztc-code', 'placeholder': 'bab1e61f17', 'maxlength': 10 })
								]),
								E('td', {}, [
									E('label', { 'for': 'add-name' }, [ _('Name / Note:') ]),
									E('input', { 'type': 'text', 'id': 'add-name', 'placeholder': _('Optional') })
								]),
								E('td', {}, [
									E('label', { 'for': 'add-ip' }, [ _('Preassigned IP (Optional):') ]),
									E('input', { 'type': 'text', 'id': 'add-ip', 'class': 'ztc-code', 'placeholder': pool ? pool.ipRangeStart : _('e.g. 10.x.y.z') })
								]),
								E('td', { 'class': 'ztc-member-editor-note', 'colspan': 3 }, [
									E('strong', {}, [ _('Add Member Manually') ]),
									E('span', {}, [ _('Name and IP are optional. The member is authorized immediately.') ])
								]),
								E('td', {}, [
									E('label', { 'class': 'ztc-editor-action-label', 'aria-hidden': 'true' }, [ _('Actions') ]),
									E('button', {
										'class': 'btn cbi-button-save ztc-member-add-button',
										'click': function(ev) {
											ev.preventDefault();
											var nodeid = String(document.getElementById('add-nodeid').value || '').trim().toLowerCase();
											var name = String(document.getElementById('add-name').value || '').trim();
											var ip = String(document.getElementById('add-ip').value || '').trim();
											if (!/^[0-9a-f]{10}$/.test(nodeid)) {
												showNotification(_('Node ID must be 10 hexadecimal characters.'), 'warning');
												return;
											}
											if (ip && ipv4ToNumber(ip) === null) {
												showNotification(_('Enter a valid IPv4 address.'), 'warning');
												return;
											}
											return callAuthorizeMember(nwid, nodeid, true)
												.then(requireRpcResult)
												.then(function() {
													var updates = [];
													if (name)
														updates.push(callRenameMember(nwid, nodeid, name).then(requireRpcResult));
													if (ip)
														updates.push(callChangeMemberIP(nwid, nodeid, [ ip ]).then(requireRpcResult));
													return Promise.all(updates);
												})
												.then(function() {
													showNotification(_('Member added and authorized.'), 'success');
													self.loadNetworkDetails(nwid);
												})
												.catch(handleRpcError);
										}
									}, [ _('Add & Authorize') ])
								])
							])
						])
					])
				]),
			]),
			E('div', { 'class': 'cbi-section ztc-card' }, [
				E('h3', {}, [ _('Routes Configuration') ]),
				E('div', { 'class': 'ztc-route-wrap' }, [
					E('table', { 'class': 'ztc-route-table' }, [
						E('colgroup', {}, [
							E('col', { 'class': 'ztc-route-target-col' }),
							E('col', { 'class': 'ztc-route-via-col' }),
							E('col', { 'class': 'ztc-route-action-col' })
						]),
						E('thead', {}, [
							E('tr', {}, [
								E('th', {}, [ _('Target CIDR') ]),
								E('th', {}, [ _('Via Gateway') ]),
								E('th', {}, [ _('Action') ])
							])
						]),
						E('tbody', {}, routes.length ? routes.map(function(route) {
							return E('tr', {}, [
								E('td', { 'class': 'ztc-code' }, [ route.target ]),
								E('td', { 'class': route.via ? 'ztc-code' : '' }, [ route.via || _('Direct') ]),
								E('td', {}, [
									E('button', {
										'class': 'btn cbi-button-remove ztc-route-button',
										'click': function(ev) {
											ev.preventDefault();
											return callDelRoute(nwid, route.target).then(requireRpcResult).then(function() {
												self.loadNetworkDetails(nwid);
											}).catch(handleRpcError);
										}
									}, [ _('Delete Route') ])
								])
							]);
						}) : [
							E('tr', {}, [ E('td', { 'class': 'ztc-route-empty', 'colspan': 3 }, [ _('No routes configured.') ]) ])
						]),
						E('tfoot', {}, [
							E('tr', { 'class': 'ztc-route-editor' }, [
								E('td', {}, [
									E('label', { 'for': 'route-target' }, [ _('Target CIDR:') ]),
									E('input', { 'type': 'text', 'id': 'route-target', 'class': 'ztc-code', 'placeholder': 'e.g. 10.10.0.0/24' })
								]),
								E('td', {}, [
									E('label', { 'for': 'route-via' }, [ _('Via Gateway (Optional):') ]),
									E('input', { 'type': 'text', 'id': 'route-via', 'class': 'ztc-code', 'placeholder': 'e.g. 10.121.15.1' })
								]),
								E('td', {}, [
									E('label', { 'class': 'ztc-route-action-label', 'aria-hidden': 'true' }, [ _('Action') ]),
									E('button', {
										'class': 'btn cbi-button-save ztc-route-button',
										'click': function(ev) {
											ev.preventDefault();
											var target = String(document.getElementById('route-target').value || '').trim();
											var via = String(document.getElementById('route-via').value || '').trim();
											if (!target) {
												showNotification(_('Target CIDR is required.'), 'warning');
												return;
											}
											return callAddRoute(nwid, target, via).then(requireRpcResult).then(function() {
												self.loadNetworkDetails(nwid);
											}).catch(handleRpcError);
										}
									}, [ _('Add Route') ])
								])
							])
						])
					])
				])
			])
		]);
	},

	filterMembersTable: function() {
		var statusFilter = document.getElementById('status-filter-select');
		var searchInput = document.getElementById('member-search-input');
		if (!statusFilter || !searchInput)
			return;

		var filterVal = statusFilter.value;
		var searchVal = searchInput.value.toLowerCase().trim();
		document.querySelectorAll('#members-tbody tr').forEach(function(row) {
			var isOnline = row.getAttribute('data-online') === 'true';
			var searchData = row.getAttribute('data-search') || '';
			var matchesStatus = filterVal === 'all' || (filterVal === 'online' && isOnline) || (filterVal === 'offline' && !isOnline);
			row.style.display = matchesStatus && searchData.indexOf(searchVal) !== -1 ? '' : 'none';
		});
	},

	sortMembersTable: function(colIdx) {
		var tbody = document.getElementById('members-tbody');
		if (!tbody)
			return;

		var dir = (this.sortColumn === colIdx && this.sortDirection !== -1) ? -1 : 1;
		this.sortColumn = colIdx;
		this.sortDirection = dir;

		// Editable columns render <input> elements whose values are invisible
		// to textContent; cells may also carry an explicit data-sort key.
		function cellKey(row) {
			var cell = row.children[colIdx];
			if (!cell)
				return '';
			if (cell.hasAttribute('data-sort'))
				return cell.getAttribute('data-sort');
			var input = cell.querySelector('input');
			return String(input ? input.value : cell.textContent).trim().toLowerCase();
		}

		var numericPattern = /^-?\d+(\.\d+)?$/;
		var rows = Array.from(tbody.querySelectorAll('tr'));
		rows.sort(function(a, b) {
			var valA = cellKey(a);
			var valB = cellKey(b);
			var result = (numericPattern.test(valA) && numericPattern.test(valB)) ?
				(parseFloat(valA) - parseFloat(valB)) :
				valA.localeCompare(valB);
			return dir * result;
		});
		rows.forEach(function(row) { tbody.appendChild(row); });
	}
});
