// 日志：Service Worker 经 importScripts 载入共享 logger；测试/异常环境下用空实现兜底
if (typeof importScripts === 'function') { try { importScripts('../shared/logger.js'); } catch (_) {} }
if (typeof importScripts === 'function') { try { importScripts('../rename/renamer.js'); } catch (_) {} }
if (typeof importScripts === 'function') { try { importScripts('../charts/apple.js'); } catch (_) {} }
if (typeof importScripts === 'function') { try { importScripts('../charts/qq.js'); } catch (_) {} }
if (typeof importScripts === 'function') { try { importScripts('../charts/netease.js'); } catch (_) {} }
if (typeof importScripts === 'function') { try { importScripts('../charts/matcher.js'); } catch (_) {} }
if (typeof BPLLog === 'undefined') {
    globalThis.BPLLog = { info() {}, log() {}, warn() {}, error() {}, flush() {}, recent() { return []; } };
}

const DEF_STATE = { playlistId: null, trackId: null, index: 0, playing: false, mode: 'loop' };
const STORAGE_SCHEMA_VERSION = 1;

const MODES = ['order', 'shuffle', 'one', 'loop', 'shuffleLoop'];
const CHART_MATCH_STATES = ['pending', 'matching', 'matched', 'failed'];
const CHART_AUTO_MATCH_DELAY_MS = 8000;
const CHART_MATCH_TIMEOUT_MS = 12000;
const CHART_NETWORK_TIMEOUT_MS = 12000;
const chartMatchInflight = new Map();
const chartImportInflight = new Map();
const sourceRematchInflight = new Map();
const DEFINITIVE_UNAVAILABLE_CODES = new Set([-404, 62002]);
let chartAutoMatchTask = null;
let chartAutoNextAt = 0;
let chartAutoPlaylistId = null;
let chartWasPlaying = false;
let chartWindowId = null;
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
// All read/modify/write operations on player state share this queue. Offscreen
// reports patches; it never persists an independently read snapshot.
let playerStateMutationChain = Promise.resolve();
function withPlayerStateMutation(fn) {
    const task = playerStateMutationChain.then(fn, fn);
    playerStateMutationChain = task.then(() => {}, () => {});
    return task;
}
function patchPlayerState(patch, context) {
    return withPlayerStateMutation(async () => {
        const state = await getState();
        if (context && Object.prototype.hasOwnProperty.call(context, 'trackId') &&
            state.trackId !== context.trackId) return { ok: true, stale: true, state };
        const next = Object.assign({}, state);
        for (const key of ['playlistId', 'trackId', 'index', 'playing', 'mode']) {
            if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
        }
        if (patch && patch.trackId) {
            const playlist = findPl(await getPlaylists(), next.playlistId);
            const index = playlist ? playlist.items.findIndex(item => item.id === patch.trackId) : -1;
            if (index < 0) return { ok: true, stale: true, state };
            next.index = index;
        }
        next.mode = normalizeMode(next);
        await chrome.storage.local.set({ bpl_state: next });
        return { ok: true, state: next };
    });
}
function findPl(lists, id) { return lists.find(p => p.id === id); }
function selectedItemIndices(playlist, itemIds) {
    if (!Array.isArray(itemIds)) return [];
    const ids = new Set(itemIds.filter(id => typeof id === 'string'));
    return playlist.items.map((item, index) => ids.has(item.id) ? index : -1).filter(index => index >= 0);
}
function deletionConfirmationMatches(playlist, confirmation, itemIds) {
    if (!playlist || !confirmation || confirmation.playlistId !== playlist.id ||
        confirmation.name !== String(playlist.name || '') || !Array.isArray(confirmation.items)) return false;
    const ids = itemIds == null ? playlist.items.map(item => item.id) : itemIds;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || confirmation.items.length !== ids.length) return false;
    const expected = new Map();
    for (const item of confirmation.items) {
        if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || expected.has(item.id)) return false;
        expected.set(item.id, item.title);
    }
    const current = new Map(playlist.items.map(item => [item.id, item]));
    return ids.every(id => current.has(id) && expected.has(id) && expected.get(id) === String(current.get(id).title || ''));
}
function deletionChanged() {
    return { ok: false, staleConfirmation: true, error: '播放列表或待删除条目已变化，请取消后重新确认' };
}
function resetMatchingState(item) {
    if (item.matchState !== 'matching') return false;
    item.matchState = item.bvid ? 'matched' : 'pending';
    delete item.matchStartedAt;
    delete item.matchError;
    return true;
}
function positionMatchesItem(pos, it) {
    if (!pos || !it) return false;
    if (pos.trackId && it.id) return pos.trackId === it.id;
    return pos.bvid === it.bvid && (pos.cid || 0) === (it.cid || 0);
}
async function reconcileStoredState(lists) {
    return await withPlayerStateMutation(async () => {
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
    if (before !== JSON.stringify(st)) await chrome.storage.local.set({ bpl_state: st });
    if (trackRemoved) await chrome.storage.local.set({ bpl_position: null });
    return { state: st, trackRemoved };
    });
}
function normUrl(u) {
    u = String(u || '');
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u;
}
const NETWORK_TIMEOUT_MS = 5000;
const NETWORK_RETRY_DELAY_MS = 250;
// A failed automatic chart search should not be retriggered by several UI
// contexts in quick succession. Manual retry deliberately bypasses this gate.
const CHART_MATCH_FAILURE_COOLDOWN_MS = 15000;
const CHART_MANUAL_RETRY_LIMIT = 10;
const MATCH_OPERATION_TIMEOUT_MS = 105000;
const MATCH_PLAY_OPERATION_TIMEOUT_MS = 140000;
const MEDIA_PROBE_TIMEOUT_MS = 12000;
let backgroundPlayIntent = 0;
function beginBackgroundPlayIntent() { return ++backgroundPlayIntent; }
function currentBackgroundPlayIntent(intent) { return intent === backgroundPlayIntent; }
function matchIdentity(item) {
    return [item.matchOrigin || '', item.chartSource || '', item.chartId || '',
        item.sourceRank || '', item.sourceTitle || '', item.sourceArtist || '',
        item.matchTargetTitle || '', item.matchTargetArtist || '', Number(item.matchRevision) || 0].join('|');
}
function matchTimeoutError() {
    const error = new Error('匹配音源超时，请稍后重试');
    error.name = 'TimeoutError';
    error.transient = true;
    return error;
}
function assertMatchDeadline(deadline) {
    if (Date.now() >= deadline) throw matchTimeoutError();
}
// Each phase consumes the same operation budget. Ignore a late resolution even
// if the event loop delivers it before the timer callback. Callers commit only
// after this promise succeeds, so abandoned requests cannot save a new source.
function matchBeforeDeadline(deadline, operation) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };
        if (Date.now() >= deadline) { reject(matchTimeoutError()); return; }
        timer = setTimeout(() => finish(reject, matchTimeoutError()), deadline - Date.now());
        Promise.resolve().then(() => {
            assertMatchDeadline(deadline);
            return operation();
        }).then(value => {
            if (Date.now() >= deadline) finish(reject, matchTimeoutError());
            else finish(resolve, value);
        }, error => finish(reject, error));
    });
}
async function verifyCandidateMedia(urls, deadline) {
    const result = await matchBeforeDeadline(deadline, () => sendToOffscreen({ cmd: 'probeAudio', urls,
        timeoutMs: Math.min(MEDIA_PROBE_TIMEOUT_MS, deadline - Date.now()) }));
    if (result && result.ok) return;
    const error = new Error(result && result.error || '候选音频无法播放');
    error.transient = !!(result && (result.transient || result.cancelled || result._transport));
    throw error;
}
function isTransientMatchError(error) {
    return !!(error && (error.transient || error.name === 'TimeoutError' ||
        error.name === 'TypeError' || Number(error.status) === 408 ||
        Number(error.status) === 429 || Number(error.status) >= 500));
}
// Bilibili may temporarily reject extension-originated search requests with
// HTTP 412. Retry only the search request itself, with a short backoff, so a
// single user action can recover without turning a rejection into a request
// burst. Candidate/playability retries remain controlled by the caller.
const BILI_SEARCH_412_RETRY_LIMIT = 4;
const BILI_SEARCH_412_RETRY_DELAYS_MS = [1500, 3000, 6000];
const COLLECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const COLLECTION_CACHE_MAX = 20;
const collectionCache = new Map();
const collectionInflight = new Map();
function waitMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isRetryableNetworkError(error) {
    const status = Number(error && error.status) || 0;
    return !status || status === 408 || status === 429 || status >= 500;
}
function isDefinitiveUnavailableResponse(value) {
    return !!(value && DEFINITIVE_UNAVAILABLE_CODES.has(Number(value.code)));
}
function apiResponseError(value, fallback) {
    const error = new Error(String(value && value.message || fallback || 'B站接口返回异常'));
    if (isDefinitiveUnavailableResponse(value)) error.sourceUnavailable = true;
    return error;
}
async function biliFetchOnce(url, timeout) {
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timer = null;
    let settled = false;
    return await new Promise((resolve, reject) => {
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };
        timer = setTimeout(() => {
            if (controller) { try { controller.abort(); } catch (_) {} }
            const error = new Error('网络请求超时');
            error.name = 'TimeoutError';
            finish(reject, error);
        }, timeout || NETWORK_TIMEOUT_MS);
        // 所有接口都只读取公开数据，不需要用户登录态。显式 omit 可避免
        // Edge/Chrome 对扩展跨站凭据请求执行更严格的 CORS/隐私拦截。
        const options = { credentials: 'omit', cache: 'no-store' };
        if (/^https:\/\/api\.bilibili\.com\//i.test(String(url || ''))) {
            // B站公开接口会拒绝没有来源的扩展请求（HTTP 412）。
            // 该 referrer 只附加到扩展自身发出的 fetch，不会修改网页请求。
            options.referrer = 'https://www.bilibili.com/';
            options.referrerPolicy = 'strict-origin-when-cross-origin';
        }
        if (controller) options.signal = controller.signal;
        Promise.resolve(fetch(url, options)).then(async response => {
            if (response && response.ok === false) {
                const error = new Error('HTTP ' + response.status);
                error.status = response.status;
                throw error;
            }
            return await response.json();
        }).then(value => finish(resolve, value), error => finish(reject, error));
    });
}
async function biliFetch(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return await biliFetchOnce(url, NETWORK_TIMEOUT_MS); }
        catch (error) {
            lastError = error;
            if (attempt || !isRetryableNetworkError(error)) break;
            await waitMs(NETWORK_RETRY_DELAY_MS);
        }
    }
    throw lastError || new Error('网络请求失败');
}
async function chartFetch(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        // 榜单只需要公开的歌曲名、歌手和排名，不需要用户 Cookie。
        try { return await biliFetchOnce(url, CHART_NETWORK_TIMEOUT_MS); }
        catch (error) {
            lastError = error;
            if (attempt || !isRetryableNetworkError(error)) break;
            await waitMs(NETWORK_RETRY_DELAY_MS);
        }
    }
    throw lastError || new Error('榜单网络请求失败');
}

function isSearchRateLimitedResponse(value) {
    const code = Number(value && value.code);
    return code === 412 || code === -412;
}

// Search endpoints get a separate, bounded 412 retry policy. The generic
// Bilibili fetch helper intentionally does not retry 412 because most other
// endpoints should fail fast when anti-abuse checks reject a request.
async function biliSearchFetch(url) {
    let lastError;
    for (let attempt = 0; attempt < BILI_SEARCH_412_RETRY_LIMIT; attempt++) {
        try {
            const response = await biliFetch(url);
            if (isSearchRateLimitedResponse(response)) {
                const error = apiResponseError(response, 'HTTP 412');
                error.status = 412;
                throw error;
            }
            return response;
        } catch (error) {
            lastError = error;
            const status = Number(error && error.status) || 0;
            if (status !== 412 || attempt + 1 >= BILI_SEARCH_412_RETRY_LIMIT) break;
            const delay = BILI_SEARCH_412_RETRY_DELAYS_MS[attempt] || BILI_SEARCH_412_RETRY_DELAYS_MS[BILI_SEARCH_412_RETRY_DELAYS_MS.length - 1];
            BPLLog.info('chart', 'B站搜索返回 HTTP 412，' + delay + 'ms 后重试（' +
                (attempt + 2) + '/' + BILI_SEARCH_412_RETRY_LIMIT + '）');
            await waitMs(delay);
        }
    }
    throw lastError || new Error('B站搜索失败');
}

function chartCatalog() {
    const sources = [];
    for (const adapter of [globalThis.BPLChartApple, globalThis.BPLChartQQ, globalThis.BPLChartNetease]) {
        if (adapter && typeof adapter.catalog === 'function') sources.push(adapter.catalog());
    }
    return sources;
}
function chartAdapter(sourceId) {
    if (sourceId === 'apple' && globalThis.BPLChartApple) return globalThis.BPLChartApple;
    if (sourceId === 'qq' && globalThis.BPLChartQQ) return globalThis.BPLChartQQ;
    if (sourceId === 'netease' && globalThis.BPLChartNetease) return globalThis.BPLChartNetease;
    return null;
}
function chartItemKey(playlistId, itemId) { return String(playlistId || '') + ':' + String(itemId || ''); }
function isChartItem(item) {
    return !!(item && item.chartSource && item.sourceTitle && CHART_MATCH_STATES.indexOf(item.matchState) >= 0);
}
function isManualItem(item) {
    return !!(item && item.matchOrigin === 'manual' && item.matchTargetTitle &&
        CHART_MATCH_STATES.indexOf(item.matchState) >= 0);
}
function isMatchItem(item) {
    return isChartItem(item) || isManualItem(item);
}
function chartDisplayTitle(title, artist) {
    const songTitle = String(title || '').trim();
    const songArtist = String(artist || '').trim();
    return songTitle + (songArtist ? ' - ' + songArtist : '');
}
function normalizedMatchHistory(item) {
    const result = [];
    for (const bvid of (Array.isArray(item && item.matchHistory) ? item.matchHistory : [])) {
        const value = String(bvid || '');
        if (isValidBvid(value) && result.indexOf(value) < 0) result.push(value);
    }
    return result;
}
function extendedMatchHistory(item, ...bvids) {
    const result = normalizedMatchHistory(item);
    for (const bvid of bvids) {
        const value = String(bvid || '');
        if (!isValidBvid(value)) continue;
        const previous = result.indexOf(value);
        if (previous >= 0) result.splice(previous, 1);
        result.push(value);
    }
    return result;
}
function matchOrigin(item) {
    if (item && (item.matchOrigin === 'chart' || item.matchOrigin === 'repair' || item.matchOrigin === 'manual')) return item.matchOrigin;
    return isChartItem(item) && item.bvid ? 'chart' : '';
}
function canRematchSource(item) {
    return !!(item && item.bvid && (item.sourceUnavailable || matchOrigin(item)));
}
function sourceMatchTarget(item) {
    const chartTitle = String(item && item.sourceTitle || '').trim();
    const chartArtist = String(item && item.sourceArtist || '').trim();
    return {
        title: String(item && (item.matchTargetTitle || chartTitle || item.title) || '').trim(),
        sourceArtist: String(item && (item.matchTargetArtist || chartArtist) || '').trim(),
        duration: Number(item && (item.matchTargetDuration || item.duration)) || 0,
        owner: String(item && (item.matchTargetOwner || (!matchOrigin(item) ? item.owner : '')) || '').trim()
    };
}
function chartPlaceholder(source, song) {
    const title = String(song.title || '').trim();
    const artist = String(song.artist || '').trim();
    return {
        id: genId(),
        bvid: '', cid: 0,
        title: chartDisplayTitle(title, artist),
        pic: '', owner: '', duration: 0, page: 1,
        chartSource: source.sourceId,
        chartId: source.chartId,
        sourceRank: Number(song.rank) || 0,
        sourceTitle: title,
        sourceArtist: artist,
        matchState: 'pending',
        matchAttempts: 0
    };
}
function biliSearchCandidate(raw) {
    const matcher = globalThis.BPLChartMatcher;
    const arc = String(raw && (raw.arcurl || raw.url) || '');
    const match = arc.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return {
        bvid: String(raw && raw.bvid || (match && match[1]) || ''),
        title: matcher ? matcher.stripHtml(raw && raw.title) : String(raw && raw.title || '').replace(/<[^>]*>/g, ''),
        author: String(raw && (raw.author || raw.owner && raw.owner.name) || ''),
        pic: normUrl(raw && (raw.pic || raw.cover)),
        duration: raw && raw.duration,
        play: Number(raw && raw.play) || 0,
        typename: String(raw && raw.typename || ''),
        tags: String(raw && (raw.tag || raw.tags) || ''),
        description: matcher ? matcher.stripHtml(raw && raw.description) : String(raw && raw.description || '').replace(/<[^>]*>/g, ''),
        rank: Number(raw && (raw.rank_index || raw.rank)) || 0
    };
}
async function searchBiliChartItem(item, manual, extraExcluded) {
    const matcher = globalThis.BPLChartMatcher;
    if (!matcher || typeof matcher.rankReplacementCandidates !== 'function') throw new Error('榜单匹配器不可用');
    const target = sourceMatchTarget(item);
    const keyword = [target.title, target.sourceArtist].filter(Boolean).join(' ');
    if (!keyword) throw new Error('条目标题为空，无法搜索音源');
    const pageSize = manual ? 30 : 10;
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
        '&order=totalrank&page=1&page_size=' + pageSize + '&keyword=' + encodeURIComponent(keyword);
    const response = await biliSearchFetch(url);
    if (!response || response.code !== 0 || !response.data) {
        throw new Error((response && response.message) || 'B站搜索失败');
    }
    const excluded = new Set(extendedMatchHistory(item, item.bvid));
    for (const bvid of (extraExcluded || [])) excluded.add(String(bvid || ''));
    const candidates = (Array.isArray(response.data.result) ? response.data.result : [])
        .map(biliSearchCandidate)
        .filter(candidate => candidate.bvid && !excluded.has(candidate.bvid));
    const ranked = matcher.rankReplacementCandidates({
        title: target.title,
        sourceArtist: target.sourceArtist,
        duration: target.duration
    }, candidates, manual ? 18 : 24);
    return ranked.length ? Object.assign({ score: ranked[0].score }, ranked[0].candidate) : null;
}
async function mutateChartItem(playlistId, itemId, updater) {
    let updated = false;
    await withPlaylistMutation(async () => {
        const lists = await getPlaylists();
        const playlist = findPl(lists, playlistId);
        const item = playlist && playlist.items.find(entry => entry.id === itemId);
        if (!item || !isMatchItem(item)) return;
        updated = updater(item) !== false;
        if (!updated) return;
        await savePlaylists(lists);
        await broadcastData();
    });
    return updated;
}
async function performChartMatch(playlistId, itemId, manual, verifyPlayable, operationDeadline) {
    const deadline = operationDeadline || Date.now() + MATCH_OPERATION_TIMEOUT_MS;
    const lists = await getPlaylists();
    const playlist = findPl(lists, playlistId);
    const snapshot = playlist && playlist.items.find(item => item.id === itemId);
    if (!snapshot || !isMatchItem(snapshot)) return { ok: false, cancelled: true, error: '待匹配条目不存在' };
    const alreadyMatched = snapshot.matchState === 'matched' && snapshot.bvid;
    if (alreadyMatched && !(manual && verifyPlayable)) return { ok: true, matched: true, itemId: itemId };
    if (!manual && snapshot.matchState === 'failed' && snapshot.matchFailedAt &&
        Date.now() - Number(snapshot.matchFailedAt) < CHART_MATCH_FAILURE_COOLDOWN_MS) {
        return { ok: false, throttled: true, itemId: itemId,
            error: snapshot.matchError || '自动匹配暂未成功，请稍后手动重试' };
    }

    const sourceIdentity = matchIdentity(snapshot);
    const started = await mutateChartItem(playlistId, itemId, item => {
        if (matchIdentity(item) !== sourceIdentity) return false;
        item.matchState = 'matching';
        item.matchStartedAt = Date.now();
        item.matchAttempts = (Number(item.matchAttempts) || 0) + 1;
        delete item.matchError;
    });
    if (!started) return { ok: false, cancelled: true, error: '待匹配条目已发生变化' };

    try {
        const excludedCandidates = new Set();
        const retryLimit = manual && verifyPlayable ? CHART_MANUAL_RETRY_LIMIT : 1;
        let candidate = null;
        let verified = null;
        let lastCandidateError = null;
        for (let attempt = 0; attempt < retryLimit; attempt++) {
            assertMatchDeadline(deadline);
            let current = null;
            try {
                // 每一轮都重新发起一次搜索，只采用这一轮的最佳结果。
                // 不把一次搜索返回的多个候选当作同一轮的重试。
                // A manual request may join an automatic search. Validate its
                // existing result first; only a failed source needs a fresh search.
                current = alreadyMatched && attempt === 0
                    ? { bvid: snapshot.bvid, title: snapshot.title, pic: snapshot.pic,
                        author: snapshot.owner, duration: snapshot.duration, score: snapshot.matchScore }
                    : await matchBeforeDeadline(deadline, () => searchBiliChartItem(snapshot, !!manual, excludedCandidates));
                if (!current || !isValidBvid(current.bvid)) throw new Error('没有找到可信的B站视频');
                candidate = current;
                if (!(manual && verifyPlayable)) break;
                const resolved = await matchBeforeDeadline(deadline, () => resolveCid(current.bvid, 1));
                if (!resolved || !resolved.cid) throw new Error('候选视频没有可播放的分P');
                const urls = await matchBeforeDeadline(deadline, () => getAudioUrls(current.bvid, resolved.cid));
                if (!urls || !urls.length) throw new Error('候选视频没有公开音频流');
                await verifyCandidateMedia(urls, deadline);
                verified = { candidate: current, resolved: resolved };
                break;
            } catch (candidateError) {
                lastCandidateError = candidateError;
                if (isTransientMatchError(candidateError)) throw candidateError;
                if (current && current.bvid) excludedCandidates.add(current.bvid);
                BPLLog.info('chart', '第 ' + (attempt + 1) + '/' + retryLimit + ' 次匹配失败' +
                    (current && current.bvid ? '[' + current.bvid + ']' : '') + '：' +
                    String(candidateError && candidateError.message || candidateError));
                // biliSearchFetch already made bounded, delayed retries for
                // HTTP 412. If they all failed there is no candidate to
                // exclude, so stop this match instead of starting another
                // outer candidate round against the same rejection.
                if (!current && Number(candidateError && candidateError.status) === 412) throw candidateError;
                if (attempt + 1 >= retryLimit) {
                    if (!(manual && verifyPlayable)) throw candidateError;
                    throw new Error('最多重试 ' + retryLimit + ' 次后仍未找到可播放音源：' +
                        String(lastCandidateError && lastCandidateError.message || lastCandidateError));
                }
            }
        }
        if (!candidate || (manual && verifyPlayable && !verified)) {
            throw new Error('没有找到可信的可播放B站视频');
        }
        const matcher = globalThis.BPLChartMatcher;
        const changed = await mutateChartItem(playlistId, itemId, item => {
            assertMatchDeadline(deadline);
            const currentIdentity = matchIdentity(item);
            if (currentIdentity !== sourceIdentity) return false;
            item.bvid = candidate.bvid;
            item.cid = verified && verified.resolved ? (Number(verified.resolved.cid) || 0) : 0;
            // Keep the canonical chart label. The Bilibili candidate supplies
            // playback metadata only; its promotional/original title should
            // not leak into a chart playlist.
            const isChart = isChartItem(item);
            if (isChart) item.title = chartDisplayTitle(item.sourceTitle, item.sourceArtist) || candidate.title;
            item.pic = normUrl(candidate.pic);
            item.owner = candidate.author || '';
            item.duration = matcher ? matcher.parseDuration(candidate.duration) : 0;
            item.page = verified && verified.resolved && verified.resolved.page
                ? (Number(verified.resolved.page.page) || 1) : 1;
            item.matchState = 'matched';
            item.matchScore = Number(candidate.score) || 0;
            item.matchedAt = Date.now();
            item.matchOrigin = isChart ? 'chart' : 'manual';
            item.matchTargetTitle = isChart ? item.sourceTitle : (item.matchTargetTitle || item.title);
            item.matchTargetArtist = isChart ? (item.sourceArtist || '') : (item.matchTargetArtist || '');
            item.matchTargetDuration = item.matchTargetDuration || (matcher ? matcher.parseDuration(candidate.duration) : 0);
            item.matchHistory = extendedMatchHistory(item, candidate.bvid);
            delete item.matchStartedAt;
            delete item.matchError;
        });
        return changed ? { ok: true, matched: true, itemId: itemId, bvid: candidate.bvid }
            : { ok: false, cancelled: true, error: '榜单条目已发生变化' };
    } catch (error) {
        const message = String(error && error.message || error || '匹配失败');
        await mutateChartItem(playlistId, itemId, item => {
            if (matchIdentity(item) !== sourceIdentity) return false;
            item.matchState = 'failed';
            item.matchError = message;
            item.matchFailedAt = Date.now();
            delete item.matchStartedAt;
        });
        BPLLog.warn('chart', '匹配失败[' + (snapshot.sourceArtist || snapshot.matchTargetArtist || '') + ' - ' +
            (snapshot.sourceTitle || snapshot.matchTargetTitle || snapshot.title || '') + ']：' + message);
        return { ok: false, error: message, itemId: itemId };
    }
}
async function matchChartItem(playlistId, itemId, manual, verifyPlayable) {
    const key = chartItemKey(playlistId, itemId);
    const existing = chartMatchInflight.get(key);
    const needsVerification = !!(manual && verifyPlayable);
    if (existing && (!needsVerification || existing.verifiesPlayback)) return await existing;
    const deadline = Date.now() + MATCH_OPERATION_TIMEOUT_MS;
    const run = async () => {
        if (existing) {
            await matchBeforeDeadline(deadline, () => existing);
            // A renamed pending item also invalidates its queued verification.
            if (chartMatchInflight.get(key) !== task) return { ok: false, cancelled: true };
        }
        return await performChartMatch(playlistId, itemId, manual, verifyPlayable, deadline);
    };
    const task = run().catch(error => ({ ok: false, error: String(error.message || error), itemId }))
        .finally(() => { if (chartMatchInflight.get(key) === task) chartMatchInflight.delete(key); });
    task.verifiesPlayback = needsVerification;
    chartMatchInflight.set(key, task);
    return await task;
}
async function matchNextChartItem(playlistId) {
    if (!playlistId) return { ok: true, idle: true };
    const lists = await getPlaylists();
    const playlist = findPl(lists, playlistId);
    if (!playlist || !playlist.chartSource) return { ok: true, idle: true };
    const now = Date.now();
    const item = playlist.items.find(entry => isChartItem(entry) && (
        entry.matchState === 'pending' || (entry.matchState === 'matching' && now - (entry.matchStartedAt || 0) > CHART_MATCH_TIMEOUT_MS)
    ));
    return item ? await matchChartItem(playlist.id, item.id, false) : { ok: true, idle: true };
}
async function playChartItem(playlistId, itemId) {
    const playbackDeadline = Date.now() + MATCH_PLAY_OPERATION_TIMEOUT_MS;
    const intent = beginBackgroundPlayIntent();
    let lists = await getPlaylists();
    let playlist = findPl(lists, playlistId);
    let index = playlist ? playlist.items.findIndex(item => item.id === itemId) : -1;
    if (index < 0) return { ok: false, error: '榜单条目不存在' };
    let item = playlist.items[index];
    if (isChartItem(item) && (item.matchState !== 'matched' || !item.bvid)) {
        const matched = await matchChartItem(playlistId, itemId, true, true);
        if (!matched || !matched.ok) return matched || { ok: false, error: '匹配音源失败' };
        lists = await getPlaylists();
        playlist = findPl(lists, playlistId);
        index = playlist ? playlist.items.findIndex(entry => entry.id === itemId) : -1;
        item = index >= 0 ? playlist.items[index] : null;
    }
    if (!item || !item.bvid) return { ok: false, error: '匹配音源失败' };
    if (!currentBackgroundPlayIntent(intent)) return { ok: true, cancelled: true };
    return await sendToOffscreen({ cmd: 'playIndex', index: index, itemId: item.id, playlistId: playlistId, _intentId: intent, playbackDeadline });
}

async function setSourceUnavailable(playlistId, itemId, bvid, message) {
    if (!playlistId || !itemId || !bvid) return false;
    return await mutatePlaylistItem(playlistId, itemId, item => {
        if (item.bvid !== bvid) return false;
        item.sourceUnavailable = true;
        item.sourceUnavailableAt = Date.now();
        item.sourceUnavailableReason = String(message || '原视频已失效').slice(0, 200);
    });
}

async function mutatePlaylistItem(playlistId, itemId, updater) {
    let updated = false;
    await withPlaylistMutation(async () => {
        const lists = await getPlaylists();
        const playlist = findPl(lists, playlistId);
        const item = playlist && playlist.items.find(entry => entry.id === itemId);
        if (!item) return;
        updated = updater(item) !== false;
        if (!updated) return;
        await savePlaylists(lists);
        await broadcastData();
    });
    return updated;
}

async function checkBiliSource(bvid) {
    try {
        const response = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
        if (response && response.code === 0 && response.data) return { available: true, response };
        if (isDefinitiveUnavailableResponse(response)) {
            return { available: false, unavailable: true, error: String(response.message || '原视频已失效') };
        }
        return { available: false, unavailable: false, error: String(response && response.message || '无法确认原视频状态') };
    } catch (error) {
        return { available: false, unavailable: false, error: String(error && error.message || error) };
    }
}

async function searchReplacementCandidates(item) {
    const matcher = globalThis.BPLChartMatcher;
    if (!matcher || typeof matcher.rankReplacementCandidates !== 'function') throw new Error('替代源匹配器不可用');
    const target = sourceMatchTarget(item);
    const keyword = [target.title, target.sourceArtist].filter(Boolean).join(' ');
    if (!keyword) throw new Error('条目标题为空，无法搜索替代源');
    const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
        '&order=totalrank&page=1&page_size=30&keyword=' + encodeURIComponent(keyword);
    const response = await biliSearchFetch(url);
    if (!response || response.code !== 0 || !response.data) {
        throw new Error((response && response.message) || 'B站搜索失败');
    }
    const excluded = new Set(extendedMatchHistory(item, item && item.bvid));
    const candidates = (Array.isArray(response.data.result) ? response.data.result : [])
        .map(biliSearchCandidate)
        .filter(candidate => candidate.bvid && !excluded.has(candidate.bvid));
    return matcher.rankReplacementCandidates(target, candidates).slice(0, 3);
}

function replacementResolvedPage(item, resolved) {
    const pages = resolved && resolved.info && Array.isArray(resolved.info.pages) ? resolved.info.pages : [];
    const duration = Number(item && item.duration) || 0;
    if (pages.length <= 1 || !duration) return resolved;
    let best = pages[0];
    let bestDiff = Math.abs((Number(best.duration) || 0) - duration);
    for (const page of pages.slice(1)) {
        const diff = Math.abs((Number(page.duration) || 0) - duration);
        if (diff < bestDiff) { best = page; bestDiff = diff; }
    }
    return { cid: best.cid || resolved.cid, info: resolved.info, page: best };
}

async function performSourceRematch(playlistId, itemId) {
    const playbackDeadline = Date.now() + MATCH_PLAY_OPERATION_TIMEOUT_MS;
    const intent = beginBackgroundPlayIntent();
    const deadline = Date.now() + MATCH_OPERATION_TIMEOUT_MS;
    let lists = await getPlaylists();
    let playlist = findPl(lists, playlistId);
    let item = playlist && playlist.items.find(entry => entry.id === itemId);
    if (!item || !canRematchSource(item) || !isValidBvid(item.bvid)) {
        return { ok: false, error: '该条目不支持重新匹配音源' };
    }
    const originalBvid = item.bvid;
    const originalTitle = item.title;
    if (item.sourceUnavailable && !matchOrigin(item)) {
        let recheck;
        try { recheck = await matchBeforeDeadline(deadline, () => checkBiliSource(originalBvid)); }
        catch (error) { return { ok: false, error: String(error.message || error) }; }
        if (recheck.available) {
            await mutatePlaylistItem(playlistId, itemId, current => {
                assertMatchDeadline(deadline);
                if (current.bvid !== originalBvid) return false;
                delete current.sourceUnavailable;
                delete current.sourceUnavailableAt;
                delete current.sourceUnavailableReason;
            });
            lists = await getPlaylists();
            playlist = findPl(lists, playlistId);
            const index = playlist ? playlist.items.findIndex(entry => entry.id === itemId) : -1;
            if (index < 0) return { ok: false, error: '条目已发生变化' };
            if (!currentBackgroundPlayIntent(intent)) return { ok: true, cancelled: true, recovered: true };
            const played = await sendToOffscreen({ cmd: 'playIndex', index, itemId, playlistId, _intentId: intent, playbackDeadline });
            return Object.assign({}, played, { recovered: true });
        }
        if (!recheck.unavailable) return { ok: false, error: '暂时无法确认原视频已失效，请稍后重试' };
    }

    const searchItem = Object.assign({}, item, { matchHistory: extendedMatchHistory(item, originalBvid) });
    let lastError = null;
    for (let attempt = 0; attempt < CHART_MANUAL_RETRY_LIMIT; attempt++) {
        if (Date.now() >= deadline) { lastError = matchTimeoutError(); break; }
        let entry = null;
        try {
            const ranked = await matchBeforeDeadline(deadline, () => searchReplacementCandidates(searchItem));
            if (!ranked.length) break;
            entry = ranked[0];
            let resolved = await matchBeforeDeadline(deadline, () => resolveCid(entry.candidate.bvid, 1));
            resolved = replacementResolvedPage(item, resolved);
            if (!resolved.cid) throw new Error('候选视频没有可播放的分P');
            const urls = await matchBeforeDeadline(deadline, () => getAudioUrls(entry.candidate.bvid, resolved.cid));
            await verifyCandidateMedia(urls, deadline);
            const replacement = resolvedItemFields(resolved, entry.candidate.bvid, resolved.page && resolved.page.page || 1, entry.candidate);
            const changed = await mutatePlaylistItem(playlistId, itemId, current => {
                assertMatchDeadline(deadline);
                if (current.bvid !== originalBvid || !canRematchSource(current)) return false;
                const title = current.title || originalTitle;
                const target = sourceMatchTarget(current);
                const origin = matchOrigin(current) || 'repair';
                const history = extendedMatchHistory(current, originalBvid, replacement.bvid);
                Object.assign(current, replacement);
                current.title = title;
                current.matchOrigin = origin;
                current.matchTargetTitle = target.title;
                current.matchTargetArtist = target.sourceArtist;
                current.matchTargetDuration = target.duration;
                current.matchTargetOwner = target.owner;
                current.matchHistory = history;
                if (isChartItem(current)) {
                    current.matchState = 'matched';
                    current.matchScore = Number(entry.score) || 0;
                    current.matchedAt = Date.now();
                }
                delete current.sourceUnavailable;
                delete current.sourceUnavailableAt;
                delete current.sourceUnavailableReason;
            });
            if (!changed) return { ok: false, error: '条目已发生变化' };
            lists = await getPlaylists();
            playlist = findPl(lists, playlistId);
            const index = playlist ? playlist.items.findIndex(current => current.id === itemId) : -1;
            if (index < 0) return { ok: false, error: '条目已发生变化' };
            if (!currentBackgroundPlayIntent(intent)) return { ok: true, cancelled: true, replaced: true, bvid: replacement.bvid };
            const played = await sendToOffscreen({ cmd: 'playIndex', index, itemId, playlistId, _intentId: intent, playbackDeadline });
            return Object.assign({}, played, { replaced: true, bvid: replacement.bvid });
        } catch (error) {
            lastError = error;
            if (!entry || isTransientMatchError(error) || Number(error.status) === 412) break;
            searchItem.matchHistory = extendedMatchHistory(searchItem, entry.candidate.bvid);
            BPLLog.warn('repair', '替代候选不可播放[' + entry.candidate.bvid + ']：' + String(error && error.message || error));
        }
    }
    return { ok: false, error: '没有找到可播放的替代源' + (lastError ? '：' + String(lastError.message || lastError) : '') };
}

async function rematchSource(playlistId, itemId) {
    const key = chartItemKey(playlistId, itemId);
    const existing = sourceRematchInflight.get(key);
    if (existing) return await existing;
    const task = performSourceRematch(playlistId, itemId)
        .finally(() => sourceRematchInflight.delete(key));
    sourceRematchInflight.set(key, task);
    return await task;
}

function isValidBvid(bvid) { return /^BV[0-9A-Za-z]{10,}$/.test(String(bvid || '')); }
function collectionKey(bvid) { return String(bvid || ''); }
function collectionItemKey(item) { return String(item.bvid || '') + ':' + String(Number(item.cid) || 0); }
function samePlaylistContent(left, right) {
    if (!left || !right) return false;
    if (left.bvid && right.bvid) return left.bvid === right.bvid && (left.cid || 0) === (right.cid || 0);
    if (isChartItem(left) && isChartItem(right)) {
        return left.chartSource === right.chartSource && left.chartId === right.chartId &&
            Number(left.sourceRank) === Number(right.sourceRank) && left.sourceTitle === right.sourceTitle &&
            left.sourceArtist === right.sourceArtist;
    }
    return false;
}
function addCollectionItem(items, seen, item) {
    const bvid = String(item.bvid || '');
    const cid = Number(item.cid) || 0;
    if (!isValidBvid(bvid) || !cid) return;
    const normalized = {
        bvid: bvid,
        cid: cid,
        title: String(item.title || bvid),
        renameTitle: String(item.renameTitle || item.title || bvid),
        pic: normUrl(item.pic),
        owner: String(item.owner || ''),
        duration: Number(item.duration) || 0,
        page: Number(item.page) || 1
    };
    const key = collectionItemKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
}
function collectionItemTitle(episodeTitle, part, nested, fallback) {
    const episode = String(episodeTitle || '').trim();
    const pagePart = String(part || '').trim();
    if (!nested) return pagePart || episode || String(fallback || '未命名视频');
    if (episode && pagePart && episode !== pagePart) return episode + ' · ' + pagePart;
    return pagePart || episode || String(fallback || '未命名视频');
}
function collectionRenameTitle(episodeTitle, part, nested, fallback) {
    const episode = String(episodeTitle || '').trim();
    const pagePart = String(part || '').trim();
    if (!episode || !pagePart || episode === pagePart) return pagePart || episode || String(fallback || '未命名视频');
    return episode + (nested ? ' · ' : ' | ') + pagePart;
}
function mapCollection(data, bvid) {
    const items = [], seen = new Set();
    const season = data && data.ugc_season;
    if (season && Array.isArray(season.sections) && season.sections.length) {
        for (const section of season.sections) {
            for (const episode of ((section && Array.isArray(section.episodes)) ? section.episodes : [])) {
                const pages = Array.isArray(episode.pages) && episode.pages.length
                    ? episode.pages : (episode.page ? [episode.page] : []);
                for (const page of pages) {
                    const arc = episode.arc || {};
                    const owner = arc.author && arc.author.name;
                    addCollectionItem(items, seen, {
                        bvid: episode.bvid,
                        cid: page.cid || episode.cid,
                        title: collectionItemTitle(episode.title, page.part, pages.length > 1, episode.bvid || bvid),
                        renameTitle: collectionRenameTitle(episode.title, page.part, pages.length > 1, episode.bvid || bvid),
                        pic: arc.pic || episode.pic || season.cover,
                        owner: owner || '',
                        duration: page.duration || arc.duration || episode.duration,
                        page: page.page
                    });
                }
            }
        }
        return { kind: 'season', title: String(season.title || data.title || bvid), cover: normUrl(season.cover || data.pic), items };
    }
    const pages = data && Array.isArray(data.pages) ? data.pages : [];
    if (pages.length > 1) {
        for (const page of pages) {
            const part = String(page.part || '').trim();
            addCollectionItem(items, seen, {
                bvid: data.bvid || bvid,
                cid: page.cid,
                title: part || String(data.title || bvid),
                pic: data.pic,
                owner: data.owner && data.owner.name,
                duration: page.duration || data.duration,
                page: page.page
            });
        }
        return { kind: 'pages', title: String(data.title || bvid), cover: normUrl(data.pic), items };
    }
    return { kind: 'none', title: String(data && data.title || bvid), cover: normUrl(data && data.pic), items: [] };
}
async function loadCollection(bvid) {
    if (!isValidBvid(bvid)) throw new Error('无效的 BVID');
    const key = collectionKey(bvid);
    const cached = collectionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        collectionCache.delete(key);
        collectionCache.set(key, cached);
        return cached.value;
    }
    if (collectionInflight.has(key)) return await collectionInflight.get(key);
    const task = biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
        .then(response => {
            if (!response || response.code !== 0 || !response.data) throw new Error((response && response.message) || '无法获取合集信息');
            const value = mapCollection(response.data, bvid);
            if (value.kind === 'none' || !value.items.length) {
                const error = new Error('当前视频不属于合集或多P视频');
                error.code = 'NOT_COLLECTION';
                throw error;
            }
            collectionCache.delete(key);
            collectionCache.set(key, { value, expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS });
            while (collectionCache.size > COLLECTION_CACHE_MAX) collectionCache.delete(collectionCache.keys().next().value);
            return value;
        })
        .finally(() => collectionInflight.delete(key));
    collectionInflight.set(key, task);
    return await task;
}
async function collectionSummary(bvid) {
    const value = await loadCollection(bvid);
    const activeId = await getActiveId();
    const lists = await getPlaylists();
    const active = findPl(lists, activeId);
    return {
        ok: true, kind: value.kind, bvid: String(bvid), title: value.title,
        cover: value.cover, count: value.items.length,
        activePlaylistId: active ? active.id : null,
        activePlaylistName: active ? active.name : ''
    };
}
function normalizeImportedItems(raw) {
    const seen = new Set(), items = [];
    for (const item of (Array.isArray(raw) ? raw : [])) {
        if (!item || !item.bvid) continue;
        const normalized = {
            bvid: String(item.bvid), cid: Number(item.cid) || 0,
            title: String(item.title || item.bvid), pic: normUrl(item.pic),
            owner: String(item.owner || ''), duration: Number(item.duration) || 0,
            page: Number(item.page) || 1
        };
        const key = collectionItemKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(Object.assign({ id: genId() }, normalized));
    }
    return items;
}

function clonePlaylistBackupValue(value, depth) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (depth >= 8) return null;
    if (Array.isArray(value)) return value.map(entry => clonePlaylistBackupValue(entry, depth + 1));
    if (typeof value !== 'object') return null;
    const result = {};
    for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
        result[key] = clonePlaylistBackupValue(value[key], depth + 1);
    }
    return result;
}

function restorePlaylistItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const item = clonePlaylistBackupValue(raw, 0);
    const bvid = String(item.bvid || '');
    const chartPlaceholder = !bvid && item.chartSource && item.sourceTitle &&
        CHART_MATCH_STATES.indexOf(String(item.matchState || '')) >= 0;
    const manualPlaceholder = !bvid && item.matchOrigin === 'manual' && item.matchTargetTitle &&
        CHART_MATCH_STATES.indexOf(String(item.matchState || '')) >= 0;
    if ((!bvid || !isValidBvid(bvid)) && !chartPlaceholder && !manualPlaceholder) return null;

    item.id = genId();
    item.bvid = bvid;
    item.cid = Number(item.cid) || 0;
    item.title = String(item.title || item.sourceTitle || item.matchTargetTitle || bvid);
    item.pic = normUrl(item.pic);
    item.owner = String(item.owner || '');
    item.duration = Number(item.duration) || 0;
    item.page = Number(item.page) || 1;

    if (item.matchOrigin !== 'chart' && item.matchOrigin !== 'repair' && item.matchOrigin !== 'manual') delete item.matchOrigin;
    if (CHART_MATCH_STATES.indexOf(String(item.matchState || '')) < 0) delete item.matchState;
    if (item.matchOrigin === 'manual') {
        item.matchTargetTitle = String(item.matchTargetTitle || item.title || '').trim().slice(0, 200);
        item.matchTargetArtist = String(item.matchTargetArtist || '').trim();
        item.matchTargetDuration = Number(item.matchTargetDuration) || 0;
    }
    resetMatchingState(item);
    item.matchHistory = normalizedMatchHistory(item);
    if (!item.matchHistory.length) delete item.matchHistory;
    if (!item.bvid) {
        delete item.sourceUnavailable;
        delete item.sourceUnavailableAt;
        delete item.sourceUnavailableReason;
    }
    return item;
}

function restorePlaylistMetadata(raw) {
    const metadata = clonePlaylistBackupValue(raw && typeof raw === 'object' ? raw : {}, 0);
    delete metadata.id;
    delete metadata.items;
    delete metadata.name;
    return metadata;
}
async function resolveCid(bvid, page) {
    const encoded = encodeURIComponent(bvid);
    const viewTask = biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encoded)
        .then(value => ({ value })).catch(error => ({ error }));
    const pageTask = biliFetch('https://api.bilibili.com/x/player/pagelist?bvid=' + encoded)
        .then(value => ({ value })).catch(error => ({ error }));
    const viewResult = await viewTask;
    const view = viewResult.value;
    const info = view && view.data;
    let viewError = viewResult.error || (!info ? apiResponseError(view, '无法解析视频信息') : null);
    const pages = (info && info.pages) || [];
    let pg = (page && pages.find(x => x.page === page)) || pages[0] || {};
    let cid = pg.cid || (info && info.cid) || 0;
    if (cid) return { cid: cid, info: info, page: pg };

    // view 与 pagelist 并发请求，避免异常网络下两个超时顺序叠加。
    const pageResult = await pageTask;
    const fallback = pageResult.value;
    const fallbackPages = (fallback && fallback.code === 0 && Array.isArray(fallback.data)) ? fallback.data : [];
    pg = (page && fallbackPages.find(x => x.page === page)) || fallbackPages[0] || {};
    cid = pg.cid || 0;
    if (cid) {
        const fallbackInfo = info || { bvid: bvid };
        if (!Array.isArray(fallbackInfo.pages) || !fallbackInfo.pages.length) fallbackInfo.pages = fallbackPages;
        return { cid: cid, info: fallbackInfo, page: pg };
    }
    if (!viewError) viewError = pageResult.error || apiResponseError(fallback, '无法解析视频 cid');
    throw viewError || new Error('无法解析视频 cid');
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
    let dashError = null;
    let mp4Error = null;
    const [jDash, jMp4] = await Promise.all([
        biliFetch(base + '&fnval=4048&fourk=1').catch(error => { dashError = error; return null; }),
        biliFetch(base + '&fnval=1').catch(error => { mp4Error = error; return null; })
    ]);
    const errorText = error => error ? (': ' + String(error.message || error)) : '';
    if (!jDash) BPLLog.warn('bg', 'playurl(dash) 请求失败/无响应[' + bvid + ']' + errorText(dashError));
    else if (jDash.code !== 0) BPLLog.warn('bg', 'playurl(dash) code=' + jDash.code + ' ' + (jDash.message || '') + '[' + bvid + ']');
    if (!jMp4) BPLLog.warn('bg', 'playurl(durl) 请求失败/无响应[' + bvid + ']' + errorText(mp4Error));
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
        BPLLog.error('bg', 'getAudioUrls[' + bvid + '/' + cid + '] 未获取到公开音频流：' + (msg || '未知'));
        const error = new Error('未获取到公开音频流' + (msg ? '：' + msg : '（接口未返回可用音频或该视频无音频）'));
        if (isTransientMatchError(dashError) || isTransientMatchError(mp4Error)) error.transient = true;
        const responses = [jDash, jMp4].filter(Boolean);
        if (responses.length === 2 && responses.every(isDefinitiveUnavailableResponse)) error.sourceUnavailable = true;
        throw error;
    }
    const uniq = [...new Set(urls)];
    const dash = jDash && jDash.data && jDash.data.dash;
    const tag = dash
        ? '(dash' + ((dash.flac && dash.flac.audio) ? '+flac' : '') + ((dash.dolby && dash.dolby.audio && dash.dolby.audio.length) ? '+dolby' : '') + ')'
        : '(durl)';
    BPLLog.info('bg', 'getAudioUrls[' + bvid + '/' + cid + '] 得 ' + uniq.length + ' 个候选' + tag);
    return uniq;
}
function resolvedItemFields(r, bvid, page, fallback) {
    const d = r.info || {}, pg = r.page || {};
    const pages = d.pages || [];
    const multi = pages.length > 1;
    fallback = fallback || {};
    return {
        bvid: d.bvid || bvid,
        cid: r.cid || 0,
        title: (multi && pg.part) ? ((d.title || fallback.title || bvid) + ' · ' + pg.part) : (d.title || fallback.title || bvid),
        pic: normUrl(d.pic || fallback.pic),
        owner: (d.owner && d.owner.name) || fallback.owner || '',
        duration: pg.duration || d.duration || fallback.duration || 0,
        page: page
    };
}
async function buildItem(bvid, page, fallback) {
    if (typeof fallback === 'string') fallback = { title: fallback };
    fallback = fallback || {};
    try {
        const r = await resolveCid(bvid, page);
        return Object.assign({ id: genId() }, resolvedItemFields(r, bvid, page, fallback));
    } catch (e) {
        BPLLog.warn('bg', 'buildItem[' + bvid + '] 元数据暂未解析：' + String((e && e.message) || e));
        return {
            id: genId(), bvid: bvid, cid: 0, title: fallback.title || bvid,
            pic: normUrl(fallback.pic), owner: fallback.owner || '', duration: fallback.duration || 0, page: page
        };
    }
}

async function repairResolvedItem(p, resolved) {
    if (!p || !p.playlistId || !p.itemId || !resolved) return;
    await withPlaylistMutation(async () => {
        const lists = await getPlaylists();
        const pl = findPl(lists, p.playlistId);
        const it = pl && pl.items.find(x => x.id === p.itemId);
        if (!it || it.bvid !== p.bvid || it.cid) return;
        const chartTitle = isChartItem(it) ? chartDisplayTitle(it.sourceTitle, it.sourceArtist) : '';
        Object.assign(it, resolvedItemFields(resolved, p.bvid, p.page || 1, it));
        if (chartTitle) it.title = chartTitle;
        await savePlaylists(lists);
        await broadcastData();
    });
}

async function migrate() {
    return await withPlaylistMutation(async () => {
        return await withPlayerStateMutation(async () => {
        const r = await chrome.storage.local.get(['bpl_schema_version', 'bpl_playlists', 'bpl_list', 'bpl_state', 'bpl_active', 'bpl_position']);
        let lists = (r.bpl_playlists && r.bpl_playlists.length) ? r.bpl_playlists : null;
        let activeId = r.bpl_active || null;
        let legacyList = false;
        if (!lists) {
            const id = genId();
            lists = [{ id, name: '默认播放列表', items: r.bpl_list || [] }];
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
    });
}

async function ensureDefaultPlaylist() {
    const lists = await getPlaylists();
    if (lists.length) {
        if (ensurePlaylistItemIds(lists)) await savePlaylists(lists);
        return lists;
    }
    const id = genId();
    const pls = [{ id, name: '默认播放列表', items: [] }];
    await savePlaylists(pls);
    await setActiveId(id);
    return pls;
}

const OFFSCREEN_PATH = 'src/player/offscreen.html';
let creating = null;
let offscreenPort = null;
let offscreenReady = false;
let portMsgId = 0;
let requestSeq = 0;
const portWaiters = {};
let lastPingAt = 0;
let lastCreateAt = 0;   // 本次 createDocument 的时刻：用于判断 bpl_boot 是否来自当前这份文档
let offscreenBroken = false;   // 测出上下文整体失效（Extension context invalidated），下条命令需重建
let lastRecreateAt = 0;        // 上次重建时刻：冷却闸，防止“损坏→重建→仍损坏”退化成新一轮踩踏
const RECREATE_COOLDOWN_MS = 10000;
const PORT_ACK_TIMEOUT_MS = 1200;
// Matching (45s), source resolution (35s), media startup (25s), plus IPC margin.
const LONG_CMD_TIMEOUT_MS = 110000;
const FAST_CMD_TIMEOUT_MS = 7000;
const LONG_PLAYER_CMDS = new Set(['playIndex', 'next', 'prev', 'toggle']);
function commandTimeout(cmd) {
    if (cmd === 'probeAudio') return MEDIA_PROBE_TIMEOUT_MS + 3000;
    return LONG_PLAYER_CMDS.has(cmd) ? LONG_CMD_TIMEOUT_MS : FAST_CMD_TIMEOUT_MS;
}
function nextRequestId() {
    requestSeq = (requestSeq + 1) % 1000000;
    return Date.now().toString(36) + '-' + requestSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function hasOffscreen() {
    if (chrome.offscreen.hasDocument) {
        try { return await chrome.offscreen.hasDocument(); } catch (e) {}
    }
    if (typeof chrome.runtime.getContexts === 'function') {
        try {
            const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            return !!(ctxs && ctxs.length);
        } catch (_) {}
    }
    // Chrome 109–115 has offscreen but no runtime.getContexts API.
    if (typeof clients !== 'undefined' && typeof clients.matchAll === 'function') {
        try {
            const url = chrome.runtime.getURL(OFFSCREEN_PATH);
            return (await clients.matchAll({ type: 'window', includeUncontrolled: true })).some(client => client.url === url);
        } catch (_) {}
    }
    return false;
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
        if (!cid) {
            const resolved = await resolveCid(p.bvid, p.page || 1);
            cid = resolved.cid;
            await repairResolvedItem(p, resolved);
        }
        if (!cid) return { ok: false, error: '无法解析视频 cid' };
        const urls = await getAudioUrls(p.bvid, cid);
        return { ok: true, urls: urls, cid: cid };
    } catch (e) {
        const message = String((e && e.message) || e);
        let unavailable = !!(e && e.sourceUnavailable);
        if (!unavailable && p && p.bvid) {
            const checked = await checkBiliSource(p.bvid);
            unavailable = !!checked.unavailable;
        }
        if (unavailable && p) await setSourceUnavailable(p.playlistId, p.itemId, p.bvid, message);
        BPLLog.error('bg', 'resolveAudio[' + (p && p.bvid) + '] 失败：' + message);
        return { ok: false, error: message, sourceUnavailable: unavailable };
    }
}
// Port 先等即时 ACK。收到 ACK 说明命令已经进入 offscreen 执行；未收到 ACK
// 才判定为陈旧连接，并使用同一 requestId 走 sendMessage，避免重复播放。
function sendViaPort(msg, timeout) {
    return new Promise(resolve => {
        const id = ++portMsgId;
        const targetPort = offscreenPort;
        let settled = false, acknowledged = false, resultTimer = null, ackTimer = null;
        const done = outcome => {
            if (settled) return;
            settled = true;
            delete portWaiters[id];
            if (resultTimer) clearTimeout(resultTimer);
            if (ackTimer) clearTimeout(ackTimer);
            resolve(outcome);
        };
        portWaiters[id] = incoming => {
            if (incoming && incoming.disconnected) {
                done({ kind: acknowledged ? 'acked-timeout' : 'unacked' });
                return;
            }
            if (incoming && incoming.ack) {
                acknowledged = true;
                if (ackTimer) clearTimeout(ackTimer);
                return;
            }
            if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'result')) done({ kind: 'result', value: incoming.result });
        };
        resultTimer = setTimeout(() => done({ kind: acknowledged ? 'acked-timeout' : 'unacked' }), Math.max(1, timeout));
        ackTimer = setTimeout(() => { if (!acknowledged) done({ kind: 'unacked' }); }, Math.max(1, Math.min(PORT_ACK_TIMEOUT_MS, timeout)));
        try { targetPort.postMessage(Object.assign({ _id: id }, msg)); }
        catch (_) { done({ kind: 'unacked' }); }
    });
}
function sendViaMessage(msg, timeout) {
    return new Promise(resolve => {
        const id = ++portMsgId;
        let settled = false, timer = null;
        const done = outcome => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(outcome);
        };
        timer = setTimeout(() => done({ kind: 'timeout' }), Math.max(1, timeout));
        try {
            chrome.runtime.sendMessage(Object.assign({ target: 'offscreen', _id: id }, msg), response => {
                done(response === undefined ? { kind: 'timeout' } : { kind: 'result', value: response });
            });
        } catch (error) {
            done({ kind: 'result', value: { ok: false, error: '音频模块通信失败：' + String((error && error.message) || error) } });
        }
    });
}

// 快速控制不再被慢速取源命令串行阻塞；播放竞态由 offscreen 的播放意图取消机制处理。
let offscreenFailCount = 0;
function sendToOffscreen(msg) {
    const request = Object.assign({}, msg);
    if (LONG_PLAYER_CMDS.has(request.cmd) || request.cmd === 'stop') {
        if (request._intentId == null) request._intentId = beginBackgroundPlayIntent();
        if (!currentBackgroundPlayIntent(request._intentId)) return Promise.resolve({ ok: true, cancelled: true });
    }
    if (!request._requestId) request._requestId = nextRequestId();
    let deadline = Date.now() + commandTimeout(request.cmd);
    if (Number.isFinite(request.playbackDeadline)) {
        deadline = Math.min(deadline, request.playbackDeadline);
        // Reserve time for the media result/state reply inside the original
        // match RPC's 150s UI budget. Never restart a full playback budget.
        request.deadline = deadline - 5000;
        if (Date.now() >= request.deadline) {
            return Promise.resolve({ ok: false, error: '匹配后的播放准备超时，请稍后重试', _transport: 'deadline' });
        }
        return matchBeforeDeadline(deadline, () => sendToOffscreenOnce(request, deadline))
            .catch(error => ({ ok: false, error: error.name === 'TimeoutError'
                ? '匹配后的播放准备超时，请稍后重试' : String(error.message || error), _transport: 'deadline' }));
    }
    return sendToOffscreenOnce(request, deadline);
}
// 对上下文失效或未捕获的 API 访问异常，允许一次有冷却期的重建尝试。
// offscreen 没有 storage 本身是正常 API 限制；存储代理处理它，不会返回这里的错误。
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
// 单次投递：优先 Port，只有未收到 ACK 才断开并走 sendMessage 兜底。
async function trySendOnce(msg, deadline) {
    await ensureOffscreen();
    if (msg._intentId != null && !currentBackgroundPlayIntent(msg._intentId)) return { ok: true, cancelled: true };
    let remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: '音频操作超时', _transport: 'deadline' };
    if (await waitForPort(Math.min(2500, remaining))) {
        if (msg._intentId != null && !currentBackgroundPlayIntent(msg._intentId)) return { ok: true, cancelled: true };
        remaining = deadline - Date.now();
        const attemptedPort = offscreenPort;
        const outcome = await sendViaPort(msg, remaining);
        if (outcome.kind === 'result') return outcome.value;
        if (outcome.kind === 'acked-timeout') return { ok: false, error: '音频操作执行超时，请稍后重试', _transport: 'acked-timeout' };
        BPLLog.warn('bg', 'Port 未确认命令，断开陈旧连接并改走 sendMessage');
        if (attemptedPort && attemptedPort === offscreenPort) {
            offscreenPort = null;
            offscreenReady = false;
            try { if (attemptedPort.disconnect) attemptedPort.disconnect(); } catch (_) {}
        }
    }
    remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: '音频模块通信超时', _transport: 'no-response' };
    if (msg._intentId != null && !currentBackgroundPlayIntent(msg._intentId)) return { ok: true, cancelled: true };
    const fallback = await sendViaMessage(msg, remaining);
    if (fallback.kind === 'result') return fallback.value;
    return { ok: false, error: '音频模块通信失败：offscreen 无响应', _transport: 'no-response' };
}
async function sendToOffscreenOnce(msg, deadline) {
    const cooldownOk = () => Date.now() - lastRecreateAt > RECREATE_COOLDOWN_MS;
    let recreated = false;
    if (offscreenBroken && cooldownOk()) await recreateOffscreen();
    let res = await trySendOnce(msg, deadline);
    if (isFatalContextError(res) && cooldownOk()) {
        BPLLog.warn('bg', 'offscreen 上下文损坏（' + res.error + '），重建一次重试');
        BPLLog.flush();
        await recreateOffscreen();
        recreated = true;
        res = await trySendOnce(msg, deadline);
    }
    if (res && res._transport !== 'no-response') {
        offscreenFailCount = 0;
        return res;
    }
    offscreenFailCount++;
    if (!recreated && cooldownOk() && deadline - Date.now() > 500) {
        BPLLog.warn('bg', 'offscreen 双通道无响应，强制重建一次并重试本条命令');
        BPLLog.flush();
        await recreateOffscreen();
        recreated = true;
        const retry = await trySendOnce(msg, deadline);
        if (retry && retry._transport !== 'no-response') {
            offscreenFailCount = 0;
            return retry;
        }
        res = retry;
    }
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
        if (w) { w(msg); }
    });
    port.onDisconnect.addListener(() => {
        const wasActive = offscreenPort === port;
        if (wasActive) {
            offscreenPort = null;
            offscreenReady = false;
            Object.keys(portWaiters).forEach(id => {
                try { portWaiters[id]({ disconnected: true }); } catch (_) {}
            });
        }
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
    // These reads are independent after a playlist mutation. Run them in
    // parallel so importing a chart does not wait for three storage IPC
    // round-trips in sequence.
    const [playlists, activeId, state] = await Promise.all([
        getPlaylists(), getActiveId(), getState()
    ]);
    broadcast({ type: 'data', playlists, activeId, state });
}

async function openChartPickerWindow() {
    if (!chrome.windows || typeof chrome.windows.create !== 'function') {
        throw new Error('当前浏览器不支持独立榜单窗口');
    }
    if (chartWindowId != null && typeof chrome.windows.update === 'function') {
        try {
            await chrome.windows.update(chartWindowId, { focused: true });
            return { ok: true, windowId: chartWindowId, reused: true };
        } catch (_) {
            chartWindowId = null;
        }
    }
    const created = await chrome.windows.create({
        url: chrome.runtime.getURL('src/charts/chart-picker.html'),
        type: 'popup', width: 680, height: 640, focused: true
    });
    chartWindowId = created && created.id != null ? created.id : null;
    return { ok: true, windowId: chartWindowId };
}
if (chrome.windows && chrome.windows.onRemoved && typeof chrome.windows.onRemoved.addListener === 'function') {
    chrome.windows.onRemoved.addListener(id => {
        if (id === chartWindowId) chartWindowId = null;
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.bplPing === 'offscreen-nostorage') {
        // offscreen 的扩展 API 仅有 runtime，代理存储属于正常跨上下文通信。
        BPLLog.info('bg', 'offscreen 已启用 background 存储代理');
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
    'addManualItem', 'remove', 'renameItem', 'batchRemove', 'batchCopy', 'batchMove', 'moveItem', 'clear',
    'createPlaylist', 'renamePlaylist', 'deletePlaylist', 'importPlaylist', 'setActive'
]);

async function importChartPlaylist(msg, importedId) {
    const adapter = chartAdapter(String(msg.sourceId || ''));
    if (!adapter || typeof adapter.fetchChart !== 'function') return { ok: false, error: '不支持的榜单来源' };
    let chart;
    try { chart = await adapter.fetchChart(String(msg.chartId || ''), chartFetch, { limit: msg.limit }); }
    catch (error) {
        const message = String(error && error.message || error || '榜单读取失败');
        BPLLog.warn('chart', '榜单读取失败：' + message);
        return { ok: false, error: message };
    }
    const items = (chart.items || []).map(song => chartPlaceholder(chart, song));
    if (!items.length) return { ok: false, error: '榜单没有可导入的歌曲' };
    return await withPlaylistMutation(async () => {
        const lists = await getPlaylists();
        const prior = importedId && findPl(lists, importedId);
        if (prior) return { ok: true, playlistId: prior.id, count: prior.items.length };
        const id = importedId || genId();
        const name = String(msg.name || '').trim() || chart.sourceName + ' - ' + chart.chartName;
        lists.push({ id, name: name.slice(0, 100), items, chartSource: chart.sourceId, chartId: chart.chartId, chartName: chart.chartName });
        await savePlaylists(lists);
        await setActiveId(id);
        await broadcastData();
        return { ok: true, playlistId: id, count: items.length };
    });
}

async function handleBg(msg, sender, mutationLocked) {
    // offscreen 的 bgResolveAudio 发 {target:'bg', resolveAudio:{...}}（历史形状，不带 cmd 字段）。
    // 必须在 switch(msg.cmd) 之前拦截，否则落入 default→{ok:false}，offscreen 报“无候选”且 bg 侧毫无日志。
    if (msg.resolveAudio) return await handleResolveAudio(msg.resolveAudio);
    // Destructive edits from stale interfaces must never be interpreted against
    // whichever playlist happens to be active when the queued operation runs.
    if (['remove', 'renameItem', 'batchRemove', 'batchCopy', 'batchMove', 'moveItem', 'clear'].includes(msg.cmd) &&
        !msg.playlistId) return { ok: false, error: '缺少播放列表标识，请刷新页面后重试' };
    if (!mutationLocked && PLAYLIST_MUTATION_CMDS.has(msg.cmd)) {
        return await withPlaylistMutation(() => handleBg(msg, sender, true));
    }
    switch (msg.cmd) {
        case 'getChartCatalog': {
            const sources = chartCatalog();
            return sources.length ? { ok: true, sources: sources } : { ok: false, error: '没有可用的榜单来源' };
        }
        case 'openChartWindow': {
            return await openChartPickerWindow();
        }
        case 'importChart': {
            const requestId = /^chart-[a-zA-Z0-9-]{8,80}$/.test(msg.requestId || '') ? msg.requestId : '';
            const importedId = requestId ? 'import-' + requestId : null;
            const prior = importedId && findPl(await getPlaylists(), importedId);
            if (prior) return { ok: true, playlistId: prior.id, count: prior.items.length };
            if (requestId && chartImportInflight.has(requestId)) return await chartImportInflight.get(requestId);
            const task = importChartPlaylist(msg, importedId);
            if (requestId) chartImportInflight.set(requestId, task);
            try { return await task; }
            finally { if (requestId) chartImportInflight.delete(requestId); }
        }
        case 'patchPlayerState': {
            if (sender && sender.url && sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH)) {
                return { ok: false, error: '来源不受信任' };
            }
            return await patchPlayerState(msg.patch || {}, msg.context || msg.guard);
        }
        case 'playerIntentChanged': {
            if (sender && sender.url && sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH)) {
                return { ok: false, error: '来源不受信任' };
            }
            beginBackgroundPlayIntent();
            return { ok: true };
        }
        case 'recoverMatchTasks': {
            return await withPlaylistMutation(async () => {
                const lists = await getPlaylists();
                let changed = false;
                for (const playlist of lists) for (const item of playlist.items) {
                    if (!chartMatchInflight.has(chartItemKey(playlist.id, item.id))) {
                        changed = resetMatchingState(item) || changed;
                    }
                }
                if (changed) { await savePlaylists(lists); await broadcastData(); }
                return { ok: true };
            });
        }
        case 'matchChartItem': {
            return await matchChartItem(String(msg.playlistId || ''), String(msg.itemId || ''), !!msg.manual, !!msg.verifyPlayable);
        }
        case 'matchManualItem': {
            return await matchChartItem(String(msg.playlistId || ''), String(msg.itemId || ''), true, true);
        }
        case 'playChartItem': {
            return await playChartItem(String(msg.playlistId || ''), String(msg.itemId || ''));
        }
        case 'repairSource':
        case 'rematchSource': {
            return await rematchSource(String(msg.playlistId || ''), String(msg.itemId || ''));
        }
        case 'getCollection': {
            try { return await collectionSummary(msg.bvid); }
            catch (e) {
                if (!e || e.code !== 'NOT_COLLECTION') {
                    BPLLog.warn('bg', 'getCollection[' + msg.bvid + '] 失败：' + String((e && e.message) || e));
                }
                return { ok: false, notCollection: !!(e && e.code === 'NOT_COLLECTION'), error: String((e && e.message) || e) };
            }
        }
        case 'importCollection': {
            const targetId = msg.targetPlaylistId || await getActiveId();
            let value;
            try { value = await loadCollection(msg.bvid); }
            catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
            let importItems = value.items;
            if (msg.smartRename && globalThis.BPLRenamer && typeof globalThis.BPLRenamer.renameItems === 'function') {
                try {
                    const renameSource = value.items.map(item => Object.assign({}, item, {
                        title: String(item.renameTitle || item.title || item.bvid)
                    }));
                    importItems = await globalThis.BPLRenamer.renameItems(renameSource, { prefix: String(msg.renamePrefix || '') });
                } catch (error) {
                    BPLLog.warn('bg', 'smart rename failed; using source titles: ' + String(error && error.message || error));
                }
            }
            return await withPlaylistMutation(async () => {
                const lists = await ensureDefaultPlaylist();
                const importTarget = msg.importTarget || msg.mode || (msg.target === 'new' ? 'new' : 'current');
                const preparedItems = normalizeImportedItems(importItems);
                if (importTarget === 'new') {
                    if (!preparedItems.length) return { ok: false, error: '合集没有可导入的视频' };
                    const id = genId();
                    const name = (msg.name && String(msg.name).trim()) || value.title || '导入的合集';
                    lists.push({ id, name: name.slice(0, 100), items: preparedItems });
                    await savePlaylists(lists);
                    await setActiveId(id);
                    await broadcastData();
                    return { ok: true, added: preparedItems.length, dup: 0, count: preparedItems.length, playlistId: id };
                }
                const pl = findPl(lists, targetId);
                if (!pl) return { ok: false, error: '目标播放列表不存在' };
                const existing = new Set(pl.items.map(collectionItemKey));
                let added = 0, dup = 0;
                for (const item of preparedItems) {
                    const key = collectionItemKey(item);
                    if (existing.has(key)) { dup++; continue; }
                    existing.add(key);
                    pl.items.push(item);
                    added++;
                }
                if (added) { await savePlaylists(lists); await broadcastData(); }
                return { ok: true, added, dup, count: preparedItems.length, playlistId: pl.id };
            });
        }
        case 'add': {
            const activeId = msg.playlistId || await getActiveId();
            const bvid = msg.bvid || (msg.item && msg.item.bvid);
            if (!bvid) return { ok: false };
            const page = msg.page || (msg.item && msg.item.page) || 1;
            const fallback = { title: msg.fallbackTitle, pic: msg.fallbackPic, owner: msg.fallbackOwner, duration: msg.fallbackDuration };
            const it = Object.assign({}, (msg.item && msg.item.cid) ? msg.item : await buildItem(bvid, page, fallback));
            it.id = genId();
            it.pic = normUrl(it.pic);
            return await withPlaylistMutation(async () => {
                const lists = await ensureDefaultPlaylist();
                const pl = findPl(lists, activeId || await getActiveId());
                if (!pl) return { ok: false, error: '目标播放列表不存在' };
                if (pl.items.some(x => x.bvid === it.bvid && (x.cid || 0) === (it.cid || 0))) return { ok: true, dup: true };
                pl.items.push(it);
                await savePlaylists(lists);
                await broadcastData();
                return { ok: true, incomplete: !it.cid };
            });
        }
        case 'addManualItem': {
            const title = String(msg.title || '').trim().slice(0, 200);
            if (!title) return { ok: false, error: '条目名称不能为空' };
            const lists = await ensureDefaultPlaylist();
            let activeId = msg.playlistId || await getActiveId();
            let pl = findPl(lists, activeId);
            if (msg.playlistId && !pl) return { ok: false, error: '目标播放列表不存在' };
            if (!pl) { pl = lists[0]; await setActiveId(pl.id); }
            const item = {
                id: genId(),
                bvid: '', cid: 0, title: title,
                pic: '', owner: '', duration: 0, page: 1,
                matchOrigin: 'manual',
                matchTargetTitle: title,
                matchTargetArtist: '',
                matchTargetDuration: 0,
                matchState: 'pending',
                matchAttempts: 0,
                matchHistory: []
            };
            pl.items.push(item);
            await savePlaylists(lists);
            await broadcastData();
            return { ok: true, itemId: item.id, playlistId: pl.id };
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
            const data = msg.data || {};
            if (data.type === 'state' && data.state) {
                const playing = !!data.state.playing;
                const playlistId = data.state.playlistId || null;
                if (playing && (!chartWasPlaying || chartAutoPlaylistId !== playlistId)) {
                    chartAutoPlaylistId = playlistId;
                    chartAutoNextAt = Date.now() + CHART_AUTO_MATCH_DELAY_MS;
                }
                chartWasPlaying = playing;
            }
            if (data.type === 'progress' && data.playing && !chartAutoPlaylistId) {
                const storedState = await getState();
                chartAutoPlaylistId = storedState.playlistId || null;
                chartAutoNextAt = Date.now() + CHART_AUTO_MATCH_DELAY_MS;
                chartWasPlaying = true;
            }
            if (data.type === 'progress' && data.playing && chartAutoPlaylistId && Date.now() >= chartAutoNextAt) {
                chartAutoNextAt = Date.now() + CHART_AUTO_MATCH_DELAY_MS;
                if (!chartAutoMatchTask) {
                    chartAutoMatchTask = matchNextChartItem(chartAutoPlaylistId)
                        .finally(() => { chartAutoMatchTask = null; });
                }
                await chartAutoMatchTask;
            }
            return { ok: true };
        }
        case 'storageGet': {
            // offscreen 经 runtime 请求存储，避免访问其上下文不开放的 storage API。
            const values = await chrome.storage.local.get(msg.keys);
            return { ok: true, values: values };
        }
        case 'storageSet': {
            // offscreen 存储代理（写）
            await chrome.storage.local.set(msg.data || {});
            return { ok: true };
        }
        case 'logMerge': {
            // offscreen 通过代理把日志条目并入 background 侧的 bpl_log。
            const cur = (await chrome.storage.local.get('bpl_log')).bpl_log;
            let arr = Array.isArray(cur) ? cur : [];
            arr = arr.concat(Array.isArray(msg.entries) ? msg.entries : []);
            const cap = (typeof BPLLog !== 'undefined' && BPLLog.MAX) || 500;
            if (arr.length > cap) arr = arr.slice(-cap);
            await chrome.storage.local.set({ bpl_log: arr });
            return { ok: true };
        }
        case 'player': {
            const payload = Object.assign({}, msg.payload || {});
            if (LONG_PLAYER_CMDS.has(payload.cmd) || payload.cmd === 'stop') {
                payload._intentId = beginBackgroundPlayIntent();
            }
            // 浏览中的播放列表(activeId)与正在播放的播放列表(state.playlistId)可以不同。
            // 显式点播必须携带用户点击的播放列表，否则 offscreen 会继续按旧播放列表解释同一个索引。
            if (payload.cmd === 'playIndex' && !payload.playlistId) payload.playlistId = await getActiveId();
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
            const pl = findPl(lists, msg.playlistId);
            if (!deletionConfirmationMatches(pl, msg.confirmation, [msg.itemId])) return deletionChanged();
            const i = pl.items.findIndex(item => item.id === msg.itemId);
            if (i >= 0 && i < pl.items.length) pl.items.splice(i, 1);
            await savePlaylists(lists);
            await reconcileStoredState(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'renameItem': {
            const lists = await getPlaylists();
            const pl = findPl(lists, msg.playlistId);
            const item = pl && pl.items.find(entry => entry.id === msg.itemId);
            if (item) {
                const t = String(msg.title || '').trim();
                if (t) {
                    item.title = t.slice(0, 200);
                    if (isManualItem(item) && !item.bvid && item.matchTargetTitle !== item.title) {
                        item.matchTargetTitle = item.title;
                        item.matchRevision = (Number(item.matchRevision) || 0) + 1;
                        chartMatchInflight.delete(chartItemKey(pl.id, item.id));
                        item.matchState = 'pending';
                        item.matchAttempts = 0;
                        delete item.matchStartedAt;
                        delete item.matchError;
                        delete item.matchFailedAt;
                    }
                }
                await savePlaylists(lists);
                await broadcastData();
            }
            return { ok: true };
        }
        case 'batchRemove': {
            const lists = await getPlaylists();
            const pl = findPl(lists, msg.playlistId);
            if (!Array.isArray(msg.itemIds) || !deletionConfirmationMatches(pl, msg.confirmation, msg.itemIds)) return deletionChanged();
            const asc = selectedItemIndices(pl, msg.itemIds);
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
            const fromPl = findPl(lists, msg.playlistId);
            const toPl = findPl(lists, msg.toId);
            if (!fromPl || !toPl) return { ok: false };
            if (fromPl.id === toPl.id) return { ok: false, error: '请选择不同的目标播放列表' };
            const asc = selectedItemIndices(fromPl, msg.itemIds);
            if (!asc.length) return { ok: true };
            let added = 0;
            for (const i of asc) {
                const it = fromPl.items[i];
                if (it && !toPl.items.some(x => samePlaylistContent(x, it))) {
                    const copy = Object.assign({}, it);
                    if (msg.cmd === 'batchCopy') copy.id = genId();
                    resetMatchingState(copy);
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
            const pl = findPl(lists, msg.playlistId);
            if (!pl) return { ok: false };
            const from = pl.items.findIndex(item => item.id === msg.itemId);
            // Explicit null means append. Missing/stale IDs must not become an accidental move.
            const to = msg.beforeItemId === null ? pl.items.length : pl.items.findIndex(item => item.id === msg.beforeItemId);
            if (from == null || to == null || from === to) return { ok: true };
            if (from < 0 || from >= pl.items.length || to < 0 || to > pl.items.length) return { ok: false };
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
            const pl = findPl(lists, msg.playlistId);
            if (!deletionConfirmationMatches(pl, msg.confirmation)) return deletionChanged();
            pl.items = [];
            await savePlaylists(lists);
            await reconcileStoredState(lists);
            await broadcastData();
            return { ok: true };
        }
        case 'createPlaylist': {
            const lists = await getPlaylists();
            const id = genId();
            const name = (msg.name && String(msg.name).trim()) || ('新播放列表' + (lists.length + 1));
            lists.push({ id, name: name.slice(0, 100), items: [] });
            await savePlaylists(lists);
            await setActiveId(id);
            await broadcastData();
            return { ok: true, id };
        }
        case 'renamePlaylist': {
            const lists = await getPlaylists();
            const pl = findPl(lists, msg.id);
            if (!pl) return { ok: false, error: '该播放列表已不存在，请取消后重新选择' };
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
            if (!deletionConfirmationMatches(lists[idx], msg.confirmation)) return deletionChanged();
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
            const items = (Array.isArray(msg.items) ? msg.items : []).map(restorePlaylistItem).filter(Boolean);
            if (!items.length) return { ok: false, error: '没有有效条目' };
            const id = genId();
            const name = (msg.name && String(msg.name).trim()) || '导入的播放列表';
            const playlist = restorePlaylistMetadata(msg.playlist);
            playlist.id = id;
            playlist.name = name.slice(0, 100);
            playlist.items = items;
            lists.push(playlist);
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

// SW 生命周期日志：回收后重启属正常，不意味着音频宿主也被销毁。
// 保留启动记录，便于和 Port 重连、播放状态变化一同排查。
function logSwStart(reason) {
    let v = '';
    try { v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''; } catch (_) {}
    BPLLog.info('bg', 'Service Worker 启动(' + reason + ')' + (v ? ' v' + v : ''));
}
// 浏览器启动和首次安装时预热，减少首次点播等待；失败仍由命令的惰性创建路径处理。
// 升级时跳过预热，避免与旧扩展上下文的关闭重叠。此选择与 offscreen 的 storage API 限制无关。
function prewarmOffscreen() { ensureOffscreen().catch(() => {}); }
function runMigration(reason) {
    migrate()
        .catch(e => BPLLog.error('bg', '存储迁移失败(' + reason + ')：' + ((e && e.message) || e)));
}
chrome.runtime.onInstalled.addListener((d) => {
    logSwStart('installed' + ((d && d.reason) ? ':' + d.reason : ''));
    runMigration('installed');
    if (!(d && d.reason === 'update')) prewarmOffscreen();
});
chrome.runtime.onStartup.addListener(() => { logSwStart('startup'); runMigration('startup'); prewarmOffscreen(); });
// SW 被重新唤醒（非 onInstalled/onStartup 路径，如消息唤起）时也补一条，便于判断回收频率
logSwStart('eval');
