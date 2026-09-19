(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (!/^https?:$/.test(location.protocol)) return;

    // 日志：manifest 中 content_scripts 先注入 logger.js；异常环境兜底
    if (typeof BPLLog === 'undefined') {
        globalThis.BPLLog = { info() {}, log() {}, warn() {}, error() {}, flush() {}, recent() { return []; } };
    }

    const HOST_ID = 'bpl-ext-host';
    const STORE_KEY = 'bpl_panel';
    const PANEL_URL = chrome.runtime.getURL('src/panel/sidepanel.html');
    // 扩展自身源（如 chrome-extension://abc），用于桥接来源白名单；不用 new URL 以兼容更多环境
    const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/+$/, '');
    const Z = 2147483646;
    const THEME_API = globalThis.BPLTheme || null;
    const THEME_KEY = THEME_API ? THEME_API.STORAGE_KEY : 'bpl_theme';
    const THEME_PICKER_ORDER = ['paper', 'gold', 'jade', 'starry', 'glass', 'clear'];

    let shadow, hostEl, mini, miniPlay, panel, pframe, addBtn, addTxt, collectionBtn, collectionTxt,
        collectionDialog, collectionDialogTitle, collectionDialogCount, collectionTargetName,
        collectionNameInput, collectionRenameCheck, collectionRenamePrefixInput,
        collectionStatus, collectionConfirmBtn, collectionCancelBtn, resizeGrip, themePicker;
    let panelOpen = false;
    let frameLoaded = false;
    let built = false;
    let posX = null, posY = null, panelWidth = null, panelHeight = null;
    let panelXRatio = null, panelYRatio = null, preferredPanelWidth = null, preferredPanelHeight = null;
    let panelPreferenceRevision = 0, panelInteraction = false, pendingPanelPreference = null;
    let collectionProbeBvid = '';
    let collectionProbeAt = 0;
    let collectionProbeInFlight = false;
    let collectionProbePromise = null;
    let collectionProbeToken = 0;
    let collectionSummaryState = null;
    let collectionDialogBvid = '';
    let collectionDialogMode = 'current';
    let collectionActionBusy = false;
    let collectionActionToken = 0;
    const COLLECTION_PROBE_RETRY_MS = 30000;

    const PANEL_MARGIN = 4;
    const PANEL_MIN_WIDTH = 300;
    const PANEL_MIN_HEIGHT = 300;
    function clampPanelGeometry(x, y, width, height, viewportWidth, viewportHeight) {
        const maxWidth = Math.max(1, viewportWidth - PANEL_MARGIN * 2);
        const maxHeight = Math.max(1, viewportHeight - PANEL_MARGIN * 2);
        const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
        const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
        const w = Math.max(minWidth, Math.min(Number(width) || 340, maxWidth));
        const h = Math.max(minHeight, Math.min(Number(height) || 540, maxHeight));
        const left = Math.max(PANEL_MARGIN, Math.min(Number(x) || PANEL_MARGIN, viewportWidth - w - PANEL_MARGIN));
        const top = Math.max(PANEL_MARGIN, Math.min(Number(y) || PANEL_MARGIN, viewportHeight - h - PANEL_MARGIN));
        return { x: left, y: top, width: w, height: h };
    }

    function clampRatio(value, fallback) {
        if (value == null) return fallback;
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(n, 1));
    }

    function panelRatiosFromGeometry(x, y, width, height, viewportWidth, viewportHeight, fallbackX, fallbackY) {
        const g = clampPanelGeometry(x, y, width, height, viewportWidth, viewportHeight);
        const travelX = Math.max(0, viewportWidth - g.width - PANEL_MARGIN * 2);
        const travelY = Math.max(0, viewportHeight - g.height - PANEL_MARGIN * 2);
        return {
            xRatio: travelX > 0
                ? clampRatio((g.x - PANEL_MARGIN) / travelX, 0.5)
                : clampRatio(fallbackX, 0.5),
            yRatio: travelY > 0
                ? clampRatio((g.y - PANEL_MARGIN) / travelY, 0.5)
                : clampRatio(fallbackY, 0.5)
        };
    }

    function panelGeometryFromRatios(xRatio, yRatio, width, height, viewportWidth, viewportHeight) {
        const sized = clampPanelGeometry(PANEL_MARGIN, PANEL_MARGIN, width, height, viewportWidth, viewportHeight);
        const travelX = Math.max(0, viewportWidth - sized.width - PANEL_MARGIN * 2);
        const travelY = Math.max(0, viewportHeight - sized.height - PANEL_MARGIN * 2);
        return {
            x: PANEL_MARGIN + clampRatio(xRatio, 0.5) * travelX,
            y: PANEL_MARGIN + clampRatio(yRatio, 0.5) * travelY,
            width: sized.width,
            height: sized.height
        };
    }

    function isBiliVideo() {
        return /(^|\.)bilibili\.com$/.test(location.hostname) && /^\/video\//.test(location.pathname);
    }

    function getCurrentBvid() {
        if (!isBiliVideo()) return '';
        const match = String(location.pathname || '').match(/^\/video\/(BV[0-9A-Za-z]{10,})(?:\/|$)/);
        return match ? match[1] : '';
    }

    function sendBgRequest(payload, timeout) {
        return new Promise(resolve => {
            let settled = false;
            let timer = null;
            const finish = value => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(value);
            };
            timer = setTimeout(() => finish({ ok: false, error: '后台响应超时，请稍后重试' }), timeout || 15000);
            try {
                chrome.runtime.sendMessage(payload, response => {
                    const lastError = chrome.runtime && chrome.runtime.lastError;
                    if (lastError) {
                        reviveIfDead(lastError);
                        finish({ ok: false, error: String(lastError.message || lastError) });
                        return;
                    }
                    finish(response || { ok: false, error: '后台无响应，请稍后重试' });
                });
            } catch (error) {
                reviveIfDead(error);
                finish({ ok: false, error: String((error && error.message) || error) });
            }
        });
    }

    function formatCollectionError(error) {
        const text = String((error && error.message) || error || '导入失败，请稍后重试');
        if (/quota|QUOTA_BYTES|storage.*(full|limit)|存储.*(空间|上限)/i.test(text)) {
            return '扩展存储空间不足，请清理部分播放列表后重试';
        }
        if (/timeout|超时/i.test(text)) return '网络响应超时，请稍后重试';
        if (/failed to fetch|network|网络/i.test(text)) return '网络请求失败，请检查网络后重试';
        return text.replace(/^Error:\s*/, '');
    }

    // ===================== 音频播放（offscreen 唯一宿主，命令一律经后台转发，无兜底） =====================
    const PLAYER_CMDS = { toggle: 1, next: 1, prev: 1, playIndex: 1, seek: 1, getStatus: 1, stop: 1, setMode: 1, setVolume: 1, setMute: 1, getVolume: 1 };
    const LONG_PLAYER_CMDS = { toggle: 1, next: 1, prev: 1, playIndex: 1 };
    let playerState = { playing: false, hasTrack: false, index: 0, mode: 'loop' };
    let loggedBridgeOrigin = false;
    let loggedBroadcast = false;

    // 失效上下文自愈（v2.2.7）：扩展升级后，升级前就开着的标签页里 content script 的扩展上下文
    // 已永久失效（所有 runtime/storage 调用抛 "Extension context invalidated"，现场日志实锤），
    // 页内无药可救——唯一解是重载本页让新版脚本重新注入。sessionStorage 守卫保证只重载一次，
    // 绝不循环；重载成功（通道复活）后即清除守卫，使下次升级仍可再次自愈。
    function reviveIfDead(err) {
        const msg = String((err && err.message) || err || '');
        if (!/Extension context invalidated/i.test(msg)) return false;
        try {
            if (sessionStorage.getItem('bpl_revive')) return true;
            sessionStorage.setItem('bpl_revive', '1');
        } catch (_) {}
        BPLLog.warn('content', '扩展上下文已失效（疑升级前残留标签页）→ 重载本页一次以复活');
        try { location.reload(); } catch (_) {}
        return true;
    }

    function sendBgPlayer(payload, timeout) {
        return new Promise(res => {
            let done = false;
            const finish = v => { if (!done) { done = true; clearTimeout(t); res(v); } };
            const t = setTimeout(() => finish({ ok: false, error: '后台超时' }), timeout || 15000);
            try {
                chrome.runtime.sendMessage({ target: 'bg', cmd: 'player', payload: payload }, r => {
                    const le = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.lastError : null;
                    if (le) reviveIfDead(le);
                    else if (r) { try { sessionStorage.removeItem('bpl_revive'); } catch (_) {} }
                    finish(r || { ok: false, error: '后台无响应' });
                });
            } catch (e) {
                reviveIfDead(e);
                finish({ ok: false, error: String((e && e.message) || e) });
            }
        });
    }
    // 命令路由：offscreen 是唯一音频宿主（按产品决策放弃一切兜底）。播放命令一律经后台转发给 offscreen 文档。
    function handlePlayerCmd(payload) { return sendBgPlayer(payload, LONG_PLAYER_CMDS[payload && payload.cmd] ? 120000 : 10000); }
    // =================================================================================

    const PLAY_D = 'M8 5v14l11-7z';
    const PAUSE_D = 'M6 5h4v14H6zm8 0h4v14h-4z';

    const CSS =
        '*{box-sizing:border-box}' +
        ':host{--bpl-page:#141517;--bpl-raised:#202024;--bpl-control:#2b2b2f;--bpl-hover:#3a3a3f;' +
        '--bpl-border:#2a2b30;--bpl-border-strong:#3a3a3f;--bpl-border-hover:#55555c;' +
        '--bpl-text:#e8e8e8;--bpl-faint:#747680;--bpl-accent:#fb7299;--bpl-accent-hover:#fc8bab;' +
        '--bpl-accent-soft:#2a2026;--bpl-on-accent:#fff;--bpl-shadow:rgba(0,0,0,.45);' +
        '--bpl-shadow-strong:rgba(0,0,0,.6);--bpl-accent-shadow:rgba(251,114,153,.4);' +
        '--bpl-control-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(0,0,0,.24);' +
        '--bpl-control-active-shadow:inset 0 2px 4px rgba(0,0,0,.24);--bpl-surface-highlight:rgba(255,255,255,.07)}' +
        '.mini,.panel{position:fixed;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'text-shadow:var(--bpl-text-shadow,none)}' +

        '.mini{right:20px;bottom:90px;z-index:' + Z + ';display:flex;align-items:center;justify-content:flex-end;' +
        'width:24px;height:24px;border-radius:12px;background:var(--bpl-control);border:1px solid var(--bpl-border-strong);' +
        'cursor:pointer;user-select:none;overflow:hidden;opacity:.4;' +
        'box-shadow:0 3px 12px var(--bpl-shadow),inset 0 1px 0 var(--bpl-surface-highlight);' +
        'transition:width .36s cubic-bezier(.34,1.56,.64,1),height .36s cubic-bezier(.34,1.56,.64,1),' +
        'border-radius .36s,opacity .22s,background .25s,border-color .25s,box-shadow .3s;' +
        'animation:miniIn .5s cubic-bezier(.34,1.56,.64,1) backwards}' +
        '.mini:hover{opacity:1;border-color:var(--bpl-border-hover)}' +
        '.mini.loaded{width:112px;height:32px;border-radius:16px;opacity:.75;cursor:default;' +
        'background:var(--bpl-mini-bg,var(--bpl-raised))}' +
        '.mini.loaded:hover{opacity:1}' +
        '.mini.playing{opacity:1;border-color:var(--bpl-accent);' +
        'box-shadow:0 3px 18px var(--bpl-accent-shadow),inset 0 1px 0 var(--bpl-surface-highlight)}' +
        '.mini.dragging{transition:none;opacity:1}' +
        '@keyframes miniIn{from{transform:scale(0)}to{transform:scale(1)}}' +

        '.m-controls{display:none;align-items:center;gap:2px;padding-left:6px}' +
        '.mini.loaded .m-controls{display:flex}' +

        '.m-core{flex:none;position:relative;width:24px;height:24px;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;cursor:pointer}' +
        '.mini.loaded .m-core{margin:0 4px 0 2px}' +

        '.m-ico{font-size:12px;color:var(--bpl-accent);line-height:1;transition:opacity .2s}' +
        '.mini.loaded .m-ico{opacity:0}' +

        '.m-spec{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;' +
        'gap:2px;padding:5px 4px 6px;opacity:0;transition:opacity .25s}' +
        '.mini.loaded .m-spec{opacity:1}' +
        '.m-spec i{width:3px;border-radius:1.5px;background:var(--bpl-accent);height:20%;transition:height .25s,background .2s}' +
        '.mini.playing .m-spec i{animation:specB .9s ease-in-out infinite}' +
        '.mini.playing .m-spec i:nth-child(2){animation-delay:.18s}' +
        '.mini.playing .m-spec i:nth-child(3){animation-delay:.36s}' +
        '.mini.playing .m-spec i:nth-child(4){animation-delay:.1s}' +
        '.m-spec:hover i{background:var(--bpl-accent-hover)}' +
        '@keyframes specB{0%,100%{height:18%}50%{height:100%}}' +

        '.m-btn{flex:none;width:24px;height:24px;border:none;border-radius:50%;background:transparent;' +
        'color:var(--bpl-text);cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'transition:background .15s,color .15s,transform .15s}' +
        '.m-btn svg{display:block}' +
        '.m-btn:not(.m-play) svg{filter:var(--bpl-mini-icon-filter,none)}' +
        '.m-btn:not(.m-play) svg path{stroke:var(--bpl-mini-icon-outline,transparent);' +
        'stroke-width:var(--bpl-mini-icon-stroke,0);paint-order:stroke fill}' +
        '.m-btn:hover{background:var(--bpl-hover);color:var(--bpl-text);transform:scale(1.12)}' +
        '.m-btn:active{transform:scale(.86)}' +
        '.m-btn.m-play{background:var(--bpl-accent);color:var(--bpl-on-accent);box-shadow:var(--bpl-control-shadow)}' +
        '.m-btn.m-play:hover{background:var(--bpl-accent-hover)}' +
        '.m-btn.m-play:active{box-shadow:var(--bpl-control-active-shadow)}' +

        '.panel{z-index:' + (Z + 1) + ';width:340px;height:540px;max-width:92vw;' +
        'max-height:calc(100vh - 160px);right:20px;bottom:146px;' +
        'background:var(--bpl-panel-bg,var(--bpl-page-bg,var(--bpl-page)));border:1px solid var(--bpl-border-strong);border-top:2px solid var(--bpl-accent);border-radius:12px;' +
        'overflow:hidden;display:flex;flex-direction:column;' +
        '-webkit-backdrop-filter:var(--bpl-panel-backdrop,none);backdrop-filter:var(--bpl-panel-backdrop,none);' +
        'box-shadow:0 14px 44px var(--bpl-shadow-strong),0 0 0 1px var(--bpl-control-soft),' +
        'inset 0 1px 0 var(--bpl-surface-highlight);' +
        'transform-origin:100% 100%;opacity:0;visibility:hidden;transform:scale(.55) translateY(18px);' +
        'transition:opacity .2s ease,transform .28s cubic-bezier(.34,1.56,.64,1),visibility 0s linear .28s}' +
        '.panel.open{opacity:1;visibility:visible;transform:none;' +
        'transition:opacity .18s ease,transform .3s cubic-bezier(.34,1.56,.64,1),visibility 0s}' +
        '.panel.sized{max-width:calc(100vw - 8px);max-height:calc(100vh - 8px)}' +
        '.panel.dragging,.panel.resizing{transition:none}' +
        '.panel.dragging .pframe,.panel.resizing .pframe{pointer-events:none}' +

        '.phead{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bpl-toolbar-bg,var(--bpl-raised));' +
        '-webkit-backdrop-filter:var(--bpl-toolbar-backdrop,none);backdrop-filter:var(--bpl-toolbar-backdrop,none);' +
        'border-bottom:1px solid var(--bpl-border);cursor:move;user-select:none;min-height:30px}' +
        '.gripbar{flex:1;min-width:12px;font-size:13px;color:var(--bpl-faint);line-height:1;letter-spacing:1px}' +
        '.pbtn{flex:none;width:26px;height:26px;border:1px solid var(--bpl-border-strong);border-radius:6px;' +
        'background:var(--bpl-control);color:var(--bpl-text);font-size:15px;line-height:1;cursor:pointer;' +
        'box-shadow:var(--bpl-control-shadow);transition:.13s}' +
        '.pbtn:hover{background:var(--bpl-hover);color:var(--bpl-text)}' +
        '.pbtn:active{transform:translateY(1px);box-shadow:var(--bpl-control-active-shadow)}' +
        '.pbtn.add{color:var(--bpl-accent);font-size:13px;width:auto;padding:0 9px;font-weight:600}' +
        '.pbtn.add:hover{background:var(--bpl-accent-soft)}' +
        '.pbtn.collection-add{font-size:12px;width:auto;padding:0 8px;color:var(--bpl-on-accent);' +
        'background:var(--bpl-accent);border-color:var(--bpl-accent);font-weight:650}' +
        '.pbtn.collection-add:hover{background:var(--bpl-accent-hover);border-color:var(--bpl-accent-hover)}' +
        '.theme-picker{flex:none;display:flex;align-items:center;gap:4px}' +
        '.theme-swatches{display:flex;align-items:center;gap:3px;max-width:0;opacity:0;overflow:hidden;' +
        'pointer-events:none;transition:max-width .22s ease,opacity .16s ease}' +
        '.theme-picker.open .theme-swatches{max-width:112px;opacity:1;pointer-events:auto}' +
        '.theme-toggle{appearance:none;flex:none;display:block;width:18px;height:18px;padding:0;border:0;outline:none;border-radius:50%;' +
        'background:conic-gradient(from 25deg,var(--bpl-accent),#ffd43b,#56cc9d,#4d96ff,#c77dff,var(--bpl-accent));' +
        'box-shadow:none;cursor:pointer;transition:transform .35s ease,filter .2s ease}' +
        '.theme-toggle:hover{background:conic-gradient(from 25deg,var(--bpl-accent),#ffd43b,#56cc9d,#4d96ff,#c77dff,var(--bpl-accent));' +
        'transform:rotate(90deg);filter:saturate(1.25)}' +
        '.theme-toggle:active{transform:scale(.9);box-shadow:none}' +
        '.theme-picker.open .theme-toggle{transform:rotate(135deg);filter:saturate(1.2)}' +
        '.theme-picker.open .theme-toggle:active{transform:rotate(135deg) scale(.9)}' +
        '.theme-toggle:focus-visible{outline:none;filter:saturate(1.25) brightness(1.08)}' +
        '.theme-swatch:focus-visible{outline:2px solid var(--bpl-accent);outline-offset:2px}' +
        '.theme-swatch{appearance:none;flex:none;width:16px;height:16px;padding:0;' +
        'border:1px solid var(--bpl-swatch-border,var(--bpl-border-strong));border-radius:50%;' +
        'background:var(--swatch);background-clip:padding-box;box-shadow:0 1px 3px var(--bpl-shadow);cursor:pointer;' +
        'transition:border-color .13s ease,filter .13s ease}' +
        '.theme-swatch:hover{border-color:var(--bpl-text);filter:brightness(1.08) saturate(1.08)}' +
        '.theme-swatch:active{transform:none;filter:brightness(.92);box-shadow:0 1px 3px var(--bpl-shadow)}' +
        '.theme-swatch.selected{border-color:var(--bpl-accent);filter:brightness(1.1) saturate(1.12)}' +
        '.pbody{flex:1;min-height:0;position:relative}' +
        '.pframe{width:100%;height:100%;border:none;display:block;background:transparent}' +
        '.resize-grip{position:absolute;right:0;bottom:0;z-index:3;width:18px;height:18px;' +
        'cursor:nwse-resize;color:var(--bpl-faint);touch-action:none}' +
        '.resize-grip::before,.resize-grip::after{content:"";position:absolute;height:1px;border-radius:.5px;' +
        'background:currentColor;transform:rotate(-45deg);transform-origin:center}' +
        '.resize-grip::before{right:2px;bottom:7px;width:12px}' +
        '.resize-grip::after{right:2px;bottom:4px;width:6px}' +

        '.collection-dialog{position:fixed;z-index:' + (Z + 1) + ';right:20px;bottom:146px;width:340px;height:540px;' +
        'display:flex;align-items:center;justify-content:center;padding:12px;border-radius:12px;' +
        'background:rgba(0,0,0,.28);opacity:0;visibility:hidden;pointer-events:none;' +
        'transition:opacity .16s ease,visibility 0s linear .16s}' +
        '.collection-dialog.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .16s ease}' +
        '.collection-sheet{width:min(300px,100%);max-height:100%;overflow:auto;padding:16px;border-radius:8px;' +
        'background:var(--bpl-panel-bg,var(--bpl-raised));border:1px solid var(--bpl-border-strong);color:var(--bpl-text);' +
        '-webkit-backdrop-filter:blur(18px) saturate(1.25);backdrop-filter:blur(18px) saturate(1.25);' +
        'box-shadow:0 14px 36px var(--bpl-shadow-strong),inset 0 1px 0 var(--bpl-surface-highlight)}' +
        '.collection-heading{margin:0;font-size:16px;line-height:1.35;font-weight:700;letter-spacing:0}' +
        '.collection-title{margin:8px 0 2px;font-size:13px;line-height:1.45;overflow-wrap:anywhere}' +
        '.collection-count{margin:0 0 12px;color:var(--bpl-faint);font-size:12px;line-height:1.4}' +
        '.collection-targets{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:9px}' +
        '.collection-choice{height:30px;border:1px solid var(--bpl-border-strong);border-radius:6px;' +
        'background:var(--bpl-control);color:var(--bpl-text);font-size:12px;cursor:pointer;box-shadow:var(--bpl-control-shadow)}' +
        '.collection-choice.selected{color:var(--bpl-on-accent);background:var(--bpl-accent);border-color:var(--bpl-accent)}' +
        '.collection-target-name{min-height:18px;margin:0 0 9px;color:var(--bpl-faint);font-size:12px;line-height:1.45;overflow-wrap:anywhere}' +
        '.collection-new-name{width:100%;height:30px;margin:0 0 9px;padding:0 9px;border:1px solid var(--bpl-border-strong);' +
        'border-radius:6px;background:var(--bpl-control);color:var(--bpl-text);font:12px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;outline:none}' +
        '.collection-new-name:focus{border-color:var(--bpl-accent)}' +
        '.collection-dialog[data-mode="current"] .collection-new-name{display:none}' +
        '.collection-rename-row{position:relative;display:flex;align-items:center;gap:4px;margin:2px 0 7px;min-height:18px}' +
        '.collection-rename{display:flex;align-items:center;gap:7px;flex:none;min-width:0;margin:0;color:var(--bpl-text);font-size:12px;line-height:1.4;cursor:pointer}' +
        '.collection-rename-check{accent-color:var(--bpl-accent);margin:0}' +
        '.collection-rename-info{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--bpl-faint);cursor:help;display:inline-flex;align-items:center;justify-content:center}' +
        '.collection-rename-info svg{display:block;width:14px;height:14px}' +
        '.collection-rename-info:hover,.collection-rename-info:focus-visible{color:var(--bpl-accent);outline:none}' +
        '.collection-rename-tip{position:absolute;right:0;bottom:calc(100% + 6px);z-index:2;width:220px;padding:7px 9px;border:1px solid var(--bpl-border-strong);border-radius:6px;background:var(--bpl-raised);color:var(--bpl-text);font-size:11px;line-height:1.45;box-shadow:0 6px 16px var(--bpl-shadow-strong);opacity:0;visibility:hidden;pointer-events:none;transform:translateY(3px);transition:opacity .14s ease,transform .14s ease,visibility 0s linear .14s}' +
        '.collection-rename-info:hover + .collection-rename-tip,.collection-rename-info:focus-visible + .collection-rename-tip{opacity:1;visibility:visible;transform:none;transition:opacity .14s ease,transform .14s ease}' +
        '.collection-rename-prefix{width:100%;height:30px;margin:0 0 9px;padding:0 9px;border:1px solid var(--bpl-border-strong);border-radius:6px;background:var(--bpl-control);color:var(--bpl-text);font:12px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;outline:none}' +
        '.collection-rename-prefix:focus{border-color:var(--bpl-accent)}' +
        '.collection-rename-prefix:disabled{cursor:not-allowed;opacity:.55}' +
        '.collection-status{min-height:18px;margin:0 0 9px;color:var(--bpl-faint);font-size:12px;line-height:1.45;overflow-wrap:anywhere}' +
        '.collection-status.error{color:var(--bpl-danger,var(--bpl-accent))}' +
        '.collection-status.success{color:var(--bpl-accent)}' +
        '.collection-actions{display:flex;justify-content:flex-end;gap:7px}' +
        '.collection-action{height:30px;padding:0 12px;border:1px solid var(--bpl-border-strong);border-radius:6px;' +
        'background:var(--bpl-control);color:var(--bpl-text);font-size:12px;cursor:pointer;box-shadow:var(--bpl-control-shadow)}' +
        '.collection-action.primary{background:var(--bpl-accent);border-color:var(--bpl-accent);color:var(--bpl-on-accent);font-weight:650}' +
        '.collection-action:disabled,.collection-choice:disabled{cursor:wait;opacity:.6}';

    function orderedThemes() {
        if (!THEME_API) return [];
        return THEME_API.themes.slice().sort((a, b) => {
            const ai = THEME_PICKER_ORDER.indexOf(a.id), bi = THEME_PICKER_ORDER.indexOf(b.id);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        });
    }

    function syncThemePicker(id) {
        if (!themePicker) return;
        themePicker.querySelectorAll('[data-theme-id]').forEach(button => {
            const selected = button.dataset.themeId === id;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
    }

    function applyOuterTheme(id) {
        if (!THEME_API || !hostEl) return null;
        const theme = THEME_API.apply(hostEl, id);
        syncThemePicker(theme.id);
        syncFrameTheme(theme.id);
        return theme;
    }

    function syncFrameTheme(id) {
        if (!pframe || !pframe.contentWindow) return;
        try { pframe.contentWindow.postMessage({ bplBridge: 'theme', themeId: id }, '*'); } catch (_) {}
    }

    function setThemePickerOpen(open) {
        if (!themePicker) return;
        themePicker.classList.toggle('open', !!open);
        const toggleBtn = themePicker.querySelector('.theme-toggle');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function initThemePicker() {
        if (!THEME_API || !themePicker) return;
        themePicker.addEventListener('pointerdown', e => e.stopPropagation());
        themePicker.addEventListener('click', e => {
            e.stopPropagation();
            const swatch = e.target.closest('[data-theme-id]');
            if (swatch) {
                const theme = applyOuterTheme(swatch.dataset.themeId);
                setThemePickerOpen(false);
                if (theme) {
                    try { chrome.storage.local.set({ [THEME_KEY]: theme.id }); } catch (err) { reviveIfDead(err); }
                }
                return;
            }
            if (e.target.closest('.theme-toggle')) {
                setThemePickerOpen(!themePicker.classList.contains('open'));
            }
        });
        chrome.storage.local.get(THEME_KEY).then(result => {
            applyOuterTheme(result && result[THEME_KEY]);
        }).catch(err => reviveIfDead(err));
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[THEME_KEY]) {
                applyOuterTheme(changes[THEME_KEY].newValue);
            }
        });
        syncThemePicker(THEME_API.DEFAULT_ID);
    }

    function buildUI() {
        if (built || document.getElementById(HOST_ID)) return;
        if (!document.body) return;
        built = true;

        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:' + Z;
        hostEl = host;
        if (THEME_API) THEME_API.apply(host, THEME_API.DEFAULT_ID);
        shadow = host.attachShadow({ mode: 'closed' });
        const themeMarkup = THEME_API
            ? '<div class="theme-picker"><div class="theme-swatches" role="listbox" aria-label="播放器配色">' +
                orderedThemes().map(theme => '<button class="theme-swatch" data-theme-id="' + theme.id +
                    '" title="' + theme.name + '" aria-label="' + theme.name + '" role="option" style="--swatch:' +
                    theme.swatch + '"></button>').join('') +
                '</div><button class="theme-toggle" title="切换配色" aria-label="切换配色" aria-expanded="false"></button></div>'
            : '';
        shadow.innerHTML =
            '<style>' + CSS + '</style>' +
            '<div class="mini" title="B站听歌列表">' +
            '<div class="m-controls">' +
            '<button class="m-btn m-prev" title="上一首"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>' +
            '<button class="m-btn m-play" title="播放/暂停"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="' + PLAY_D + '"/></svg></button>' +
            '<button class="m-btn m-next" title="下一首"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>' +
            '</div>' +
            '<div class="m-core" title="展开播放列表">' +
            '<span class="m-ico">♪</span>' +
            '<div class="m-spec"><i></i><i></i><i></i><i></i></div>' +
            '</div>' +
            '</div>' +
            '<div class="panel">' +
            '<div class="phead">' +
            '<span class="gripbar" title="拖动面板">⠿</span>' +
            themeMarkup +
            '<button class="pbtn add" title="把当前B站视频加入播放列表" style="display:none"><span class="addtxt">＋加入</span></button>' +
            '<button class="pbtn collection-add" title="把当前合集或多P视频全部加入播放列表" style="display:none"><span class="collectiontxt">全部加入</span></button>' +
            '</div>' +
            '<div class="pbody"><iframe class="pframe" title="playlist" allow="autoplay"></iframe></div>' +
            '<div class="resize-grip" title="调整面板大小"></div>' +
            '</div>' +
            '<div class="collection-dialog" data-mode="current" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="bpl-collection-heading">' +
            '<div class="collection-sheet">' +
            '<h2 class="collection-heading" id="bpl-collection-heading">导入合集</h2>' +
            '<p class="collection-title"></p>' +
            '<p class="collection-count"></p>' +
            '<div class="collection-targets" role="radiogroup" aria-label="导入目标">' +
            '<button class="collection-choice selected" type="button" data-collection-target="current" role="radio" aria-checked="true">当前播放列表</button>' +
            '<button class="collection-choice" type="button" data-collection-target="new" role="radio" aria-checked="false">新建播放列表</button>' +
            '</div>' +
            '<p class="collection-target-name"></p>' +
            '<input class="collection-new-name" maxlength="100" aria-label="新播放列表名称" placeholder="新播放列表名称">' +
            '<div class="collection-rename-row"><label class="collection-rename"><input class="collection-rename-check" type="checkbox"><span>智能重命名</span></label>' +
            '<button class="collection-rename-info" type="button" aria-label="智能重命名说明" aria-describedby="bpl-rename-tip">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10v5"></path><path d="M12 7.5h.01"></path></svg></button>' +
            '<span class="collection-rename-tip" id="bpl-rename-tip" role="tooltip">自动精简分P标题，结果可能不完全准确。可自行配置 rules.json</span></div>' +
            '<input class="collection-rename-prefix" maxlength="80" aria-label="统一前缀（可选）" placeholder="统一前缀（可选）" disabled>' +
            '<p class="collection-status" role="status" aria-live="polite"></p>' +
            '<div class="collection-actions">' +
            '<button class="collection-action cancel" type="button">取消</button>' +
            '<button class="collection-action primary confirm" type="button">确认导入</button>' +
            '</div></div></div>';

        mini = shadow.querySelector('.mini');
        miniPlay = shadow.querySelector('.m-play');
        panel = shadow.querySelector('.panel');
        pframe = shadow.querySelector('.pframe');
        addBtn = shadow.querySelector('.add');
        addTxt = shadow.querySelector('.addtxt');
        collectionBtn = shadow.querySelector('.collection-add');
        collectionTxt = shadow.querySelector('.collectiontxt');
        collectionDialog = shadow.querySelector('.collection-dialog');
        collectionDialogTitle = shadow.querySelector('.collection-title');
        collectionDialogCount = shadow.querySelector('.collection-count');
        collectionTargetName = shadow.querySelector('.collection-target-name');
        collectionNameInput = shadow.querySelector('.collection-new-name');
        collectionRenameCheck = shadow.querySelector('.collection-rename-check');
        collectionRenamePrefixInput = shadow.querySelector('.collection-rename-prefix');
        collectionStatus = shadow.querySelector('.collection-status');
        collectionConfirmBtn = shadow.querySelector('.collection-action.confirm');
        collectionCancelBtn = shadow.querySelector('.collection-action.cancel');
        resizeGrip = shadow.querySelector('.resize-grip');
        themePicker = shadow.querySelector('.theme-picker');

        pframe.addEventListener('load', () => {
            const id = hostEl.getAttribute('data-bpl-theme') || THEME_API && THEME_API.DEFAULT_ID;
            if (id) syncFrameTheme(id);
        });

        makeMiniDraggable();
        initThemePicker();
        addBtn.addEventListener('click', addCurrent);
        collectionBtn.addEventListener('click', openCollectionDialog);
        collectionDialog.addEventListener('click', handleCollectionDialogClick);
        collectionRenameCheck.addEventListener('change', syncRenameControls);
        makeDraggable(panel, shadow.querySelector('.phead'));
        makeResizable(panel, resizeGrip);

        function miniActivate(target) {
            if (target && target.closest) {
                if (target.closest('.m-core')) { toggle(); return; }
                if (target.closest('.m-prev')) { handlePlayerCmd({ cmd: 'prev' }); return; }
                if (target.closest('.m-play')) { handlePlayerCmd({ cmd: 'toggle' }); return; }
                if (target.closest('.m-next')) { handlePlayerCmd({ cmd: 'next' }); return; }
            }
            if (!mini.classList.contains('loaded')) toggle();
        }
        function makeMiniDraggable() {
            let down = false, moved = false, sx = 0, sy = 0, sr = 0, sb = 0, downTarget = null;
            mini.addEventListener('pointerdown', e => {
                down = true; moved = false; downTarget = e.target;
                sx = e.clientX; sy = e.clientY;
                const r = mini.getBoundingClientRect();
                sr = window.innerWidth - r.right;
                sb = window.innerHeight - r.bottom;
                try { mini.setPointerCapture(e.pointerId); } catch (_) {}
            });
            mini.addEventListener('pointermove', e => {
                if (!down) return;
                const dx = e.clientX - sx, dy = e.clientY - sy;
                if (!moved && Math.hypot(dx, dy) > 4) { moved = true; mini.classList.add('dragging'); }
                if (moved) {
                    const nr = Math.max(4, Math.min(sr - dx, window.innerWidth - 40));
                    const nb = Math.max(4, Math.min(sb - dy, window.innerHeight - 40));
                    mini.style.right = nr + 'px';
                    mini.style.bottom = nb + 'px';
                }
            });
            mini.addEventListener('pointerup', () => {
                const wasDrag = moved, tgt = downTarget;
                down = false; moved = false; downTarget = null;
                mini.classList.remove('dragging');
                if (wasDrag) {
                    const r = mini.getBoundingClientRect();
                    try {
                        chrome.storage.local.set({
                            bpl_mini: { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) }
                        });
                    } catch (e) { reviveIfDead(e); }
                    return;
                }
                miniActivate(tgt);
            });
            mini.addEventListener('pointercancel', () => {
                down = false; moved = false; downTarget = null;
                mini.classList.remove('dragging');
            });
        }

        document.body.appendChild(host);

        document.addEventListener('click', e => {
            if (!panelOpen) return;
            if (hostEl && hostEl.contains(e.target)) return;
            toggle(false);
        }, true);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && collectionDialog && collectionDialog.classList.contains('open')) {
                closeCollectionDialog();
            }
        }, true);

        chrome.storage.local.get('bpl_mini').then(r => {
            const p = (r && r.bpl_mini) || {};
            if (typeof p.right === 'number' && typeof p.bottom === 'number') {
                mini.style.right = Math.max(4, Math.min(p.right, window.innerWidth - 40)) + 'px';
                mini.style.bottom = Math.max(4, Math.min(p.bottom, window.innerHeight - 40)) + 'px';
            }
        }).catch(e => reviveIfDead(e));

        // 所有标签页共享位置；读取旧格式时只转换显示，下一次实际拖动才写回，避免迁移互相覆盖。
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes[STORE_KEY]) return;
            panelPreferenceRevision++;
            const value = changes[STORE_KEY].newValue || {};
            if (panelInteraction) pendingPanelPreference = value;
            else restorePanelPreference(value);
        });
        refreshPanelPreference();
        window.addEventListener('resize', keepPanelInViewport);
        updateAddBtn();
        updateMiniUI();
    }

    function updateMiniUI() {
        if (!mini) return;
        mini.classList.toggle('loaded', !!playerState.hasTrack);
        mini.classList.toggle('playing', !!playerState.playing);
        const p = miniPlay && miniPlay.querySelector('path');
        if (p) p.setAttribute('d', playerState.playing ? PAUSE_D : PLAY_D);
    }

    function restorePanelPreference(p) {
        const hasRatioPosition = Number.isFinite(p.xRatio) && Number.isFinite(p.yRatio);
        const hasLegacyPosition = Number.isFinite(p.x) && Number.isFinite(p.y);
        const hasSize = Number.isFinite(p.width) && Number.isFinite(p.height);
        if (!hasRatioPosition && !hasLegacyPosition && !hasSize) return;
        preferredPanelWidth = hasSize ? Math.max(PANEL_MIN_WIDTH, p.width) : panel.offsetWidth || 340;
        preferredPanelHeight = hasSize ? Math.max(PANEL_MIN_HEIGHT, p.height) : panel.offsetHeight || 540;
        let geometry;
        if (hasRatioPosition) {
            panelXRatio = clampRatio(p.xRatio, 0.5);
            panelYRatio = clampRatio(p.yRatio, 0.5);
            geometry = panelGeometryFromRatios(
                panelXRatio, panelYRatio, preferredPanelWidth, preferredPanelHeight,
                window.innerWidth, window.innerHeight
            );
        } else {
            geometry = clampPanelGeometry(
                hasLegacyPosition ? p.x : window.innerWidth - preferredPanelWidth - 20,
                hasLegacyPosition ? p.y : window.innerHeight - preferredPanelHeight - 146,
                preferredPanelWidth, preferredPanelHeight, window.innerWidth, window.innerHeight
            );
            const ratios = panelRatiosFromGeometry(
                geometry.x, geometry.y, geometry.width, geometry.height,
                window.innerWidth, window.innerHeight, 0.5, 0.5
            );
            panelXRatio = ratios.xRatio;
            panelYRatio = ratios.yRatio;
        }
        applyPanelGeometry(geometry);
    }

    function refreshPanelPreference() {
        const revision = panelPreferenceRevision;
        chrome.storage.local.get(STORE_KEY).then(values => {
            if (revision !== panelPreferenceRevision || panelInteraction) return;
            restorePanelPreference(values && values[STORE_KEY] || {});
        }).catch(e => reviveIfDead(e));
    }

    function beginPanelInteraction() {
        panelPreferenceRevision++;
        panelInteraction = true;
        pendingPanelPreference = null;
    }

    function finishPanelInteraction(changed, rememberSize) {
        panelPreferenceRevision++;
        panelInteraction = false;
        const pending = pendingPanelPreference;
        pendingPanelPreference = null;
        if (changed) persist(rememberSize);
        else if (pending) restorePanelPreference(pending);
        else refreshPanelPreference();
    }

    function applyPanelGeometry(g) {
        panel.classList.add('sized');
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = g.x + 'px';
        panel.style.top = g.y + 'px';
        panel.style.width = g.width + 'px';
        panel.style.height = g.height + 'px';
        posX = g.x; posY = g.y;
        panelWidth = g.width; panelHeight = g.height;
        syncCollectionDialogGeometry();
    }

    function keepPanelInViewport() {
        if (!panel || !panel.classList.contains('sized')) {
            syncCollectionDialogGeometry();
            return;
        }
        if (Number.isFinite(panelXRatio) && Number.isFinite(panelYRatio)) {
            applyPanelGeometry(panelGeometryFromRatios(
                panelXRatio,
                panelYRatio,
                preferredPanelWidth == null ? panelWidth : preferredPanelWidth,
                preferredPanelHeight == null ? panelHeight : preferredPanelHeight,
                window.innerWidth,
                window.innerHeight
            ));
            return;
        }
        applyPanelGeometry(clampPanelGeometry(
            posX, posY, panelWidth, panelHeight, window.innerWidth, window.innerHeight
        ));
    }

    function savePanelPreference() {
        if (!Number.isFinite(panelXRatio) || !Number.isFinite(panelYRatio) ||
            preferredPanelWidth == null || preferredPanelHeight == null) return;
        try {
            chrome.storage.local.set({
                [STORE_KEY]: {
                    version: 2,
                    xRatio: panelXRatio,
                    yRatio: panelYRatio,
                    width: preferredPanelWidth,
                    height: preferredPanelHeight
                }
            }).catch(e => reviveIfDead(e));
        } catch (e) { reviveIfDead(e); }
    }

    function persist(rememberSize) {
        if (posX == null || posY == null || panelWidth == null || panelHeight == null) return;
        const ratios = panelRatiosFromGeometry(
            posX, posY, panelWidth, panelHeight,
            window.innerWidth, window.innerHeight, panelXRatio, panelYRatio
        );
        panelXRatio = ratios.xRatio;
        panelYRatio = ratios.yRatio;
        if (rememberSize || preferredPanelWidth == null || preferredPanelHeight == null) {
            preferredPanelWidth = panelWidth;
            preferredPanelHeight = panelHeight;
        }
        savePanelPreference();
    }

    function ensureFrame() {
        if (frameLoaded) return;
        frameLoaded = true;
        pframe.src = PANEL_URL;
    }

    function toggle(open) {
        panelOpen = (open == null) ? !panelOpen : !!open;
        panel.classList.toggle('open', panelOpen);
        if (!panelOpen) {
            setThemePickerOpen(false);
            closeCollectionDialog();
        }
        if (panelOpen) { refreshPanelPreference(); ensureFrame(); updateAddBtn(); }
    }

    function updateAddBtn() {
        const bvid = getCurrentBvid();
        if (addBtn) addBtn.style.display = bvid ? '' : 'none';
        syncCollectionPage(bvid);
        if (panelOpen && bvid) probeCollection(false);
    }

    function syncCollectionPage(bvid) {
        bvid = String(bvid || '');
        if (bvid === collectionProbeBvid) return;
        collectionProbeToken++;
        collectionProbeBvid = bvid;
        collectionProbeAt = 0;
        collectionProbeInFlight = false;
        collectionProbePromise = null;
        collectionSummaryState = null;
        if (collectionBtn) {
            collectionBtn.style.display = 'none';
            collectionBtn.disabled = false;
        }
        if (collectionTxt) collectionTxt.textContent = '全部加入';
        closeCollectionDialog();
    }

    function collectionRequestIsCurrent(bvid, token) {
        return token === collectionProbeToken && bvid === collectionProbeBvid && bvid === getCurrentBvid();
    }

    function probeCollection(force) {
        const bvid = getCurrentBvid();
        syncCollectionPage(bvid);
        if (!bvid) return Promise.resolve({ ok: false, unavailable: true });
        if (collectionProbeInFlight && collectionProbePromise) return collectionProbePromise;
        const now = Date.now();
        if (!force && collectionSummaryState) return Promise.resolve(collectionSummaryState);
        if (!force && collectionProbeAt && now - collectionProbeAt < COLLECTION_PROBE_RETRY_MS) {
            return Promise.resolve({ ok: false, cooldown: true });
        }

        const token = ++collectionProbeToken;
        collectionProbeAt = now;
        collectionProbeInFlight = true;
        const task = sendBgRequest({ target: 'bg', cmd: 'getCollection', bvid: bvid }, 15000).then(result => {
            if (!collectionRequestIsCurrent(bvid, token)) return { ok: false, stale: true };
            collectionProbeInFlight = false;
            collectionProbePromise = null;
            if (result && result.ok && Number(result.count) > 0) {
                collectionSummaryState = result;
                if (collectionBtn) {
                    collectionBtn.style.display = '';
                    collectionBtn.title = '导入《' + String(result.title || bvid) + '》的全部 ' + result.count + ' 个视频';
                }
                return result;
            }
            collectionSummaryState = null;
            if (collectionBtn) collectionBtn.style.display = 'none';
            if (result && result.notCollection) collectionProbeAt = Number.POSITIVE_INFINITY;
            return result || { ok: false, error: '无法获取合集信息' };
        });
        collectionProbePromise = task;
        return task;
    }

    async function openCollectionDialog() {
        const bvid = getCurrentBvid();
        if (!bvid || collectionActionBusy) return;
        if (collectionBtn) collectionBtn.disabled = true;
        if (collectionTxt) collectionTxt.textContent = '读取中…';
        const result = await probeCollection(true);
        if (collectionBtn) collectionBtn.disabled = false;
        if (collectionTxt) collectionTxt.textContent = '全部加入';
        if (!result || !result.ok || getCurrentBvid() !== bvid) return;

        collectionDialogBvid = bvid;
        collectionSummaryState = result;
        collectionDialogMode = result.activePlaylistId ? 'current' : 'new';
        if (collectionDialogTitle) collectionDialogTitle.textContent = '《' + String(result.title || bvid) + '》';
        if (collectionDialogCount) collectionDialogCount.textContent = '共 ' + Number(result.count || 0) + ' 个视频';
        if (collectionNameInput) collectionNameInput.value = String(result.title || '').slice(0, 100);
        if (collectionRenameCheck) collectionRenameCheck.checked = false;
        if (collectionRenamePrefixInput) {
            collectionRenamePrefixInput.value = '';
            collectionRenamePrefixInput.disabled = true;
        }
        if (collectionStatus) {
            collectionStatus.textContent = '';
            collectionStatus.className = 'collection-status';
        }
        if (collectionConfirmBtn) collectionConfirmBtn.textContent = '确认导入';
        if (collectionCancelBtn) collectionCancelBtn.hidden = false;
        if (collectionDialog) delete collectionDialog.dataset.complete;
        setCollectionDialogMode(collectionDialogMode);
        syncCollectionDialogGeometry();
        collectionDialog.classList.add('open');
        collectionDialog.setAttribute('aria-hidden', 'false');
    }

    function setCollectionDialogMode(mode) {
        collectionDialogMode = mode === 'new' ? 'new' : 'current';
        if (!collectionDialog) return;
        collectionDialog.dataset.mode = collectionDialogMode;
        collectionDialog.querySelectorAll('[data-collection-target]').forEach(button => {
            const selected = button.dataset.collectionTarget === collectionDialogMode;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-checked', selected ? 'true' : 'false');
        });
        if (collectionTargetName) {
            collectionTargetName.textContent = collectionDialogMode === 'new'
                ? '将创建新播放列表并自动切换到该播放列表'
                : '目标：' + String(collectionSummaryState && collectionSummaryState.activePlaylistName || '当前播放列表');
        }
        if (collectionDialogMode === 'new' && collectionNameInput) collectionNameInput.focus();
    }

    function syncCollectionDialogGeometry() {
        if (!collectionDialog || !panel) return;
        const rect = panel.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        collectionDialog.style.left = rect.left + 'px';
        collectionDialog.style.top = rect.top + 'px';
        collectionDialog.style.right = 'auto';
        collectionDialog.style.bottom = 'auto';
        collectionDialog.style.width = rect.width + 'px';
        collectionDialog.style.height = rect.height + 'px';
    }

    function setCollectionControlsDisabled(disabled) {
        if (!collectionDialog) return;
        collectionDialog.querySelectorAll('.collection-choice,.collection-action,.collection-new-name,.collection-rename-check,.collection-rename-prefix').forEach(control => {
            control.disabled = !!disabled;
        });
        if (!disabled) syncRenameControls();
    }

    function syncRenameControls() {
        if (collectionRenamePrefixInput) collectionRenamePrefixInput.disabled = !collectionRenameCheck || !collectionRenameCheck.checked;
    }

    function closeCollectionDialog() {
        collectionActionToken++;
        collectionActionBusy = false;
        collectionDialogBvid = '';
        if (!collectionDialog) return;
        collectionDialog.classList.remove('open');
        collectionDialog.setAttribute('aria-hidden', 'true');
        delete collectionDialog.dataset.complete;
        setCollectionControlsDisabled(false);
        if (collectionConfirmBtn) collectionConfirmBtn.textContent = '确认导入';
        if (collectionCancelBtn) collectionCancelBtn.hidden = false;
    }

    function handleCollectionDialogClick(event) {
        if (!collectionDialog) return;
        if (event.target === collectionDialog || event.target.closest('.collection-action.cancel')) {
            closeCollectionDialog();
            return;
        }
        const choice = event.target.closest('[data-collection-target]');
        if (choice && !collectionActionBusy) {
            setCollectionDialogMode(choice.dataset.collectionTarget);
            return;
        }
        if (event.target.closest('.collection-action.confirm')) {
            if (collectionDialog.dataset.complete === 'true') closeCollectionDialog();
            else confirmCollectionImport();
        }
    }

    async function confirmCollectionImport() {
        if (collectionActionBusy || !collectionDialogBvid) return;
        const bvid = collectionDialogBvid;
        const token = ++collectionActionToken;
        collectionActionBusy = true;
        setCollectionControlsDisabled(true);
        if (collectionStatus) {
            collectionStatus.className = 'collection-status';
            collectionStatus.textContent = collectionDialogMode === 'new' ? '正在创建播放列表并导入…' : '正在确认目标播放列表…';
        }

        let latestSummary = collectionSummaryState;
        if (collectionDialogMode === 'current') {
            latestSummary = await sendBgRequest({ target: 'bg', cmd: 'getCollection', bvid: bvid }, 15000);
            if (token !== collectionActionToken || bvid !== getCurrentBvid()) return;
            if (!latestSummary || !latestSummary.ok) {
                finishCollectionImportError(latestSummary && latestSummary.error);
                return;
            }
            collectionSummaryState = latestSummary;
            if (collectionTargetName) collectionTargetName.textContent = '目标：' + String(latestSummary.activePlaylistName || '当前播放列表');
        }

        const payload = buildCollectionImportPayload(
            bvid,
            collectionDialogMode,
            latestSummary,
            collectionNameInput && collectionNameInput.value,
            collectionRenameCheck && collectionRenameCheck.checked,
            collectionRenamePrefixInput && collectionRenamePrefixInput.value
        );
        if (collectionStatus) collectionStatus.textContent = collectionDialogMode === 'new' ? '正在导入合集…' : '正在导入到当前播放列表…';
        const result = await sendBgRequest(payload, 30000);
        if (token !== collectionActionToken || bvid !== getCurrentBvid()) return;
        if (!result || !result.ok) {
            finishCollectionImportError(result && result.error);
            return;
        }

        collectionActionBusy = false;
        setCollectionControlsDisabled(true);
        if (collectionStatus) {
            const added = Number(result.added) || 0;
            const dup = Number(result.dup) || 0;
            collectionStatus.className = 'collection-status success';
            if (collectionDialogMode === 'new') collectionStatus.textContent = '已创建播放列表并导入 ' + added + ' 个视频';
            else if (!added && dup) collectionStatus.textContent = '全部 ' + dup + ' 个视频均已在当前播放列表中';
            else if (dup) collectionStatus.textContent = '已加入 ' + added + ' 个视频，跳过 ' + dup + ' 个重复项';
            else collectionStatus.textContent = '已加入 ' + added + ' 个视频';
        }
        if (collectionDialog) collectionDialog.dataset.complete = 'true';
        if (collectionConfirmBtn) {
            collectionConfirmBtn.disabled = false;
            collectionConfirmBtn.textContent = '确认';
        }
        if (collectionCancelBtn) collectionCancelBtn.hidden = true;
    }

    function finishCollectionImportError(error) {
        collectionActionBusy = false;
        setCollectionControlsDisabled(false);
        if (collectionCancelBtn) collectionCancelBtn.hidden = false;
        if (collectionStatus) {
            collectionStatus.className = 'collection-status error';
            collectionStatus.textContent = formatCollectionError(error);
        }
    }

    function buildCollectionImportPayload(bvid, mode, summary, name, smartRename, renamePrefix) {
        const payload = {
            target: 'bg',
            cmd: 'importCollection',
            bvid: String(bvid || ''),
            importTarget: mode === 'new' ? 'new' : 'current'
        };
        if (payload.importTarget === 'current' && summary && summary.activePlaylistId) {
            payload.targetPlaylistId = summary.activePlaylistId;
        } else if (payload.importTarget === 'new') {
            payload.name = String(name || summary && summary.title || '').trim().slice(0, 100);
        }
        if (smartRename) {
            payload.smartRename = true;
            payload.renamePrefix = String(renamePrefix || '').trim().slice(0, 80);
        }
        return payload;
    }

    function addCurrent() {
        if (!isBiliVideo()) return;
        const m = location.pathname.match(/(BV[0-9A-Za-z]+)/);
        if (!m) return;
        const bvid = m[1];
        const page = Math.max(1, parseInt(new URLSearchParams(location.search).get('p'), 10) || 1);
        const meta = selector => {
            const el = document.querySelector(selector);
            return el ? String(el.content || el.getAttribute('content') || '').trim() : '';
        };
        const heading = document.querySelector('h1.video-title');
        const fallbackTitle = (heading && String(heading.title || heading.textContent || '').trim()) ||
            meta('meta[property="og:title"]') || document.title;
        const fallbackPic = meta('meta[itemprop="image"]') || meta('meta[property="og:image"]');
        const fallbackOwner = meta('meta[name="author"]');
        const old = addTxt.textContent;
        addTxt.textContent = '加入中…';
        chrome.runtime.sendMessage({
            target: 'bg', cmd: 'add', bvid: bvid, page: page,
            fallbackTitle: fallbackTitle, fallbackPic: fallbackPic, fallbackOwner: fallbackOwner
        }, res => {
            if (chrome.runtime.lastError) { addTxt.textContent = old; return; }
            if (!res || res.ok === false) addTxt.textContent = '加入失败';
            else if (res.dup) addTxt.textContent = '已在列表';
            else addTxt.textContent = res.incomplete ? '待解析' : '已加入';
            setTimeout(() => { addTxt.textContent = old; }, 1500);
        });
    }

    function makeDraggable(el, handle) {
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, width = 0, height = 0;
        handle.addEventListener('pointerdown', e => {
            if (e.target.closest('.pbtn')) return;
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            beginPanelInteraction();
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect();
            const g = clampPanelGeometry(
                r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight
            );
            applyPanelGeometry(g);
            ox = g.x; oy = g.y; width = g.width; height = g.height;
            el.classList.add('dragging');
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        });
        handle.addEventListener('pointermove', e => {
            if (!dragging) return;
            applyPanelGeometry(clampPanelGeometry(
                ox + e.clientX - sx,
                oy + e.clientY - sy,
                width,
                height,
                window.innerWidth,
                window.innerHeight
            ));
        });
        const end = e => {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('dragging');
            finishPanelInteraction(e.type !== 'pointercancel' && (posX !== ox || posY !== oy), false);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function makeResizable(el, handle) {
        let resizing = false, sx = 0, sy = 0;
        let ox = 0, oy = 0, startWidth = 0, startHeight = 0;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            resizing = true;
            beginPanelInteraction();
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect();
            const g = clampPanelGeometry(
                r.left, r.top, r.width, r.height, window.innerWidth, window.innerHeight
            );
            applyPanelGeometry(g);
            ox = g.x; oy = g.y; startWidth = g.width; startHeight = g.height;
            el.classList.add('resizing');
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        });
        handle.addEventListener('pointermove', e => {
            if (!resizing) return;
            const maxWidth = Math.max(1, window.innerWidth - ox - PANEL_MARGIN);
            const maxHeight = Math.max(1, window.innerHeight - oy - PANEL_MARGIN);
            const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
            const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
            const width = Math.max(minWidth, Math.min(startWidth + e.clientX - sx, maxWidth));
            const height = Math.max(minHeight, Math.min(startHeight + e.clientY - sy, maxHeight));
            applyPanelGeometry({ x: ox, y: oy, width: width, height: height });
        });
        const end = e => {
            if (!resizing) return;
            resizing = false;
            el.classList.remove('resizing');
            finishPanelInteraction(e.type !== 'pointercancel' &&
                (panelWidth !== startWidth || panelHeight !== startHeight), true);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function forwardBroadcast(msg) {
        if (frameLoaded && pframe && pframe.contentWindow) {
            try { pframe.contentWindow.postMessage({ bplBridge: 'broadcast', msg: msg }, '*'); } catch (_) {}
        }
    }

    chrome.runtime.onMessage.addListener(msg => {
        if (!msg) return;
        if (msg.target === 'content' && msg.cmd === 'togglePanel') { toggle(); return; }
        if (msg.target === 'all') {
            // 诊断留痕（每实例一次）：现场曾出现“广播投递失效、UI 冻住”，凭此条可确认
            // content script 是否真的收到了广播、首条是何类型（v2.2.7 起广播改为双路投递）。
            if (!loggedBroadcast) { loggedBroadcast = true; BPLLog.info('content', '收到首个广播 type=' + msg.type); }
            if (msg.type === 'state' && msg.state) {
                playerState.playing = !!msg.state.playing;
                playerState.hasTrack = !!msg.state.hasTrack;
                playerState.index = msg.state.index || 0;
                playerState.mode = msg.state.mode || 'loop';
                updateMiniUI();
            } else if (msg.type === 'progress') {
                if (msg.playing != null) { playerState.playing = msg.playing; updateMiniUI(); }
            }
            forwardBroadcast(msg);
        }
    });

    // 桥接来源决策（抽成纯函数便于单测）：
    //   'player'        播放命令：扩展自身源，或来源为 null 的真实面板 iframe
    //   'forward'       通用命令（播放列表增删改/openTab 等）：仅扩展自身源放行
    //   'reject-http'   网页源（http/https，浏览器设定、不可伪造）一律拒绝
    //   'reject-origin' 非扩展源发起的通用命令拒绝——堵住“只拒 http(s)+任意透传”的越权面
    function bridgeDecision(origin, cmd) {
        if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return 'reject-http';
        if (cmd && PLAYER_CMDS[cmd] && (origin === EXT_ORIGIN || origin === 'null')) return 'player';
        if (origin !== EXT_ORIGIN) return 'reject-origin';
        return 'forward';
    }

    window.addEventListener('message', e => {
        const d = e.data;
        if (!d || d.bplBridge !== 'req') return;
        // null origin 也可能来自网页创建的 sandbox iframe，必须同时绑定窗口身份。
        if (!frameLoaded || !pframe || !pframe.contentWindow || e.source !== pframe.contentWindow) return;
        const payload = d.payload;
        const decision = bridgeDecision(e.origin, payload && payload.cmd);
        if (decision === 'reject-http') return;
        if (!loggedBridgeOrigin) { loggedBridgeOrigin = true; BPLLog.info('content', '桥接首个请求 origin=' + e.origin + ' → ' + decision); }
        const respond = res => {
            try { pframe.contentWindow.postMessage({ bplBridge: 'res', id: d.id, result: res }, '*'); } catch (_) {}
        };
        if (decision === 'reject-origin') {
            BPLLog.warn('content', '桥接拒绝非扩展源通用命令 origin=' + e.origin + ' cmd=' + (payload && payload.cmd));
            respond({ ok: false, error: '来源不受信任' });
            return;
        }
        if (decision === 'player') {
            handlePlayerCmd(payload).then(respond, err => respond({ ok: false, error: String((err && err.message) || err) }));
            return;
        }
        // decision === 'forward'
        try {
            chrome.runtime.sendMessage(payload, res => respond(res));
        } catch (err) {
            respond({ ok: false, error: String((err && err.message) || err) });
        }
    });

    if (typeof globalThis !== 'undefined' && typeof globalThis.__BPL_EXPOSE === 'function') {
        globalThis.__BPL_EXPOSE({
            handlePlayerCmd: handlePlayerCmd,
            getPlayerState: () => playerState,
            updateMiniUI: updateMiniUI,
            bridgeDecision: bridgeDecision,
            clampPanelGeometry: clampPanelGeometry,
            panelRatiosFromGeometry: panelRatiosFromGeometry,
            panelGeometryFromRatios: panelGeometryFromRatios,
            getCurrentBvid: getCurrentBvid,
            probeCollection: probeCollection,
            formatCollectionError: formatCollectionError,
            buildCollectionImportPayload: buildCollectionImportPayload,
            getCollectionProbeState: () => ({
                bvid: collectionProbeBvid,
                available: !!collectionSummaryState,
                summary: collectionSummaryState,
                inFlight: collectionProbeInFlight,
                token: collectionProbeToken
            })
        });
    }

    buildUI();
    if (!built) {
        const t = setInterval(() => { if (document.body) { buildUI(); if (built) clearInterval(t); } }, 300);
        setTimeout(() => clearInterval(t), 8000);
    }
    setInterval(() => { if (built) updateAddBtn(); }, 2000);
    handlePlayerCmd({ cmd: 'getStatus' }).then(r => {
        if (r && r.ok) {
            playerState.playing = !!r.playing;
            playerState.hasTrack = !!r.hasTrack;
            updateMiniUI();
        }
    });
})();
