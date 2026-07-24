const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const resolveAudioRes = opts.resolveAudioRes || { ok: true, url: 'https://cdn/audio.m4s' };
    const audio = {
        paused: true, src: '', currentTime: 0, duration: 0, playbackRate: 1,
        play() { this.paused = false; return Promise.resolve(); },
        pause() { this.paused = true; },
        load() {},
        removeAttribute() { this.src = ''; },
        addEventListener() {}
    };
    const win = { addEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
    win.top = win; win.self = win;
    let captured = null;
    const sandbox = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
        window: win,
        location: { protocol: 'https:', hostname: 'www.bilibili.com', pathname: '/video/BV1', search: '' },
        document: { body: null, getElementById: () => null, createElement: () => ({}) },
        navigator: {},
        Audio: function () { return audio; },
        chrome: {
            runtime: {
                getURL: p => 'chrome-extension://id/' + p,
                onMessage: { addListener() {} },
                sendMessage: (msg, cb) => {
                    let res;
                    if (msg && msg.cmd === 'resolveAudio') res = resolveAudioRes;
                    else res = undefined;
                    if (cb) cb(res);
                    return Promise.resolve(res);
                }
            },
            storage: {
                local: {
                    get: () => Promise.resolve(Object.assign({}, store)),
                    set: o => { Object.assign(store, o); return Promise.resolve(); }
                },
                onChanged: { addListener() {} }
            }
        },
        __BPL_EXPOSE: api => { captured = api; },
        __audio: audio, __store: store
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    sandbox.__player = captured;
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

async function testPlayIndex() {
    console.log('\n[content.js pPlayIndex（经 background 取音频源）]');
    let ctx = makeCtx({ store: { bpl_playlists: [{ id: 'pl1', name: 'p', items: [] }], bpl_state: { playlistId: 'pl1', index: 0, playing: false, mode: 'loop' } } });
    let r = await ctx.__player.pPlayIndex(0);
    ok(r.ok === false && /空/.test(r.error), '空歌单 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2) });
    r = await ctx.__player.pPlayIndex(99);
    ok(r.ok === false && /越界/.test(r.error), '索引越界 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2), resolveAudioRes: { ok: false, error: '需要登录' } });
    r = await ctx.__player.pPlayIndex(0);
    ok(r.ok === false && /需要登录/.test(r.error), 'background 取源失败透传 (' + r.error + ')');

    ctx = makeCtx({ store: setupPlaylist(2) });
    r = await ctx.__player.pPlayIndex(0);
    ok(r.ok === true && ctx.__audio.src === 'https://cdn/audio.m4s', '正常播放设置 src (' + ctx.__audio.src + ')');
}

async function testModes() {
    console.log('\n[content.js 播放模式]');
    let ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'order'; ctx.__store.bpl_state.index = 2;
    await ctx.__player.pAdvance();
    ok((await ctx.__player.pGetState()).playing === false, 'order 末尾停止');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 2;
    await ctx.__player.pAdvance();
    let st = await ctx.__player.pGetState();
    ok(st.index === 0 && st.playing === true, 'loop 回首');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffle'; ctx.__store.bpl_state.index = 0;
    let stopped = false;
    for (let i = 0; i < 10; i++) { await ctx.__player.pNext(); if ((await ctx.__player.pGetState()).playing === false) { stopped = true; break; } }
    ok(stopped, 'shuffle 播完停止');

    ctx = makeCtx({ store: setupPlaylist(4) });
    ctx.__store.bpl_state.mode = 'shuffleLoop'; ctx.__store.bpl_state.index = 0;
    let kept = true;
    for (let i = 0; i < 12; i++) { await ctx.__player.pNext(); if ((await ctx.__player.pGetState()).playing === false) { kept = false; break; } }
    ok(kept, 'shuffleLoop 不停');

    ctx = makeCtx({ store: setupPlaylist(3) });
    ctx.__store.bpl_state.mode = 'loop'; ctx.__store.bpl_state.index = 0; ctx.__audio.currentTime = 0;
    await ctx.__player.pPrev();
    ok((await ctx.__player.pGetState()).index === 2, 'prev 开头回末尾');
}

async function testHandleCmd() {
    console.log('\n[content.js handlePlayerCmd]');
    const ctx = makeCtx({ store: setupPlaylist(3) });
    let r = await ctx.__player.handlePlayerCmd({ cmd: 'setMode', mode: 'shuffle' });
    ok(r.ok === true && (await ctx.__player.pGetState()).mode === 'shuffle', 'setMode 生效');
    r = await ctx.__player.handlePlayerCmd({ cmd: 'getStatus' });
    ok(r.ok === true && typeof r.position === 'number', 'getStatus 返回状态');
    r = await ctx.__player.handlePlayerCmd({ cmd: 'playIndex', index: 1 });
    ok(r.ok === true && (await ctx.__player.pGetState()).index === 1, 'playIndex 命令');
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
