'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require uci';

// 解析 /tmp/wechatpush/usage.db（CSV 表头: no,ip,mac,in,out,total,used）
// in = 今日下载，out = 今日上传，total = 今日总计。文件不存在或为空时返回空映射。
function parseUsageDb(raw) {
	var map = {};
	if (!raw) return map;
	var lines = raw.split('\n');
	if (lines.length < 2) return map;
	var header = lines[0].split(',');
	var macIdx = header.indexOf('mac');
	var inIdx = header.indexOf('in');
	var outIdx = header.indexOf('out');
	var totalIdx = header.indexOf('total');
	if (macIdx < 0) return map;
	for (var i = 1; i < lines.length; i++) {
		var cols = lines[i].split(',');
		if (cols.length <= macIdx) continue;
		var mac = (cols[macIdx] || '').trim().toLowerCase();
		if (!mac || mac === 'mac') continue;
		var vin = inIdx >= 0 ? (parseInt(cols[inIdx], 10) || 0) : 0;
		var vout = outIdx >= 0 ? (parseInt(cols[outIdx], 10) || 0) : 0;
		var vtotal = totalIdx >= 0 ? (parseInt(cols[totalIdx], 10) || 0) : (vin + vout);
		map[mac] = { in: vin, out: vout, total: vtotal };
	}
	return map;
}

function formatTraffic(bytes) {
	var value = parseInt(bytes, 10);
	if (!value || value <= 0) return '0';
	var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	var i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value = value / 1024;
		i++;
	}
	var digits = i === 0 ? 0 : (value >= 100 ? 0 : (value >= 10 ? 1 : 2));
	return value.toFixed(digits) + ' ' + units[i];
}

return view.extend({
	load: function () {
		var self = this;
		// 清除 localStorage 中的排序设置
		localStorage.removeItem('sortColumn');
		localStorage.removeItem('sortDirection');
		uci.load('wechatpush');
		return this.fetchAndRenderDevices().then(function () {
			self.setupAutoRefresh();
		});
	},

	fetchAndRenderDevices: function () {
		var self = this;
		return this.fetchDevices().then(function (data) {
			var container = self.render(data);
			self.switchContent(container);
		}).catch(function (error) {
			console.error('Error fetching or rendering devices:', error);
		});
	},

	fetchDevices: function () {
		var devices_path = '/tmp/wechatpush/devices.json';
		var usage_path = '/tmp/wechatpush/usage.db';
		return Promise.all([
			fs.read(devices_path),
			fs.read(usage_path).catch(function () { return ''; })
		]).then(function (res) {
			try {
				var data = JSON.parse(res[0]);
				var wlanMap = {};
				var usageMap = parseUsageDb(res[1] || '');

				// 如果存在无线接口信息，解析为频段
				if (data.wlan && Array.isArray(data.wlan)) {
					data.wlan.forEach(function (wlan) {
						wlanMap[wlan.interface] = wlan.band;
					});
				}

				// 解析设备的接口信息，并附加今日流量
				data.devices.forEach(function (device) {
					if (device.type) {
						device.interface = device.type;
					} else if (wlanMap[device.interface]) {
						device.interface = wlanMap[device.interface];
					} else {
						device.interface = "LAN";
					}
					var traffic = usageMap[(device.mac || '').toLowerCase()];
					if (traffic) {
						device.traffic_in = traffic.in;
						device.traffic_out = traffic.out;
						device.traffic_total = traffic.total;
					}
				});
				return { devices: data.devices };
			} catch (e) {
				console.error('Error parsing JSON:', e);
				return { devices: [] };
			}
		});
	},

	render: function (data) {
		if (!data || !data.devices || !Array.isArray(data.devices)) {
			return document.createElement('div');
		}
		var devices = data.devices.filter(device => device.status === 'online' || device.status === 'unknown');
		var totalDevices = devices.length;
		var headers = [_('Hostname'), _('IPv4 address'), _('MAC address'), _('Interfaces'), _('Connection Point'), _('Online time'), _('Download'), _('Upload'), _('Details')];
		var columns = ['name', 'ip', 'mac', 'interface', 'parent', 'uptime', 'traffic_in', 'traffic_out', 'usage'];
		var visibleColumns = [];
		var hasData = false;

		// 获取配置中的默认排序列
		var defaultSortColumn = uci.get('wechatpush', 'config', 'defaultSortColumn') || 'ip';
		var defaultSortDirection = (defaultSortColumn === 'uptime') ? 'desc' : 'asc';

		// 获取存储的排序设置，如果没有则使用默认设置
		var storedSortColumn = localStorage.getItem('sortColumn');
		var storedSortDirection = localStorage.getItem('sortDirection');

		var currentSortColumn = storedSortColumn || defaultSortColumn;
		var currentSortDirection = storedSortDirection || defaultSortDirection;

		devices.sort(function (a, b) {
			return compareDevices(a, b, currentSortColumn, currentSortDirection);
		});

		// 根据数据源决定可见列
		for (var i = 0; i < columns.length; i++) {
			var column = columns[i];
			var hasColumnData = false;

			// 特殊处理 parent 列
			if (column === 'parent') {
				var hasNonLocalParent = false;
				for (var j = 0; j < devices.length; j++) {
					var parentValue = devices[j][column];
					if (parentValue && parentValue !== "Local") {
						hasNonLocalParent = true;
						break;
					}
				}
				// 如果存在非 "Local" 的 parent 值，则显示该列
				if (hasNonLocalParent) {
					visibleColumns.push(i);
				}
			} else {
				// 其他列的正常逻辑
				for (var j = 0; j < devices.length; j++) {
					if (devices[j][column] !== undefined && devices[j][column] !== '') {
						hasColumnData = true;
						hasData = true;
						break;
					}
				}
				if (hasColumnData) {
					visibleColumns.push(i);
				}
			}
		}

		var style = `
			/* 设备表格样式 */
			.device-table {
				width: 80%; /* 表格宽度占满父容器 */
				border-collapse: collapse; /* 合并边框 */
				margin-top: 10px; /* 顶部外边距 */
				box-shadow: 0 0 10px rgba(0, 0, 0, 0.1); /* 阴影效果 */
				border-radius: 8px; /* 圆角边框 */
				overflow: hidden; /* 内容溢出隐藏 */
			}

			.device-table th,
			.device-table td {
				padding: 10px; /* 单元格内边距 */
				text-align: center; /* 文本居中 */
				border: 1px solid #ddd; /* 边框样式 */
			}

			.device-table th {
				background-color: rgba(0, 0, 0, 0.05); /* 表头背景色，透明 */
				font-weight: bold; /* 粗体字体 */
				cursor: pointer; /* 鼠标指针样式为指针 */
				position: relative; /* 相对定位 */
			}

			.device-table th.sortable::after {
				right: 10px; /* 右侧距离 */
				top: 50%; /* 顶部偏移50% */
				transform: translateY(-50%); /* 垂直居中 */
				border-width: 5px 5px 0; /* 边框宽度 */
				border-style: solid; /* 边框样式为实线 */
				opacity: 0.6; /* 透明度 */
			}

			.device-table th.asc::after {
				content: '';
				position: absolute;
				right: 10px;
				top: 50%;
				transform: translateY(-50%);
				border-width: 6px;
				border-style: solid;
				border-color: #666 transparent transparent transparent; /* 向上箭头颜色 */
			}

			.device-table th.desc::after {
				content: '';
				position: absolute;
				right: 10px;
				top: 50%;
				transform: translateY(-50%);
				border-width: 6px;
				border-style: solid;
				border-color: transparent transparent #666 transparent; /* 向下箭头颜色 */
			}

			.device-table tbody tr:nth-child(even) {
				background-color: rgba(0, 0, 0, 0.05); /* 偶数行背景色，透明 */
			}

			.device-table td:first-child {
				text-align: left; /* 第一列文本左对齐 */
				padding-left: 20px; /* 第一列左侧内边距 */
			}

			.device-table td a {
				color: #007bff; /* 链接颜色 */
				text-decoration: none; /* 去掉下划线 */
			}

			.device-table td a:hover {
				text-decoration: underline; /* 鼠标悬停下划线 */
			}

			.device-table .hide {
				display: none; /* 隐藏元素 */
			}

			@media (max-width: 767px) {
				.device-table {
					width: 100%; /* 表格宽度占满父容器 */
					overflow: hidden; /* 内容溢出隐藏 */
				}
				.device-table th,
				.device-table td {
					padding: 3px; /* 单元格内边距 */
					text-align: center; /* 文本居中 */
					border: 0.35px solid #ddd; /* 边框样式 */
				}
				.device-table td:first-child {
					max-width: 80px;
				}
				.device-table td:first-child {
					text-align: left; /* 第一列文本左对齐 */
					padding-left: 2px; /* 第一列左侧内边距 */
					overflow: hidden; /* 隐藏溢出内容 */
					text-overflow: ellipsis; /* 显示省略号 */
				}
				/* 隐藏特定列 */
				.device-table th[data-column="parent"],
				.device-table td[data-column="parent"],
				.device-table th[data-column="traffic_out"],
				.device-table td[data-column="traffic_out"] {
					display: none;
				}
				/* 隐藏接口列的文本部分 */
				.device-table td[data-column="interface"] span:not(.iface-icon) {
					display: none;
				}
				/* 调整图标样式 */
				.device-table td[data-column="interface"] .iface-icon {
					margin-right: 0; /* 去掉图标右侧的间距 */
				}
			}
		`;

		function createTable() {
			var table = document.createElement('table');
			table.classList.add('device-table');

			var thead = document.createElement('thead');
			var tr = document.createElement('tr');

			for (var i = 0; i < headers.length; i++) {
				var th = document.createElement('th');
				th.textContent = headers[i];

				if (visibleColumns.includes(i)) {
					th.classList.add('sortable');
					th.dataset.column = columns[i];
					if (columns[i] === currentSortColumn) {
						th.classList.add(currentSortDirection === 'asc' ? 'asc' : 'desc');
					}
				} else {
					th.classList.add('hide');
				}

				tr.appendChild(th);
			}

			thead.appendChild(tr);
			table.appendChild(thead);

			var tbody = document.createElement('tbody');
			devices.forEach(function (device) {
				var row = document.createElement('tr');
				for (var i = 0; i < columns.length; i++) {
					if (visibleColumns.includes(i)) {
						var cell = document.createElement('td');
						cell.dataset.column = columns[i];
						if (columns[i] === 'uptime') {
							cell.textContent = calculateUptime(device['uptime'], window.innerWidth <= 767);
						} else if (columns[i] === 'ip' && device['http_access']) {
							var link = document.createElement('a');
							link.href = `${device['http_access']}://${device['ip']}`;
							link.textContent = device['ip'];
							link.target = '_blank';
							cell.appendChild(link);
						} else if (columns[i] === 'interface') {
							var icon = document.createElement('span');
							icon.classList.add('iface-icon');
							if (device['interface'] === '2.4G') {
								icon.innerHTML = '📶';
							} else if (device['interface'] === '5G') {
								icon.innerHTML = '🛜';
							} else if (device['interface'] === 'WiFi') {
								icon.innerHTML = '🛜';
							}

							var text = document.createElement('span');
							text.textContent = device['interface'];

							cell.appendChild(icon);
							cell.appendChild(text);
						} else if (columns[i] === 'traffic_in' || columns[i] === 'traffic_out') {
							var trafficBytes = parseInt(device[columns[i]], 10) || 0;
							cell.textContent = formatTraffic(trafficBytes);
							if (trafficBytes > 0)
								cell.title = trafficBytes + ' B';
						} else if (columns[i] === 'parent') {
							if (device['parent']) {
								var parentDevice = devices.find(d => {
									// 统一转换为大写比较
									var deviceMac = (d.mac || '').toUpperCase();
									var parentMac = (device['parent'] || '').toUpperCase();
									return deviceMac === parentMac || d.ip === device['parent'];
								});
								if (parentDevice) {
									cell.textContent = parentDevice.name || parentDevice.ip;
								} else {
									cell.textContent = device['parent'];
								}
							} else {
								cell.textContent = '';
							}
						} else {
							cell.textContent = device[columns[i]];
						}
						row.appendChild(cell);
					}
				}
				tbody.appendChild(row);
			});

			table.appendChild(tbody);

			return table;
		}

		function calculateUptime(uptime, simpleFormat = false) {
			var startTimeStamp = parseInt(uptime);
			var currentTimeStamp = Math.floor(Date.now() / 1000);
			var uptimeInSeconds = currentTimeStamp - startTimeStamp;

			var days = Math.floor(uptimeInSeconds / (3600 * 24));
			var hours = Math.floor((uptimeInSeconds % (3600 * 24)) / 3600);
			var minutes = Math.floor((uptimeInSeconds % 3600) / 60);
			var seconds = uptimeInSeconds % 60;

			if (simpleFormat) {
				return days > 0 ? `${days}d ${hours}h` :
					   hours > 0 ? `${hours}h ${minutes}m` :
					   minutes > 0 ? `${minutes}m ${seconds}s` :
					   `${seconds}s`;
			} else {
				if (days > 0) {
					return _('%dd %dh').replace(/%d/g, match => 
						match === '%d' ? days : hours);
				} else if (hours > 0) {
					return _('%dh %dm').replace(/%d/g, match => 
						match === '%d' ? hours : minutes);
				} else if (minutes > 0) {
					return _('%dm %ds').replace(/%d/g, match => 
						match === '%d' ? minutes : seconds);
				} else {
					return _('%ds').replace('%d', seconds);
				}
			}
		}

		function compareDevices(a, b, column, direction) {
			var value1 = getValueForSorting(a, column);
			var value2 = getValueForSorting(b, column);

			// 处理 name/mac 列的 "unknown" 优先级
			if (column === 'name' || column === 'mac') {
				const isUnknown1 = (value1 === "unknown");
				const isUnknown2 = (value2 === "unknown");

				if (isUnknown1 !== isUnknown2) {
					return direction === 'asc' 
						// 升序时 unknown 排最后（视为最大值），降序时排最前
						//? (isUnknown1 ? 1 : -1)
						//: (isUnknown1 ? -1 : 1);
						// 升序时 unknown 排最前（视为最小值）
						? (isUnknown1 ? -1 : 1)
						: (isUnknown1 ? 1 : -1);
				}
			}

			// 处理 parent 列的优先级
			if (column === 'parent') {
				const aHasValue = a.parent ? 1 : 0;
				const bHasValue = b.parent ? 1 : 0;
				if (aHasValue !== bHasValue) {
					return direction === 'desc' 
						? (bHasValue - aHasValue) 
						: (aHasValue - bHasValue);
				}
				value1 = a.parent || '';
				value2 = b.parent || '';
			}

			// 通用比较逻辑
			if (value1 < value2) {
				return direction === 'asc' ? -1 : 1;
			} else if (value1 > value2) {
				return direction === 'asc' ? 1 : -1;
			}
			return 0;
		}

		var interfaceDisplayMap = {
			'2.4G': '2.4G',
			'5G': '5G',
			'WiFi': 'WiFi'
		};

		// 排序
		function getValueForSorting(device, column) {
			if (column === 'uptime') {
				return parseInt(device['uptime']);
			} else if (column === 'ip') {
				return ipToNumber(device['ip']);
			} else if (column === 'interface') {
				return interfaceDisplayMap[device['interface']] || 'LAN';
			} else if (column === 'traffic_in' || column === 'traffic_out') {
				return parseInt(device[column], 10) || 0;
			} else if (column === 'parent') {
				// 使用 parent 列的实际显示值进行排序
				if (device['parent']) {
					var parentDevice = devices.find(d => {
						var deviceMac = (d.mac || '').toUpperCase();
						var parentMac = (device['parent'] || '').toUpperCase();
						return deviceMac === parentMac || d.ip === device['parent'];
					});
					if (parentDevice) {
						return parentDevice.name || parentDevice.ip;
					} else {
						return device['parent'];
					}
				} else {
					return '';
				}
			}
			return device[column];
		}

		function ipToNumber(ipAddress) {
			var parts = ipAddress.split('.');
			var number = 0;

			for (var i = 0; i < parts.length; i++) {
				number = number * 256 + parseInt(parts[i]);
			}

			return number;
		}

		var container = document.createElement('div');
		refreshContainer();

		container.addEventListener('click', function (event) {
			if (event.target.tagName === 'TH' && event.target.parentNode.rowIndex === 0) {
				var columnIndex = event.target.cellIndex;
				var column = columns[columnIndex];
				var direction = 'asc';

				// 使在线时间第一次点击方向为倒序
				if (column === 'uptime' || column === 'parent') {
					if (currentSortColumn !== column) {
						// 首次点击该列，默认方向为 desc
						direction = 'desc';
					} else {
						// 切换方向
						direction = currentSortDirection === 'desc' ? 'asc' : 'desc';
					}
				} else if (column === currentSortColumn) {
					direction = currentSortDirection === 'asc' ? 'desc' : 'asc';
				} else {
					direction = 'asc';
				}

				sortTable(column, direction);
			}
		});

		function refreshContainer() {
			container.innerHTML = '';
			container.appendChild(document.createElement('h2')).textContent = _('Currently %s devices online').replace('%s', totalDevices);
			container.appendChild(createTable());
			container.appendChild(document.createElement('style')).textContent = style;
		}

		function sortTable(column, direction) {
			devices.sort(function (a, b) {
				return compareDevices(a, b, column, direction);
			});

			currentSortColumn = column;
			currentSortDirection = direction;

			// 存储排序设置
			localStorage.setItem('sortColumn', currentSortColumn);
			localStorage.setItem('sortDirection', currentSortDirection);

			refreshContainer();
		}

		return container;
	},

	setupAutoRefresh: function () {
		var self = this;
		poll.add(L.bind(function () {
			self.fetchAndRenderDevices();
		}));
	},

	switchContent: function (newContent) {
		var existingContainer = document.querySelector('#view');
		if (!existingContainer) {
			console.error('Table container not found.');
			return;
		}
		existingContainer.innerHTML = '';
		existingContainer.appendChild(newContent);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});