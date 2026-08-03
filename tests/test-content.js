const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const sent = [];
    let msgListener = null;
    let reloads = 0;
    const sessStore = {};   // sessionStorage 替身：失效上下文自愈的一次性重载守卫存这里
    const sess = {
        getItem: k => (k in sessStore ? sessStore[k] : null),
        setItem: (k, v) => { sessStore[k] = String(v); },
        removeItem: k => { delete sessStore[k]; }
    };
    const playerResponder = opts.playerResponder || (() => ({ ok: true }));
    const win = { innerWidth: 1920, innerHeight: 1080, addEventListener() {} };
    win.top = win; win.self = win;
    let exposed = null;
    const sandbox = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
        window: win,
        sessionStorage: sess,
        location: {
            protocol: 'https:', hostname: 'www.bilibili.com', pathname: '/video/BV1', search: '',
            reload: () => { reloads++; }
        },
        document: { body: null, getElementById: () => null, createElement: () => ({}), title: 'T' },
        navigator: {},
        chrome: {
            runtime: {
                getURL: p => 'chrome-extension://id/' + p,
                sendMessage: (msg, cb) => {
                    // 模拟“扩展上下文失效”（升级前残留标签页）：所有 runtime 调用同步抛错
                    if (opts.sendThrows) throw new Error(opts.sendThrows);
                    sent.push(msg);
                    let res;
                    if (msg && msg.cmd === 'player') res = playerResponder(msg.payload);
                    else if (msg && msg.cmd === 'resolveAudio') res = { ok: true, urls: ['https://cdn/a.m4s'] };
                    else res = { ok: true };
                    if (cb) cb(res);
                    return Promise.resolve(res);
                },
                onMessage: { addListener: (fn) => { msgListener = fn; } }
            },
            storage: {
                local: {
                    get: () => Promise.resolve(Object.assign({}, store)),
                    set: o => { Object.assign(store, o); return Promise.resolve(); }
                }
            }
        },
        __BPL_EXPOSE: api => { exposed = api; },
        __sent: sent,
        __reloads: () => reloads,
        __sess: sess,
        __fireMsg: m => { if (msgListener) msgListener(m); },
        __api: () => exposed
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

(async () => {
    console.log('[content.js 播放命令路由]');
    let ctx = makeCtx({ playerResponder: (p) => ({ ok: true, cmd: p.cmd }) });
    let r = await ctx.__api().handlePlayerCmd({ cmd: 'toggle' });
    ok(r.ok && r.cmd === 'toggle', 'handlePlayerCmd 返回后台/offscreen 响应');
    let sent = ctx.__sent.find(m => m.cmd === 'player' && m.payload && m.payload.cmd === 'toggle');
    ok(sent && sent.target === 'bg', '命令经 background player 路由 (target=bg,cmd=player)');

    r = await ctx.__api().handlePlayerCmd({ cmd: 'playIndex', index: 3 });
    sent = ctx.__sent.filter(m => m.cmd === 'player').pop();
    ok(sent.payload.cmd === 'playIndex' && sent.payload.index === 3, 'playIndex 透传 index');

    console.log('\n[content.js 状态广播同步]');
    ctx = makeCtx();
    ctx.__fireMsg({ target: 'all', type: 'state', state: { playing: true, hasTrack: true, index: 2, mode: 'shuffle' } });
    let st = ctx.__api().getPlayerState();
    ok(st.playing === true && st.hasTrack === true && st.index === 2 && st.mode === 'shuffle', '接收 state 广播更新 playerState');
    ctx.__fireMsg({ target: 'all', type: 'progress', playing: false, position: 5, duration: 100 });
    st = ctx.__api().getPlayerState();
    ok(st.playing === false && st.hasTrack === true, '接收 progress 更新 playing（保留 hasTrack）');

    console.log('\n[content.js 命令一律经后台转发（放弃兜底）]');
    // 通信失败：原样返回错误，不再有页内引擎接管（产品决策：无兜底）
    ctx = makeCtx({ playerResponder: () => ({ ok: false, error: '音频模块通信失败：offscreen 持续不可用' }) });
    r = await ctx.__api().handlePlayerCmd({ cmd: 'playIndex', index: 1 });
    ok(r.ok === false && /通信失败/.test(r.error), 'offscreen 通信失败原样返回、无兜底接管 (' + r.error + ')');
    // 业务错误：原样透传给用户
    ctx = makeCtx({ playerResponder: () => ({ ok: false, error: '当前播放的歌单为空' }) });
    r = await ctx.__api().handlePlayerCmd({ cmd: 'playIndex', index: 0 });
    ok(r.ok === false && /空/.test(r.error), '业务错误原样透传 (' + r.error + ')');

    console.log('\n[content.js 桥接来源决策（安全）]');
    ctx = makeCtx();
    const bd = ctx.__api().bridgeDecision;   // 扩展源 = chrome-extension://id（mock getURL）
    ok(bd('https://evil.com', 'toggle') === 'reject-http', '网页源播放命令拒绝');
    ok(bd('https://evil.com', 'deletePlaylist') === 'reject-http', '网页源通用命令拒绝');
    ok(bd('chrome-extension://id', 'toggle') === 'player', '扩展源播放命令放行(player)');
    ok(bd('null', 'toggle') === 'player', 'null 源播放命令放行(兼容个别环境)');
    ok(bd('chrome-extension://id', 'deletePlaylist') === 'forward', '扩展源通用命令放行(forward)');
    ok(bd('null', 'deletePlaylist') === 'reject-origin', 'null 源通用命令拒绝(堵越权)');
    ok(bd('chrome-extension://other', 'clear') === 'reject-origin', '其他扩展源通用命令拒绝');

    console.log('\n[content.js 面板尺寸与视口边界]');
    const clamp = ctx.__api().clampPanelGeometry;
    let g = clamp(20, 30, 100, 120, 1000, 800);
    ok(g.x === 20 && g.y === 30 && g.width === 300 && g.height === 300,
        '面板尺寸不小于 300x300');
    g = clamp(50, 60, 2000, 2000, 1000, 800);
    ok(g.x === 4 && g.y === 4 && g.width === 992 && g.height === 792,
        '面板尺寸不超过视口并保留 4px 边距');
    g = clamp(-200, 900, 400, 350, 1000, 800);
    ok(g.x === 4 && g.y === 446 && g.width === 400 && g.height === 350,
        '越界位置被钳制到完整可见范围');

    console.log('\n[content.js 失效上下文自愈（v2.2.7：升级残留标签页）]');
    // 现场日志实锤：升级前开着的标签页里 runtime 调用全抛 "Extension context invalidated"，
    // UI 僵死。期望：检测→重载本页一次（守卫防循环）；通道复活后清守卫。
    ctx = makeCtx({ sendThrows: 'Extension context invalidated' });
    ok(ctx.__reloads() === 1, '启动即命中失效上下文 → 触发一次性重载复活 (reloads=' + ctx.__reloads() + ')');
    r = await ctx.__api().handlePlayerCmd({ cmd: 'toggle' });
    ok(r.ok === false && /invalidated/i.test(r.error), '失效错误原样返回 (' + r.error + ')');
    await ctx.__api().handlePlayerCmd({ cmd: 'next' });
    ok(ctx.__reloads() === 1, 'sessionStorage 守卫防重载循环（始终 1 次，reloads=' + ctx.__reloads() + '）');
    ctx = makeCtx();
    ctx.__sess.setItem('bpl_revive', '1');
    await ctx.__api().handlePlayerCmd({ cmd: 'toggle' });
    ok(ctx.__sess.getItem('bpl_revive') == null, '通道恢复（收到正常响应）后清除重载守卫');

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
