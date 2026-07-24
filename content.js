(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (!/^https?:$/.test(location.protocol)) return;

    const HOST_ID = 'bpl-ext-host';
    const STORE_KEY = 'bpl_panel';
    const PANEL_URL = chrome.runtime.getURL('sidepanel.html');
    const Z = 2147483646;

    let shadow, hostEl, mini, miniPlay, panel, pframe, addBtn, addTxt;
    let panelOpen = false;
    let frameLoaded = false;
    let built = false;
    let posX = null, posY = null;

    function isBiliVideo() {
        return /(^|\.)bilibili\.com$/.test(location.hostname) && /^\/video\//.test(location.pathname);
    }

    // ===================== 音频播放器（在本内容脚本内直接播放） =====================
    const audio = new Audio();
    let curIndex = -1;
    let shuffleOrder = [];
    let shufflePos = -1;
    const P_DEF = { playlistId: null, index: 0, playing: false, mode: 'loop' };
    const P_MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
    const PLAYER_CMDS = { toggle: 1, next: 1, prev: 1, playIndex: 1, seek: 1, getStatus: 1, stop: 1, setMode: 1, setVolume: 1, setMute: 1, getVolume: 1 };

    function pNormMode(st) {
        if (P_MODES.indexOf(st.mode) >= 0) return st.mode;
        if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
        return st.loop ? 'loop' : 'order';
    }
    function pGetState() {
        return chrome.storage.local.get('bpl_state').then(r => {
            const st = Object.assign({}, P_DEF, r.bpl_state || {});
            st.mode = pNormMode(st);
            return st;
        });
    }
    function pGetPlaylists() {
        return chrome.storage.local.get('bpl_playlists').then(r => r.bpl_playlists || []);
    }
    async function pGetItems() {
        const st = await pGetState();
        const pls = await pGetPlaylists();
        const pl = pls.find(p => p.id === st.playlistId);
        return pl ? pl.items : [];
    }
    async function pSetState(patch) {
        const st = await pGetState();
        Object.assign(st, patch);
        await chrome.storage.local.set({ bpl_state: st });
        forwardBroadcast({ target: 'all', type: 'state', state: st });
        return st;
    }
    async function pEnsurePlaylist() {
        const st = await pGetState();
        if (st.playlistId) return st;
        const activeId = (await chrome.storage.local.get('bpl_active')).bpl_active;
        if (activeId) return await pSetState({ playlistId: activeId });
        return st;
    }
    function bgResolveAudio(it) {
        return new Promise(res => {
            try {
                chrome.runtime.sendMessage(
                    { target: 'bg', cmd: 'resolveAudio', bvid: it.bvid, cid: it.cid || 0, page: it.page || 1 },
                    r => res(r || { ok: false, error: '获取音频失败（后台无响应）' })
                );
            } catch (e) {
                res({ ok: false, error: String((e && e.message) || e) });
            }
        });
    }
    function pShuffled(count) {
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(i);
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }
    function pBuildAfter(count, played) {
        shuffleOrder = pShuffled(count).filter(i => i !== played).concat([played]);
        shufflePos = 0;
    }
    function pBuildFrom(count, first) {
        shuffleOrder = [first].concat(pShuffled(count).filter(i => i !== first));
        shufflePos = 0;
    }
    function pIsShuffle(mode) { return mode === 'shuffle' || mode === 'shuffleLoop'; }

    async function pPlayIndex(i, keepOrder) {
        const items = await pGetItems();
        if (!items.length) return { ok: false, error: '当前播放的歌单为空' };
        if (i < 0 || i >= items.length) return { ok: false, error: '播放索引越界 (' + i + '/' + items.length + ')' };
        const st = await pGetState();
        if (pIsShuffle(st.mode) && !keepOrder) pBuildFrom(items.length, i);
        const it = items[i];
        const r = await bgResolveAudio(it);
        if (!r || !r.ok || !r.url) return { ok: false, error: (r && r.error) || '获取音频失败' };
        try {
            curIndex = i;
            audio.src = r.url;
            await audio.play();
            await pSetState({ index: i, playing: true });
            return { ok: true };
        } catch (e) {
            const msg = String((e && e.message) || e);
            const blocked = /autoplay|play\(\)|user (didn|did not)|gesture|not allowed/i.test(msg);
            return { ok: false, error: blocked ? '浏览器阻止了自动播放：请先点一下页面任意位置或浮动按钮，再点播放' : msg };
        }
    }
    async function pStopPlayback() {
        audio.pause();
        await pSetState({ playing: false });
        return { ok: true };
    }
    async function pAdvance() {
        const items = await pGetItems();
        const st = await pGetState();
        if (!items.length) return { ok: false, error: '当前播放的歌单为空' };
        const mode = st.mode;
        if (pIsShuffle(mode)) {
            if (shuffleOrder.length !== items.length) { pBuildAfter(items.length, st.index); return await pPlayIndex(shuffleOrder[shufflePos], true); }
            if (shufflePos < shuffleOrder.length - 1) { shufflePos++; return await pPlayIndex(shuffleOrder[shufflePos], true); }
            if (mode === 'shuffleLoop') { pBuildAfter(items.length, st.index); return await pPlayIndex(shuffleOrder[shufflePos], true); }
            return await pStopPlayback();
        }
        const wrap = (mode === 'loop' || mode === 'one');
        let n = st.index + 1;
        if (n >= items.length) { if (wrap) n = 0; else return await pStopPlayback(); }
        return await pPlayIndex(n, true);
    }
    async function pNext() { return await pAdvance(); }
    async function pPrev() {
        const items = await pGetItems();
        const st = await pGetState();
        if (!items.length) return { ok: false, error: '当前播放的歌单为空' };
        if (audio.currentTime > 3) { audio.currentTime = 0; return { ok: true }; }
        if (pIsShuffle(st.mode) && shuffleOrder.length === items.length && shufflePos > 0) {
            shufflePos--;
            return await pPlayIndex(shuffleOrder[shufflePos], true);
        }
        let n = st.index - 1;
        if (n < 0) n = (st.mode === 'loop' || st.mode === 'shuffleLoop') ? items.length - 1 : 0;
        return await pPlayIndex(n, true);
    }
    async function pToggle() {
        if (audio.paused) {
            if (!audio.src) {
                await pEnsurePlaylist();
                const st = await pGetState();
                return await pPlayIndex(st.index);
            }
            try { await audio.play(); } catch (e) {
                return { ok: false, error: '浏览器阻止了自动播放：请先点一下页面或浮动按钮再试' };
            }
            await pSetState({ playing: true });
        } else {
            audio.pause();
            await pSetState({ playing: false });
        }
        return { ok: true };
    }
    async function handlePlayerCmd(payload) {
        switch (payload.cmd) {
            case 'toggle': return await pToggle();
            case 'next': return await pNext();
            case 'prev': return await pPrev();
            case 'playIndex': await pEnsurePlaylist(); return await pPlayIndex(payload.index);
            case 'seek': audio.currentTime = payload.value || 0; return { ok: true };
            case 'getStatus': return { ok: true, position: audio.currentTime || 0, duration: audio.duration || 0, playing: !audio.paused, index: curIndex };
            case 'stop':
                audio.pause(); audio.removeAttribute('src'); audio.load();
                curIndex = -1; shuffleOrder = []; shufflePos = -1;
                await pSetState({ playing: false });
                return { ok: true };
            case 'setMode': {
                const st = await pGetState();
                const mode = P_MODES.indexOf(payload.mode) >= 0 ? payload.mode : st.mode;
                shuffleOrder = []; shufflePos = -1;
                await pSetState({ mode: mode });
                return { ok: true };
            }
            case 'setVolume': {
                const v = Math.max(0, Math.min(1, Number(payload.value)));
                audio.volume = v;
                chrome.storage.local.set({ bpl_volume: v });
                return { ok: true, volume: v, muted: audio.muted };
            }
            case 'setMute': {
                audio.muted = !!payload.muted;
                chrome.storage.local.set({ bpl_mute: audio.muted });
                return { ok: true, volume: audio.volume, muted: audio.muted };
            }
            case 'getVolume':
                return { ok: true, volume: audio.volume, muted: audio.muted };
            default: return { ok: false };
        }
    }

    audio.addEventListener('ended', async () => {
        const st = await pGetState();
        if (st.mode === 'one') {
            audio.currentTime = 0;
            try { await audio.play(); } catch (e) {}
            await pSetState({ playing: true });
        } else {
            pAdvance();
        }
    });
    audio.addEventListener('play', updateMiniUI);
    audio.addEventListener('pause', updateMiniUI);
    audio.addEventListener('emptied', updateMiniUI);
    chrome.storage.local.get(['bpl_volume', 'bpl_mute']).then(r => {
        if (typeof r.bpl_volume === 'number') audio.volume = Math.max(0, Math.min(1, r.bpl_volume));
        if (typeof r.bpl_mute === 'boolean') audio.muted = r.bpl_mute;
    });
    setInterval(() => {
        if (!audio.src) return;
        forwardBroadcast({
            target: 'all', type: 'progress',
            position: audio.currentTime || 0,
            duration: audio.duration || 0,
            playing: !audio.paused
        });
    }, 1000);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.bpl_playlists) return;
        shuffleOrder = []; shufflePos = -1;
        pGetItems().then(items => {
            if (!items.length && audio.src) {
                audio.pause(); audio.removeAttribute('src'); audio.load(); curIndex = -1;
            }
        });
    });
    // =================================================================================

    const CSS =
        '.mini,.panel{position:fixed;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif}' +

        '.mini{right:20px;bottom:90px;z-index:' + Z + ';display:flex;align-items:center;justify-content:center;' +
        'width:24px;height:24px;border-radius:12px;background:#232327;border:1px solid #3a3a3f;' +
        'cursor:pointer;user-select:none;overflow:hidden;opacity:.4;' +
        'box-shadow:0 3px 12px rgba(0,0,0,.45);' +
        'transition:width .34s cubic-bezier(.34,1.56,.64,1),height .34s cubic-bezier(.34,1.56,.64,1),' +
        'border-radius .34s,opacity .22s,background .25s,border-color .25s,box-shadow .3s;' +
        'animation:miniIn .5s cubic-bezier(.34,1.56,.64,1) backwards}' +
        '.mini:hover{opacity:1;border-color:#55555c}' +
        '.mini.loaded{width:150px;height:36px;border-radius:18px;opacity:.75;cursor:default;background:#202024}' +
        '.mini.playing{opacity:1;border-color:#fb7299;box-shadow:0 3px 18px rgba(251,114,153,.4)}' +
        '@keyframes miniIn{from{transform:scale(0)}to{transform:scale(1)}}' +

        '.m-ico{font-size:12px;color:#fb7299;line-height:1;flex:none}' +
        '.mini.loaded .m-ico{display:none}' +

        '.m-ui{display:none;align-items:center;width:100%;padding:0 7px 0 9px}' +
        '.mini.loaded .m-ui{display:flex}' +

        '.m-spec{flex:none;margin-right:auto;display:flex;align-items:flex-end;gap:2.5px;height:16px;' +
        'padding:0 3px;cursor:pointer;background:none;border:none}' +
        '.m-spec i{width:3px;border-radius:1.5px;background:#fb7299;height:22%;transition:height .25s,background .2s}' +
        '.mini.playing .m-spec i{animation:specB .9s ease-in-out infinite}' +
        '.mini.playing .m-spec i:nth-child(2){animation-delay:.18s}' +
        '.mini.playing .m-spec i:nth-child(3){animation-delay:.36s}' +
        '.mini.playing .m-spec i:nth-child(4){animation-delay:.1s}' +
        '.mini.playing .m-spec i:nth-child(5){animation-delay:.28s}' +
        '.m-spec:hover i{background:#fc8bab}' +
        '@keyframes specB{0%,100%{height:18%}50%{height:100%}}' +

        '.m-btn{flex:none;width:26px;height:26px;border:none;border-radius:50%;background:transparent;' +
        'color:#ddd;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'transition:background .15s,color .15s,transform .15s;margin-left:2px}' +
        '.m-btn:hover{background:#33333a;color:#fff;transform:scale(1.1)}' +
        '.m-btn:active{transform:scale(.88)}' +
        '.m-btn.m-play{background:#fb7299;color:#fff;font-size:11px}' +
        '.m-btn.m-play:hover{background:#fc8bab}' +

        '.panel{z-index:' + (Z + 1) + ';width:340px;height:540px;max-width:92vw;' +
        'max-height:calc(100vh - 160px);right:20px;bottom:146px;' +
        'background:#18191c;border:1px solid #33333a;border-top:2px solid #fb7299;border-radius:12px;' +
        'overflow:hidden;display:flex;flex-direction:column;box-shadow:0 14px 44px rgba(0,0,0,.6);' +
        'transform-origin:100% 100%;opacity:0;visibility:hidden;transform:scale(.55) translateY(18px);' +
        'transition:opacity .2s ease,transform .28s cubic-bezier(.34,1.56,.64,1),visibility 0s linear .28s}' +
        '.panel.open{opacity:1;visibility:visible;transform:none;' +
        'transition:opacity .18s ease,transform .3s cubic-bezier(.34,1.56,.64,1),visibility 0s}' +

        '.phead{flex:none;display:flex;align-items:center;gap:6px;padding:9px 10px;background:#202024;' +
        'border-bottom:1px solid #2b2b2f;cursor:move;user-select:none}' +
        '.ptitle{flex:1;font-size:13px;font-weight:600;color:#e6e6e6;letter-spacing:.3px}' +
        '.pbtn{flex:none;width:26px;height:26px;border:none;border-radius:6px;background:#2b2b2f;' +
        'color:#ccc;font-size:15px;line-height:1;cursor:pointer;transition:.13s}' +
        '.pbtn:hover{background:#3a3a3f;color:#fff}' +
        '.pbtn.add{color:#fb7299;font-size:16px;width:auto;padding:0 9px;font-weight:600}' +
        '.pbtn.add:hover{background:#2a2026}' +
        '.pbody{flex:1;min-height:0;position:relative}' +
        '.pframe{width:100%;height:100%;border:none;display:block;background:#18191c}';

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
            '<span class="m-ico">♪</span>' +
            '<div class="m-ui">' +
            '<button class="m-spec" title="展开播放列表"><i></i><i></i><i></i><i></i><i></i></button>' +
            '<button class="m-btn m-prev" title="上一首">⏮</button>' +
            '<button class="m-btn m-play" title="播放/暂停">▶</button>' +
            '<button class="m-btn m-next" title="下一首">⏭</button>' +
            '</div>' +
            '</div>' +
            '<div class="panel">' +
            '<div class="phead">' +
            '<span class="ptitle">♪ B站听歌列表</span>' +
            '<button class="pbtn add" title="把当前B站视频加入歌单" style="display:none"><span class="addtxt">＋加入</span></button>' +
            '<button class="pbtn close" title="收起面板">×</button>' +
            '</div>' +
            '<div class="pbody"><iframe class="pframe" title="playlist" allow="autoplay"></iframe></div>' +
            '</div>';

        mini = shadow.querySelector('.mini');
        miniPlay = shadow.querySelector('.m-play');
        panel = shadow.querySelector('.panel');
        pframe = shadow.querySelector('.pframe');
        addBtn = shadow.querySelector('.add');
        addTxt = shadow.querySelector('.addtxt');

        mini.addEventListener('click', e => {
            if (e.target.closest('.m-spec')) { toggle(); return; }
            if (e.target.closest('.m-prev')) { pPrev(); return; }
            if (e.target.closest('.m-play')) { pToggle(); return; }
            if (e.target.closest('.m-next')) { pNext(); return; }
            if (!mini.classList.contains('loaded')) toggle();
        });
        shadow.querySelector('.close').addEventListener('click', () => toggle(false));
        addBtn.addEventListener('click', addCurrent);
        makeDraggable(panel, shadow.querySelector('.phead'));

        document.body.appendChild(host);

        document.addEventListener('click', e => {
            if (!panelOpen) return;
            if (hostEl && hostEl.contains(e.target)) return;
            toggle(false);
        }, true);

        chrome.storage.local.get(STORE_KEY).then(r => {
            const p = (r && r[STORE_KEY]) || {};
            const valid = typeof p.x === 'number' && typeof p.y === 'number' &&
                (p.x > 8 || p.y > 8) &&
                p.x < window.innerWidth - 60 && p.y < window.innerHeight - 60;
            if (valid) {
                posX = p.x; posY = p.y;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.left = posX + 'px';
                panel.style.top = posY + 'px';
            }
            if (p.open) setTimeout(() => toggle(true), 60);
        });
        updateAddBtn();
        updateMiniUI();
    }

    function updateMiniUI() {
        if (!mini) return;
        const hasTrack = !!audio.src;
        const playing = hasTrack && !audio.paused;
        mini.classList.toggle('loaded', hasTrack);
        mini.classList.toggle('playing', playing);
        if (miniPlay) miniPlay.textContent = playing ? '⏸' : '▶';
    }

    function persist() {
        chrome.storage.local.set({ [STORE_KEY]: { open: panelOpen, x: posX, y: posY } });
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
        persist();
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
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        handle.addEventListener('pointerdown', e => {
            if (e.target.closest('.pbtn')) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect();
            ox = r.left; oy = r.top;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        });
        handle.addEventListener('pointermove', e => {
            if (!dragging) return;
            let nx = ox + e.clientX - sx;
            let ny = oy + e.clientY - sy;
            nx = Math.max(4, Math.min(nx, window.innerWidth - el.offsetWidth - 4));
            ny = Math.max(4, Math.min(ny, window.innerHeight - 44));
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
        });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            const r = el.getBoundingClientRect();
            posX = Math.round(r.left); posY = Math.round(r.top);
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
        if (msg.target === 'all') forwardBroadcast(msg);
    });

    window.addEventListener('message', e => {
        const d = e.data;
        if (!d || d.bplBridge !== 'req') return;
        if (typeof e.origin === 'string' && /^https?:\/\//.test(e.origin)) return;
        if (!frameLoaded || !pframe || !pframe.contentWindow) return;
        const payload = d.payload;
        const respond = res => {
            try { pframe.contentWindow.postMessage({ bplBridge: 'res', id: d.id, result: res }, '*'); } catch (_) {}
        };
        if (payload && PLAYER_CMDS[payload.cmd]) {
            handlePlayerCmd(payload).then(respond, err => respond({ ok: false, error: String((err && err.message) || err) }));
            return;
        }
        try {
            chrome.runtime.sendMessage(payload, res => respond(res));
        } catch (_) {}
    });

    if (typeof globalThis !== 'undefined' && typeof globalThis.__BPL_EXPOSE === 'function') {
        globalThis.__BPL_EXPOSE({
            audio: audio, bgResolveAudio: bgResolveAudio,
            pGetState: pGetState, pGetItems: pGetItems, pSetState: pSetState,
            pPlayIndex: pPlayIndex, pAdvance: pAdvance, pNext: pNext, pPrev: pPrev,
            pToggle: pToggle, handlePlayerCmd: handlePlayerCmd
        });
    }

    buildUI();
    if (!built) {
        const t = setInterval(() => { if (document.body) { buildUI(); if (built) clearInterval(t); } }, 300);
        setTimeout(() => clearInterval(t), 8000);
    }
    setInterval(() => { if (built) updateAddBtn(); }, 2000);
})();
