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
    const PANEL_URL = chrome.runtime.getURL('sidepanel.html');
    // 扩展自身源（如 chrome-extension://abc），用于桥接来源白名单；不用 new URL 以兼容更多环境
    const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/+$/, '');
    const Z = 2147483646;

    let shadow, hostEl, mini, miniPlay, panel, pframe, addBtn, addTxt, resizeGrip;
    let panelOpen = false;
    let frameLoaded = false;
    let built = false;
    let posX = null, posY = null, panelWidth = null, panelHeight = null;

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

    function isBiliVideo() {
        return /(^|\.)bilibili\.com$/.test(location.hostname) && /^\/video\//.test(location.pathname);
    }

    // ===================== 音频播放（offscreen 唯一宿主，命令一律经后台转发，无兜底） =====================
    const PLAYER_CMDS = { toggle: 1, next: 1, prev: 1, playIndex: 1, seek: 1, getStatus: 1, stop: 1, setMode: 1, setVolume: 1, setMute: 1, getVolume: 1 };
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
    function handlePlayerCmd(payload) { return sendBgPlayer(payload, 15000); }
    // =================================================================================

    const PLAY_D = 'M8 5v14l11-7z';
    const PAUSE_D = 'M6 5h4v14H6zm8 0h4v14h-4z';

    const CSS =
        '*{box-sizing:border-box}' +
        '.mini,.panel{position:fixed;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}' +

        '.mini{right:20px;bottom:90px;z-index:' + Z + ';display:flex;align-items:center;justify-content:flex-end;' +
        'width:24px;height:24px;border-radius:12px;background:#232327;border:1px solid #3a3a3f;' +
        'cursor:pointer;user-select:none;overflow:hidden;opacity:.4;' +
        'box-shadow:0 3px 12px rgba(0,0,0,.45);' +
        'transition:width .36s cubic-bezier(.34,1.56,.64,1),height .36s cubic-bezier(.34,1.56,.64,1),' +
        'border-radius .36s,opacity .22s,background .25s,border-color .25s,box-shadow .3s;' +
        'animation:miniIn .5s cubic-bezier(.34,1.56,.64,1) backwards}' +
        '.mini:hover{opacity:1;border-color:#55555c}' +
        '.mini.loaded{width:112px;height:32px;border-radius:16px;opacity:.75;cursor:default;background:#202024}' +
        '.mini.loaded:hover{opacity:1}' +
        '.mini.playing{opacity:1;border-color:#fb7299;box-shadow:0 3px 18px rgba(251,114,153,.4)}' +
        '.mini.dragging{transition:none;opacity:1}' +
        '@keyframes miniIn{from{transform:scale(0)}to{transform:scale(1)}}' +

        '.m-controls{display:none;align-items:center;gap:2px;padding-left:6px}' +
        '.mini.loaded .m-controls{display:flex}' +

        '.m-core{flex:none;position:relative;width:24px;height:24px;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;cursor:pointer}' +
        '.mini.loaded .m-core{margin:0 4px 0 2px}' +

        '.m-ico{font-size:12px;color:#fb7299;line-height:1;transition:opacity .2s}' +
        '.mini.loaded .m-ico{opacity:0}' +

        '.m-spec{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;' +
        'gap:2px;padding:5px 4px 6px;opacity:0;transition:opacity .25s}' +
        '.mini.loaded .m-spec{opacity:1}' +
        '.m-spec i{width:3px;border-radius:1.5px;background:#fb7299;height:20%;transition:height .25s,background .2s}' +
        '.mini.playing .m-spec i{animation:specB .9s ease-in-out infinite}' +
        '.mini.playing .m-spec i:nth-child(2){animation-delay:.18s}' +
        '.mini.playing .m-spec i:nth-child(3){animation-delay:.36s}' +
        '.mini.playing .m-spec i:nth-child(4){animation-delay:.1s}' +
        '.m-spec:hover i{background:#fc8bab}' +
        '@keyframes specB{0%,100%{height:18%}50%{height:100%}}' +

        '.m-btn{flex:none;width:24px;height:24px;border:none;border-radius:50%;background:transparent;' +
        'color:#ddd;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'transition:background .15s,color .15s,transform .15s}' +
        '.m-btn svg{display:block}' +
        '.m-btn:hover{background:#33333a;color:#fff;transform:scale(1.12)}' +
        '.m-btn:active{transform:scale(.86)}' +
        '.m-btn.m-play{background:#fb7299;color:#fff}' +
        '.m-btn.m-play:hover{background:#fc8bab}' +

        '.panel{z-index:' + (Z + 1) + ';width:340px;height:540px;max-width:92vw;' +
        'max-height:calc(100vh - 160px);right:20px;bottom:146px;' +
        'background:#18191c;border:1px solid #33333a;border-top:2px solid #fb7299;border-radius:12px;' +
        'overflow:hidden;display:flex;flex-direction:column;box-shadow:0 14px 44px rgba(0,0,0,.6);' +
        'transform-origin:100% 100%;opacity:0;visibility:hidden;transform:scale(.55) translateY(18px);' +
        'transition:opacity .2s ease,transform .28s cubic-bezier(.34,1.56,.64,1),visibility 0s linear .28s}' +
        '.panel.open{opacity:1;visibility:visible;transform:none;' +
        'transition:opacity .18s ease,transform .3s cubic-bezier(.34,1.56,.64,1),visibility 0s}' +
        '.panel.sized{max-width:calc(100vw - 8px);max-height:calc(100vh - 8px)}' +
        '.panel.dragging,.panel.resizing{transition:none}' +
        '.panel.dragging .pframe,.panel.resizing .pframe{pointer-events:none}' +

        '.phead{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;background:#202024;' +
        'border-bottom:1px solid #2b2b2f;cursor:move;user-select:none;min-height:30px}' +
        '.gripbar{flex:1;font-size:13px;color:#4a4a52;line-height:1;letter-spacing:1px}' +
        '.pbtn{flex:none;width:26px;height:26px;border:none;border-radius:6px;background:#2b2b2f;' +
        'color:#ccc;font-size:15px;line-height:1;cursor:pointer;transition:.13s}' +
        '.pbtn:hover{background:#3a3a3f;color:#fff}' +
        '.pbtn.add{color:#fb7299;font-size:13px;width:auto;padding:0 9px;font-weight:600}' +
        '.pbtn.add:hover{background:#2a2026}' +
        '.pbody{flex:1;min-height:0;position:relative}' +
        '.pframe{width:100%;height:100%;border:none;display:block;background:#18191c}' +
        '.resize-grip{position:absolute;right:0;bottom:0;z-index:3;width:18px;height:18px;' +
        'cursor:nwse-resize;color:#777982;touch-action:none}' +
        '.resize-grip::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;' +
        'border-right:2px solid currentColor;border-bottom:2px solid currentColor}';

    function buildUI() {
        if (built || document.getElementById(HOST_ID)) return;
        if (!document.body) return;
        built = true;

        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:' + Z;
        hostEl = host;
        shadow = host.attachShadow({ mode: 'closed' });
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
            '<button class="pbtn add" title="把当前B站视频加入歌单" style="display:none"><span class="addtxt">＋加入</span></button>' +
            '</div>' +
            '<div class="pbody"><iframe class="pframe" title="playlist" allow="autoplay"></iframe></div>' +
            '<div class="resize-grip" title="调整面板大小"></div>' +
            '</div>';

        mini = shadow.querySelector('.mini');
        miniPlay = shadow.querySelector('.m-play');
        panel = shadow.querySelector('.panel');
        pframe = shadow.querySelector('.pframe');
        addBtn = shadow.querySelector('.add');
        addTxt = shadow.querySelector('.addtxt');
        resizeGrip = shadow.querySelector('.resize-grip');

        makeMiniDraggable();
        addBtn.addEventListener('click', addCurrent);
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

        chrome.storage.local.get('bpl_mini').then(r => {
            const p = (r && r.bpl_mini) || {};
            if (typeof p.right === 'number' && typeof p.bottom === 'number') {
                mini.style.right = Math.max(4, Math.min(p.right, window.innerWidth - 40)) + 'px';
                mini.style.bottom = Math.max(4, Math.min(p.bottom, window.innerHeight - 40)) + 'px';
            }
        }).catch(e => reviveIfDead(e));

        // 恢复面板位置与用户调整后的尺寸。开合状态仍不持久化：新页面/刷新后一律默认收起。
        chrome.storage.local.get(STORE_KEY).then(r => {
            const p = (r && r[STORE_KEY]) || {};
            const hasPosition = typeof p.x === 'number' && typeof p.y === 'number';
            const hasSize = typeof p.width === 'number' && typeof p.height === 'number';
            if (hasPosition || hasSize) {
                const width = hasSize ? p.width : panel.offsetWidth;
                const height = hasSize ? p.height : panel.offsetHeight;
                const x = hasPosition ? p.x : window.innerWidth - width - 20;
                const y = hasPosition ? p.y : window.innerHeight - height - 146;
                applyPanelGeometry(clampPanelGeometry(x, y, width, height, window.innerWidth, window.innerHeight));
            }
        }).catch(e => reviveIfDead(e));
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
    }

    let viewportPersistTimer = null;
    function keepPanelInViewport() {
        if (!panel || !panel.classList.contains('sized')) return;
        applyPanelGeometry(clampPanelGeometry(
            posX, posY, panelWidth, panelHeight, window.innerWidth, window.innerHeight
        ));
        if (viewportPersistTimer) clearTimeout(viewportPersistTimer);
        viewportPersistTimer = setTimeout(persist, 150);
    }

    function persist() {
        if (posX == null || posY == null || panelWidth == null || panelHeight == null) return;
        try {
            chrome.storage.local.set({
                [STORE_KEY]: { x: posX, y: posY, width: panelWidth, height: panelHeight }
            });
        } catch (e) { reviveIfDead(e); }
    }

    function ensureFrame() {
        if (frameLoaded) return;
        frameLoaded = true;
        pframe.src = PANEL_URL;
    }

    function toggle(open) {
        panelOpen = (open == null) ? !panelOpen : !!open;
        panel.classList.toggle('open', panelOpen);
        if (panelOpen) { ensureFrame(); updateAddBtn(); }
    }

    function updateAddBtn() {
        if (addBtn) addBtn.style.display = isBiliVideo() ? '' : 'none';
    }

    function addCurrent() {
        if (!isBiliVideo()) return;
        const m = location.pathname.match(/(BV[0-9A-Za-z]+)/);
        if (!m) return;
        const bvid = m[1];
        const page = Math.max(1, parseInt(new URLSearchParams(location.search).get('p'), 10) || 1);
        const old = addTxt.textContent;
        addTxt.textContent = '加入中…';
        chrome.runtime.sendMessage({ target: 'bg', cmd: 'add', bvid: bvid, page: page, fallbackTitle: document.title }, res => {
            if (chrome.runtime.lastError) { addTxt.textContent = old; return; }
            addTxt.textContent = (res && res.dup) ? '已在列表' : '已加入';
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
        const end = () => {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('dragging');
            persist();
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
        const end = () => {
            if (!resizing) return;
            resizing = false;
            el.classList.remove('resizing');
            persist();
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
    //   'player'        播放命令：危害仅为控制播放，任意非网页源放行（兼容个别环境扩展 iframe 源被序列化为 'null'）
    //   'forward'       通用命令（歌单增删改/openTab 等）：仅扩展自身源放行
    //   'reject-http'   网页源（http/https，浏览器设定、不可伪造）一律拒绝
    //   'reject-origin' 非扩展源发起的通用命令拒绝——堵住“只拒 http(s)+任意透传”的越权面
    function bridgeDecision(origin, cmd) {
        if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return 'reject-http';
        if (cmd && PLAYER_CMDS[cmd]) return 'player';
        if (origin !== EXT_ORIGIN) return 'reject-origin';
        return 'forward';
    }

    window.addEventListener('message', e => {
        const d = e.data;
        if (!d || d.bplBridge !== 'req') return;
        const payload = d.payload;
        const decision = bridgeDecision(e.origin, payload && payload.cmd);
        if (decision === 'reject-http') return;
        if (!frameLoaded || !pframe || !pframe.contentWindow) return;
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
            clampPanelGeometry: clampPanelGeometry
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
