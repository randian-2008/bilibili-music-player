// 日志：Service Worker 经 importScripts 载入共享 logger；测试/异常环境下用空实现兜底
if (typeof importScripts === 'function') { try { importScripts('logger.js'); } catch (_) {} }
if (typeof BPLLog === 'undefined') {
    globalThis.BPLLog = { info() {}, log() {}, warn() {}, error() {}, flush() {}, recent() { return []; } };
}

const DEF_STATE = { playlistId: null, trackId: null, index: 0, playing: false, mode: 'loop' };
const STORAGE_SCHEMA_VERSION = 1;

const MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
function normalizeMode(st) {
    if (MODES.indexOf(st.mode) >= 0) return st.mode;
    if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
    return st.loop ? 'loop' : 'order';
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function ensurePlaylistItemIds(lists) {
    const seen = new Set();
    let changed = false;
    for (const pl of (lists || [])) {
        if (!Array.isArray(pl.items)) { pl.items = []; changed = true; }
        for (const it of pl.items) {
            let id = (it && typeof it.id === 'string') ? it.id.trim() : '';
            if (!id || seen.has(id)) {
                id = genId();
                it.id = id;
                changed = true;
            }
            seen.add(id);
        }
    }
    return changed;
}

let playlistMutationChain = Promise.resolve();
function withPlaylistMutation(fn) {
    const run = () => fn();
    const task = playlistMutationChain.then(run, run);
    playlistMutationChain = task.then(() => {}, () => {});
    return task;
}

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
function positionMatchesItem(pos, it) {
    if (!pos || !it) return false;
    if (pos.trackId && it.id) return pos.trackId === it.id;
    return pos.bvid === it.bvid && (pos.cid || 0) === (it.cid || 0);
}
async function reconcileStoredState(lists) {
    const st = await getState();
    const before = JSON.stringify(st);
    let trackRemoved = false;
    const pl = findPl(lists, st.playlistId);
    if (!pl) {
        if (st.playlistId || st.trackId || st.playing || st.index !== 0) {
            trackRemoved = !!st.trackId;
            st.playlistId = null;
            st.trackId = null;
            st.index = 0;
            st.playing = false;
        }
    } else if (st.trackId) {
        const index = pl.items.findIndex(it => it.id === st.trackId);
        if (index >= 0) {
            st.index = index;
        } else {
            trackRemoved = true;
            st.trackId = null;
            st.playing = false;
            st.index = Math.max(0, Math.min(st.index, Math.max(0, pl.items.length - 1)));
        }
    } else {
        st.playing = false;
        st.index = Math.max(0, Math.min(st.index, Math.max(0, pl.items.length - 1)));
    }
    if (before !== JSON.stringify(st)) await saveState(st);
    if (trackRemoved) await chrome.storage.local.set({ bpl_position: null });
    return { state: st, trackRemoved };
}
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
    if (!jDash) BPLLog.warn('bg', 'playurl(dash) 请求失败/无响应[' + bvid + ']');
    else if (jDash.code !== 0) BPLLog.warn('bg', 'playurl(dash) code=' + jDash.code + ' ' + (jDash.message || '') + '[' + bvid + ']');
    if (!jMp4) BPLLog.warn('bg', 'playurl(durl) 请求失败/无响应[' + bvid + ']');
    else if (jMp4.code !== 0) BPLLog.warn('bg', 'playurl(durl) code=' + jMp4.code + ' ' + (jMp4.message || '') + '[' + bvid + ']');
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
        BPLLog.error('bg', 'getAudioUrls[' + bvid + '/' + cid + '] 未获取到音频流：' + (msg || '未知'));
        throw new Error('未获取到音频流' + (msg ? '：' + msg : '（可能需要登录B站或该视频无音频）'));
    }
    const uniq = [...new Set(urls)];
    const dash = jDash && jDash.data && jDash.data.dash;
    const tag = dash
        ? '(dash' + ((dash.flac && dash.flac.audio) ? '+flac' : '') + ((dash.dolby && dash.dolby.audio && dash.dolby.audio.length) ? '+dolby' : '') + ')'
        : '(durl)';
    BPLLog.info('bg', 'getAudioUrls[' + bvid + '/' + cid + '] 得 ' + uniq.length + ' 个候选' + tag);
    return uniq;
}
async function buildItem(bvid, page, fallbackTitle) {
    try {
        const r = await resolveCid(bvid, page);
        const d = r.info, pg = r.page;
        const multi = (d.pages || []).length > 1;
        return {
            id: genId(),
            bvid: d.bvid || bvid,
            cid: r.cid,
            title: (multi && pg.part) ? (d.title + ' · ' + pg.part) : (d.title || bvid),
            pic: normUrl(d.pic),
            owner: (d.owner && d.owner.name) || '',
            duration: pg.duration || d.duration || 0,
            page: page
        };
    } catch (e) {
        return { id: genId(), bvid: bvid, cid: 0, title: fallbackTitle || bvid, pic: '', owner: '', duration: 0, page: page };
    }
}

async function migrate() {
    return await withPlaylistMutation(async () => {
        const r = await chrome.storage.local.get(['bpl_schema_version', 'bpl_playlists', 'bpl_list', 'bpl_state', 'bpl_active', 'bpl_position']);
        let lists = (r.bpl_playlists && r.bpl_playlists.length) ? r.bpl_playlists : null;
        let activeId = r.bpl_active || null;
        let legacyList = false;
        if (!lists) {
            const id = genId();
            lists = [{ id, name: '默认歌单', items: r.bpl_list || [] }];
            activeId = id;
            legacyList = true;
        }
        ensurePlaylistItemIds(lists);
        if (!activeId || !findPl(lists, activeId)) activeId = lists[0].id;

        const rawState = r.bpl_state || {};
        const st = Object.assign({}, DEF_STATE, rawState);
        st.mode = normalizeMode(st);
        if (legacyList) st.playlistId = activeId;
        if (!Object.prototype.hasOwnProperty.call(rawState, 'trackId')) {
            const pl = findPl(lists, st.playlistId);
            const it = pl && pl.items[st.index];
            const hadTrack = !!rawState.playing || positionMatchesItem(r.bpl_position, it);
            st.trackId = (it && hadTrack) ? it.id : null;
        }
        if (st.trackId) {
            const pl = findPl(lists, st.playlistId);
            const index = pl ? pl.items.findIndex(it => it.id === st.trackId) : -1;
            if (index >= 0) st.index = index;
            else { st.trackId = null; st.playing = false; st.index = 0; }
        } else {
            st.playing = false;
        }

        await chrome.storage.local.set({
            bpl_schema_version: STORAGE_SCHEMA_VERSION,
            bpl_playlists: lists,
            bpl_active: activeId,
            bpl_state: st
        });
        if (legacyList) await chrome.storage.local.remove('bpl_list');
    });
}

async function ensureDefaultPlaylist() {
    const lists = await getPlaylists();
    if (lists.length) {
        if (ensurePlaylistItemIds(lists)) await savePlaylists(lists);
        return lists;
    }
    const id = genId();
    const pls = [{ id, name: '默认歌单', items: [] }];
    await savePlaylists(pls);
    await setActiveId(id);
    return pls;
}

const OFFSCREEN_PATH = 'offscreen.html';
let creating = null;
let offscreenPort = null;
let offscreenReady = false;
let portMsgId = 0;
const portWaiters = {};
let lastPingAt = 0;
let lastCreateAt = 0;   // 本次 createDocument 的时刻：用于判断 bpl_boot 是否来自当前这份文档
let offscreenBroken = false;   // 测出上下文整体失效（Extension context invalidated），下条命令需重建
let lastRecreateAt = 0;        // 上次重建时刻：冷却闸，防止“损坏→重建→仍损坏”退化成新一轮踩踏
const RECREATE_COOLDOWN_MS = 10000;

async function hasOffscreen() {
    if (chrome.offscreen.hasDocument) {
        try { return await chrome.offscreen.hasDocument(); } catch (e) {}
    }
    try {
        const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return !!(ctxs && ctxs.length);
    } catch (e) { return false; }
}
// 读取 bpl_boot 并翻译成一句确切死因——不再笼统报“静默”，而是区分到具体层级：
//   loaded         offscreen.js 已加载（问题在下游命令通道）
//   boot           offscreen-boot 已运行但 offscreen.js 未加载完成（body 脚本加载/执行失败）
//   resource-error 某脚本资源加载失败（附 src）
//   script-error / promise-error  运行期抛错（附 msg）
//   无记录          offscreen-boot 都没运行（文档脚本完全未执行，疑后台挂起/效率模式）
async function readBootDiag() {
    try {
        if (offscreenPort) return 'Port 已连接（offscreen 存活）';
        const b = await chrome.storage.local.get('bpl_boot');
        const boot = b && b.bpl_boot;
        if (!boot || !boot.phase) return 'offscreen 文档脚本完全未执行（无 bpl_boot；疑 Edge 后台挂起/效率模式）';
        const stale = (boot.at && Date.now() - boot.at > 15000) ? '（记录较旧）' : '';
        switch (boot.phase) {
            case 'loaded': return 'offscreen.js 已加载但命令未达（Port/消息通道异常）' + stale;
            case 'boot': return 'offscreen-boot 已运行但 offscreen.js 未加载完成（疑 body 脚本加载/执行失败）' + stale;
            case 'resource-error': return '脚本资源加载失败：' + (boot.src || '?') + stale;
            case 'script-error': return 'offscreen 脚本错误：' + (boot.msg || '?') + stale;
            case 'promise-error': return 'offscreen Promise 错误：' + (boot.msg || '?') + stale;
            default: return 'bpl_boot.phase=' + boot.phase + stale;
        }
    } catch (e) { return '诊断读取失败：' + String((e && e.message) || e); }
}
// 创建后自检：5s 内若 Port 未连上、且本文档的 bpl_boot 未推进到 loaded，则用 readBootDiag 给出一句定论。
// 注意：不再在 create 前清 bpl_boot——那会把 offscreen-boot 刚写的证据立刻抹掉，让诊断永远读到“无记录”。
let aliveCheckPending = false;
async function verifyOffscreenAlive() {
    if (aliveCheckPending) return;
    aliveCheckPending = true;
    try {
        const start = Date.now();
        while (Date.now() - start < 5000) {
            if (offscreenPort) return;   // 健康：Port 已连
            const b = await chrome.storage.local.get('bpl_boot');
            const boot = b && b.bpl_boot;
            if (boot && boot.phase === 'loaded' && boot.at && boot.at >= lastCreateAt) return;   // 本文档已 loaded
            await new Promise(r => setTimeout(r, 200));
        }
        BPLLog.error('bg', 'offscreen 自检未通过：' + (await readBootDiag()));
        BPLLog.flush();
    } catch (e) { /* 自检失败不影响主流程 */ }
    finally { aliveCheckPending = false; }
}
async function ensureOffscreen() {
    if (offscreenPort || await hasOffscreen()) return;
    if (creating) { await creating; return; }
    lastCreateAt = Date.now();
    creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['AUDIO_PLAYBACK'],
        justification: '后台播放B站音频（跨页面持续播放）'
    }).then(() => {
        BPLLog.info('bg', 'offscreen createDocument 成功');
        verifyOffscreenAlive();
    }).catch(e => {
        BPLLog.error('bg', 'offscreen createDocument 失败：' + ((e && e.message) || e));
        throw e;
    }).finally(() => { creating = null; });
    await creating;
}
// 等待 offscreen 经 Port 连上（冷启动 / Service Worker 重启后的重连窗口）
async function waitForPort(timeout) {
    if (offscreenPort) return true;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (offscreenPort) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return !!offscreenPort;
}
async function handleResolveAudio(p) {
    try {
        let cid = p.cid || 0;
        if (!cid) cid = (await resolveCid(p.bvid, p.page || 1)).cid;
        if (!cid) return { ok: false, error: '无法解析视频 cid' };
        const urls = await getAudioUrls(p.bvid, cid);
        return { ok: true, urls: urls };
    } catch (e) {
        BPLLog.error('bg', 'resolveAudio[' + (p && p.bvid) + '] 失败：' + String((e && e.message) || e));
        return { ok: false, error: String((e && e.message) || e) };
    }
}
// 经 Port 发命令；超时/发送失败 resolve(undefined)（offscreen 正常响应恒为对象，故 undefined 即失败）
function sendViaPort(msg, timeout) {
    return new Promise(resolve => {
        const id = ++portMsgId;
        let settled = false;
        const done = v => { if (!settled) { settled = true; delete portWaiters[id]; clearTimeout(timer); resolve(v); } };
        portWaiters[id] = done;
        const timer = setTimeout(() => done(undefined), timeout);
        try { offscreenPort.postMessage(Object.assign({ _id: id }, msg)); }
        catch (e) { done(undefined); }
    });
}
// 经 runtime.sendMessage 发命令：仅在 Port 未就绪时【本轮一次性】兜底，绝不长期粘用
function sendViaMessage(msg, timeout) {
    return new Promise(resolve => {
        const id = ++portMsgId;
        let settled = false;
        const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => done({ ok: false, error: '音频模块通信失败：offscreen 无响应' }), timeout);
        try {
            chrome.runtime.sendMessage(Object.assign({ target: 'offscreen', _id: id }, msg), r => {
                done((r === undefined) ? { ok: false, error: '音频模块通信失败：offscreen 无响应' } : r);
            });
        } catch (e) {
            done({ ok: false, error: '音频模块通信失败：' + String((e && e.message) || e) });
        }
    });
}

// 单飞（single-flight）：所有发往 offscreen 的命令串行执行，避免并发 create 互相干扰。
let sendChain = Promise.resolve();
let offscreenFailCount = 0;
function sendToOffscreen(msg) {
    const run = () => sendToOffscreenOnce(msg);
    const p = sendChain.then(run, run);
    sendChain = p.then(() => { }, () => { });
    return p;
}
// 识别“offscreen 上下文损坏”的错误签名：chrome.runtime 在、chrome.storage 未绑定（多见于升级
// installed:update 瞬间建出的半残文档），或上下文整体失效。这类错误重建一次即可恢复，区别于
// 业务错误（如歌单为空，原样返回）与单纯无响应（走诊断路径）。
function isFatalContextError(r) {
    return !!(r && r.ok === false && r.error &&
        /Cannot read properties of undefined|Extension context invalidated|上下文失效|chrome\.storage/.test(r.error));
}
// 有界自愈：关闭损坏文档、稍候、重建一份健康 offscreen。带冷却闸（10s 内至多一次），
// 因此即便环境彻底损坏也不会退化成旧版那种 2 秒一轮的踩踏风暴。
async function recreateOffscreen() {
    lastRecreateAt = Date.now();
    offscreenBroken = false;
    offscreenReady = false;
    offscreenPort = null;
    try { if (chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument(); } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
    await ensureOffscreen();
}
// 单次投递：优先 Port，Port 不可用/无响应再走 sendMessage（同一 offscreen 宿主的两条通道，非页内兜底）。
// 恒返回一个结果对象（成功/业务错误/上下文损坏/无响应），从不返回 undefined，便于上层统一判定。
async function trySendOnce(msg) {
    await ensureOffscreen();
    // boot ping 已证明文档存活，给 offscreen.js 充分的加载/连接窗口
    if (await waitForPort(2500)) {
        const res = await sendViaPort(msg, 4000);
        if (res !== undefined) return res;   // 成功 / 业务错误 / 上下文损坏，均交由上层判定
        // Port 连上却无响应：连接陈旧（SW 重启后残留），丢弃让下条命令重连，本轮不踩踏
        offscreenReady = false;
        offscreenPort = null;
        BPLLog.warn('bg', 'Port 已连接但命令无响应，已丢弃陈旧连接（下条命令将重连）');
    }
    return await sendViaMessage(msg, 2500);
}
// 关键修复（v2.2.1 去踩踏 / v2.2.3 自愈覆盖双通道）：
// 旧 v2.1 实现在每次失败时 closeDocument + 立即重建，2 秒一轮反复踩踏，把正在初始化的 offscreen.js 踩死。
// 新实现：创建一次、耐心等 Port；命令若报“上下文损坏”（reading 'local' 等，无论来自 Port 还是 sendMessage
// 通道）则带冷却地重建一次重试（恢复同一宿主，非页内兜底）；纯无响应则读 bpl_boot 给确切死因上报 UI。
async function sendToOffscreenOnce(msg) {
    const cooldownOk = () => Date.now() - lastRecreateAt > RECREATE_COOLDOWN_MS;
    // 进入前若上次命令已测出上下文整体失效（Extension context invalidated），先带冷却地重建一次
    if (offscreenBroken && cooldownOk()) await recreateOffscreen();
    let res = await trySendOnce(msg);
    // v2.2.3 补缺：自愈不能只看 Port 路径——命令走 sendMessage 返回上下文损坏时同样要重建重试
    if (isFatalContextError(res) && cooldownOk()) {
        BPLLog.warn('bg', 'offscreen 上下文损坏（' + res.error + '），重建一次重试');
        BPLLog.flush();
        await recreateOffscreen();
        res = await trySendOnce(msg);
    }
    // 成功或业务错误（如歌单为空）或重建后的最终结果：原样返回，不当通信失败
    if (res && !(res.ok === false && res.error && /无响应/.test(res.error))) {
        offscreenFailCount = 0;
        return res;
    }
    // 纯无响应/彻底失败：读 bpl_boot 把确切死因直接上报 UI（关闭重建只会踩死正在初始化的文档，不做）
    offscreenFailCount++;
    const diag = await readBootDiag();
    BPLLog.error('bg', 'offscreen 通信失败（累计 ' + offscreenFailCount + ' 次）：' + diag);
    BPLLog.flush();
    return { ok: false, error: '音频模块通信失败：' + diag };
}

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'bpl-audio') return;
    offscreenPort = port;
    offscreenReady = true;
    BPLLog.info('bg', 'offscreen Port 已连接：bpl-audio');
    port.onMessage.addListener(msg => {
        if (!msg || msg._id == null) return;
        if (msg.resolveAudio) {
            handleResolveAudio(msg.resolveAudio).then(result => {
                try { port.postMessage({ _id: msg._id, result: result }); } catch (e) {}
            });
            return;
        }
        const w = portWaiters[msg._id];
        if (w) { delete portWaiters[msg._id]; w(msg.result); }
    });
    port.onDisconnect.addListener(() => {
        if (offscreenPort === port) offscreenPort = null;
        offscreenReady = false;
        BPLLog.warn('bg', 'offscreen Port 断开：bpl-audio');
    });
});

function broadcast(msg) {
    const payload = Object.assign({ target: 'all' }, msg);
    // 双路投递（现场实证单路不可靠）：
    // ① runtime 广播 → 扩展页面（如独立打开的 sidepanel）。此 Edge 上 offscreen 直发、乃至 v2.2.6 改为
    //    经 SW 中继的 runtime 广播都到不了网页里的 content script（UI 依旧冻住），故必须还有 ②；
    // ② tabs.sendMessage 逐标签页精确投递到 content script —— 实证通路（togglePanel 即走它），
    //    面板 iframe 再经 content 的 postMessage 桥接收。两路在正常环境可能重复送达，各处理函数均幂等。
    chrome.runtime.sendMessage(payload).catch(() => {});
    try {
        chrome.tabs.query({}, tabs => {
            for (const t of (tabs || [])) {
                if (t.id == null) continue;
                try { chrome.tabs.sendMessage(t.id, payload).catch(() => {}); } catch (_) {}
            }
        });
    } catch (_) {}
}

async function broadcastData() {
    const playlists = await getPlaylists();
    const activeId = await getActiveId();
    const state = await getState();
    broadcast({ type: 'data', playlists, activeId, state });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.bplPing === 'offscreen-nostorage') {
        // offscreen 自报上下文无 chrome.storage。v2.2.4 起这不再是故障：offscreen 的所有存储读写
        // 已经由 background 代理（见 handleBg 的 storageGet/storageSet），音频播放不受影响。
        // 故仅记一条提示，不标记损坏、不重建（现场实锤重建出来的文档同样没有 chrome.storage）。
        BPLLog.warn('bg', 'offscreen 环境无 chrome.storage：已启用经 background 的存储代理（不影响播放）');
        return;
    }
    if (msg.bplPing === 'offscreen-boot' || msg.bplPing === 'offscreen-ready') {
        lastPingAt = Date.now();
        BPLLog.info('bg', 'offscreen ping：' + msg.bplPing);
        return;
    }
    if (msg.target === 'bg') {
        handleBg(msg, sender)
            .then(res => sendResponse(res || { ok: true }))
            .catch(e => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
});

const PLAYLIST_MUTATION_CMDS = new Set([
    'add', 'remove', 'renameItem', 'batchRemove', 'batchCopy', 'batchMove', 'moveItem', 'clear',
    'createPlaylist', 'renamePlaylist', 'deletePlaylist', 'importPlaylist', 'setActive'
]);

async function handleBg(msg, sender, mutationLocked) {
    // offscreen 的 bgResolveAudio 发 {target:'bg', resolveAudio:{...}}（历史形状，不带 cmd 字段）。
    // 必须在 switch(msg.cmd) 之前拦截，否则落入 default→{ok:false}，offscreen 报“无候选”且 bg 侧毫无日志。
    if (msg.resolveAudio) return await handleResolveAudio(msg.resolveAudio);
    if (!mutationLocked && PLAYLIST_MUTATION_CMDS.has(msg.cmd)) {
        return await withPlaylistMutation(() => handleBg(msg, sender, true));
    }
    switch (msg.cmd) {
        case 'add': {
            const lists = await ensureDefaultPlaylist();
            let activeId = await getActiveId();
            let pl = findPl(lists, activeId);
            if (!pl) { pl = lists[0]; await setActiveId(pl.id); }
            const bvid = msg.bvid || (msg.item && msg.item.bvid);
            if (!bvid) return { ok: false };
            const page = msg.page || (msg.item && msg.item.page) || 1;
            const it = Object.assign({}, (msg.item && msg.item.cid) ? msg.item : await buildItem(bvid, page, msg.fallbackTitle));
            it.id = genId();
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
            return await handleResolveAudio(msg.resolveAudio || msg);
        }
        case 'openTab': {
            // 仅允许打开B站视频页，防止桥接被滥用打开任意网址（纵深防御）
            const url = String(msg.url || '');
            if (/^https:\/\/([a-z0-9-]+\.)*bilibili\.com\//.test(url)) {
                chrome.tabs.create({ url: url });
            } else {
                BPLLog.warn('bg', 'openTab 拒绝非B站网址：' + url);
            }
            return { ok: true };
        }
        case 'relay': {
            // 广播中继：offscreen 的 state/progress 广播经此以 target:'all' 转发。
            // 必须由 bg 转发而非 offscreen 直发——现场实证 offscreen 直发的 runtime 广播
            // 到不了网页里的 content script（胶囊/面板进度条因此冻住）；bg→content 是实证通路。
            if (msg.data && typeof msg.data === 'object') broadcast(msg.data);
            return { ok: true };
        }
        case 'storageGet': {
            // offscreen 存储代理（读）：现场实锤此 Edge 的 offscreen 文档 chrome.runtime 正常、
            // chrome.storage 恒为 undefined（新建文档亦然）。offscreen 遂不再自持存储，读写经
            // runtime 消息转发给 background（bg 的 chrome.storage 正常）。offscreen 只保留 <audio>。
            const values = await chrome.storage.local.get(msg.keys);
            return { ok: true, values: values };
        }
        case 'storageSet': {
            // offscreen 存储代理（写）
            await chrome.storage.local.set(msg.data || {});
            return { ok: true };
        }
        case 'logMerge': {
            // 日志代理：无 chrome.storage 的上下文（即该 Edge 的 offscreen）经此把日志条目并入
            // bg 侧的 bpl_log——否则 offscreen 的 [off] 日志会因写存储失败而整片静默，诊断失明。
            const cur = (await chrome.storage.local.get('bpl_log')).bpl_log;
            let arr = Array.isArray(cur) ? cur : [];
            arr = arr.concat(Array.isArray(msg.entries) ? msg.entries : []);
            const cap = (typeof BPLLog !== 'undefined' && BPLLog.MAX) || 500;
            if (arr.length > cap) arr = arr.slice(-cap);
            await chrome.storage.local.set({ bpl_log: arr });
            return { ok: true };
        }
        case 'player': {
            const payload = msg.payload || {};
            if (payload.cmd !== 'getStatus' && payload.cmd !== 'ping') BPLLog.info('bg', '收到 player 命令：' + payload.cmd);
            if (payload.cmd === 'getStatus' && !offscreenPort && !(await hasOffscreen())) {
                // v2.2.9：offscreen 暂停 ~30s 即被浏览器当空闲文档回收（AUDIO_PLAYBACK 只在出声时保活），
                // 此时“有一首暂停中的歌”仍是事实。从存储推导：新页面的胶囊/面板应显示暂停态与断点位置
                // （而非无曲目的单音符 ♪），与旧页面保持一致；按下播放经 toggle 走断点续播。
                const st = await getState();
                const pls = await getPlaylists();
                const pl = pls.find(p => p.id === st.playlistId);
                const index = (pl && st.trackId) ? pl.items.findIndex(it => it.id === st.trackId) : -1;
                const it = index >= 0 ? pl.items[index] : null;
                if (!it) return { ok: true, position: 0, duration: 0, playing: false, index: -1, hasTrack: false };
                const pos = (await chrome.storage.local.get('bpl_position')).bpl_position;
                const at = positionMatchesItem(pos, it) ? (pos.position || 0) : 0;
                return { ok: true, position: at, duration: it.duration || 0, playing: false, index, trackId: st.trackId, hasTrack: true, mode: st.mode };
            }
            return await sendToOffscreen(payload);
        }
        case 'remove': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            const i = msg.index;
            if (i >= 0 && i < pl.items.length) pl.items.splice(i, 1);
            await savePlaylists(lists);
            await reconcileStoredState(lists);
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
            for (let k = asc.length - 1; k >= 0; k--) pl.items.splice(asc[k], 1);
            await savePlaylists(lists);
            await reconcileStoredState(lists);
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
                    const copy = Object.assign({}, it);
                    if (msg.cmd === 'batchCopy') copy.id = genId();
                    toPl.items.push(copy);
                    added++;
                }
            }
            if (msg.cmd === 'batchMove') {
                for (let k = asc.length - 1; k >= 0; k--) fromPl.items.splice(asc[k], 1);
            }
            await savePlaylists(lists);
            if (msg.cmd === 'batchMove') await reconcileStoredState(lists);
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
            await savePlaylists(lists);
            await reconcileStoredState(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'clear': {
            const lists = await getPlaylists();
            const pl = findPl(lists, await getActiveId());
            if (!pl) return { ok: false };
            pl.items = [];
            await savePlaylists(lists);
            await reconcileStoredState(lists);
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
            await reconcileStoredState(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'importPlaylist': {
            const lists = await getPlaylists();
            const items = (msg.items || []).filter(x => x && x.bvid).map(x => ({
                id: genId(),
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

// SW 生命周期日志：MV3 的 Service Worker 会被回收后重启，时间线上看到多次启动属正常；
// 若“播放中 SW 重启且 offscreen 未重建”即可解释“播一会儿没声/状态丢”，故每次启动留痕。
function logSwStart(reason) {
    let v = '';
    try { v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''; } catch (_) {}
    BPLLog.info('bg', 'Service Worker 启动(' + reason + ')' + (v ? ' v' + v : ''));
}
// 预热音频宿主：SW 启动即创建 offscreen，让 offscreen.js 在用户首次点播放之前就加载并连上 Port，
// 彻底消除“首条命令撞上冷启动加载窗口”的竞态（踩踏的诱因之一）。失败不阻塞——惰性路径仍会补建。
// 仅在 onStartup（浏览器启动，上下文稳定）与“非升级”的安装时预热。**升级（installed:update）时不预热**：
// 那一刻旧上下文正在切换，此刻 createDocument 会建出 chrome.storage 未绑定的半残文档（现场实锤：
// Port 能连但每条命令报 reading 'local'）。升级后改为等首条命令在稳定时刻惰性创建。
function prewarmOffscreen() { ensureOffscreen().catch(() => {}); }
function runMigration(reason) {
    migrate().catch(e => BPLLog.error('bg', '存储迁移失败(' + reason + ')：' + ((e && e.message) || e)));
}
chrome.runtime.onInstalled.addListener((d) => {
    logSwStart('installed' + ((d && d.reason) ? ':' + d.reason : ''));
    runMigration('installed');
    if (!(d && d.reason === 'update')) prewarmOffscreen();
});
chrome.runtime.onStartup.addListener(() => { logSwStart('startup'); runMigration('startup'); prewarmOffscreen(); });
// SW 被重新唤醒（非 onInstalled/onStartup 路径，如消息唤起）时也补一条，便于判断回收频率
logSwStart('eval');
