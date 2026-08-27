/* SPDX-License-Identifier: GPL-3.0-only
 *
 * Copyright (C) 2022 ImmortalWrt.org
 */

'use strict';
'require fs';
'require ui';
'require view';

return view.extend({
	load: function() {
		return fs.exec('/sbin/ifconfig').then(function(res) {
			if (res.code !== 0 || !res.stdout || res.stdout.trim() === '') {
				ui.addNotification(null, E('p', {}, _('Unable to get interface info: %s.').format(
					String(res.stderr || '').trim() || _('unknown error'))));
				return [];
			}

			var interfaces = res.stdout.match(/zt[a-z0-9]+/g);
			if (!interfaces || interfaces.length === 0)
				return [];

			interfaces = Array.from(new Set(interfaces));
			return Promise.all(interfaces.map(function(name) {
				return fs.exec('/sbin/ifconfig', [ name ]);
			})).then(function(results) {
				return results.map(function(result, index) {
					if (result.code !== 0 || !result.stdout || result.stdout.trim() === '') {
						ui.addNotification(null, E('p', {},
							_('Unable to get interface %s info: %s.').format(interfaces[index],
								String(result.stderr || '').trim() || _('unknown error'))));
						return null;
					}

					var output = result.stdout.trim();
					var mac = output.match(/(?:HWaddr|ether)\s+([0-9a-f:]{17})/i);
					var ipv4 = output.match(/inet (?:addr:)?\s*([0-9.]+)/);
					var ipv6 = output.match(/inet6 (?:addr:)?\s*([0-9a-f:]+)/i);
					var mtu = output.match(/MTU(?::|\s)(\d+)/i);
					var rx = output.match(/RX bytes(?::|\s)(\d+)(?:\s+\(([^)]+)\))?/i);
					var tx = output.match(/TX bytes(?::|\s)(\d+)(?:\s+\(([^)]+)\))?/i);

					return {
						name: interfaces[index],
						mac: mac ? mac[1] : '-',
						ipv4: ipv4 ? ipv4[1] : '-',
						ipv6: ipv6 ? ipv6[1] : '-',
						mtu: mtu ? mtu[1] : '-',
						rxBytes: rx ? (rx[2] || rx[1] + ' B') : '-',
						txBytes: tx ? (tx[2] || tx[1] + ' B') : '-'
					};
				}).filter(Boolean);
			});
		});
	},

	render: function(data) {
		var title = E('h2', { 'class': 'content' }, _('ZeroTier'));
		var description = E('div', { 'class': 'cbi-map-descr' },
			_('ZeroTier is an open source, cross-platform and easy to use virtual LAN.'));

		if (!Array.isArray(data) || data.length === 0)
			return E('div', {}, [ title, description, E('div', { 'class': 'alert-message notice' }, _('No interface online.')) ]);

		var cards = data.map(function(info) {
			return E('div', { 'class': 'cbi-section', 'style': 'margin-bottom:16px' }, [
				E('h3', {}, [ _('Network Interface Information'), ': ', info.name ]),
				E('table', { 'class': 'table' }, [
					[ _('Interface Name'), info.name ],
					[ _('MAC Address'), info.mac ],
					[ _('IPv4 Address'), info.ipv4 ],
					[ _('IPv6 Address'), info.ipv6 ],
					[ _('MTU'), info.mtu ],
					[ _('Total Download'), info.rxBytes ],
					[ _('Total Upload'), info.txBytes ]
				].map(function(row) {
					return E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left', 'width': '32%' }, row[0]),
						E('td', { 'class': 'td left' }, row[1])
					]);
				}))
			]);
		});

		return E('div', {}, [ title, description ].concat(cards));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
