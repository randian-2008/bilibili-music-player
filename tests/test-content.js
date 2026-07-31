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
    const playerResponder = opts.playerResponder || (() => ({ ok: true }));
    const win = { innerWidth: 1920, innerHeight: 1080, addEventListener() {} };
    win.top = win; win.self = win;
    let exposed = null;
    const sandbox = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
        window: win,
        location: { protocol: 'https:', hostname: 'www.bilibili.com', pathname: '/video/BV1', search: '' },
        document: { body: null, getElementById: () => null, createElement: () => ({}), title: 'T' },
        navigator: {},
        chrome: {
            runtime: {
                getURL: p => 'chrome-extension://id/' + p,
                sendMessage: (msg, cb) => {
                    sent.push(msg);
                    let res;
                    if (msg && msg.cmd === 'player') res = playerResponder(msg.payload);
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

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
