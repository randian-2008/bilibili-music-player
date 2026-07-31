const DEF_STATE = { playlistId: null, index: 0, playing: false, mode: 'loop' };
const P_MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
const audio = document.getElementById('player');
let curIndex = -1;
let shuffleOrder = [];
let shufflePos = -1;
let curBlobUrl = null;

function normMode(st) {
    if (P_MODES.indexOf(st.mode) >= 0) return st.mode;
    if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
    return st.loop ? 'loop' : 'order';
}
function pGetState() {
    return chrome.storage.local.get('bpl_state').then(r => {
        const st = Object.assign({}, DEF_STATE, r.bpl_state || {});
        st.mode = normMode(st);
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
function broadcastState(st) {
    const out = Object.assign({}, st, { hasTrack: !!audio.src });
    chrome.runtime.sendMessage({ target: 'all', type: 'state', state: out }).catch(() => {});
}
async function pSetState(patch) {
    const st = await pGetState();
    Object.assign(st, patch);
    await chrome.storage.local.set({ bpl_state: st });
    broadcastState(st);
    return st;
}
async function pEnsurePlaylist() {
    const st = await pGetState();
    if (st.playlistId) return st;
    const activeId = (await chrome.storage.local.get('bpl_active')).bpl_active;
    if (activeId) return await pSetState({ playlistId: activeId });
    return st;
}
let port = null;
let reqId = 0;
const pendingReq = {};

function connectAudioPort() {
    let p;
    try {
        p = chrome.runtime.connect({ name: 'bpl-audio' });
    } catch (e) {
        setTimeout(() => connectAudioPort(), 500);
        return;
    }
    port = p;
    p.onMessage.addListener(msg => {
        if (!msg || msg._id == null) return;
        if (msg.cmd) {
            handleCmd(msg).then(res => {
                try { p.postMessage({ _id: msg._id, result: res || { ok: true } }); } catch (e) {}
            }).catch(e => {
                try { p.postMessage({ _id: msg._id, result: { ok: false, error: String((e && e.message) || e) } }); } catch (_) {}
            });
            return;
        }
        if (pendingReq[msg._id]) {
            const cb = pendingReq[msg._id];
            delete pendingReq[msg._id];
            cb(msg.result);
        }
    });
    p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        setTimeout(() => connectAudioPort(), 500);
    });
}

function bgResolveAudio(it) {
    return new Promise(res => {
        const id = ++reqId;
        pendingReq[id] = result => res(result || { ok: false, error: '获取音频失败（后台无响应）' });
        const trySend = () => {
            if (!port) { setTimeout(trySend, 100); return; }
            try {
                port.postMessage({ _id: id, resolveAudio: { bvid: it.bvid, cid: it.cid || 0, page: it.page || 1 } });
            } catch (e) {
                delete pendingReq[id];
                res({ ok: false, error: String((e && e.message) || e) });
            }
        };
        trySend();
        setTimeout(() => {
            if (pendingReq[id]) { delete pendingReq[id]; res({ ok: false, error: '获取音频失败（后台超时）' }); }
        }, 8000);
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

async function tryPlayUrl(url) {
    audio.src = url;
    try {
        await audio.play();
        return { ok: true };
    } catch (e) {
        if (e && e.name === 'NotAllowedError') return { blocked: true };
    }
    try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        if (curBlobUrl) URL.revokeObjectURL(curBlobUrl);
        curBlobUrl = URL.createObjectURL(blob);
        audio.src = curBlobUrl;
        await audio.play();
        return { ok: true };
    } catch (e) {
        if (e && e.name === 'NotAllowedError') return { blocked: true };
        return { ok: false };
    }
}

async function pPlayIndex(i, keepOrder) {
    const items = await pGetItems();
    if (!items.length) return { ok: false, error: '当前播放的歌单为空' };
    if (i < 0 || i >= items.length) return { ok: false, error: '播放索引越界 (' + i + '/' + items.length + ')' };
    const st = await pGetState();
    if (pIsShuffle(st.mode) && !keepOrder) pBuildFrom(items.length, i);
    const it = items[i];
    const r = await bgResolveAudio(it);
    if (!r || !r.ok || !r.urls || !r.urls.length) return { ok: false, error: (r && r.error) || '获取音频失败' };
    let blocked = false;
    for (const url of r.urls) {
        const res = await tryPlayUrl(url);
        if (res.ok) {
            curIndex = i;
            setupMediaSession(it);
            await pSetState({ index: i, playing: true });
            return { ok: true };
        }
        if (res.blocked) { blocked = true; break; }
    }
    audio.removeAttribute('src');
    audio.load();
    broadcastState(await pGetState());
    return {
        ok: false,
        error: blocked
            ? '浏览器阻止了自动播放：请先点一下页面任意位置或浮动按钮，再点播放'
            : '无法播放该音频（已尝试 ' + r.urls.length + ' 个音源）'
    };
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

function setupMediaSession(it) {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: it.title || '',
            artist: it.owner || 'Bilibili',
            album: 'B站听歌列表',
            artwork: it.pic ? [{ src: it.pic, sizes: '512x512', type: 'image/jpeg' }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => { audio.play().catch(() => {}); });
        navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => { pPrev(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { pNext(); });
    } catch (e) {}
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
audio.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    pSetState({ playing: true });
});
audio.addEventListener('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    pSetState({ playing: false });
});

chrome.storage.local.get(['bpl_volume', 'bpl_mute']).then(r => {
    if (typeof r.bpl_volume === 'number') audio.volume = Math.max(0, Math.min(1, r.bpl_volume));
    if (typeof r.bpl_mute === 'boolean') audio.muted = r.bpl_mute;
});

setInterval(() => {
    if (!audio.src) return;
    chrome.runtime.sendMessage({
        target: 'all', type: 'progress',
        position: audio.currentTime || 0,
        duration: audio.duration || 0,
        playing: !audio.paused
    }).catch(() => {});
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
        try {
            navigator.mediaSession.setPositionState({
                duration: audio.duration || 0,
                position: audio.currentTime || 0,
                playbackRate: audio.playbackRate || 1
            });
        } catch (e) {}
    }
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

async function handleCmd(msg) {
    switch (msg.cmd) {
        case 'toggle': return await pToggle();
        case 'next': return await pNext();
        case 'prev': return await pPrev();
        case 'playIndex': await pEnsurePlaylist(); return await pPlayIndex(msg.index);
        case 'seek': audio.currentTime = msg.value || 0; return { ok: true };
        case 'getStatus': return { ok: true, position: audio.currentTime || 0, duration: audio.duration || 0, playing: !audio.paused, index: curIndex, hasTrack: !!audio.src };
        case 'stop':
            audio.pause(); audio.removeAttribute('src'); audio.load();
            if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; }
            curIndex = -1; shuffleOrder = []; shufflePos = -1;
            await pSetState({ playing: false });
            return { ok: true };
        case 'setMode': {
            const st = await pGetState();
            const mode = P_MODES.indexOf(msg.mode) >= 0 ? msg.mode : st.mode;
            shuffleOrder = []; shufflePos = -1;
            await pSetState({ mode: mode });
            return { ok: true };
        }
        case 'setVolume': {
            const v = Math.max(0, Math.min(1, Number(msg.value)));
            audio.volume = v;
            chrome.storage.local.set({ bpl_volume: v });
            return { ok: true, volume: v, muted: audio.muted };
        }
        case 'setMute': {
            audio.muted = !!msg.muted;
            chrome.storage.local.set({ bpl_mute: audio.muted });
            return { ok: true, volume: audio.volume, muted: audio.muted };
        }
        case 'getVolume': return { ok: true, volume: audio.volume, muted: audio.muted };
        default: return { ok: false };
    }
}

connectAudioPort();
pGetState().then(st => broadcastState(st));
