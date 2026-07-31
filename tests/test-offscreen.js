const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'offscreen.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const resolveAudioRes = opts.resolveAudioRes || { ok: true, urls: ['https://cdn/audio.m4s'] };
    const playFailUrls = new Set(opts.playFailUrls || []);
    const fetchFailUrls = new Set(opts.fetchFailUrls || []);
    const audio = {
        paused: true, src: '', currentTime: 0, duration: 0, playbackRate: 1,
        play() {
            if (playFailUrls.has(this.src)) {
                const e = new Error('The element has no supported sources.');
                e.name = 'NotSupportedError';
                return Promise.reject(e);
            }
            this.paused = false;
            return Promise.resolve();
        },
        pause() { this.paused = true; },
        load() {},
        removeAttribute() { this.src = ''; },
        addEventListener() {}
    };
    const sandbox = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        setTimeout: (fn) => 0, clearTimeout: () => {}, setInterval: () => 0,
        fetch: (url) => {
            if (fetchFailUrls.has(url)) return Promise.reject(new Error('fetch fail'));
            return Promise.resolve({ ok: true, blob: () => Promise.resolve({}) });
        },
        URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
        window: { addEventListener() {} },
        navigator: {},
        document: { getElementById: () => audio },
        chrome: {
            runtime: {
                sendMessage: (msg, cb) => {
                    if (msg && msg.cmd === 'resolveAudio') {
                        if (cb) cb(resolveAudioRes);
                        return Promise.resolve(resolveAudioRes);
                    }
                    return Promise.resolve(undefined);
                },
                onMessage: { addListener() {} }
            },
            storage: {
                local: {
                    get: () => Promise.resolve(Object.assign({}, store)),
                    set: o => { Object.assign(store, o); return Promise.resolve(); }
                },
                onChanged: { addListener() {} }
            }
        },
        __audio: audio, __store: store
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

function setupPlaylist(n) {
    const items = [];
    for (let i = 0; i < n; i++) items.push({ bvid: 'BV' + i, cid: 100 + i, title: 't' + i, pic: '', owner: '', duration: 10, page: 1 });
    return {
        bpl_playlists: [{ id: 'pl1', name: 'p', items }],
        bpl_active: 'pl1',
        bpl_state: { playlistId: 'pl1', index: 0, playing: false, mode: 'order' }
    };
}
const getState = ctx => ctx.pGetState();

async function testPlayIndex() {
    console.log('\n[offscreen pPlayIndex]');
    let ctx = makeCtx({ store: { bpl_playlists: [{ id: 'pl1', name: 'p', items: [] }], bpl_state: { playlistId: 'pl1', index: 0, playing: false, mode: 'loop' } } });
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
}

async function testModes() {
    console.log('\n[offscreen 播放模式]');
    let ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'order'; ctx.__store.bpl_state.index = 2;
    await ctx.pAdvance();
    ok((await getState(ctx)).playing === false, 'order 末尾停止');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 2;
    await ctx.pAdvance();
    let st = await getState(ctx);
    ok(st.index === 0 && st.playing === true, 'loop 回首');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffle'; ctx.__store.bpl_state.index = 0;
    let stopped = false;
    for (let i = 0; i < 10; i++) { await ctx.pNext(); if ((await getState(ctx)).playing === false) { stopped = true; break; } }
    ok(stopped, 'shuffle 播完停止');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffleLoop'; ctx.__store.bpl_state.index = 0;
    let kept = true;
    for (let i = 0; i < 12; i++) { await ctx.pNext(); if ((await getState(ctx)).playing === false) { kept = false; break; } }
    ok(kept, 'shuffleLoop 不停');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 0; ctx.__audio.currentTime = 0;
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
    r = await ctx.handleCmd({ cmd: 'setVolume', value: 0.5 });
    ok(r.ok === true && ctx.__audio.volume === 0.5 && ctx.__store.bpl_volume === 0.5, 'setVolume 生效并持久化');
    r = await ctx.handleCmd({ cmd: 'stop' });
    ok(r.ok === true && ctx.__audio.src === '' , 'stop 清空音源');
}

(async () => {
    try {
        await testPlayIndex();
        await testModes();
        await testHandleCmd();
    } catch (e) { console.error('测试执行异常:', e); fail++; }
    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})();
