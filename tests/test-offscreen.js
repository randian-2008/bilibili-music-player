const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'offscreen.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const resolveAudioRes = opts.resolveAudioRes || { ok: true, urls: ['https://cdn/audio.m4s'] };
    let resolveAudioCalls = 0;
    const resolveAudio = payload => {
        resolveAudioCalls++;
        return opts.resolveAudioResponder ? opts.resolveAudioResponder(payload, resolveAudioCalls) : resolveAudioRes;
    };
    const playFailUrls = new Set(opts.playFailUrls || []);
    const playNeverUrls = new Set(opts.playNeverUrls || []);
    const fetchFailUrls = new Set(opts.fetchFailUrls || []);
    const asyncErrorUrls = new Set(opts.asyncErrorUrls || []);   // play() 成功后异步触发 error（模拟 CDN 403）
    const audio = {
        paused: true, currentTime: 0, duration: 0, playbackRate: 1, volume: 1, muted: false,
        error: null, networkState: 1, readyState: 0, playCalls: 0,
        ls: {},
        _src: '',
        addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); },
        removeEventListener(t, f) { const l = this.ls[t]; if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } },
        play() {
            this.playCalls++;
            if (playNeverUrls.has(this._src)) return new Promise(() => {});
            if (playFailUrls.has(this._src)) {
                const e = new Error('The element has no supported sources.');
                e.name = 'NotSupportedError';
                return Promise.reject(e);
            }
            this.paused = false;
            if (asyncErrorUrls.has(this._src)) {
                setImmediate(() => {
                    this.error = { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
                    (this.ls.error || []).slice().forEach(f => f());
                });
            }
            return Promise.resolve();
        },
        pause() { this.paused = true; },
        load() {},
        removeAttribute(n) { if (n === 'src') this.src = ''; }
    };
    // 换源即清空 error/就绪态，模拟真实 HTMLMediaElement（否则上一源的残留 error 会误杀下一源）
    Object.defineProperty(audio, 'src', {
        get() { return audio._src; },
        set(v) { audio._src = v; audio.error = null; audio.readyState = v ? 4 : 0; }
    });
    const handlers = [];
    const msgListeners = [];
    const portSent = [];
    const port = {
        postMessage(msg) {
            portSent.push(msg);
            if (msg && msg.resolveAudio) {
                Promise.resolve().then(() => {
                    Promise.resolve(resolveAudio(msg.resolveAudio)).then(result => handlers.forEach(fn => fn({ _id: msg._id, result })));
                });
            }
        },
        onMessage: { addListener: (fn) => handlers.push(fn) },
        onDisconnect: { addListener() {} }
    };
    // 模拟 background 端：storageGet/storageSet 代理 + resolveAudio 取源（noStorage 变体的生命线）
    const sent = [];
    const sendMessage = (payload, cb) => {
        sent.push(payload);
        if (payload && payload.cmd === 'storageGet') {
            Promise.resolve().then(() => cb && cb({ ok: true, values: Object.assign({}, store) }));
            return undefined;
        }
        if (payload && payload.cmd === 'storageSet') {
            Object.assign(store, payload.data || {});
            Promise.resolve().then(() => cb && cb({ ok: true }));
            return undefined;
        }
        if (cb && payload && payload.resolveAudio) {
            Promise.resolve().then(() => Promise.resolve(resolveAudio(payload.resolveAudio)).then(cb));
            return undefined;
        }
        return Promise.resolve(undefined);
    };
    const chromeObj = {
        runtime: {
            connect: () => port,
            sendMessage: sendMessage,
            onMessage: { addListener: (fn) => msgListeners.push(fn) }
        },
        storage: {
            local: {
                get: () => Promise.resolve(Object.assign({}, store)),
                set: o => { Object.assign(store, o); return Promise.resolve(); }
            },
            onChanged: { addListener() {} }
        }
    };
    // noStorage 变体：复刻现场 Edge——chrome.runtime 完好、chrome.storage 恒为 undefined。
    // offscreen 必须完全经 background 代理完成存储读写并照常播放。
    if (opts.noStorage) chromeObj.storage = undefined;
    let timerSeq = 0;
    const timers = new Map();
    const fastSetTimeout = fn => {
        const id = ++timerSeq;
        const handle = setImmediate(() => {
            if (!timers.has(id)) return;
            timers.delete(id);
            fn();
        });
        timers.set(id, handle);
        return id;
    };
    const fastClearTimeout = id => {
        const handle = timers.get(id);
        if (handle) clearImmediate(handle);
        timers.delete(id);
    };
    const windowHandlers = {};
    const sandbox = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        // setImmediate 驱动：offscreen 的 playSettled 宽限计时需真实触发（忽略延时、立即排队）
        setTimeout: fastSetTimeout, clearTimeout: fastClearTimeout, setInterval: () => 0,
        fetch: (url) => {
            if (fetchFailUrls.has(url)) return Promise.reject(new Error('fetch fail'));
            return Promise.resolve({ ok: true, blob: () => Promise.resolve({}) });
        },
        URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
        window: {
            addEventListener(type, fn) { (windowHandlers[type] = windowHandlers[type] || []).push(fn); },
            dispatch(type) { (windowHandlers[type] || []).slice().forEach(fn => fn()); }
        },
        navigator: {},
        document: { getElementById: () => audio },
        chrome: chromeObj,
        __audio: audio, __store: store,
        __resolveAudioCalls: () => resolveAudioCalls,
        __port: port, __portSent: portSent, __sent: sent,
        __drive: (msg) => { handlers.forEach(fn => fn(msg)); },
        __driveMsg: (msg) => { msgListeners.forEach(fn => fn(msg)); }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

function setupPlaylist(n) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ id: 'item' + i, bvid: 'BV' + i, cid: 100 + i, title: 't' + i, pic: '', owner: '', duration: 10, page: 1 });
    return {
        bpl_playlists: [{ id: 'pl1', name: 'p', items }],
        bpl_active: 'pl1',
        bpl_state: { playlistId: 'pl1', trackId: null, index: 0, playing: false, mode: 'order' }
    };
}
const getState = ctx => ctx.pGetState();

async function testPlayIndex() {
    console.log('\n[offscreen pPlayIndex]');
    let ctx = makeCtx({ store: { bpl_playlists: [{ id: 'pl1', name: 'p', items: [] }], bpl_state: { playlistId: 'pl1', trackId: null, index: 0, playing: false, mode: 'loop' } } });
    let r = await ctx.pPlayIndex(0);
    ok(r.ok === false && /空/.test(r.error), '空歌单 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2) });
    r = await ctx.pPlayIndex(99);
    ok(r.ok === false && /越界/.test(r.error), '索引越界 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2), resolveAudioRes: { ok: false, error: '需要登录' } });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === false && /需要登录/.test(r.error), '取源失败透传 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2) });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'https://cdn/audio.m4s', '正常播放设置 src (' + ctx.__audio.src + ')');
    ok((await getState(ctx)).trackId === 'item0', '起播状态写入稳定 trackId');

    // v2.2.6 回归：state 广播必须经 bg 中继（offscreen 直发 {target:'all'} 到不了网页里的 content script，
    // 现场表现为胶囊不变形/图标动画不切换、面板进度条不动）
    const relays = ctx.__sent.filter(m => m && m.target === 'bg' && m.cmd === 'relay' && m.data && m.data.type === 'state');
    const relayed = relays[relays.length - 1];   // 取最后一条：加载时先发过一条 playing:false 的初始态
    ok(!!relayed && relayed.data.state.hasTrack === true && relayed.data.state.playing === true,
        '起播后经 bg 中继 state 广播（hasTrack/playing 驱动胶囊变形与图标）');

    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioRes: { ok: true, urls: ['https://cdn/bad.m4s', 'https://cdn/good.m4s'] },
        playFailUrls: ['https://cdn/bad.m4s'],
        fetchFailUrls: ['https://cdn/bad.m4s']
    });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'https://cdn/good.m4s', '首源彻底失败→切换下一源 (' + ctx.__audio.src + ')');

    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioRes: { ok: true, urls: ['https://cdn/x.m4s'] },
        playFailUrls: ['https://cdn/x.m4s']
    });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'blob:mock', '直接播放失败→fetch+blob 兜底成功 (' + ctx.__audio.src + ')');

    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioRes: { ok: true, urls: ['https://cdn/a.m4s', 'https://cdn/b.m4s'] },
        playFailUrls: ['https://cdn/a.m4s', 'https://cdn/b.m4s'],
        fetchFailUrls: ['https://cdn/a.m4s', 'https://cdn/b.m4s']
    });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === false && /已尝试 2 个音源/.test(r.error), '全部音源失败报错 (' + r.error + ')');

    // 关键回归（bug①）：play() 成功 resolve，但媒体随后异步报错（CDN 403 → SRC_NOT_SUPPORTED）。
    // 旧实现只 await play()，会误判“已起播”而停在坏源上无声播放；新实现 error 事件感知 → 切下一源。
    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioRes: { ok: true, urls: ['https://cdn/asyncbad.m4s', 'https://cdn/good.m4s'] },
        asyncErrorUrls: ['https://cdn/asyncbad.m4s'],
        fetchFailUrls: ['https://cdn/asyncbad.m4s']
    });
    r = await ctx.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'https://cdn/good.m4s',
        'play 成功后异步 error → 认定首源失败并切下一源 (' + ctx.__audio.src + ')');
}

async function testModes() {
    console.log('\n[offscreen 播放模式]');
    let ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'order'; ctx.__store.bpl_state.index = 2; ctx.__store.bpl_state.trackId = 'item2';
    await ctx.pAdvance();
    let st = await getState(ctx);
    ok(st.playing === false && st.trackId === null && ctx.__audio.src === '', 'order 末尾彻底停止并释放音源');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 2; ctx.__store.bpl_state.trackId = 'item2';
    await ctx.pAdvance();
    st = await getState(ctx);
    ok(st.index === 0 && st.playing === true, 'loop 回首');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffle'; ctx.__store.bpl_state.index = 0; ctx.__store.bpl_state.trackId = 'item0';
    let stopped = false;
    for (let i = 0; i < 10; i++) { await ctx.pNext(); if ((await getState(ctx)).playing === false) { stopped = true; break; } }
    ok(stopped, 'shuffle 播完停止');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffleLoop'; ctx.__store.bpl_state.index = 0; ctx.__store.bpl_state.trackId = 'item0';
    let kept = true;
    for (let i = 0; i < 12; i++) { await ctx.pNext(); if ((await getState(ctx)).playing === false) { kept = false; break; } }
    ok(kept, 'shuffleLoop 不停');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 0; ctx.__store.bpl_state.trackId = 'item0'; ctx.__audio.currentTime = 0;
    await ctx.pPrev();
    ok((await getState(ctx)).index === 2, 'prev 开头回末尾');
}

async function testHandleCmd() {
    console.log('\n[offscreen handleCmd]');
    const ctx = makeCtx({ store: setupPlaylist(3) });
    let r = await ctx.handleCmd({ cmd: 'setMode', mode: 'shuffle' });
    ok(r.ok === true && (await getState(ctx)).mode === 'shuffle', 'setMode 生效');
    r = await ctx.handleCmd({ cmd: 'getStatus' });
    ok(r.ok === true && typeof r.position === 'number' && r.hasTrack === false, 'getStatus 返回状态');
    r = await ctx.handleCmd({ cmd: 'playIndex', index: 1 });
    ok(r.ok === true && (await getState(ctx)).index === 1, 'playIndex 命令');

    const customStore = setupPlaylist(1);
    customStore.bpl_playlists.push({ id: 'pl2', name: '新歌单', items: [
        { id: 'custom0', bvid: 'BVCUSTOM', cid: 909, title: 'custom', pic: '', owner: '', duration: 10, page: 1 }
    ] });
    customStore.bpl_active = 'pl2';
    const customCtx = makeCtx({ store: customStore });
    r = await customCtx.handleCmd({ cmd: 'playIndex', index: 0, playlistId: 'pl2' });
    const customState = await customCtx.pGetState();
    const resolveReq = customCtx.__sent.find(m => m && m.cmd === 'resolveAudio');
    ok(r.ok === true && customState.playlistId === 'pl2' && customState.trackId === 'custom0' &&
        resolveReq && resolveReq.resolveAudio.bvid === 'BVCUSTOM' && resolveReq.resolveAudio.playlistId === 'pl2',
        'playIndex 按显式歌单 ID 取曲并切换播放身份');
    r = await ctx.handleCmd({ cmd: 'setVolume', value: 0.5 });
    ok(r.ok === true && ctx.__audio.volume === 0.5 && ctx.__store.bpl_volume === 0.5, 'setVolume 生效并持久化');
    r = await ctx.handleCmd({ cmd: 'stop' });
    ok(r.ok === true && ctx.__audio.src === '' && (await getState(ctx)).trackId === null, 'stop 清空音源和当前曲目身份');
    r = await ctx.handleCmd({ cmd: 'ping' });
    ok(r.ok === true && r.pong === 1, 'ping 探测应答 pong（健康探测）');
}

async function testPort() {
    console.log('\n[offscreen Port 命令闭环]');
    const ctx = makeCtx({ store: setupPlaylist(3) });
    const before = ctx.__portSent.length;
    ctx.__drive({ _id: 42, cmd: 'setMode', mode: 'shuffle' });
    let resp = null;
    for (let i = 0; i < 20; i++) {
        resp = ctx.__portSent.slice(before).find(m => m._id === 42 && Object.prototype.hasOwnProperty.call(m, 'result'));
        if (resp) break;
        await new Promise(r => setTimeout(r, 5));
    }
    ok(resp && resp.result && resp.result.ok === true && (await ctx.pGetState()).mode === 'shuffle',
        'Port 命令→响应闭环（setMode）');
    ok(ctx.__portSent.slice(before).some(m => m._id === 42 && m.ack === true), 'Port 收到命令后立即 ACK');

    ctx.__drive({ _id: 43, cmd: 'getStatus' });
    resp = null;
    for (let i = 0; i < 20; i++) {
        resp = ctx.__portSent.slice(before).find(m => m._id === 43 && Object.prototype.hasOwnProperty.call(m, 'result'));
        if (resp) break;
        await new Promise(r => setTimeout(r, 5));
    }
    ok(resp && resp.result && typeof resp.result.position === 'number', 'Port getStatus 响应');
}

async function testNoStorage() {
    // 现场回归（v2.2.4 存储代理）：此 Edge 的 offscreen 无 chrome.storage（连新建文档亦然），
    // 但 chrome.runtime 正常。以下断言“存储全量经 background 代理”后播放链路毫发无损。
    console.log('\n[offscreen 无 chrome.storage → 经 background 代理]');
    const ticks = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

    let ctx = makeCtx({ store: setupPlaylist(2), noStorage: true });
    ok(ctx.chrome.storage === undefined, '变体前提：chrome.storage 缺失（chrome.runtime 仍在）');
    let r = await ctx.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'https://cdn/audio.m4s', '无 storage 也能完整播放（经代理取歌单/状态）');
    let st = await ctx.pGetState();
    ok(st.trackId === 'item0' && st.index === 0 && st.playing === true, '状态经代理持久化（trackId/index 写回 bg）');
    ok(ctx.__store.bpl_state && ctx.__store.bpl_state.playing === true, '写入确实落到（模拟的）bg 存储');

    ctx = makeCtx({ store: setupPlaylist(3), noStorage: true });
    r = await ctx.handleCmd({ cmd: 'playIndex', index: 2 });
    ok(r.ok === true && (await ctx.pGetState()).index === 2, 'handleCmd playIndex 经代理闭环');

    // 无 storage.onChanged：data 广播驱动歌单变更；即使歌单非空，当前 trackId 被删也必须停播
    ctx.__store.bpl_playlists[0].items = ctx.__store.bpl_playlists[0].items.slice(0, 2);
    ctx.__driveMsg({ target: 'all', type: 'data', playlists: ctx.__store.bpl_playlists });
    await ticks(3);
    ok(ctx.__audio.src === '' && (await ctx.pGetState()).trackId === null,
        'data 广播发现当前 trackId 已删除，停播并清曲目身份（替代 onChanged）');
}

async function testResume() {
    // v2.2.9 断点续播：现场实证 offscreen 暂停 ~30s 即被浏览器回收（进度随之蒸发），
    // 再按播放却从头开始。以下断言“进度落盘 + 回收后重建从断点续播”全链路。
    console.log('\n[offscreen 断点续播（暂停→回收→再按播放从断点起）]');
    const ticks = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

    // ① 暂停时进度落盘（pause 事件驱动，bvid+cid+position 三要素）
    let ctx = makeCtx({ store: setupPlaylist(2) });
    await ctx.pPlayIndex(1);
    ok(ctx.__store.bpl_position && ctx.__store.bpl_position.trackId === 'item1' && ctx.__store.bpl_position.bvid === 'BV1' && ctx.__store.bpl_position.position === 0,
        '起播即写断点 0（身份 item1/BV1/101）');
    ctx.__audio.currentTime = 42;
    ctx.__audio.ls.pause.slice().forEach(f => f());   // 触发 pause 事件监听（mock 不自动派发）
    await ticks(3);
    let pos = ctx.__store.bpl_position;
    ok(pos && pos.trackId === 'item1' && pos.bvid === 'BV1' && pos.cid === 101 && pos.position === 42, '暂停时进度落盘 42s (' + JSON.stringify(pos) + ')');

    // ② 文档被回收后重建（新 ctx = 全新空音频，存储共享 = bg 侧持久层），toggle → 从 42s 继续
    const ctx2 = makeCtx({ store: ctx.__store });
    ok(!ctx2.__audio.src, '新文档音频为空（模拟回收后重建）');
    let r = await ctx2.pToggle();
    ok(r.ok === true && !!ctx2.__audio.src && ctx2.__audio.currentTime === 42,
        '再按播放从断点 42s 继续（不是从头）(at=' + ctx2.__audio.currentTime + 's)');
    ok((await ctx2.pGetState()).playing === true, '续播后状态为播放中');

    // ③ 断点身份不符（歌单变动/换了歌）→ 从头播，不盲跳
    ctx = makeCtx({ store: setupPlaylist(2) });
    ctx.__store.bpl_position = { trackId: 'other', bvid: 'BV1', cid: 101, position: 88 };
    r = await ctx.pToggle();
    ok(r.ok === true && ctx.__audio.currentTime === 0, '断点曲目不符 → 从头播');

    // ④ 显式点歌不吃断点（用户意图明确：就是要听这首的开头）
    ctx = makeCtx({ store: setupPlaylist(2) });
    ctx.__store.bpl_position = { trackId: 'item1', bvid: 'BV1', cid: 101, position: 88 };
    r = await ctx.handleCmd({ cmd: 'playIndex', index: 1 });
    ok(r.ok === true && ctx.__audio.currentTime === 0, '显式 playIndex 从头播（不续断点）');

    // ⑤ stop 清断点：显式停止 = 下回从头
    ctx = makeCtx({ store: setupPlaylist(2) });
    await ctx.pPlayIndex(0);
    r = await ctx.handleCmd({ cmd: 'stop' });
    ok(r.ok === true && ctx.__store.bpl_position === null && (await ctx.pGetState()).trackId === null, 'stop 清除断点和当前曲目身份');
}

async function testRecoveryAndCancellation() {
    console.log('\n[offscreen 异步取消 / 请求去重 / 播放自恢复]');
    const ticks = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

    let releaseFirst;
    let ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioResponder: (payload, call) => call === 1
            ? new Promise(resolve => { releaseFirst = resolve; })
            : { ok: true, urls: ['https://cdn/newest.m4s'], cid: payload.cid }
    });
    const oldPlay = ctx.pPlayIndex(0);
    while (!releaseFirst) await ticks(1);
    const newest = await ctx.pPlayIndex(1);
    releaseFirst({ ok: true, urls: ['https://cdn/stale.m4s'], cid: 100 });
    const stale = await oldPlay;
    ok(newest.ok === true && stale.cancelled === true && ctx.__audio.src === 'https://cdn/newest.m4s' && (await ctx.pGetState()).index === 1,
        '新播放取消旧异步结果，旧音源不能晚到覆盖当前曲目');

    ctx = makeCtx({ store: setupPlaylist(2) });
    const sameRequest = { _requestId: 'same-play', cmd: 'playIndex', index: 0 };
    const deduped = await Promise.all([ctx.runRequest(sameRequest), ctx.runRequest(Object.assign({}, sameRequest))]);
    ok(deduped.every(x => x.ok) && ctx.__resolveAudioCalls() === 1 && ctx.__audio.playCalls === 1,
        '同一 requestId 的并发/跨通道请求只执行一次');

    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioRes: { ok: true, urls: ['https://cdn/hang.m4s', 'https://cdn/good.m4s'] },
        playNeverUrls: ['https://cdn/hang.m4s'],
        fetchFailUrls: ['https://cdn/hang.m4s']
    });
    const bounded = await ctx.pPlayIndex(0);
    ok(bounded.ok === true && ctx.__audio.src === 'https://cdn/good.m4s', 'audio.play 永久挂起时在预算内切换下一音源');

    let recoverMode = false;
    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioResponder: () => recoverMode
            ? { ok: true, urls: ['https://cdn/recovered.m4s'] }
            : { ok: true, urls: ['https://cdn/initial.m4s'] }
    });
    await ctx.pPlayIndex(0);
    recoverMode = true;
    ctx.__audio.error = { code: 2, message: 'network' };
    (ctx.__audio.ls.error || []).slice().forEach(fn => fn());
    await ticks(30);
    ok(ctx.__audio.src === 'https://cdn/recovered.m4s' && ctx.__resolveAudioCalls() >= 2,
        '运行中 audio error 自动刷新音源并从断点恢复');

    ctx = makeCtx({ store: setupPlaylist(2) });
    await ctx.pPlayIndex(0);
    const callsBeforeStall = ctx.__resolveAudioCalls();
    (ctx.__audio.ls.stalled || []).slice().forEach(fn => fn());
    (ctx.__audio.ls.playing || []).slice().forEach(fn => fn());
    await ticks(10);
    ok(ctx.__resolveAudioCalls() === callsBeforeStall,
        '短暂 stalled 自行恢复后取消排队任务，不会无故重播');

    let failRecovery = false;
    ctx = makeCtx({
        store: setupPlaylist(2),
        resolveAudioResponder: () => failRecovery
            ? { ok: false, error: '网络不可用' }
            : { ok: true, urls: ['https://cdn/initial.m4s'] }
    });
    await ctx.pPlayIndex(0);
    failRecovery = true;
    ctx.__audio.error = { code: 2, message: 'offline' };
    (ctx.__audio.ls.error || []).slice().forEach(fn => fn());
    await ticks(80);
    const playerError = ctx.__sent.find(m => m && m.cmd === 'relay' && m.data && m.data.type === 'playerError');
    ok(ctx.__audio.src === '' && (await ctx.pGetState()).playing === false && !!playerError,
        '自恢复最多重试三次，最终停止并广播可读错误');
}

(async () => {
    try {
        await testPlayIndex();
        await testModes();
        await testHandleCmd();
        await testPort();
        await testNoStorage();
        await testResume();
        await testRecoveryAndCancellation();
    } catch (e) { console.error('测试执行异常:', e); fail++; }
    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})();
