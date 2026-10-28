'use strict';
'require view';
'require uci';
'require gately/common';

var C   = gately_common;
var api = {
    info:        C.rpc('get_system_info'),
    updChk:      C.rpc('get_upstream_version', ['release_type', 'arch']),
    updStat:     C.rpc('get_update_status'),
    updDo:       C.rpc('do_update',            ['tag', 'filename']),
    autoLog:     C.rpc('get_auto_update_log',  ['type']),
    cleanUpdate: C.rpc('clean_update'),
    saveSettings: C.rpc('save_settings',
        ['release_type', 'github_mirror',
         'auto_update', 'update_interval'])
};

var $    = function(id) { return document.getElementById(id); };
var ucig = function(k) { return uci.get('gately', 'gately', k); };

function buildInfoGrid() {
    var items = [
        [_('Gately Version'), 'ii_ver'],  [_('Release Tag'), 'ii_tag'],
        [_('LuCI Version'),  'ii_luci'], [_('Commit'),      'ii_commit'],
        [_('Architecture'),  'ii_arch'], [_('Build Date'),  'ii_build'],
        [_('Binary Path'),   'ii_bin'],  [_('Data Dir'),    'ii_cfg']
    ];
    return C.buildCard(_('Current Installation'),
        C.buildInfoTiles(items, 150, true), { icon: 'info' });
}

function buildSettingsCard() {
    var chkSel = E('select', { id: 'set_channel', class: 'gately-select', style: 'min-width:140px;' }, [
        E('option', { value: 'stable' },     _('Stable')),
        E('option', { value: 'prerelease' }, _('Include pre-release'))
    ]);
    chkSel.value = ucig('release_type') || 'stable';

    var mirrorInput = E('input', {
        type: 'text',
        id: 'set_mirror',
        class: 'gately-input',
        placeholder: _('e.g. https://ghfast.top/'),
        style: 'flex:1;min-width:200px;',
        value: ucig('github_mirror') || ''
    });

    var saveBtn = E('button', {
        type: 'button',
        class: 'gately-btn gately-btn-primary',
        click: function() {
            saveBtn.disabled = true;

            var autoEl  = document.getElementById('_f_auto_update');
            var ivEl    = document.getElementById('_f_update_interval');

            var relType = chkSel.value;
            var mirror  = mirrorInput.value.trim();
            var auto    = (autoEl && autoEl.checked) ? '1' : '0';
            var interval= (ivEl && ivEl.value) ? ivEl.value : '7';

            L.resolveDefault(api.saveSettings(
                relType, mirror, auto, interval), {}
            ).then(function(res) {
                saveBtn.disabled = false;
                var ok = res && res.result === 'ok';
                C.showToast({
                    ok: ok,
                    title: ok ? _('Saved') : _('Save failed'),
                    msg: ok
                        ? _('Update settings saved.')
                        : C.saveMessage(res),
                    timeout: ok ? 2000 : 0
                });
            }).catch(function() {
                saveBtn.disabled = false;
                C.showToast({
                    ok: false,
                    title: _('Save failed'),
                    msg: _('Request failed, please try again.'),
                    timeout: 0
                });
            });
        }
    }, [C.icon('check', 14), E('span', {}, _('Save'))]);

    return C.buildCard(_('Update Settings'), [
        C.buildFormRow('custom', 'set_channel_row', _('Release Channel'),
            null,
            _('Include pre-release versions (rc) when checking'),
            chkSel),
        C.buildFormRow('custom', 'set_mirror_row', _('GitHub Acceleration Mirror'),
            null,
            E('span', {}, [
                _('If checking times out (rc=28, cannot reach github.com), fill a GitHub proxy prefix and save. Leave empty for direct connection.'), E('br'),
                _('Common prefix ends with /, e.g. https://ghfast.top/')
            ]),
            mirrorInput),
        C.buildFormRow('toggle', 'auto_update', _('Enable Auto Update'),
            ucig('auto_update') || '0',
            _('Periodically check and install the latest version')),
        C.buildFormRow('number', 'update_interval', _('Check Interval (days)'),
            ucig('update_interval') || '7',
            _('Range: 1 – 365 days'),
            { style: 'width:80px;', min: '1', max: '365' }),
        E('div', { class: 'gately-banner-row', style: 'justify-content:flex-end;' }, saveBtn)
    ], { icon: 'gear' });
}

function buildUpdateSection(t, title, iconKey, chkLabel, self) {
    return C.buildCard(title, [
        E('div', { class: 'gately-banner-row' }, [
            E('button', {
                type: 'button',
                class: 'gately-btn gately-btn-primary',
                id: t + '_chk',
                click: function() { self._chk(t); }
            }, [C.icon('refresh', 14), E('span', {}, chkLabel)]),
            E('span', { id: t + '_stat', class: 'gately-state' },
                _('Click to check for updates'))
        ]),
        E('div', { id: t + '_sels', class: 'gately-sels', style: 'display:none;' }, [
            E('label', { class: 'gately-inline-label' }, _('Version:')),
            E('select', { id: t + '_tag', class: 'gately-select gately-select--tag', change: function() { self._sel(t); } }),
            E('label', { class: 'gately-inline-label' }, _('File:')),
            E('select', { id: t + '_file', class: 'gately-select gately-select--file' }),
            E('button', {
                type: 'button',
                class: 'gately-btn gately-btn-success',
                id: t + '_do',
                click: function() { self._do(t); }
            }, [C.icon('download', 14), E('span', {}, _('Install Now'))])
        ]),
        E('div', { id: t + '_bar_wrap', style: 'display:none;' },
            [C.buildBar(t + '_bar', 'progress')]),
        E('pre', { id: t + '_log', class: 'gately-log' })
    ], { icon: iconKey });
}

function showAutoLog(type) {
    L.resolveDefault(api.autoLog(type), {}).then(function(res) {
        var el = $('auto_log');
        if (!el) return;
        el.textContent = (res && res.log) ? res.log : _('(No log)');
        el.classList.add('is-open');
        el.scrollTop = el.scrollHeight;
    });
}

return view.extend({
    handleSave: null,
    handleSaveApply: null,
    handleReset: null,

    load: function() {
        return uci.load('gately');
    },

    render: function() {
        var self = this;

        var content = E('div', { class: 'cbi-map gately-page' }, [
            E('h2', {}, _('Gately — Download & Update')),
            buildInfoGrid(),
            buildSettingsCard(),
            buildUpdateSection('upd', _('Gately Core Update'), 'download',
                _('Check Upstream'), self),
            C.buildCard(_('Auto Update Log'), [
                E('div', { class: 'gately-banner-row' }, [
                    E('button', {
                        type: 'button',
                        class: 'gately-btn gately-btn-primary',
                        click: function() { showAutoLog(''); }
                    }, [C.icon('clock', 14), E('span', {}, _('Auto Update Log'))]),
                    E('button', {
                        type: 'button',
                        class: 'gately-btn gately-btn-primary',
                        click: function() { showAutoLog('run'); }
                    }, [C.icon('info', 14), E('span', {}, _('Runtime Log'))]),
                    E('button', {
                        type: 'button',
                        class: 'gately-btn gately-btn-danger',
                        click: function() {
                            var doClean = function() {
                                L.hideModal();
                                L.resolveDefault(api.cleanUpdate(), {}).then(function(res) {
                                    var ok = res && res.result === 'ok';
                                    ['upd_log', 'auto_log'].forEach(function(id) {
                                        var e = $(id);
                                        if (e) { e.textContent = ''; e.classList.remove('is-open'); }
                                    });
                                    C.showToast({
                                        ok:      ok,
                                        title:   ok ? _('Done') : _('Failed'),
                                        msg:     ok ? _('Cache cleared.') : _('Clear failed.'),
                                        timeout: ok ? 2000 : 0
                                    });
                                });
                            };

                            var cancelBtn = E('button', {
                                type: 'button',
                                class: 'gately-btn',
                                click: function() { L.hideModal(); }
                            }, [E('span', {}, _('Cancel'))]);

                            var okBtn = E('button', {
                                type: 'button',
                                class: 'gately-btn gately-btn-danger',
                                click: doClean
                            }, [C.icon('trash', 14), E('span', {}, _('Clear'))]);

                            L.showModal(_('Clear Cache'), [
                                E('div', { class: 'gately-modal' }, [
                                    E('div', { class: 'gately-modal-head gately-modal-head--danger' }, [
                                        C.icon('trash', 20),
                                        E('span', {}, _('Clear all update cache and logs?'))
                                    ]),
                                    E('p', { class: 'gately-modal-note' },
                                        _('This only clears cached downloads and logs, it does not affect the current binary or configuration.')),
                                    E('div', { class: 'gately-modal-actions' }, [cancelBtn, okBtn])
                                ])
                            ]);
                        }
                    }, [C.icon('trash', 14), E('span', {}, _('Clear Cache'))])
                ]),
                E('pre', { id: 'auto_log', class: 'gately-log' })
            ], { icon: 'clock' })
        ]);

        C.initThemeButton();
        this._info();
        return content;
    },

    _chk: function(t) {
        var self = this;
        var btn  = $(t + '_chk');
        if (btn) btn.disabled = true;
        C.setVis(t + '_sels',  false);
        C.setVis(t + '_bar_wrap', false);
        C.setBar(t + '_bar', 0);
        var lg = $(t + '_log');
        if (lg) { lg.textContent = ''; lg.classList.add('is-open'); }
        C.setState(t + '_stat', _('Checking upstream…'), 'busy');

        var reltype = ucig('release_type') || 'stable';
        var arch    = ucig('arch') || 'auto';

        L.resolveDefault(api.updChk(reltype, arch), {}).then(function(res) {
            if (!res || res.result === 'error') {
                if (btn) btn.disabled = false;
                C.setState(t + '_stat', _('Failed to start check'), 'err');
                return;
            }
            self._poll(t, 'chk');
        });
    },

    _do: function(t) {
        var self = this;
        var tag  = ($(t + '_tag')  || {}).value;
        var fn   = ($(t + '_file') || {}).value;
        if (!tag || !fn) {
            C.setState(t + '_stat', _('Please select version and file first'), 'err');
            return;
        }
        var arch = ucig('arch') || 'auto';

        // 确认后真正开始安装
        var proceed = function() {
            L.hideModal();
            var btn = $(t + '_do');
            if (btn) btn.disabled = true;
            C.setVis(t + '_bar_wrap', true);
            C.setBar(t + '_bar', 0);
            var lg = $(t + '_log');
            if (lg) { lg.textContent = ''; lg.classList.add('is-open'); }
            C.setState(t + '_stat', _('Starting…'), 'busy');

            L.resolveDefault(api.updDo(tag, fn), {}).then(function(res) {
                if (!res || res.result !== 'ok') {
                    if (btn) btn.disabled = false;
                    C.setState(t + '_stat', _('Failed to start install'), 'err');
                    return;
                }
                self._poll(t, 'do');
            });
        };

        var kvRow = function(label, val) {
            return E('div', { class: 'gately-modal-kv-row' }, [
                E('span', { class: 'gately-modal-kv-label' }, label),
                E('span', { class: 'gately-modal-kv-val' }, val)
            ]);
        };

        var cancelBtn = E('button', {
            type: 'button',
            class: 'gately-btn',
            click: function() { L.hideModal(); }
        }, [E('span', {}, _('Cancel'))]);

        var okBtn = E('button', {
            type: 'button',
            class: 'gately-btn gately-btn-success',
            click: proceed
        }, [C.icon('download', 14), E('span', {}, _('Confirm Install'))]);

        L.showModal(_('Install Gately'), [
            E('div', { class: 'gately-modal' }, [
                E('div', { class: 'gately-modal-head' }, [
                    C.icon('download', 20),
                    E('span', {}, _('Ready to install Gately %s ?').format(tag))
                ]),
                E('div', { class: 'gately-modal-kv' }, [
                    kvRow(_('Version'), tag),
                    kvRow(_('Architecture'), arch),
                    kvRow(_('Package'), fn)
                ]),
                E('p', { class: 'gately-modal-note' },
                    _('The binary will be replaced and the service restarted.')),
                E('div', { class: 'gately-modal-actions' }, [cancelBtn, okBtn])
            ])
        ]);
    },

    _poll: function(t, phase) {
        var self = this;
        var tk   = t + '_' + phase + '_poller';
        if (self[tk]) self[tk].stop();

        self[tk] = C.LogPoller({
            status:   function() { return api[t + 'Stat'](); },
            textEl:   t + '_log',
            bar:      phase === 'do' ? t + '_bar' : null,
            interval: 1000,
            terminal: phase === 'chk'
                ? function(s) {
                    var code = s.code || s.status;
                    return code === 'ready' || code === 'error';
                }
                : function(s) {
                    var code = s.code || s.status;
                    return code === 'done' || code === 'error';
                },
            onTick: function(s) {
                var code = s.code || s.status;
                if (phase === 'chk') {
                    if (code === 'checking' || code === 'idle')
                        C.setState(t + '_stat', _('Checking upstream…'), 'busy');
                    else if (code === 'ready')
                        C.setState(t + '_stat',
                            _('Found %d version(s)').format(s.count || 0), 'ok');
                    else if (code === 'error')
                        C.setState(t + '_stat', C.taskMessage(s), 'err');
                } else {
                    if (code === 'downloading' || code === 'idle')
                        C.setState(t + '_stat', _('Downloading…'), 'busy');
                    else if (code === 'installing')
                        C.setState(t + '_stat', C.taskMessage(s), 'busy');
                    else if (code === 'done')
                        C.setState(t + '_stat',
                            _('Installation complete: %s').format(s.installed || ''), 'ok');
                    else if (code === 'error')
                        C.setState(t + '_stat', C.taskMessage(s), 'err');
                }
            },
            onDone: function(s) {
                var code = s.code || s.status;
                [t + '_chk', t + '_do'].forEach(function(id) {
                    var e = $(id);
                    if (e) e.disabled = false;
                });

                if (phase === 'chk') {
                    if (code === 'ready' && s.releases) {
                        self['_R' + t] = s.releases;
                        var ts = $(t + '_tag');
                        ts.innerHTML = '';
                        s.releases.forEach(function(r) {
                            ts.appendChild(E('option', { value: r.tag }, r.tag));
                        });
                        self._sel(t);
                        C.setVis(t + '_sels', true, 'flex');
                    }
                } else {
                    if (code === 'done') {
                        C.setBar(t + '_bar', 100);
                        self._info();
                    }
                }
            }
        });
        self[tk].start();
    },

    _sel: function(t) {
        var rels = this['_R' + t] || [];
        var tv   = ($(t + '_tag') || {}).value;
        var fs   = $(t + '_file');
        if (!tv || !fs) return;
        var rel  = rels.filter(function(x) { return x.tag === tv; })[0];
        fs.innerHTML = '';
        fs.disabled = false;
        if (!rel || !rel.files) return;

        var best = 0;
        rel.files.forEach(function(f, i) {
            fs.appendChild(E('option', { value: f.name }, f.name));
            if (f.name === rel.best) best = i;
        });
        fs.selectedIndex = best;
    },

    _info: function() {
        L.resolveDefault(api.info(), {}).then(function(s) {
            if (!s) return;
            [
                ['ii_ver',   s.version      ],
                ['ii_tag',   s.release_tag  ],
                ['ii_luci',  s.luci_version ],
                ['ii_commit',s.commit       ],
                ['ii_arch',  s.arch         ],
                ['ii_build', s.build_date   ],
                ['ii_bin',   s.binpath      ],
                ['ii_cfg',   s.configdir    ]
            ].forEach(function(kv) {
                var e = $(kv[0]);
                if (!e) return;
                e.textContent     = kv[1] || _('Unknown');
                e.style.fontStyle = '';
            });
        });
    }
});
