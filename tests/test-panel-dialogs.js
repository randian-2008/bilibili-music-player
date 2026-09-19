const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bgHarness = fs.readFileSync(path.join(__dirname, 'test-background.js'), 'utf8').split('(async () => {')[0];
const makeBackground = new Function('require', '__dirname', bgHarness + '\nreturn makeCtx;')(require, __dirname);
const panelCode = fs.readFileSync(path.join(__dirname, '../src/panel/sidepanel.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('  PASS: ' + label); }

async function fixture() {
    const bg = makeBackground();
    bg.__store.bpl_playlists = [
        { id: 'A', name: '课程', items: [{ id: 'a1', title: '第一课', bvid: 'BV1TEST00001' }, { id: 'a2', title: '第二课', bvid: 'BV1TEST00002' }] },
        { id: 'B', name: '音乐', items: [{ id: 'b1', title: '歌曲', bvid: 'BV1TEST00003' }] }
    ];
    bg.__store.bpl_active = 'A';
    const nodes = new Map(), sent = [], timers = new Map();
    let timerId = 0, document;
    function element() {
        const listeners = new Map(), classes = new Set(['hidden']), attrs = {};
        return {
            style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [],
            value: '', hidden: false, disabled: false, open: false, isConnected: true,
            textContent: '', innerHTML: '', scrollHeight: 20, clientWidth: 100, offsetWidth: 50,
            classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
                toggle(value, on) { if (on === undefined) on = !classes.has(value); on ? classes.add(value) : classes.delete(value); } },
            addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
            fire(type, values = {}) {
                const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...values };
                return Promise.all((listeners.get(type) || []).map(fn => fn(event)));
            },
            querySelector: () => null, querySelectorAll: () => [], closest: () => null,
            setAttribute(key, value) { attrs[key] = value; }, getAttribute: key => attrs[key], removeAttribute(key) { delete attrs[key]; },
            focus() { document.activeElement = this; }, select() {},
            appendChild(child) { this.children.push(child); child.parentElement = this; },
            replaceChildren() { this.children = []; }, get childElementCount() { return this.children.length; },
            getBoundingClientRect: () => ({ left: 10, top: 10, right: 290, bottom: 280 }),
            showModal() { this.open = true; }, close() { this.open = false; return this.fire('close'); }
        };
    }
    const el = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
    document = { body: element(), documentElement: element(), activeElement: null,
        querySelector: el, querySelectorAll: () => [], createElement: element,
        getElementById: id => id === 'diag' ? null : el('#' + id), addEventListener() {} };
    el('#npCover').parentElement = element();
    const win = { addEventListener() {}, removeEventListener() {}, innerWidth: 320, innerHeight: 300 };
    win.self = win.top = win;
    const ctx = { console, document, window: win, Date, Math, Promise, JSON,
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
        alert() { throw new Error('native alert'); }, confirm() { throw new Error('native confirm'); }, prompt() { throw new Error('native prompt'); },
        FileReader: class { readAsText(file) { this.result = file.content; this.onload(); } },
        chrome: { storage: { ...bg.chrome.storage, onChanged: { addListener() {} } }, runtime: {
            onMessage: { addListener() {} }, sendMessage(message, callback) {
                sent.push(clone(message));
                if (ctx.holdCommand === message.cmd) return;
                bg.handleBg(clone(message)).then(callback);
            }
        } }
    };
    vm.createContext(ctx); vm.runInContext(panelCode, ctx); await flush();
    return { ctx, bg, el, document, sent, timers,
        menu: act => el('#plMenu').fire('click', { target: { dataset: { act } } }),
        submit: () => el('#actionDialogForm').fire('submit'),
        cancel: () => el('#actionDialogCancel').fire('click'),
        sync: async () => { await ctx.refresh(); await flush(); },
        select: (...indices) => { ctx.enterSelMode(indices[0]); indices.slice(1).forEach(index => ctx.toggleSel(index)); }
    };
}

(async () => {
    let f = await fixture();
    f.select(0, 1);
    await f.el('#selDelBtn').fire('click');
    check(f.el('#actionDialog').open && f.document.activeElement === f.el('#actionDialogCancel'), '删除浮层在面板内打开，默认焦点为取消');
    check(f.el('#actionDialogMessage').textContent.includes('课程') && f.el('#actionDialogMessage').textContent.includes('2 个') &&
        f.el('#actionDialogItems').children.map(item => item.textContent).join('|') === '第一课|第二课', '确认显示准确列表名、数量和全部待删条目');
    await f.el('#actionDialog').fire('cancel');
    check(!f.el('#actionDialog').open && !f.sent.some(msg => msg.cmd === 'batchRemove'), 'Esc 取消不发送删除命令');
    await f.el('#selDelBtn').fire('click');
    f.bg.__store.bpl_playlists[0].items.reverse();
    f.bg.__store.bpl_active = 'B';
    await f.sync();
    await f.submit(); await flush();
    check(f.bg.__store.bpl_playlists[0].items.length === 0 && f.bg.__store.bpl_playlists[1].items.length === 1,
        '确认期间切换列表和重排后，仅删除浮层列出的原条目');

    for (const action of ['clear', 'delete']) {
        for (const mutation of ['add', 'remove', 'rename-item', 'rename-list', 'replace-id', 'remove-list']) {
            f = await fixture();
            await f.menu(action);
            const pl = f.bg.__store.bpl_playlists[0];
            if (mutation === 'add') pl.items.push({ id: 'a3', title: '第三课' });
            if (mutation === 'remove') pl.items.pop();
            if (mutation === 'rename-item') pl.items[0].title = '新名称';
            if (mutation === 'rename-list') pl.name = '改名后的列表';
            if (mutation === 'replace-id') pl.items[0].id = 'replacement';
            if (mutation === 'remove-list') f.bg.__store.bpl_playlists.shift();
            const before = JSON.stringify(f.bg.__store.bpl_playlists);
            await f.submit(); await flush();
            check(JSON.stringify(f.bg.__store.bpl_playlists) === before && f.el('#actionDialogConfirm').disabled &&
                f.el('#actionDialogError').textContent.includes('重新确认'), action + '：' + mutation + ' 后拒绝过期确认，数据不被删除');
        }
    }
    f = await fixture();
    f.select(0, 1); await f.el('#selDelBtn').fire('click');
    f.bg.__store.bpl_playlists[0].items.pop();
    await f.submit();
    check(f.bg.__store.bpl_playlists[0].items.length === 1, '批量删除中有一个目标已消失时，不部分删除剩余条目');

    f = await fixture();
    f.select(0); await f.el('#selDelBtn').fire('click');
    f.bg.__store.bpl_playlists[0].items[1].title = '无关条目改名';
    await f.submit();
    check(f.bg.__store.bpl_playlists[0].items.length === 1 && f.bg.__store.bpl_playlists[0].items[0].id === 'a2', '无关条目变化不阻止删除已确认条目');

    for (const action of ['clear', 'delete']) {
        f = await fixture(); await f.menu(action);
        const first = f.submit(), repeated = f.submit();
        await Promise.all([first, repeated]); await flush();
        const cmd = action === 'delete' ? 'deletePlaylist' : 'clear';
        check(f.sent.filter(msg => msg.cmd === cmd).length === 1 && !f.el('#actionDialog').open, action + ' 正常确认只提交一次并关闭浮层');
        check(action === 'delete' ? !f.bg.__store.bpl_playlists.some(pl => pl.id === 'A') : f.bg.__store.bpl_playlists[0].items.length === 0,
            action + ' 正确删除内容，清空保留列表、删除移除列表');
    }
    f = await fixture();
    await f.menu('create');
    f.el('#actionDialogInput').value = '   '; await f.submit();
    check(!f.sent.some(msg => msg.cmd === 'createPlaylist') && !f.el('#actionDialogError').hidden, '空白名称在浮层内报错，不创建列表');
    f.el('#actionDialogInput').value = '新课程'; await f.submit(); await flush();
    check(f.bg.__store.bpl_playlists.some(pl => pl.name === '新课程'), '新建列表使用内部输入浮层');
    await f.sync();
    await f.menu('rename');
    const originalId = f.bg.__store.bpl_active;
    f.bg.__store.bpl_active = 'B'; await f.sync();
    f.el('#actionDialogInput').value = '整理后的课程'; await f.submit(); await flush();
    check(f.bg.__store.bpl_playlists.find(pl => pl.id === originalId).name === '整理后的课程' &&
        f.bg.__store.bpl_playlists[1].name === '音乐', '输入浮层期间切换列表不会改错名称');

    f = await fixture();
    f.ctx.handleImportFile({ name: 'bad.json', content: '{broken' });
    check(f.el('#actionDialogTitle').textContent === '导入失败' && f.el('#actionDialogCancel').hidden, '解析失败用内部提示浮层，仅显示确认');
    await f.submit();
    f.ctx.handleImportFile({ name: 'bad.json', content: '{}' });
    check(f.el('#actionDialogMessage').textContent === '不是有效的播放列表 JSON', '无效 JSON 结构在浮层内提示');
    await f.submit();
    f.ctx.handleImportFile({ name: 'empty.json', content: '[]' });
    check(f.el('#actionDialogMessage').textContent === 'JSON 里没有有效条目', '空导入在浮层内提示');
    await f.submit();
    f.bg.__store.bpl_playlists[0].items = []; await f.sync(); await f.menu('export-json');
    check(f.el('#actionDialogMessage').textContent === '当前播放列表是空的', '空列表导出在浮层内提示');
    await f.submit(); await f.menu('delete'); await f.submit();
    check(!f.bg.__store.bpl_playlists.some(pl => pl.id === 'A'), '空列表也可经确认删除');

    f = await fixture(); await f.menu('delete');
    const dialog = f.el('#actionDialog');
    await dialog.fire('pointerdown', { clientX: 100, clientY: 50 });
    await dialog.fire('click', { clientX: 100, clientY: 50 });
    check(dialog.open, '点击浮层内部空白不会意外取消');
    await dialog.fire('pointerdown', { clientX: 0, clientY: 0 });
    await dialog.fire('click', { clientX: 0, clientY: 0 });
    check(!dialog.open && !f.sent.some(msg => msg.cmd === 'deletePlaylist'), '点击遮罩取消，不删除内容');

    f = await fixture(); await f.menu('delete'); f.ctx.holdCommand = 'deletePlaylist';
    const waiting = f.submit();
    await f.submit();
    const timeout = [...f.timers.values()].find(timer => timer.delay === 10000);
    assert(timeout); timeout.fn(); await waiting;
    check(f.el('#actionDialogConfirm').disabled && !f.el('#actionDialogCancel').disabled &&
        f.sent.filter(msg => msg.cmd === 'deletePlaylist').length === 1, '删除响应超时后不允许盲目重发，提示检查结果');

    f = await fixture();
    f.bg.__store.bpl_playlists[0].items[0].title = '<img src=x onerror=bad()>';
    await f.sync(); f.select(0); await f.el('#selDelBtn').fire('click');
    check(f.el('#actionDialogItems').children[0].textContent === '<img src=x onerror=bad()>' &&
        !f.el('#actionDialogItems').children[0].innerHTML, '条目名称只作为文本显示，不解析 HTML');
    check(!/\b(?:alert|confirm|prompt)\s*\(/.test(panelCode), '播放器无浏览器原生弹窗调用');
    for (const cmd of ['remove', 'batchRemove', 'clear', 'deletePlaylist']) {
        f = await fixture();
        const before = JSON.stringify(f.bg.__store.bpl_playlists);
        const result = await f.bg.handleBg({ cmd, playlistId: 'A', id: 'A', itemId: 'a1', itemIds: ['a1'] });
        check(result.staleConfirmation && JSON.stringify(f.bg.__store.bpl_playlists) === before,
            cmd + ' 缺少确认快照时拒绝执行（旧面板不能绕过校验）');
    }
    f = await fixture(); await f.menu('delete');
    let releaseEdit;
    const queuedEdit = f.bg.withPlaylistMutation(async () => {
        await new Promise(resolve => { releaseEdit = resolve; });
        f.bg.__store.bpl_playlists[0].items.push({ id: 'late', title: '晚到条目' });
    });
    await flush();
    const deleting = f.submit();
    releaseEdit(); await queuedEdit; await deleting;
    check(f.bg.__store.bpl_playlists[0].items.length === 3 && f.el('#actionDialogConfirm').disabled,
        '确认请求排队期间的变更也会在写入锁内被发现，不删除新增条目');
    console.log('通过: ' + checks + '  失败: 0');
})().catch(error => { console.error(error); process.exitCode = 1; });
