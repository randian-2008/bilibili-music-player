const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'logger.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx() {
    const store = {};
    const sandbox = {
        console, Math, JSON, Promise, Date,
        setTimeout: (fn) => { setImmediate(fn); return 0; }, clearTimeout: () => {},
        chrome: {
            storage: {
                local: {
                    get: () => Promise.resolve(Object.assign({}, store)),
                    set: o => { Object.assign(store, o); return Promise.resolve(); }
                }
            }
        },
        __store: store
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}
// 无 chrome.storage、有 chrome.runtime 的上下文（现场 Edge 的 offscreen）：日志经 logMerge 转给 bg
function makeRelayCtx() {
    const merged = [];
    const sandbox = {
        console, Math, JSON, Promise, Date,
        setTimeout: (fn) => { setImmediate(fn); return 0; }, clearTimeout: () => {},
        chrome: {
            runtime: {
                sendMessage: (payload, cb) => {
                    if (payload && payload.cmd === 'logMerge') {
                        merged.push(...payload.entries);
                        Promise.resolve().then(() => cb && cb({ ok: true }));
                    }
                    return undefined;
                }
            }
        },
        __merged: merged
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
    console.log('[logger.js 本地日志]');
    const ctx = makeCtx();
    const L = ctx.BPLLog;
    ok(!!L && typeof L.info === 'function' && L.__bpl === true, 'BPLLog 挂载到 globalThis');

    L.info('bg', 'hello');
    L.warn('off', 'warn-msg');
    L.error('ui', 'err-msg');
    ok(L.recent().length === 3, '内存缓冲记录 3 条 (' + L.recent().length + ')');

    L.flush();
    await tick();
    const arr = ctx.__store.bpl_log;
    ok(Array.isArray(arr) && arr.length === 3, '批量落盘 bpl_log 共 3 条');
    ok(arr[0].scope === 'bg' && arr[0].level === 'info' && arr[0].msg === 'hello', '条目含 scope/level/msg');
    ok(typeof arr[0].t === 'number' && typeof arr[0].s === 'string', '条目含时间戳 t(毫秒) 与 s(可读)');
    ok(arr.some(e => e.level === 'error' && e.msg === 'err-msg'), 'error 级别已记录');

    // 上限裁剪
    const ctx2 = makeCtx();
    const MAX = ctx2.BPLLog.MAX;
    for (let i = 0; i < MAX + 50; i++) ctx2.BPLLog.info('bg', 'm' + i);
    ctx2.BPLLog.flush();
    await tick();
    ok(ctx2.__store.bpl_log.length === MAX, '超出上限裁剪到 MAX(' + MAX + ')，实际 ' + ctx2.__store.bpl_log.length);

    // relay 路径：无存储上下文不再静默丢日志（否则 Edge offscreen 的 [off] 日志整片消失，诊断失明）
    const ctx3 = makeRelayCtx();
    ctx3.BPLLog.error('off', 'relay-msg');
    ctx3.BPLLog.flush();
    await tick();
    ok(ctx3.__merged.length === 1 && ctx3.__merged[0].msg === 'relay-msg' && ctx3.__merged[0].scope === 'off',
        '无存储上下文经 background logMerge 中继落盘');

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
