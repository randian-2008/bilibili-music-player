// 日志：offscreen.html 先载入 logger.js；测试/异常环境用空实现兜底
if (typeof BPLLog === 'undefined') {
    globalThis.BPLLog = { info() {}, log() {}, warn() {}, error() {}, flush() {}, recent() { return []; } };
}
// ==== 存储代理（v2.2.4 关键修复） ====
// 现场实锤（2026-08-02 日志）：此 Edge 的 offscreen 文档 chrome.runtime 完全正常（Port 连接、
// sendMessage 往返均通），但 chrome.storage 恒为 undefined——连销毁后新建的文档也如此，故非
// 时序/升级残留，而是该环境对 offscreen 的固有限制，也不是用户能开关的权限（storage 已在
// manifest 声明）。对策：offscreen 不再直接碰 chrome.storage；本上下文有则用本地（Chrome 等
// 正常环境），没有则把读写经 runtime 消息转发给 background（bg 的 chrome.storage 正常）。
// offscreen 的职责收敛为“只持有 <audio>”。
const REMOTE_STORAGE_TIMEOUT_MS = 4500;
function remoteGet(keys) {
    return new Promise(res => {
        let done = false, timer = null;
        const finish = v => { if (!done) { done = true; if (timer) clearTimeout(timer); res(v); } };
        try {
            chrome.runtime.sendMessage({ target: 'bg', cmd: 'storageGet', keys: keys }, r => {
                finish((r && r.ok && r.values) ? r.values : {});
            });
        } catch (e) { finish({}); }
        timer = setTimeout(() => finish({}), REMOTE_STORAGE_TIMEOUT_MS);
    });
}
function remoteSet(data) {
    return new Promise(res => {
        let done = false, timer = null;
        const finish = v => { if (!done) { done = true; if (timer) clearTimeout(timer); res(v); } };
        try {
            chrome.runtime.sendMessage({ target: 'bg', cmd: 'storageSet', data: data }, r => {
                finish(!!(r && r.ok));
            });
        } catch (e) { finish(false); }
        timer = setTimeout(() => finish(false), REMOTE_STORAGE_TIMEOUT_MS);
    });
}
const remoteStore = { get: remoteGet, set: remoteSet, remove: () => Promise.resolve() };
const hasLocalStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
const store = hasLocalStore ? chrome.storage.local : remoteStore;

function runAsync(label, operation) {
    try {
        Promise.resolve(operation()).catch(error => {
            BPLLog.error('off', label + '：' + String((error && error.message) || error));
        });
    } catch (error) {
        BPLLog.error('off', label + '：' + String((error && error.message) || error));
    }
}

BPLLog.info('off', 'offscreen.js 已加载' + (hasLocalStore ? '' : '（chrome.storage 缺失，存储经 background 代理）'));
// 立即落盘两条证据：BPLLog 有 1s 节流，若文档被快速关闭会丢；这里直写存储确保留痕
BPLLog.flush();
try {
    Promise.resolve(store.set({
        bpl_boot: {
            phase: 'loaded', at: Date.now(), s: new Date().toISOString(),
            ua: (typeof navigator !== 'undefined' && navigator.userAgent) || ''
        }
    })).catch(() => {});
} catch (_) {}

// 环境自检：无 chrome.storage 时显式告知后台（仅通知，非故障——存储已由 bg 代理，播放不受影响）。
if (!hasLocalStore) {
    BPLLog.warn('off', 'offscreen 无 chrome.storage：存储读写经 background 代理（环境特性，不影响播放）');
    BPLLog.flush();
    try {
        const p = chrome.runtime.sendMessage({ bplPing: 'offscreen-nostorage' });
        if (p && p.catch) p.catch(() => {});
    } catch (_) {}
}

// 尽早建立音频命令通道：把 port 声明与 connectAudioPort() 提到脚本最前端。
// 这样即便后续初始化（audio 监听/setInterval/storage 监听）较慢，或文档被提前回收，
// 命令通道也能在第一时间立起来，background 得以尽快感知 offscreen 存活。
// （connectAudioPort/handleCmd 均为函数声明、已提升；port 在此先行初始化以避暂时性死区。）
let port = null;
const inflightRequests = new Map();
const completedRequests = new Map();
const COMPLETED_REQUEST_TTL_MS = 60000;
connectAudioPort();

const DEF_STATE = { playlistId: null, trackId: null, index: 0, playing: false, mode: 'loop' };
const P_MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
const audio = document.getElementById('player');
let curIndex = -1;
let curTrack = null;   // 当前曲身份 {bvid, cid}：断点落盘以此为键，stop/清空时置 null
let shuffleOrder = [];
let shufflePos = -1;
let curBlobUrl = null;
let recoveryTimer = null;
let recoveryAttempts = 0;
let recoveryRunning = false;
let recoveryPending = false;
let suppressRecoveryUntil = 0;

// 诊断辅助：从 src 提取 host（测试环境 URL 可能非构造器，安全降级为截断字符串）
function hostOf(u) {
    try { return new URL(u).host; } catch (_) { return String(u).slice(0, 80); }
}
const MEDIA_ERR_NAME = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
const NET_STATE = { 0: 'EMPTY', 1: 'IDLE', 2: 'LOADING', 3: 'NO_SOURCE' };
const READY_STATE = { 0: 'NOTHING', 1: 'METADATA', 2: 'CURRENT', 3: 'FUTURE', 4: 'ENOUGH' };

function normMode(st) {
    if (P_MODES.indexOf(st.mode) >= 0) return st.mode;
    if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
    return st.loop ? 'loop' : 'order';
}
function pGetState() {
    return store.get('bpl_state').then(r => {
        const st = Object.assign({}, DEF_STATE, r.bpl_state || {});
        st.mode = normMode(st);
        return st;
    });
}
function pGetPlaylists() {
    return store.get('bpl_playlists').then(r => r.bpl_playlists || []);
}
async function pGetItems(playlistId) {
    const st = await pGetState();
    const pls = await pGetPlaylists();
    const pl = pls.find(p => p.id === (playlistId || st.playlistId));
    return pl ? pl.items : [];
}
// 广播统一经 background 中继（cmd:'relay' → bg 以 target:'all' 转发）。现场实证（v2.2.5）：
// offscreen 直接 runtime.sendMessage({target:'all'}) 到不了网页里的 content script——胶囊图标/动画/
// 变形与面板进度条因此全冻住（面板的曲名/列表标记靠 storage 安全网幸存，才没一起暴露）。
// bg→content 是实证通路（togglePanel 即走它），故 state/progress 广播一律交给 bg 转发。
function relayBroadcast(data) {
    try {
        chrome.runtime.sendMessage({ target: 'bg', cmd: 'relay', data: data }).catch(() => {});
    } catch (_) {}
}
function broadcastState(st) {
    const out = Object.assign({}, st, { hasTrack: !!audio.src });
    relayBroadcast({ type: 'state', state: out });
}
async function pSetState(patch) {
    const st = await pGetState();
    Object.assign(st, patch);
    await store.set({ bpl_state: st });
    broadcastState(st);
    return st;
}
// 进度持久化（v2.2.9 断点续播）：现场日志实锤——暂停后恰好 ~30s，offscreen 被浏览器当空闲文档
// 回收（AUDIO_PLAYBACK 只在真实出声时保活，暂停=无输出=空闲）。进度不能只活在文档里：
// 暂停时/播放中每 5s/起播写 0，一律落存储 bpl_position（含曲身份 bvid+cid）；文档被回收后
// 再按播放，按身份匹配断点 seek 回原位。stop 清除（显式停止=下次从头）。
function persistPosition(position) {
    if (!curTrack) return;
    store.set({ bpl_position: { trackId: curTrack.id || null, bvid: curTrack.bvid, cid: curTrack.cid, position: position || 0 } }).catch(() => {});
}
function clearPosition() {
    store.set({ bpl_position: null }).catch(() => {});
}
function positionMatchesTrack(pos, it) {
    if (!pos || !it) return false;
    if (pos.trackId && it.id) return pos.trackId === it.id;
    return pos.bvid === it.bvid && (pos.cid || 0) === (it.cid || 0);
}
async function pEnsurePlaylist() {
    const st = await pGetState();
    if (st.playlistId) return st;
    const activeId = (await store.get('bpl_active')).bpl_active;
    if (activeId) return await pSetState({ playlistId: activeId });
    return st;
}
function connectAudioPort() {
    let p;
    try {
        p = chrome.runtime.connect({ name: 'bpl-audio' });
    } catch (e) {
        BPLLog.error('off', 'connect() 抛错：' + ((e && e.message) || e) + '，500ms 后重试');
        setTimeout(() => connectAudioPort(), 500);
        return;
    }
    port = p;
    BPLLog.info('off', '已连接音频通道(Port)');
    p.onMessage.addListener(msg => {
        if (!msg || msg._id == null) return;
        try { p.postMessage({ _id: msg._id, ack: true }); } catch (_) {}
        if (msg.cmd) {
            runRequest(msg).then(res => {
                try { p.postMessage({ _id: msg._id, result: res || { ok: true } }); } catch (e) {}
            }).catch(e => {
                try { p.postMessage({ _id: msg._id, result: { ok: false, error: String((e && e.message) || e) } }); } catch (_) {}
            });
            return;
        }
    });
    p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        BPLLog.warn('off', 'Port 断开，500ms 后重连');
        setTimeout(() => connectAudioPort(), 500);
    });
}

function requestKey(msg) { return msg && (msg._requestId || msg._id); }
function runRequest(msg) {
    const key = requestKey(msg);
    if (!key) return Promise.resolve(handleCmd(msg));
    const now = Date.now();
    for (const [id, entry] of completedRequests) if (now - entry.at > COMPLETED_REQUEST_TTL_MS) completedRequests.delete(id);
    if (inflightRequests.has(key)) return inflightRequests.get(key);
    if (completedRequests.has(key)) return Promise.resolve(completedRequests.get(key).value);
    const task = Promise.resolve().then(() => handleCmd(msg)).then(value => {
        inflightRequests.delete(key);
        completedRequests.set(key, { at: Date.now(), value: value });
        return value;
    }, error => {
        inflightRequests.delete(key);
        throw error;
    });
    inflightRequests.set(key, task);
    return task;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    // 歌单数据变更：background 每次改歌单都会广播 {target:'all', type:'data'}。无 chrome.storage
    // 的环境（此 Edge 的 offscreen）没有 storage.onChanged，靠这条广播刷新洗牌序/空单停播，
    // 等效于下方 storage.onChanged 分支（正常环境两者都触发，onPlaylistsChanged 幂等）。
    if (msg.type === 'data' && Array.isArray(msg.playlists)) { onPlaylistsChanged(); return; }
    if (msg.target !== 'offscreen' || msg._id == null) return;
    if (msg.cmd) {
        runRequest(msg).then(res => {
            try { sendResponse(res || { ok: true }); } catch (e) {}
        }).catch(e => {
            try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) {}
        });
        return true;
    }
});

function bgResolveAudio(it, playlistId) {
    return new Promise(res => {
        let done = false;
        const finish = v => { if (!done) { done = true; res(v); } };
        try {
            chrome.runtime.sendMessage({
                target: 'bg', cmd: 'resolveAudio',
                resolveAudio: {
                    bvid: it.bvid, cid: it.cid || 0, page: it.page || 1,
                    playlistId: playlistId || null, itemId: it.id || null
                }
            }, r => {
                finish(r || { ok: false, error: '获取音频失败（后台无响应）' });
            });
        } catch (e) {
            finish({ ok: false, error: String((e && e.message) || e) });
        }
        setTimeout(() => finish({ ok: false, error: '获取音频失败（后台超时）' }), 22000);
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

// error 事件感知的播放判定：play() 可能先 resolve、随后才由 'error' 事件异步失败
// （如 CDN 403 触发 MEDIA_ERR_SRC_NOT_SUPPORTED）。仅凭 play() 的 resolve 会误判“已起播”，
// 导致无声却跳过其余候选源。这里让 play() 与 'error' 竞速，并在 resolve 后给一段宽限再查 audio.error。
const PLAY_GRACE_MS = 350;
const PLAY_TIMEOUT_MS = 4500;
const BLOB_TIMEOUT_MS = 8000;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const PLAY_TOTAL_TIMEOUT_MS = 25000;
let playIntent = 0;
let playAbortController = null;
let playbackAttemptActive = 0;
function newAbortController() { return (typeof AbortController !== 'undefined') ? new AbortController() : null; }
function isCurrentPlay(token) { return token === playIntent; }
function startPlayIntent() {
    if (playAbortController) { try { playAbortController.abort(); } catch (_) {} }
    playAbortController = newAbortController();
    return { id: ++playIntent, signal: playAbortController && playAbortController.signal };
}
function cancelPlayIntent() {
    ++playIntent;
    if (playAbortController) { try { playAbortController.abort(); } catch (_) {} }
    playAbortController = null;
}
function playSettled(a, timeout, signal) {
    return new Promise(resolve => {
        let settled = false, timer = null;
        const finish = v => {
            if (settled) return;
            settled = true;
            try { a.removeEventListener('error', onErr); } catch (_) {}
            if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
            if (timer) clearTimeout(timer);
            resolve(v);
        };
        const onErr = () => finish({ ok: false, mediaError: (a.error && a.error.code) || 0 });
        const onAbort = () => finish({ ok: false, cancelled: true });
        try { a.addEventListener('error', onErr); } catch (_) {}
        if (signal) {
            if (signal.aborted) { onAbort(); return; }
            try { signal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
        }
        timer = setTimeout(() => { const error = new Error('音频播放超时'); error.name = 'TimeoutError'; finish({ ok: false, playError: error }); }, Math.max(1, timeout || PLAY_TIMEOUT_MS));
        let playPromise;
        try { playPromise = a.play(); } catch (error) { finish({ ok: false, playError: error }); return; }
        Promise.resolve(playPromise).then(() => {
            if (settled) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                if (a.error) finish({ ok: false, mediaError: a.error.code || 0 });
                else finish({ ok: true });
            }, PLAY_GRACE_MS);
        }).catch(e => finish({ ok: false, playError: e }));
    });
}
function fetchMedia(url, timeout, parentSignal) {
    const controller = newAbortController();
    let timer = null, abortHandler = null;
    const request = (() => {
        const options = { credentials: 'include' };
        if (controller) options.signal = controller.signal;
        return Promise.resolve(fetch(url, options));
    })();
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (controller) { try { controller.abort(); } catch (_) {} }
            const error = new Error('音频网络请求超时'); error.name = 'TimeoutError'; reject(error);
        }, Math.max(1, timeout));
    });
    const parentPromise = parentSignal ? new Promise((_, reject) => {
        abortHandler = () => {
            if (controller) { try { controller.abort(); } catch (_) {} }
            const error = new Error('播放请求已取消'); error.name = 'AbortError'; reject(error);
        };
        if (parentSignal.aborted) abortHandler();
        else { try { parentSignal.addEventListener('abort', abortHandler, { once: true }); } catch (_) {} }
    }) : null;
    return Promise.race([request, timeoutPromise, parentPromise].filter(Boolean)).finally(() => {
        if (timer) clearTimeout(timer);
        if (abortHandler && parentSignal) { try { parentSignal.removeEventListener('abort', abortHandler); } catch (_) {} }
    });
}
function promiseWithTimeout(promise, timeout, message) {
    return new Promise((resolve, reject) => {
        let settled = false, timer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };
        timer = setTimeout(() => finish(reject, new Error(message || '操作超时')), Math.max(1, timeout));
        Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    });
}
async function readLimitedBlob(response, deadline) {
    const declared = Number(response && response.headers && response.headers.get && response.headers.get('content-length')) || 0;
    if (declared > MAX_BLOB_BYTES) throw new Error('音频文件过大');
    if (response && response.body && response.body.getReader && typeof Blob !== 'undefined') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const part = await promiseWithTimeout(reader.read(), deadline - Date.now(), '读取音频数据超时');
            if (part.done) break;
            total += part.value ? part.value.byteLength : 0;
            if (total > MAX_BLOB_BYTES) { try { reader.cancel(); } catch (_) {} throw new Error('音频文件过大'); }
            chunks.push(part.value);
        }
        return new Blob(chunks, { type: (response.headers && response.headers.get && response.headers.get('content-type')) || 'audio/mp4' });
    }
    const blob = await promiseWithTimeout(response.blob(), deadline - Date.now(), '读取音频数据超时');
    if (blob && blob.size > MAX_BLOB_BYTES) throw new Error('音频文件过大');
    return blob;
}
async function tryPlayUrl(url, token, deadline) {
    if (!isCurrentPlay(token)) return { cancelled: true };
    const host = hostOf(url);
    audio.src = url;
    playbackAttemptActive++;
    const res = await playSettled(audio, Math.min(PLAY_TIMEOUT_MS, Math.max(1, deadline - Date.now())), playAbortController && playAbortController.signal);
    playbackAttemptActive--;
    if (res.cancelled || !isCurrentPlay(token)) return { cancelled: true };
    if (res.ok) {
        BPLLog.info('off', '直接播放成功：' + host);
        return { ok: true };
    }
    if (res.playError && res.playError.name === 'NotAllowedError') {
        BPLLog.warn('off', '播放被浏览器阻止(NotAllowed)：' + host);
        return { blocked: true };
    }
    const why = res.mediaError ? ('MediaError ' + (MEDIA_ERR_NAME[res.mediaError] || res.mediaError))
        : ((res.playError && res.playError.name) || '未知');
    BPLLog.warn('off', '直接播放失败(' + why + ')，转 fetch+blob：' + host);
    try {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !isCurrentPlay(token)) return { cancelled: true };
        const blobDeadline = Math.min(deadline, Date.now() + BLOB_TIMEOUT_MS);
        const resp = await fetchMedia(url, blobDeadline - Date.now(), playAbortController && playAbortController.signal);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await readLimitedBlob(resp, blobDeadline);
        if (!isCurrentPlay(token)) return { cancelled: true };
        const nextBlobUrl = URL.createObjectURL(blob);
        if (!isCurrentPlay(token)) { URL.revokeObjectURL(nextBlobUrl); return { cancelled: true }; }
        if (curBlobUrl) URL.revokeObjectURL(curBlobUrl);
        curBlobUrl = nextBlobUrl;
        audio.src = curBlobUrl;
        playbackAttemptActive++;
        const res2 = await playSettled(audio, Math.min(PLAY_TIMEOUT_MS, Math.max(1, deadline - Date.now())), playAbortController && playAbortController.signal);
        playbackAttemptActive--;
        if (res2.cancelled || !isCurrentPlay(token)) return { cancelled: true };
        if (res2.ok) {
            BPLLog.info('off', 'fetch+blob 兜底播放成功：' + host);
            return { ok: true };
        }
        if (res2.playError && res2.playError.name === 'NotAllowedError') {
            BPLLog.warn('off', 'blob 播放被阻止(NotAllowed)：' + host);
            return { blocked: true };
        }
        const why2 = res2.mediaError ? ('MediaError ' + (MEDIA_ERR_NAME[res2.mediaError] || res2.mediaError))
            : ((res2.playError && res2.playError.name) || '未知');
        BPLLog.error('off', '该音源彻底失败(' + why2 + ')：' + host);
        return { ok: false };
    } catch (e) {
        if (e && e.name === 'NotAllowedError') {
            BPLLog.warn('off', 'blob 播放被阻止(NotAllowed)：' + host);
            return { blocked: true };
        }
        BPLLog.error('off', '该音源彻底失败(' + ((e && e.message) || e) + ')：' + host);
        return { ok: false };
    }
}

// savedPos：可选断点 {bvid, cid, position}——仅 toggle 从空音频起播时传入（回收后续播），
// 身份匹配才 seek 回去；显式点歌/切歌一律不传，从头播。
async function pPlayIndex(i, keepOrder, savedPos, playlistId, options) {
    const isRecovery = !!(options && options.recovery);
    if (!isRecovery) {
        recoveryPending = false;
        recoveryAttempts = 0;
        if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
    }
    suppressRecoveryUntil = Date.now() + 1200;
    const intent = startPlayIntent();
    const deadline = Date.now() + PLAY_TOTAL_TIMEOUT_MS;
    const st = await pGetState();
    if (!isCurrentPlay(intent.id)) return { ok: true, cancelled: true };
    const targetPlaylistId = playlistId || st.playlistId;
    const items = await pGetItems(targetPlaylistId);
    if (!items.length) return { ok: false, error: '当前播放的歌单为空' };
    if (i < 0 || i >= items.length) return { ok: false, error: '播放索引越界 (' + i + '/' + items.length + ')' };
    if (pIsShuffle(st.mode) && !keepOrder) pBuildFrom(items.length, i);
    const it = items[i];
    const r = await bgResolveAudio(it, targetPlaylistId);
    if (!isCurrentPlay(intent.id)) return { ok: true, cancelled: true };
    if (!r || !r.ok || !r.urls || !r.urls.length) {
        BPLLog.error('off', 'resolveAudio 失败[' + it.bvid + ']：' + ((r && r.error) || '无候选（取音源模块无有效应答）'));
        BPLLog.flush();
        return { ok: false, error: (r && r.error) || '获取音频失败' };
    }
    BPLLog.info('off', 'resolveAudio 返回 ' + r.urls.length + ' 个候选[' + it.bvid + '，' + (it.title || '') + ']');
    let blocked = false;
    for (let si = 0; si < r.urls.length; si++) {
        if (Date.now() >= deadline) break;
        const res = await tryPlayUrl(r.urls[si], intent.id, deadline);
        if (res.cancelled || !isCurrentPlay(intent.id)) return { ok: true, cancelled: true };
        if (res.ok) {
            BPLLog.info('off', '第 ' + (si + 1) + '/' + r.urls.length + ' 源播放成功[' + it.bvid + ']');
            curIndex = i;
            curTrack = { id: it.id || null, bvid: it.bvid, cid: r.cid || it.cid || 0 };
            const resumeAt = (positionMatchesTrack(savedPos, it) && savedPos.position > 0) ? savedPos.position : 0;
            if (resumeAt > 0) {
                audio.currentTime = resumeAt;
                BPLLog.info('off', '从断点继续：' + Math.round(resumeAt) + 's[' + it.bvid + ']');
            }
            setupMediaSession(it);
            await pSetState({ playlistId: targetPlaylistId, trackId: it.id || null, index: i, playing: true });
            persistPosition(resumeAt);
            suppressRecoveryUntil = 0;
            return { ok: true };
        }
        if (res.blocked) { blocked = true; break; }
    }
    if (!isCurrentPlay(intent.id)) return { ok: true, cancelled: true };
    audio.removeAttribute('src');
    audio.load();
    broadcastState(await pGetState());
    BPLLog.error('off', '所有音源失败[' + it.bvid + ']，共 ' + r.urls.length + ' 源' + (blocked ? '（自动播放被阻止）' : ''));
    BPLLog.flush();
    return {
        ok: false,
        error: blocked
            ? '浏览器阻止了自动播放：请先点一下页面任意位置或浮动按钮，再点播放'
            : '无法播放该音频（已尝试 ' + r.urls.length + ' 个音源）'
    };
}
async function pStopPlayback() {
    recoveryPending = false;
    recoveryAttempts = 0;
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
    cancelPlayIntent();
    curTrack = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; }
    curIndex = -1;
    shuffleOrder = [];
    shufflePos = -1;
    clearPosition();
    await pSetState({ trackId: null, playing: false });
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
            // 文档曾被回收（暂停 ~30s 后的常态）：音频为空，但断点在存储里。
            // 读出 bpl_position 交给 pPlayIndex 按曲身份匹配，从暂停处继续而非从头。
            await pEnsurePlaylist();
            const st = await pGetState();
            const savedPos = (await store.get('bpl_position')).bpl_position;
            return await pPlayIndex(st.index, false, savedPos);
        }
        const intent = startPlayIntent();
        playbackAttemptActive++;
        const resumed = await playSettled(audio, PLAY_TIMEOUT_MS, playAbortController && playAbortController.signal);
        playbackAttemptActive--;
        if (!isCurrentPlay(intent.id) || resumed.cancelled) return { ok: true, cancelled: true };
        if (!resumed.ok) return { ok: false, error: (resumed.playError && resumed.playError.name === 'NotAllowedError')
            ? '浏览器阻止了自动播放：请先点一下页面或浮动按钮再试' : '恢复播放超时，请稍后重试' };
        await pSetState({ playing: true });
    } else {
        recoveryPending = false;
        if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
        cancelPlayIntent();
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
        // 系统媒体键“播放”：音频为空（文档曾被回收）时走 toggle 的断点续播路径
        navigator.mediaSession.setActionHandler('play', () => {
            if (audio.paused) runAsync('系统媒体键播放失败', () => pToggle());
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (!audio.paused) runAsync('系统媒体键暂停失败', () => pToggle());
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => runAsync('系统媒体键上一首失败', () => pPrev()));
        navigator.mediaSession.setActionHandler('nexttrack', () => runAsync('系统媒体键下一首失败', () => pNext()));
    } catch (e) {}
}

function broadcastPlayerError(error, reason) {
    relayBroadcast({ type: 'playerError', error: String(error || '音频播放失败'), reason: reason || 'network' });
}
function scheduleRecovery(reason, delay) {
    if (!curTrack || !audio.src || playbackAttemptActive || recoveryRunning) return;
    recoveryPending = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        recoverPlayback(reason);
    }, Math.max(0, delay == null ? 1200 : delay));
}
async function recoverPlayback(reason) {
    if (!recoveryPending || recoveryRunning || !curTrack || !audio.src) return;
    recoveryRunning = true;
    recoveryAttempts++;
    const track = Object.assign({}, curTrack);
    const index = curIndex;
    let result;
    try {
        const st = await pGetState();
        result = await pPlayIndex(index, true, {
            trackId: track.id,
            bvid: track.bvid,
            cid: track.cid,
            position: audio.currentTime || 0
        }, st.playlistId, { recovery: true });
    } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) };
    }
    recoveryRunning = false;
    if (result && result.ok && !result.cancelled) {
        recoveryAttempts = 0;
        recoveryPending = false;
        BPLLog.info('off', '音频自恢复成功：' + reason);
        return;
    }
    if (!recoveryPending) return;
    if (recoveryAttempts < 3 && curTrack) {
        const backoff = [1000, 3000, 7000][recoveryAttempts - 1] || 7000;
        scheduleRecovery(reason + '（重试）', backoff);
        return;
    }
    recoveryPending = false;
    recoveryAttempts = 0;
    await pStopPlayback();
    const message = (result && result.error) || '网络异常，音频无法恢复';
    BPLLog.error('off', '音频自恢复失败：' + message);
    BPLLog.flush();
    broadcastPlayerError(message, reason);
}

audio.addEventListener('ended', () => {
    runAsync('自动切歌失败', async () => {
        const st = await pGetState();
        if (st.mode === 'one') {
            audio.currentTime = 0;
            const intent = startPlayIntent();
            playbackAttemptActive++;
            const result = await playSettled(audio, PLAY_TIMEOUT_MS, playAbortController && playAbortController.signal);
            playbackAttemptActive--;
            if (result.ok && isCurrentPlay(intent.id)) await pSetState({ playing: true });
            else if (!result.cancelled) scheduleRecovery('repeat playback failed', 800);
        } else {
            await pAdvance();
        }
    });
});
audio.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    runAsync('播放状态同步失败', () => pSetState({ playing: true }));
});
audio.addEventListener('playing', () => {
    // 短暂 stalled 后若媒体自行恢复，不再让旧定时器重新解析并打断正常播放。
    if (recoveryPending && !recoveryRunning) {
        recoveryPending = false;
        recoveryAttempts = 0;
        if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
        BPLLog.info('off', '音频已自行恢复，取消排队中的自恢复任务');
    }
});
audio.addEventListener('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    // 任何暂停路径（面板按钮/MediaSession/系统键）都落断点——这正是文档被回收前的最后一笔。
    // stop 会先同步清掉 curTrack，故其后触发的本事件不会误写（断点清除优先）。
    persistPosition(audio.currentTime || 0);
    runAsync('暂停状态同步失败', () => pSetState({ playing: false }));
});
// 关键诊断：play() 可能先 resolve、随后由 error 事件异步失败（如 CDN 403/解码错），
// 此处把 MediaError code、src、网络/就绪状态全部记下，专治“无法播放音源”查无对证
audio.addEventListener('error', () => {
    const e = audio.error;
    const code = e && e.code;
    BPLLog.error('off', 'audio error 事件：code=' + code + '(' + (MEDIA_ERR_NAME[code] || '?') + ')' +
        ' msg=' + ((e && e.message) || '-') +
        ' src=' + hostOf(audio.src) +
        ' networkState=' + (NET_STATE[audio.networkState] != null ? NET_STATE[audio.networkState] : audio.networkState) +
        ' readyState=' + (READY_STATE[audio.readyState] != null ? READY_STATE[audio.readyState] : audio.readyState));
    BPLLog.flush();
    if (!playbackAttemptActive && Date.now() >= suppressRecoveryUntil) scheduleRecovery('audio error', 800);
});
audio.addEventListener('stalled', () => {
    BPLLog.warn('off', 'audio stalled（取流停滞）：src=' + hostOf(audio.src) +
        ' networkState=' + (NET_STATE[audio.networkState] != null ? NET_STATE[audio.networkState] : audio.networkState));
    if (!playbackAttemptActive && Date.now() >= suppressRecoveryUntil) scheduleRecovery('audio stalled', 8000);
});
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
        if (recoveryPending) scheduleRecovery('network online', 0);
    });
}

store.get(['bpl_volume', 'bpl_mute']).then(r => {
    if (typeof r.bpl_volume === 'number') audio.volume = Math.max(0, Math.min(1, r.bpl_volume));
    if (typeof r.bpl_mute === 'boolean') audio.muted = r.bpl_mute;
}).catch(error => BPLLog.error('off', '恢复音量设置失败：' + String((error && error.message) || error)));

let progTick = 0;
setInterval(() => {
    if (!audio.src) return;
    relayBroadcast({
        type: 'progress',
        position: audio.currentTime || 0,
        duration: audio.duration || 0,
        playing: !audio.paused
    });
    // 播放中每 5s 落一次断点：即便播放途中文档被回收（罕见但 Chromium 确会发生），
    // 损失也不超过 5s；暂停时的落盘由 pause 事件保证，二者互补。
    if (!audio.paused && ++progTick % 5 === 0) persistPosition(audio.currentTime || 0);
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

function onPlaylistsChanged() {
    shuffleOrder = []; shufflePos = -1;
    pGetItems().then(items => {
        const currentExists = !curTrack || items.some(it =>
            (curTrack.id && it.id) ? curTrack.id === it.id
                : (curTrack.bvid === it.bvid && (curTrack.cid || 0) === (it.cid || 0))
        );
        if (audio.src && (!items.length || !currentExists)) {
            pStopPlayback();
        }
    }).catch(error => BPLLog.error('off', '处理歌单变更失败：' + String((error && error.message) || error)));
}
// 无 chrome.storage 的环境没有 onChanged：改由上面的 'data' 广播驱动（background 每次改单都会广播）
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.bpl_playlists) return;
        onPlaylistsChanged();
    });
}

async function handleCmd(msg) {
    switch (msg.cmd) {
        case 'toggle': return await pToggle();
        case 'next': return await pNext();
        case 'prev': return await pPrev();
        case 'playIndex':
            if (!msg.playlistId) await pEnsurePlaylist();
            return await pPlayIndex(msg.index, false, null, msg.playlistId);
        case 'seek': audio.currentTime = msg.value || 0; return { ok: true };
        case 'getStatus': return { ok: true, position: audio.currentTime || 0, duration: audio.duration || 0, playing: !audio.paused, index: curIndex, hasTrack: !!audio.src };
        case 'stop': return await pStopPlayback();
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
            store.set({ bpl_volume: v });
            return { ok: true, volume: v, muted: audio.muted };
        }
        case 'setMute': {
            audio.muted = !!msg.muted;
            store.set({ bpl_mute: audio.muted });
            return { ok: true, volume: audio.volume, muted: audio.muted };
        }
        case 'getVolume': return { ok: true, volume: audio.volume, muted: audio.muted };
        case 'ping': return { ok: true, pong: 1 };   // 健康探测应答（供诊断/自检 offscreen 是否存活）
        default: return { ok: false };
    }
}

pGetState().then(st => broadcastState(st))
    .catch(error => BPLLog.error('off', '初始化播放状态失败：' + String((error && error.message) || error)));

window.addEventListener('error', e => {
    BPLLog.error('off', 'offscreen 脚本错误：' + ((e && e.message) || e));
});
window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    BPLLog.error('off', 'offscreen Promise 错误：' + (r ? ((r.message) || r) : e));
});

// 就绪信号放在最后：此时 Port 监听器与 runtime.onMessage 兜底监听器均已注册，
// background 收到该 ping 后才认为 offscreen 可经 sendMessage 兜底，避免“就绪却收不到命令”的窗口
try {
    chrome.runtime.sendMessage({ bplPing: 'offscreen-ready' }).catch(() => {});
} catch (_) {}
