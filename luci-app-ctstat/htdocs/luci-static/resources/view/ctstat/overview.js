'use strict';
'require view';
'require fs';
'require poll';
'require ui';
'require uci';

function fmtBytes(n) {
	n = +n || 0;
	if (n < 1024) return n + ' B';
	if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
	if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
	if (n < 1099511627776) return (n / 1073741824).toFixed(2) + ' GB';
	return (n / 1099511627776).toFixed(2) + ' TB';
}

function fmtRate(bytes, iv) {
	iv = +iv || 3;
	return fmtBytes((+bytes || 0) / iv) + '/s';
}

function call(args) {
	return fs.exec('/usr/libexec/ctstat-call', args).then(function(r) {
		return (r && r.stdout) ? r.stdout : '';
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			call(['status']).catch(function() { return '{}'; }),
			call(['info']).catch(function() { return '{}'; }),
			uci.load('ctstat').catch(function() { })
		]);
	},

	render: function(data) {
		this.status = {};
		this.info = {};
		try { this.status = JSON.parse(data[0] || '{}'); } catch (e) { }
		try { this.info = JSON.parse(data[1] || '{}'); } catch (e) { }

		var self = this;

		this.tbody = E('tbody', {}, []);
		this.sumNodes = {
			clients: E('span', { 'class': 'ctstat-num' }, '0'),
			down: E('span', { 'class': 'ctstat-num' }, '0 B'),
			up: E('span', { 'class': 'ctstat-num' }, '0 B'),
			rate: E('span', { 'class': 'ctstat-num' }, '0 B/s'),
			updated: E('span', { 'class': 'ctstat-dim' }, '—')
		};

		var card = function(label, node, color) {
			return E('div', { 'class': 'ctstat-card', 'style': 'flex:1;min-width:150px' }, [
				E('div', { 'class': 'ctstat-card-label', 'style': 'color:' + color }, label),
				node
			]);
		};

		var view = E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [
				'.ctstat-card{background:var(--background-color-medium,#f8f9fa);border-radius:8px;padding:14px 16px;box-shadow:0 1px 2px rgba(0,0,0,.06)}',
				'.ctstat-card-label{font-size:12px;letter-spacing:.02em;margin-bottom:6px;opacity:.85}',
				'.ctstat-num{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}',
				'.ctstat-dim{font-size:12px;opacity:.6}',
				'.ctstat-grid{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 16px}',
				'.ctstat-tbl{width:100%;border-collapse:collapse;font-size:13px}',
				'.ctstat-tbl th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-color-medium,#ddd);font-weight:600;white-space:nowrap;cursor:pointer;user-select:none}',
				'.ctstat-tbl td{padding:7px 10px;border-bottom:1px solid var(--border-color-low,#eee);font-variant-numeric:tabular-nums;white-space:nowrap}',
				'.ctstat-tbl tr:hover td{background:var(--background-color-high,#f0f4ff)}',
				'.ctstat-mono{font-family:monospace;font-size:12px;opacity:.75}',
				'.ctstat-bar{height:4px;border-radius:2px;background:linear-gradient(90deg,#7b9cff,#4d6bfe);margin-top:4px}',
				'@media (max-width:700px){.ctstat-hide-sm{display:none}}'
			].join('')),

			E('h2', {}, '客户端流量统计'),
			E('p', { 'class': 'ctstat-dim', 'style': 'margin-top:-6px' },
				'基于 conntrack 计数，NSS/ECM 硬件加速下由 NSS 回写，统计准确。'),

			E('div', { 'class': 'ctstat-grid' }, [
				card('在线客户端', this.sumNodes.clients, '#4d6bfe'),
				card('今日下行', this.sumNodes.down, '#e8562a'),
				card('今日上行', this.sumNodes.up, '#2e9e5b'),
				card('当前速率', this.sumNodes.rate, '#8b5cf6')
			]),

			E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' }, [
				E('div', {}, [
					E('input', {
						'type': 'text', 'placeholder': '筛选主机 / IP / MAC',
						'class': 'cbi-input-text', 'style': 'width:240px',
						'input': function(ev) { self.filter = ev.target.value.trim().toLowerCase(); self.paint(); }
					})
				]),
				E('div', {}, [
					E('span', { 'class': 'ctstat-dim', 'style': 'margin-right:12px' }, [ '更新于 ', this.sumNodes.updated ]),
					E('button', {
						'class': 'cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, 'handleReset')
					}, '清零累计')
				])
			]),

			E('div', { 'style': 'overflow-x:auto' }, [
				E('table', { 'class': 'ctstat-tbl' }, [
					E('thead', {}, [
						E('tr', {}, [
							E('th', {}, '主机'),
							E('th', {}, 'IP'),
							E('th', { 'class': 'ctstat-hide-sm' }, 'MAC'),
							E('th', { 'click': function() { self.setSort('day_down'); } }, '今日下行 ▾'),
							E('th', {}, '今日上行'),
							E('th', {}, '总下行'),
							E('th', {}, '总上行'),
							E('th', {}, '实时速率')
						])
					]),
					this.tbody
				])
			]),

			this.renderSettings(),
			this.renderDiag()
		]);

		this.paint();

		poll.add(L.bind(function() {
			if (document.hidden) return Promise.resolve();
			return this.refresh();
		}, this), +uci.get('ctstat', 'config', 'refresh') || 5);

		return view;
	},

	setSort: function(k) {
		this.sortKey = k;
		this.paint();
	},

	paint: function() {
		var st = this.status || {};
		var list = (st.clients || []).slice();
		var iv = +st.interval || 3;
		var f = (this.filter || '');
		var key = this.sortKey || 'day_down';

		var pick = function(c) {
			if (!f) return true;
			return ((c.host || '') + ' ' + (c.ip || '') + ' ' + (c.mac || '')).toLowerCase().indexOf(f) >= 0;
		};
		list = list.filter(pick);

		list.sort(function(a, b) {
			var x = (+a[key] || 0), y = (+b[key] || 0);
			if (x === y) return (+b.day_down || 0) - (+a.day_down || 0);
			return y - x;
		});

		var totD = 0, totU = 0, totR = 0;
		list.forEach(function(c) {
			totD += +c.day_down || 0;
			totU += +c.day_up || 0;
			totR += +c.rate_down || 0;
		});

		this.sumNodes.clients.textContent = String(list.length);
		this.sumNodes.down.textContent = fmtBytes(totD);
		this.sumNodes.up.textContent = fmtBytes(totU);
		this.sumNodes.rate.textContent = fmtRate(totR, iv);
		this.sumNodes.updated.textContent = st.ts
			? new Date(st.ts * 1000).toLocaleTimeString()
			: '—';

		var maxD = 1;
		list.forEach(function(c) { if ((+c.day_down || 0) > maxD) maxD = +c.day_down; });

		var rows = list.map(function(c) {
			var w = Math.max(2, Math.round((+c.day_down || 0) / maxD * 100));
			var rate = (+c.rate_down || 0) + (+c.rate_up || 0);
			return E('tr', {}, [
				E('td', {}, [ c.host && c.host !== '-' ? c.host : E('span', { 'class': 'ctstat-dim' }, '未知') ]),
				E('td', { 'class': 'ctstat-mono' }, c.ip || ''),
				E('td', { 'class': 'ctstat-mono ctstat-hide-sm' }, c.mac || '-'),
				E('td', {}, [
					E('div', {}, fmtBytes(c.day_down)),
					E('div', { 'class': 'ctstat-bar', 'style': 'width:' + w + '%' })
				]),
				E('td', {}, fmtBytes(c.day_up)),
				E('td', { 'class': 'ctstat-dim' }, fmtBytes(c.down)),
				E('td', { 'class': 'ctstat-dim' }, fmtBytes(c.up)),
				E('td', {}, rate > 0 ? fmtRate(rate, iv) : E('span', { 'class': 'ctstat-dim' }, '空闲'))
			]);
		});

		if (!rows.length) {
			rows.push(E('tr', {}, [
				E('td', { 'colspan': 8, 'style': 'text-align:center;padding:28px;opacity:.6' },
					'暂无数据。请确认 ctstat 服务已启动，且 LAN 网段配置正确。')
			]));
		}

		this.tbody.innerHTML = '';
		rows.forEach(function(r) { this.tbody.appendChild(r); }, this);
	},

	refresh: function() {
		var self = this;
		return call(['status']).then(function(s) {
			try { self.status = JSON.parse(s || '{}'); } catch (e) { }
			self.paint();
		}).catch(function() { });
	},

	renderSettings: function() {
		var self = this;
		this.inInterval = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100px',
			'value': uci.get('ctstat', 'config', 'interval') || '3'
		});
		this.inLan = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'style': 'width:260px',
			'placeholder': '留空自动探测',
			'value': uci.get('ctstat', 'config', 'lan_prefix') || ''
		});
		this.inEnable = E('input', {
			'type': 'checkbox',
			'checked': uci.get('ctstat', 'config', 'enabled') !== '0'
		});

		return E('div', { 'class': 'cbi-section', 'style': 'margin-top:24px' }, [
			E('h3', {}, '设置'),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, '启用采集'),
				E('div', { 'class': 'cbi-value-field' }, this.inEnable)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, '采样间隔（秒）'),
				E('div', { 'class': 'cbi-value-field' }, [
					this.inInterval,
					E('div', { 'class': 'ctstat-dim' }, '越小越准，越大越省 CPU。建议 3–5 秒。')
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, 'LAN 网段'),
				E('div', { 'class': 'cbi-value-field' }, [
					this.inLan,
					E('div', { 'class': 'ctstat-dim' }, '多个用空格分隔，如 192.168.3.1/24 10.0.0.1/8。留空自动探测 br-* 接口。')
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-save',
					'click': ui.createHandlerFn(this, 'handleSave')
				}, '保存并应用')
			])
		]);
	},

	renderDiag: function() {
		var i = this.info || {};
		var row = function(k, v, good) {
			return E('div', { 'style': 'display:flex;gap:12px;padding:4px 0' }, [
				E('span', { 'class': 'ctstat-dim', 'style': 'width:190px' }, k),
				E('span', { 'style': 'font-family:monospace' + (good === true ? ';color:#2e9e5b' : good === false ? ';color:#e8562a' : '') }, String(v))
			]);
		};
		return E('div', { 'class': 'cbi-section', 'style': 'margin-top:20px' }, [
			E('h3', {}, '运行诊断'),
			row('服务进程', i.running && i.running !== 'no' ? 'PID ' + i.running : '未运行', !!(i.running && i.running !== 'no')),
			row('conntrack 记账 (acct)', i.conntrack_acct, i.conntrack_acct === '1'),
			row('conntrack 条目数', i.conntrack_entries),
			row('ECM 加速阈值', i.ecm_accel_delay),
			row('ECM 加速连接数', i.ecm_connections),
			row('当前 LAN 网段', i.lan_prefix || '(自动)')
		]);
	},

	handleSave: function() {
		var iv = parseInt(this.inInterval.value, 10);
		if (!(iv >= 1 && iv <= 60)) {
			ui.addNotification(null, E('p', {}, '采样间隔需在 1–60 秒之间'), 'warning');
			return;
		}
		uci.set('ctstat', 'config', 'interval', String(iv));
		uci.set('ctstat', 'config', 'lan_prefix', this.inLan.value.trim());
		uci.set('ctstat', 'config', 'enabled', this.inEnable.checked ? '1' : '0');
		return uci.save().then(function() {
			return uci.commit('ctstat');
		}).then(function() {
			return fs.exec('/etc/init.d/ctstat', [ 'restart' ]);
		}).then(function() {
			ui.addNotification(null, E('p', {}, '已保存并重启采集服务'), 'info');
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, '保存失败：' + e), 'error');
		});
	},

	handleReset: function() {
		var self = this;
		return ui.showModal('清零累计', [
			E('p', {}, '将清零所有客户端的历史累计与今日统计。连接基线会保留，不会重复计算已发生的流量。'),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, '取消'),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, function() {
						return call(['reset']).then(function() {
							ui.hideModal();
							return self.refresh();
						});
					})
				}, '确认清零')
			])
		]);
	}
});
