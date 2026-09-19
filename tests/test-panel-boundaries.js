// Execute the real DOM listeners, including storage restore and iframe sender checks.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const contentCode = fs.readFileSync(path.join(__dirname, '../src/content/content.js'), 'utf8');
const pickerCode = fs.readFileSync(path.join(__dirname, '../src/charts/chart-picker.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let passed = 0;
function check(value, message) { assert.ok(value, message); passed++; console.log('  PASS: ' + message); }

function element() {
    const listeners = {}, queries = {}, classes = new Set(), attrs = {};
    const el = {
        style: {}, dataset: {}, value: '', textContent: '', disabled: false, offsetWidth: 340, offsetHeight: 540,
        classList: {
            add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
            toggle(x, flag) { if (flag === undefined) flag = !classes.has(x); flag ? classes.add(x) : classes.delete(x); }
        },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        fire(type, event = {}) { return Promise.all((listeners[type] || []).map(fn => fn({ ...event, type }))); },
        querySelector(selector) { return queries[selector] ||= element(); }, querySelectorAll: () => [],
        setAttribute: (key, value) => { attrs[key] = value; }, getAttribute: key => attrs[key], closest: () => null,
        appendChild() {}, contains: () => false, setPointerCapture() {},
        getBoundingClientRect() {
            const left = parseFloat(this.style.left) || 4, top = parseFloat(this.style.top) || 4;
            const width = parseFloat(this.style.width) || 340, height = parseFloat(this.style.height) || 540;
            return { left, top, width, height, right: left + width, bottom: top + height };
        },
        contentWindow: { postMessage() {} }, attachShadow() { return this.querySelector('shadow'); }
    };
    Object.defineProperty(el, 'innerHTML', { set(value) {
        const first = String(value).match(/<option value="([^"]+)"/);
        if (first) this.value = first[1];
    } });
    return el;
}

function storageBus(initial) {
    const store = clone(initial), listeners = [], writes = [], pending = [];
    const bus = { store, writes, pending, deferReads: false };
    bus.api = {
        local: {
            get(key) {
                const snapshot = clone(store);
                if (key === 'bpl_panel' && bus.deferReads) return new Promise(resolve => pending.push(() => resolve(snapshot)));
                return Promise.resolve(snapshot);
            },
            set(values) {
                const changes = {};
                writes.push(clone(values));
                for (const [key, value] of Object.entries(values)) {
                    changes[key] = { oldValue: store[key], newValue: clone(value) };
                    store[key] = clone(value);
                }
                listeners.forEach(fn => fn(changes, 'local'));
                return Promise.resolve();
            }
        },
        onChanged: { addListener: fn => listeners.push(fn) }
    };
    return bus;
}

function makeTab(bus) {
    const root = element(), win = element(), sent = [], runtimeListeners = [], timers = new Map();
    let timerId = 0;
    win.innerWidth = 1000; win.innerHeight = 800; win.top = win; win.self = win;
    const ctx = {
        console, Math, JSON, Promise, Date, URLSearchParams,
        document: { body: element(), createElement: () => root, getElementById: () => null, addEventListener() {} },
        window: win, location: { protocol: 'https:', hostname: 'example.org', pathname: '/', search: '' },
        navigator: {}, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
        BPLTheme: { STORAGE_KEY: 'bpl_theme', DEFAULT_ID: 'paper', themes: [], apply: () => ({ id: 'paper' }) },
        chrome: { storage: bus.api, runtime: {
            getURL: value => 'chrome-extension://id/' + value,
            onMessage: { addListener: fn => runtimeListeners.push(fn) },
            sendMessage(message, callback) {
                sent.push(message);
                if (callback && !ctx.holdMessages) callback({ ok: true });
                return Promise.resolve({ ok: true });
            }
        } }
    };
    vm.createContext(ctx); vm.runInContext(contentCode, ctx);
    const shadow = root.querySelector('shadow');
    return {
        ctx, win, sent, timers, panel: shadow.querySelector('.panel'), frame: shadow.querySelector('.pframe'),
        head: shadow.querySelector('.phead'), resize: shadow.querySelector('.resize-grip'),
        toggle: () => runtimeListeners.forEach(fn => fn({ target: 'content', cmd: 'togglePanel' }))
    };
}
const pointer = { target: { closest: () => null }, button: 0, clientX: 330, clientY: 130, preventDefault() {}, stopPropagation() {} };
async function drag(tab, dx, dy) {
    await tab.head.fire('pointerdown', pointer);
    await tab.head.fire('pointermove', { ...pointer, clientX: pointer.clientX + dx, clientY: pointer.clientY + dy });
    await tab.head.fire('pointerup', pointer);
    await flush();
}

function makePicker() {
    const root = element(), timers = new Map(), requests = [];
    let timerId = 0, closed = 0;
    const source = { id: 'audit', name: 'Audit', categories: [{ id: 'music', name: 'Music', charts: [{ id: 'daily', name: 'Daily' }] }] };
    const ctx = {
        console, Math, JSON, Promise, Date,
        document: { querySelector: selector => root.querySelector(selector) }, window: { close: () => closed++ },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        chrome: { runtime: { sendMessage(message, callback) {
            if (message.cmd === 'getChartCatalog') callback({ ok: true, sources: [source] });
            else requests.push({ message, callback });
        } } }
    };
    vm.createContext(ctx); vm.runInContext(pickerCode, ctx);
    return {
        root, ctx, requests, closed: () => closed,
        timeout() {
            const timer = [...timers.entries()].find(([, value]) => value.delay === 35000);
            assert.ok(timer, 'Import timeout uses 35 seconds');
            timers.delete(timer[0]); timer[1].fn();
        }
    };
}

(async () => {
    console.log('[Panel storage and message boundaries]');
    const initial = { bpl_panel: { version: 2, xRatio: .5, yRatio: .5, width: 340, height: 540 } };
    const bus = storageBus(initial), a = makeTab(bus), b = makeTab(bus);
    await flush();
    await drag(a, 326, 126);
    check(bus.store.bpl_panel.xRatio === 1 && b.panel.style.left === '656px', '另一标签页立即同步实际拖动后的相对位置');
    const beforeClick = bus.writes.length;
    await b.head.fire('pointerdown', pointer); await b.head.fire('pointerup', pointer); await flush();
    check(bus.writes.length === beforeClick && bus.store.bpl_panel.xRatio === 1, '只点击标题栏不会写回位置');
    b.win.innerWidth = 320; b.win.innerHeight = 400; await b.win.fire('resize');
    await b.resize.fire('pointerdown', pointer); await b.resize.fire('pointerup', pointer); await flush();
    b.win.innerWidth = 1000; b.win.innerHeight = 800; await b.win.fire('resize');
    check(bus.writes.length === beforeClick && b.panel.style.height === '540px', '小视口点击缩放手柄不覆盖期望尺寸');
    await b.head.fire('pointerdown', pointer);
    await drag(a, -200, -100);
    await b.head.fire('pointerup', pointer); await flush();
    check(b.panel.style.left === a.panel.style.left, '无实际拖动的交互结束后应用其他标签页的新位置');

    const delayedBus = storageBus(initial); delayedBus.deferReads = true;
    const delayed = makeTab(delayedBus);
    await drag(delayed, 200, 100);
    const newLeft = delayed.panel.style.left;
    delayedBus.pending.shift()(); await flush();
    check(delayed.panel.style.left === newLeft, '迟到的初次存储读取不会覆盖已经完成的用户拖动');
    const legacyBus = storageBus({ bpl_panel: { x: 400, y: 200, width: 340, height: 540 } });
    const legacy = makeTab(legacyBus); await flush();
    check(legacy.panel.style.left === '400px' && !legacyBus.writes.length, '读取旧坐标只转换显示，不产生并发迁移写入');
    await drag(legacy, 20, 10);
    check(legacyBus.store.bpl_panel.version === 2 && Number.isFinite(legacyBus.store.bpl_panel.xRatio), '用户实际拖动后保存新版比例格式');

    b.toggle(); await flush();
    const req = origin => ({ origin, source: b.frame.contentWindow, data: { bplBridge: 'req', id: 'request', payload: { cmd: 'stop' } } });
    const beforeBridge = b.sent.length;
    await b.win.fire('message', { ...req('null'), source: { unrelated: true } });
    await b.win.fire('message', { ...req('chrome-extension://id'), source: { unrelated: true } });
    await b.win.fire('message', req('chrome-extension://other'));
    check(b.sent.length === beforeBridge, '其他窗口即使声称扩展源或 null 源也不能控制播放');
    await b.win.fire('message', req('null'));
    await b.win.fire('message', req('chrome-extension://id'));
    check(b.sent.length === beforeBridge + 2 && b.sent.at(-1).payload.cmd === 'stop', '真实面板的扩展源及 null 源播放命令正常转发');
    await b.win.fire('message', { ...req('null'), data: { bplBridge: 'req', payload: { cmd: 'deletePlaylist' } } });
    check(b.sent.length === beforeBridge + 2, '真实面板 null 源仍不放行通用存储命令');
    b.ctx.holdMessages = true;
    void b.win.fire('message', { ...req('chrome-extension://id'), data: { bplBridge: 'req', payload: { cmd: 'playIndex', index: 0 } } });
    check([...b.timers.values()].some(timer => timer.delay >= 115000), '播放命令桥等待时间覆盖匹配及取源阶段');

    console.log('[Chart import request identity]');
    const picker = makePicker(); await flush();
    const confirm = picker.root.querySelector('#confirmBtn');
    const first = confirm.fire('click'); await flush();
    await confirm.fire('click');
    check(picker.requests.length === 1, '导入执行中忽略重复确认事件');
    picker.timeout(); await first;
    check(!confirm.disabled, '等待超时后可重试确认原导入结果');
    const retry = confirm.fire('click'); await flush();
    check(picker.requests[0].message.requestId === picker.requests[1].message.requestId, '超时后的相同选项重试复用请求 ID');
    picker.requests[0].callback({ ok: true }); await flush();
    check(!picker.closed(), '已超时请求的迟到回调不会干扰当前确认');
    picker.requests[1].callback({ ok: false, error: 'source unavailable' }); await retry;
    const afterFailure = confirm.fire('click'); await flush();
    check(picker.requests[2].message.requestId !== picker.requests[1].message.requestId, '后台明确失败后允许新的导入请求');
    picker.timeout(); await afterFailure;
    const name = picker.root.querySelector('#playlistName');
    name.value = 'Different playlist'; await name.fire('input');
    const afterEdit = confirm.fire('click'); await flush();
    check(picker.requests[3].message.requestId !== picker.requests[2].message.requestId, '修改导入选项会创建新的请求 ID');
    picker.ctx.chrome.runtime.lastError = { message: 'port closed' };
    picker.requests[3].callback(undefined); await afterEdit;
    delete picker.ctx.chrome.runtime.lastError;
    const reconnect = confirm.fire('click'); await flush();
    check(picker.requests[4].message.requestId === picker.requests[3].message.requestId, '通信中断保留请求 ID，避免后台已提交却重新创建');
    picker.requests[4].callback({ ok: true }); await reconnect;
    check(picker.closed() === 1, '最终确认成功后正常关闭榜单窗口');
    console.log('通过: ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
