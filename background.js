const DEF_STATE = { playlistId: null, index: 0, playing: false, mode: 'loop' };

const MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
function normalizeMode(st) {
    if (MODES.indexOf(st.mode) >= 0) return st.mode;
    if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
    return st.loop ? 'loop' : 'order';
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function getPlaylists() {
    return (await chrome.storage.local.get('bpl_playlists')).bpl_playlists || [];
}
async function savePlaylists(p) { await chrome.storage.local.set({ bpl_playlists: p }); }
async function getActiveId() {
    return (await chrome.storage.local.get('bpl_active')).bpl_active || null;
}
async function setActiveId(id) { await chrome.storage.local.set({ bpl_active: id }); }
async function getState() {
    const st = Object.assign({}, DEF_STATE, (await chrome.storage.local.get('bpl_state')).bpl_state || {});
    st.mode = normalizeMode(st);
    return st;
}
async function saveState(s) { await chrome.storage.local.set({ bpl_state: s }); }
function findPl(lists, id) { return lists.find(p => p.id === id); }
function normUrl(u) {
    u = String(u || '');
    return u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u;
}

async function biliFetch(url) {
    const r = await fetch(url, { credentials: 'include' });
    return await r.json();
}
async function resolveCid(bvid, page) {
    const j = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    const d = j && j.data;
    if (!d) throw new Error((j && j.message) || '无法解析视频信息');
    const pages = d.pages || [];
    const pg = (page && pages.find(x => x.page === page)) || pages[0] || {};
    return { cid: pg.cid || d.cid || 0, info: d, page: pg };
}
async function getAudioUrls(bvid, cid) {
    const base = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid);
    const pushStreams = (list, urls) => {
        for (const a of list) {
            const main = a.baseUrl || a.base_url || a.url;
            if (main) urls.push(main);
            for (const b of (a.backupUrl || a.backup_url || [])) if (b) urls.push(b);
        }
    };
    const [jDash, jMp4] = await Promise.all([
        biliFetch(base + '&fnval=4048&fourk=1').catch(() => null),
        biliFetch(base + '&fnval=1').catch(() => null)
    ]);
    const urls = [];
    if (jDash && jDash.code === 0 && jDash.data && jDash.data.dash) {
        const dash = jDash.data.dash;
        const aud = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        const extra = [];
        if (dash.dolby && dash.dolby.audio && dash.dolby.audio.length) extra.push(...dash.dolby.audio);
        if (dash.flac && dash.flac.audio) extra.push(dash.flac.audio);
        pushStreams(aud, urls);
        pushStreams(extra, urls);
    }
    if (jMp4 && jMp4.code === 0 && jMp4.data && jMp4.data.durl && jMp4.data.durl.length) {
        pushStreams(jMp4.data.durl, urls);
    }
    if (!urls.length) {
        const msg = (jDash && jDash.message) || (jMp4 && jMp4.message);
        throw new Error('未获取到音频流' + (msg ? '：' + msg : '（可能需要登录B站或该视频无音频）'));
    }
    return [...new Set(urls)];
}
async function buildItem(bvid, page, fallbackTitle) {
    try {
        const r = await resolveCid(bvid, page);
        const d = r.info, pg = r.page;
        const multi = (d.pages || []).length > 1;
        return {
            bvid: d.bvid || bvid,
            cid: r.cid,
            title: (multi && pg.part) ? (d.title + ' · ' + pg.part) : (d.title || bvid),
            pic: normUrl(d.pic),
            owner: (d.owner && d.owner.name) || '',
            duration: pg.duration || d.duration || 0,
            page: page
        };
    } catch (e) {
        return { bvid: bvid, cid: 0, title: fallbackTitle || bvid, pic: '', owner: '', duration: 0, page: page };
    }
}

async function migrate() {
    const r = await chrome.storage.local.get(['bpl_playlists', 'bpl_list', 'bpl_state', 'bpl_active']);
    if (r.bpl_playlists && r.bpl_playlists.length) {
        if (!r.bpl_active) await setActiveId(r.bpl_playlists[0].id);
        return;
    }
    const items = r.bpl_list || [];
    const id = genId();
    await savePlaylists([{ id, name: '默认歌单', items }]);
    await setActiveId(id);
    if (r.bpl_state) {
        const st = Object.assign({}, DEF_STATE, r.bpl_state);
        st.playlistId = id;
        await saveState(st);
    }
    await chrome.storage.local.remove('bpl_list');
}

async function ensureDefaultPlaylist() {
    const lists = await getPlaylists();
    if (lists.length) return lists;
    const id = genId();
    const pls = [{ id, name: '默认歌单', items: [] }];
    await savePlaylists(pls);
    await setActiveId(id);
    return pls;
}

const OFFSCREEN_PATH = 'offscreen.html';
let creating = null;
let offscreenReady = false;

async function hasOffscreen() {
    if (chrome.offscreen.hasDocument) {
        try { return await chrome.offscreen.hasDocument(); } catch (e) {}
    }
    try {
        const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return !!(ctxs && ctxs.length);
    } catch (e) { return false; }
}
async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (creating) { await creating; return; }
    creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['AUDIO_PLAYBACK'],
        justification: '后台播放B站音频（跨页面持续播放）'
    }).finally(() => { creating = null; });
    await creating;
}
async function waitReady(timeout = 3000) {
    if (offscreenReady) return true;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'getStatus' });
            if (res && res.ok) { offscreenReady = true; return true; }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 120));
    }
    return false;
}
async function sendToOffscreen(msg) {
    let lastErr = '未知错误';
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await ensureOffscreen();
            await waitReady();
            const res = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
            if (res !== undefined) return res;
            throw new Error('offscreen 无响应');
        } catch (e) {
            lastErr = String((e && e.message) || e);
            offscreenReady = false;
            try { if (chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument(); } catch (_) {}
            await new Promise(r => setTimeout(r, 200));
        }
    }
    return { ok: false, error: '音频模块通信失败：' + lastErr };
}

function broadcast(msg) {
    chrome.runtime.sendMessage(Object.assign({ target: 'all' }, msg)).catch(() => {});
}

async function broadcastData() {
    const playlists = await getPlaylists();
    const activeId = await getActiveId();
    const state = await getState();
    broadcast({ type: 'data', playlists, activeId, state });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ready') { offscreenReady = true; return; }
    if (msg.target === 'bg') {
        handleBg(msg, sender)
            .then(res => sendResponse(res || { ok: true }))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
});

async function handleBg(msg, sender) {
    switch (msg.cmd) {
        case 'add': {
            const lists = await ensureDefaultPlaylist();
            let activeId = await getActiveId();
            let pl = findPl(lists, activeId);
            if (!pl) { pl = lists[0]; await setActiveId(pl.id); }
            const bvid = msg.bvid || (msg.item && msg.item.bvid);
            if (!bvid) return { ok: false };
            const page = msg.page || (msg.item && msg.item.page) || 1;
            const it = (msg.item && msg.item.cid) ? msg.item : await buildItem(bvid, page, msg.fallbackTitle);
            it.pic = normUrl(it.pic);
            if (pl.items.some(x => x.bvid === it.bvid && (x.cid || 0) === (it.cid || 0))) {
                return { ok: true, dup: true };
            }
            pl.items.push(it);
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'resolveAudio': {
            try {
                let cid = msg.cid || 0;
                if (!cid) cid = (await resolveCid(msg.bvid, msg.page || 1)).cid;
                if (!cid) return { ok: false, error: '无法解析视频 cid' };
                const urls = await getAudioUrls(msg.bvid, cid);
                return { ok: true, urls: urls };
            } catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
            }
        }
        case 'openTab': {
            if (msg.url) chrome.tabs.create({ url: msg.url });
            return { ok: true };
        }
        case 'player': {
            return await sendToOffscreen(msg.payload || {});
        }
        case 'remove': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            const i = msg.index;
            if (i >= 0 && i < pl.items.length) pl.items.splice(i, 1);
            const st = await getState();
            if (st.playlistId === pl.id) {
                if (st.index > i) st.index--;
                if (!pl.items.length) { st.playing = false; st.index = 0; }
                else if (st.index >= pl.items.length) st.index = pl.items.length - 1;
                await saveState(st);
            }
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'renameItem': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (pl && pl.items[msg.index]) {
                const t = String(msg.title || '').trim();
                if (t) pl.items[msg.index].title = t.slice(0, 200);
                await savePlaylists(lists);
                await broadcastData();
            }
            return { ok: true };
        }
        case 'batchRemove': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            const asc = [...new Set(msg.indices || [])].filter(i => i >= 0 && i < pl.items.length).sort((a, b) => a - b);
            if (!asc.length) return { ok: true };
            const st = await getState();
            for (let k = asc.length - 1; k >= 0; k--) pl.items.splice(asc[k], 1);
            if (st.playlistId === pl.id) {
                const before = asc.filter(x => x < st.index).length;
                st.index = Math.max(0, st.index - before);
                if (!pl.items.length) { st.playing = false; st.index = 0; }
                else if (st.index >= pl.items.length) st.index = pl.items.length - 1;
                await saveState(st);
            }
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true, count: asc.length };
        }
        case 'batchCopy':
        case 'batchMove': {
            const lists = await getPlaylists();
            const fromPl = findPl(lists, await getActiveId());
            const toPl = findPl(lists, msg.toId);
            if (!fromPl || !toPl) return { ok: false };
            const asc = [...new Set(msg.indices || [])].filter(i => i >= 0 && i < fromPl.items.length).sort((a, b) => a - b);
            if (!asc.length) return { ok: true };
            let added = 0;
            for (const i of asc) {
                const it = fromPl.items[i];
                if (it && !toPl.items.some(x => x.bvid === it.bvid && (x.cid || 0) === (it.cid || 0))) {
                    toPl.items.push(Object.assign({}, it));
                    added++;
                }
            }
            if (msg.cmd === 'batchMove') {
                const st = await getState();
                for (let k = asc.length - 1; k >= 0; k--) fromPl.items.splice(asc[k], 1);
                if (st.playlistId === fromPl.id) {
                    const before = asc.filter(x => x < st.index).length;
                    st.index = Math.max(0, st.index - before);
                    if (!fromPl.items.length) { st.playing = false; st.index = 0; }
                    else if (st.index >= fromPl.items.length) st.index = fromPl.items.length - 1;
                    await saveState(st);
                }
            }
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true, count: asc.length, added: added };
        }
        case 'moveItem': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            const from = msg.from, to = msg.to;
            if (from == null || to == null || from === to) return { ok: true };
            if (from < 0 || from >= pl.items.length || to < 0 || to >= pl.items.length) return { ok: false };
            const insertAt = from < to ? to - 1 : to;
            const [it] = pl.items.splice(from, 1);
            pl.items.splice(insertAt, 0, it);
            const st = await getState();
            if (st.playlistId === pl.id) {
                if (st.index === from) st.index = insertAt;
                else if (from < st.index && st.index <= insertAt) st.index--;
                else if (insertAt <= st.index && st.index < from) st.index++;
                await saveState(st);
            }
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'clear': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            pl.items = [];
            const st = await getState();
            if (st.playlistId === pl.id) {
                st.playing = false; st.index = 0;
                await saveState(st);
            }
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'createPlaylist': {
            const lists = await getPlaylists();
            const id = genId();
            const name = (msg.name && String(msg.name).trim()) || ('新歌单' + (lists.length + 1));
            lists.push({ id, name: name.slice(0, 100), items: [] });
            await savePlaylists(lists);
            await setActiveId(id);
            await broadcastData();
            return { ok: true, id };
        }
        case 'renamePlaylist': {
            const lists = await getPlaylists();
            const pl = findPl(lists, msg.id);
            if (pl && msg.name && String(msg.name).trim()) {
                pl.name = String(msg.name).trim().slice(0, 100);
                await savePlaylists(lists);
                await broadcastData();
            }
            return { ok: true };
        }
        case 'deletePlaylist': {
            const lists = await getPlaylists();
            const idx = lists.findIndex(p => p.id === msg.id);
            if (idx < 0) return { ok: false };
            lists.splice(idx, 1);
            await savePlaylists(lists);
            let activeId = await getActiveId();
            if (activeId === msg.id) {
                activeId = lists.length ? lists[0].id : null;
                await setActiveId(activeId);
            }
            const st = await getState();
            if (st.playlistId === msg.id) {
                st.playlistId = null; st.playing = false; st.index = 0;
                await saveState(st);
            }
            await broadcastData();
            return { ok: true };
        }
        case 'importPlaylist': {
            const lists = await getPlaylists();
            const items = (msg.items || []).filter(x => x && x.bvid).map(x => ({
                bvid: String(x.bvid),
                cid: Number(x.cid) || 0,
                title: String(x.title || x.bvid),
                pic: normUrl(x.pic),
                owner: String(x.owner || ''),
                duration: Number(x.duration) || 0,
                page: Number(x.page) || 1
            }));
            if (!items.length) return { ok: false, error: '没有有效歌曲' };
            const id = genId();
            const name = (msg.name && String(msg.name).trim()) || '导入的歌单';
            lists.push({ id, name: name.slice(0, 100), items });
            await savePlaylists(lists);
            await setActiveId(id);
            await broadcastData();
            return { ok: true, count: items.length };
        }
        case 'setActive': {
            if (msg.id) { await setActiveId(msg.id); await broadcastData(); }
            return { ok: true };
        }
        case 'openPanel': {
            if (sender && sender.tab && sender.tab.id != null) togglePanelInTab(sender.tab.id);
            return { ok: true };
        }
    }
    return { ok: false };
}

function togglePanelInTab(tabId) {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { target: 'content', cmd: 'togglePanel' }).catch(() => {});
}

chrome.action.onClicked.addListener(tab => {
    togglePanelInTab(tab && tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-panel') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        togglePanelInTab(tab && tab.id);
    }
});

chrome.runtime.onInstalled.addListener(() => { migrate(); });
chrome.runtime.onStartup.addListener(() => { migrate(); });
