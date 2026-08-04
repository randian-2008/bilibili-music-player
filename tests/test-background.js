const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    let resp = {};
    const store = {};
    const clone = value => JSON.parse(JSON.stringify(value));
    const off = { exists: false, createCalls: 0, closeCalls: 0 };
    const offscreenResponder = opts.offscreenResponder || ((msg) => ({ ok: true, echoed: msg.cmd }));
    const connectHandlers = [];
    const portHandlers = [];
    const portSent = [];
    const msgSent = [];
    const tabSent = [];
    const msgListeners = [];
    let connected = false;
    const fakePort = {
        name: 'bpl-audio',
        postMessage(msg) {
            portSent.push(msg);
            if (msg._id != null && msg.cmd) {
                Promise.resolve().then(() => {
                    const res = offscreenResponder(msg);
                    Promise.resolve(res).then(r => {
                        portHandlers.forEach(fn => fn({ _id: msg._id, result: r }));
                    });
                });
            }
        },
        onMessage: { addListener: (fn) => portHandlers.push(fn) },
        onDisconnect: { addListener() {} }
    };
    const sandbox = {
        console, Math, JSON, Promise, Date,
        setTimeout: (fn) => { setImmediate(fn); return 0; }, clearTimeout: () => {},
        fetch: (url) => Promise.resolve({
            json: () => Promise.resolve(opts.fetchResponder ? opts.fetchResponder(url) : resp)
        }),
        __setResp: r => { resp = r; },
        __store: store,
        __off: off,
        __portSent: portSent,
        __msgSent: msgSent,
        __tabSent: tabSent,
        __fireMsg: (msg) => { msgListeners.forEach(fn => fn(msg, null, () => {})); },
        chrome: {
            runtime: {
                onMessage: { addListener: (fn) => msgListeners.push(fn) }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
                onConnect: { addListener: (fn) => connectHandlers.push(fn) },
                sendMessage: (payload, cb) => {
                    msgSent.push(payload);
                    if (cb && payload && payload.target === 'offscreen') {
                        const res = offscreenResponder(payload);
                        Promise.resolve(res).then(r => cb(r));
                        return undefined;
                    }
                    return Promise.resolve(undefined);
                },
                getContexts: () => Promise.resolve(off.exists ? [{}] : [])
            },
            offscreen: {
                hasDocument: () => Promise.resolve(off.exists),
                createDocument: () => {
                    off.createCalls++; off.exists = true;
                    if (!opts.noPort) {
                        Promise.resolve().then(() => { connected = true; connectHandlers.forEach(fn => fn(fakePort)); });
                    }
                    return Promise.resolve();
                },
                closeDocument: () => { off.closeCalls++; off.exists = false; return Promise.resolve(); }
            },
            action: { onClicked: { addListener() {} } },
            commands: { onCommand: { addListener() {} } },
            // 模拟两个普通标签页：broadcast 的 tabs 投递路径（v2.2.7 双路②）据此断言逐标签页送达。
            // query 兼容回调形（broadcast）与 Promise 形（commands.onCommand）两种调用。
            tabs: {
                sendMessage: (id, payload) => { tabSent.push({ id: id, payload: payload }); return Promise.resolve(); },
                query: (q, cb) => {
                    const tabs = [{ id: 11 }, { id: 22 }];
                    if (typeof cb === 'function') { Promise.resolve().then(() => cb(tabs)); return undefined; }
                    return Promise.resolve(tabs);
                }
            },
            windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
            storage: {
                local: {
                    get: () => Promise.resolve(clone(store)),
                    set: o => { Object.assign(store, clone(o)); return Promise.resolve(); },
                    remove: keys => {
                        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
                        return Promise.resolve();
                    }
                }
            }
        },
        __connectPort: () => { connected = true; connectHandlers.forEach(fn => fn(fakePort)); },
        __firePort: (msg) => { portHandlers.forEach(fn => fn(msg)); }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

(async () => {
    console.log('[background getAudioUrls（B站音频源解析·多源容错）]');

    // dash 多码率 → 候选有序（高码率在前），返回多个候选
    let ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: { audio: [
        { baseUrl: 'https://cdn/low.m4s', bandwidth: 1000 },
        { baseUrl: 'https://cdn/high.m4s', bandwidth: 5000 } ] } } });
    let urls = await ctx.getAudioUrls('BV1', 1);
    ok(urls[0] === 'https://cdn/high.m4s', 'dash 高码率在前 (' + urls[0] + ')');
    ok(urls.length >= 2, '返回多个候选源 (' + urls.length + ')');

    // 含备用链接
    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: { audio: [
        { baseUrl: 'https://cdn/main.m4s', backup_url: ['https://cdn/bak1.m4s'], bandwidth: 3000 } ] } } });
    urls = await ctx.getAudioUrls('BV1', 1);
    ok(urls.includes('https://cdn/main.m4s') && urls.includes('https://cdn/bak1.m4s'), '主链+备用链 (' + urls.join(',') + ')');

    // 普通音频在前、flac 作为候选
    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: {
        audio: [{ baseUrl: 'https://cdn/normal.m4s', bandwidth: 3000 }],
        flac: { audio: { baseUrl: 'https://cdn/flac.m4s', bandwidth: 9000 } } } } });
    urls = await ctx.getAudioUrls('BV1', 1);
    ok(urls[0] === 'https://cdn/normal.m4s' && urls.includes('https://cdn/flac.m4s'), '普通音频优先、flac 候选 (' + urls.join(',') + ')');

    // durl(mp4) 兜底
    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { durl: [{ url: 'https://cdn/fb.mp4' }] } });
    urls = await ctx.getAudioUrls('BV1', 1);
    ok(urls.includes('https://cdn/fb.mp4'), 'durl 兜底 (' + urls.join(',') + ')');

    // 接口错误
    ctx = makeCtx();
    ctx.__setResp({ code: -403, message: '需要登录' });
    let threw = false;
    try { await ctx.getAudioUrls('BV1', 1); } catch (e) { threw = /需要登录|未获取到音频流/.test(e.message); }
    ok(threw, '接口错误抛异常');

    console.log('\n[background resolveCid]');
    ctx = makeCtx();
    ctx.__setResp({ data: { cid: 999, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }], title: 'T' } });
    let rc = await ctx.resolveCid('BV1', 2);
    ok(rc.cid === 222, '按分P取 cid (' + rc.cid + ')');
    rc = await ctx.resolveCid('BV1', 1);
    ok(rc.cid === 111, '第一P cid (' + rc.cid + ')');

    ctx = makeCtx({ fetchResponder: url => url.includes('/x/web-interface/view')
        ? { code: -352, message: '风控校验失败' }
        : { code: 0, data: [{ page: 1, cid: 333, part: '备用分P', duration: 88 }] } });
    rc = await ctx.resolveCid('BV1', 1);
    ok(rc.cid === 333, 'view 受限时经 pagelist 备用接口解析 cid (' + rc.cid + ')');

    console.log('\n[background buildItem（加入视频时拉元数据）]');
    ctx = makeCtx();
    ctx.__setResp({ data: { bvid: 'BV1', cid: 9, title: '歌曲', pic: 'http://i0.hdslb.com/x.jpg', owner: { name: 'UP' }, duration: 200, pages: [{ page: 1, cid: 9 }] } });
    const it = await ctx.buildItem('BV1', 1, 'fallback');
    ok(!!it.id && it.cid === 9 && it.title === '歌曲' && it.owner === 'UP', '元数据正确且生成稳定 ID (cid=' + it.cid + ',title=' + it.title + ')');
    ok(it.pic === 'https://i0.hdslb.com/x.jpg', '封面 http→https (' + it.pic + ')');

    // buildItem 失败回退
    ctx = makeCtx();
    ctx.__setResp({ code: -404, message: '啥都木有' });
    const it2 = await ctx.buildItem('BV1', 1, { title: '兜底标题', pic: '//i0.hdslb.com/fallback.jpg' });
    ok(it2.cid === 0 && it2.title === '兜底标题' && it2.pic === 'https://i0.hdslb.com/fallback.jpg',
        '解析失败保留页面元数据且封面协议规范化 (' + it2.title + ')');

    console.log('\n[background 存储模型迁移（稳定歌曲 ID / trackId）]');
    ctx = makeCtx();
    ctx.__store.bpl_playlists = [{ id: 'legacy', name: '旧歌单', items: [
        { bvid: 'BV0', cid: 100, title: 'a' },
        { bvid: 'BV1', cid: 101, title: 'b' }
    ] }];
    ctx.__store.bpl_active = 'legacy';
    ctx.__store.bpl_state = { playlistId: 'legacy', index: 1, playing: false, mode: 'loop' };
    ctx.__store.bpl_position = { bvid: 'BV1', cid: 101, position: 42 };
    await ctx.migrate();
    const migrated = ctx.__store.bpl_playlists[0].items;
    ok(migrated.every(x => !!x.id) && migrated[0].id !== migrated[1].id, '旧歌曲补齐唯一 ID');
    ok(ctx.__store.bpl_state.trackId === migrated[1].id && ctx.__store.bpl_state.index === 1,
        '旧播放索引迁移为 trackId');
    ok(ctx.__store.bpl_schema_version === 1, '写入存储 schema 版本');

    ctx = makeCtx();
    ctx.__store.bpl_playlists = [{ id: 'stopped', name: '已停止', items: [{ bvid: 'BV0', cid: 100, title: 'a' }] }];
    ctx.__store.bpl_active = 'stopped';
    ctx.__store.bpl_state = { playlistId: 'stopped', index: 0, playing: false, mode: 'loop' };
    await ctx.migrate();
    ok(ctx.__store.bpl_state.trackId === null, '旧状态无播放断点时保持“已停止”语义');

    console.log('\n[background 批量操作]');
    function seedBatch() {
        const c = makeCtx();
        const items = [];
        for (let i = 0; i < 5; i++) items.push({ id: 'item' + i, bvid: 'BV' + i, cid: 100 + i, title: 't' + i, pic: '', owner: '', duration: 10, page: 1 });
        c.__store.bpl_playlists = [
            { id: 'plA', name: 'A', items: items },
            { id: 'plB', name: 'B', items: [] }
        ];
        c.__store.bpl_active = 'plA';
        c.__store.bpl_state = { playlistId: 'plA', trackId: 'item2', index: 2, playing: true, mode: 'loop' };
        c.__store.bpl_position = { trackId: 'item2', bvid: 'BV2', cid: 102, position: 5 };
        return c;
    }
    // 批量删除（删索引 1、3），当前播放索引 2 应左移 1 → 1
    ctx = seedBatch();
    let r = await ctx.handleBg({ cmd: 'batchRemove', indices: [3, 1] }, null);
    let pl = ctx.__store.bpl_playlists[0];
    ok(r.ok && pl.items.length === 3, 'batchRemove 删除后剩 3 首');
    ok(pl.items.map(x => x.bvid).join(',') === 'BV0,BV2,BV4', '剩余顺序正确 (' + pl.items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 1,
        '按 trackId 重定位播放索引 (' + ctx.__store.bpl_state.index + ')');

    // 批量复制到 plB（不影响源）
    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchCopy', indices: [0, 2], toId: 'plB' }, null);
    let src = ctx.__store.bpl_playlists[0], dst = ctx.__store.bpl_playlists[1];
    ok(r.ok && src.items.length === 5 && dst.items.length === 2, 'batchCopy 源不变、目标+2');
    ok(dst.items.map(x => x.bvid).join(',') === 'BV0,BV2', '复制内容正确 (' + dst.items.map(x => x.bvid).join(',') + ')');
    ok(dst.items[0].id !== src.items[0].id && dst.items[1].id !== src.items[2].id, '复制歌曲生成新的稳定 ID');

    // 批量复制到 plB 两次 → 去重
    r = await ctx.handleBg({ cmd: 'batchCopy', indices: [0, 2], toId: 'plB' }, null);
    dst = ctx.__store.bpl_playlists[1];
    ok(dst.items.length === 2, '重复复制去重 (' + dst.items.length + ')');

    // 批量移动到 plB（源删除）
    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchMove', indices: [1, 2], toId: 'plB' }, null);
    src = ctx.__store.bpl_playlists[0]; dst = ctx.__store.bpl_playlists[1];
    ok(r.ok && src.items.length === 3 && dst.items.length === 2, 'batchMove 源-2、目标+2');
    ok(src.items.map(x => x.bvid).join(',') === 'BV0,BV3,BV4', '移动后源正确 (' + src.items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === null && ctx.__store.bpl_state.playing === false && ctx.__store.bpl_position === null,
        '移走正在播放歌曲后停止并清除断点');

    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchRemove', indices: [2] }, null);
    ok(r.ok && ctx.__store.bpl_state.trackId === null && ctx.__store.bpl_state.playing === false,
        '删除正在播放歌曲后清除当前曲目身份');

    console.log('\n[background moveItem 拖拽排序]');
    // 向下拖：BV1 拖到 BV3 位置 → BV1 应落在 BV3 原位置
    ctx = seedBatch();
    await ctx.handleBg({ cmd: 'moveItem', from: 1, to: 3 }, null);
    ok(ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') === 'BV0,BV2,BV1,BV3,BV4',
        '下拖落位准确 (' + ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 1,
        '下拖后按 trackId 保持当前歌曲');
    // 向上拖：BV3 拖到 BV1 位置 → BV3 应落在 BV1 原位置
    ctx = seedBatch();
    await ctx.handleBg({ cmd: 'moveItem', from: 3, to: 1 }, null);
    ok(ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') === 'BV0,BV3,BV1,BV2,BV4',
        '上拖落位准确 (' + ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 3,
        '上拖后按 trackId 保持当前歌曲');

    console.log('\n[background 歌单写入串行化]');
    ctx = makeCtx();
    ctx.__store.bpl_playlists = [];
    ctx.__store.bpl_state = { playlistId: null, trackId: null, index: 0, playing: false, mode: 'loop' };
    await Promise.all([
        ctx.handleBg({ cmd: 'createPlaylist', name: '并发 A' }, null),
        ctx.handleBg({ cmd: 'createPlaylist', name: '并发 B' }, null)
    ]);
    ok(ctx.__store.bpl_playlists.length === 2 &&
        ctx.__store.bpl_playlists.some(p => p.name === '并发 A') && ctx.__store.bpl_playlists.some(p => p.name === '并发 B'),
        '并发修改依次提交，不发生最后写入覆盖');

    console.log('\n[background 新建歌单点播路由 / 残缺条目修复]');
    ctx = makeCtx({ offscreenResponder: msg => ({ ok: true, echoed: msg.cmd }) });
    ctx.__store.bpl_playlists = [
        { id: 'default', name: '默认', items: [{ id: 'old0', bvid: 'BVOLD', cid: 10, title: '旧歌', pic: '', page: 1 }] },
        { id: 'custom', name: '新建', items: [{ id: 'new0', bvid: 'BVNEW', cid: 20, title: '新歌', pic: '', page: 1 }] }
    ];
    ctx.__store.bpl_active = 'custom';
    ctx.__store.bpl_state = { playlistId: 'default', trackId: 'old0', index: 0, playing: false, mode: 'loop' };
    r = await ctx.handleBg({ cmd: 'player', payload: { cmd: 'playIndex', index: 0 } }, null);
    const routedPlay = ctx.__portSent.find(m => m.cmd === 'playIndex');
    ok(r.ok === true && routedPlay && routedPlay.playlistId === 'custom',
        'playIndex 自动携带活动歌单 ID，不再按默认歌单解释索引');

    ctx = makeCtx({ fetchResponder: url => {
        if (url.includes('/x/web-interface/view')) return {
            code: 0,
            data: { bvid: 'BVNEW', title: '已修复歌曲', pic: 'http://i0.hdslb.com/repaired.jpg', owner: { name: 'UP' }, pages: [{ page: 1, cid: 222, duration: 99 }] }
        };
        return { code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/repaired.m4s', bandwidth: 1 }] } } };
    }});
    ctx.__store.bpl_playlists = [{ id: 'custom', name: '新建', items: [
        { id: 'new0', bvid: 'BVNEW', cid: 0, title: '页面兜底标题', pic: '', owner: '', duration: 0, page: 1 }
    ] }];
    ctx.__store.bpl_active = 'custom';
    r = await ctx.handleResolveAudio({ bvid: 'BVNEW', cid: 0, page: 1, playlistId: 'custom', itemId: 'new0' });
    const repaired = ctx.__store.bpl_playlists[0].items[0];
    ok(r.ok === true && r.cid === 222 && repaired.cid === 222 && repaired.pic === 'https://i0.hdslb.com/repaired.jpg' && repaired.title === '已修复歌曲',
        '播放残缺条目时补齐 cid、封面和标题');

    console.log('\n[background offscreen 路由（Port 通信）]');
    // sendToOffscreen 正常：创建 offscreen 并经 Port 转发命令
    ctx = makeCtx({ offscreenResponder: (msg) => ({ ok: true, echoed: msg.cmd }) });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok && r.echoed === 'toggle', 'sendToOffscreen 经 Port 转发命令并返回响应');
    ok(ctx.__off.createCalls === 1 && ctx.__off.exists, '自动创建 offscreen 文档');
    ok(ctx.__portSent.some(m => m.cmd === 'toggle'), '命令通过 port.postMessage 发送');

    // 已存在则不重复创建
    r = await ctx.sendToOffscreen({ cmd: 'next' });
    ok(r.echoed === 'next' && ctx.__off.createCalls === 1, '已存在不重复创建');

    // Port 不可用（Edge：connect 永远不达）→ 降级 sendMessage 通道（等就绪 ping 后发送）
    ctx = makeCtx({ offscreenResponder: (msg) => ({ ok: true, echoed: msg.cmd }), noPort: true });
    const pToggle2 = ctx.sendToOffscreen({ cmd: 'toggle' });
    ctx.__fireMsg({ bplPing: 'offscreen-ready' });
    r = await pToggle2;
    ok(r.ok && r.echoed === 'toggle', 'Port 不可用时降级 sendMessage 通道');
    ok(ctx.__msgSent.some(m => m.target === 'offscreen' && m.cmd === 'toggle'), '命令经 sendMessage 发送');

    // 关键回归：降级不“粘”——一旦 Port 连上，后续命令立即回到 Port。
    // 旧版 useMsgChannel 一旦置 true 就永久锁死 sendMessage（在部分 Chromium/Edge 不可靠），导致全部按钮失效。
    ctx.__connectPort();
    const portBefore = ctx.__portSent.length;
    r = await ctx.sendToOffscreen({ cmd: 'prev' });
    ok(r.ok && r.echoed === 'prev' && ctx.__portSent.slice(portBefore).some(m => m.cmd === 'prev'),
        'Port 恢复后命令立即回到 Port 通道（降级非粘性）');

    // handleBg player 路由
    r = await ctx.handleBg({ cmd: 'player', payload: { cmd: 'prev' } }, null);
    ok(r.ok && r.echoed === 'prev', 'handleBg player 路由到 offscreen');

    // getStatus 且 offscreen 未创建 → 直接返回默认状态（不急着创建）
    ctx = makeCtx({ offscreenResponder: () => ({ ok: true }) });
    r = await ctx.handleBg({ cmd: 'player', payload: { cmd: 'getStatus' } }, null);
    ok(r.ok && r.hasTrack === false && ctx.__off.createCalls === 0, 'getStatus 无 offscreen 时不创建、返回默认');

    // v2.2.9 回归：offscreen 被回收（暂停 ~30s 后的常态）≠ 没有曲目。getStatus 从存储推导
    // 暂停态 + 断点位置——否则新页面胶囊退回单音符 ♪、与旧页面的暂停态互相矛盾。
    ctx = makeCtx();
    ctx.__store.bpl_playlists = [{ id: 'pl1', name: 'p', items: [
        { id: 'i0', bvid: 'BV0', cid: 100, title: 'a', pic: '', owner: '', duration: 200, page: 1 },
        { id: 'i1', bvid: 'BV1', cid: 101, title: 'b', pic: '', owner: '', duration: 300, page: 1 } ] }];
    ctx.__store.bpl_state = { playlistId: 'pl1', trackId: 'i1', index: 1, playing: false, mode: 'loop' };
    ctx.__store.bpl_position = { trackId: 'i1', bvid: 'BV1', cid: 101, position: 77 };
    r = await ctx.handleBg({ cmd: 'player', payload: { cmd: 'getStatus' } }, null);
    ok(r.ok && r.hasTrack === true && r.playing === false && r.index === 1 && r.position === 77 && r.duration === 300,
        'offscreen 被回收时 getStatus 从存储推导暂停态+断点 (' + r.position + '/' + r.duration + ')');
    ctx.__store.bpl_position = { trackId: 'other', bvid: 'BV1', cid: 101, position: 77 };
    r = await ctx.handleBg({ cmd: 'player', payload: { cmd: 'getStatus' } }, null);
    ok(r.ok && r.hasTrack === true && r.position === 0, '断点曲目不符 → 推导位置归零');

    // offscreen 无响应 → 返回带确切诊断的错误；关键回归：单次失败不再 close+重建踩踏
    // （旧实现失败即关闭重建，2s 一轮把正在初始化的 offscreen.js 反复踩死，是本次故障元凶；
    // 连续 3 次无响应的僵死自愈见下方 v2.5.2 段）
    ctx = makeCtx({ offscreenResponder: () => undefined });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && /音频模块通信失败/.test(r.error), 'offscreen 无响应返回错误');
    ok(ctx.__off.closeCalls === 0, '单次失败不关闭重建（去踩踏，closeCalls=' + ctx.__off.closeCalls + '）');

    // 业务错误（如歌单为空）经 Port 原样返回、不重试
    ctx = makeCtx({ offscreenResponder: (msg) => ({ ok: false, error: '当前播放的歌单为空' }) });
    r = await ctx.sendToOffscreen({ cmd: 'playIndex', index: 9 });
    ok(r.ok === false && /空/.test(r.error), '业务错误原样透传、不当通信失败重试 (' + r.error + ')');

    // relay：offscreen 的 state/progress 经后台广播
    ctx = makeCtx();
    r = await ctx.handleBg({ cmd: 'relay', data: { type: 'progress', position: 1, duration: 2, playing: true } }, null);
    ok(r.ok === true && ctx.__msgSent.some(m => m.target === 'all' && m.type === 'progress'),
        'relay 命令转发为 target=all 广播（双路①：runtime.sendMessage）');

    // v2.2.7 关键回归：广播必须双路投递。现场实证——offscreen 直发、乃至改为经 SW 中继的 runtime 广播
    // 都到不了网页里的 content script（进度条/胶囊 UI 冻住）；chrome.tabs.sendMessage 逐标签页投递
    // 才是实证通路（togglePanel 一直走它且可用）。
    ctx = makeCtx();
    await ctx.handleBg({ cmd: 'relay', data: { type: 'progress', position: 3, duration: 9, playing: true } }, null);
    await new Promise(r2 => setTimeout(r2, 10));
    ok(ctx.__tabSent.length === 2 &&
        ctx.__tabSent.every(x => x.payload && x.payload.target === 'all' && x.payload.type === 'progress'),
        '广播双路②：tabs.sendMessage 逐标签页投递到 content script (' + ctx.__tabSent.length + ' 个标签页)');

    // resolveAudio 经 Port 请求处理
    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/a.m4s', bandwidth: 1000 }] } } });
    await ctx.__connectPort();
    const before = ctx.__portSent.length;
    ctx.__firePort({ _id: 7, resolveAudio: { bvid: 'BV1', cid: 1 } });
    let got = null;
    for (let i = 0; i < 20; i++) {
        got = ctx.__portSent.slice(before).find(m => m._id === 7);
        if (got) break;
        await new Promise(r2 => setTimeout(r2, 5));
    }
    ok(got && got.result && got.result.ok && got.result.urls[0] === 'https://cdn/a.m4s',
        'resolveAudio 经 Port 响应 (' + (got && got.result && got.result.urls && got.result.urls[0]) + ')');

    // v2.2.5 回归：offscreen 经 sendMessage 发 {target:'bg', resolveAudio:{...}}（历史形状、不带 cmd 字段），
    // 旧版落入 handleBg switch 的 default → {ok:false}，offscreen 报“无候选”且 bg 侧一条取源日志都没有
    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/a.m4s', bandwidth: 1 }] } } });
    const ra = await ctx.handleBg({ target: 'bg', resolveAudio: { bvid: 'BV1', cid: 9, page: 1 } });
    ok(ra.ok === true && ra.urls && ra.urls[0] === 'https://cdn/a.m4s',
        'resolveAudio 无 cmd 形状也路由到取源 (' + (ra.urls && ra.urls[0]) + ')');

    console.log('\n[background readBootDiag（offscreen 死因诊断）]');
    // 下次现场采集即凭此一句钉死根因：区分 boot-only / resource-error / loaded / 无记录
    ctx = makeCtx();
    ctx.__store.bpl_boot = { phase: 'boot', at: Date.now() };
    let d = await ctx.readBootDiag();
    ok(/offscreen\.js 未加载完成/.test(d), 'phase=boot → 判定 offscreen.js 未加载 (' + d + ')');
    ctx.__store.bpl_boot = { phase: 'resource-error', at: Date.now(), src: 'offscreen.js' };
    d = await ctx.readBootDiag();
    ok(/资源加载失败/.test(d) && /offscreen\.js/.test(d), 'phase=resource-error → 指出失败脚本 (' + d + ')');
    ctx.__store.bpl_boot = { phase: 'script-error', at: Date.now(), msg: 'x is not defined' };
    d = await ctx.readBootDiag();
    ok(/脚本错误/.test(d) && /x is not defined/.test(d), 'phase=script-error → 附带错误信息 (' + d + ')');
    ctx.__store.bpl_boot = { phase: 'loaded', at: Date.now() };
    d = await ctx.readBootDiag();
    ok(/已加载但命令未达/.test(d), 'phase=loaded → 判定命令通道异常 (' + d + ')');
    delete ctx.__store.bpl_boot;
    d = await ctx.readBootDiag();
    ok(/完全未执行/.test(d), '无 bpl_boot → 判定脚本完全未执行 (' + d + ')');

    console.log('\n[background offscreen 上下文损坏自愈（有界重建，非踩踏）]');
    // 升级残留的半残文档：Port 能连但 chrome.storage 失效，每条命令报 reading 'local'。
    // 期望：识别为上下文损坏 → 重建一次 → 重试成功；closeCalls 恰为 1（绝不退回旧版 2s 一轮的踩踏）。
    let calls = 0;
    ctx = makeCtx({ offscreenResponder: (msg) => {
        calls++;
        if (calls === 1) return { ok: false, error: "Cannot read properties of undefined (reading 'local')" };
        return { ok: true, echoed: msg.cmd };
    }});
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === true && r.echoed === 'toggle', '上下文损坏错误 → 重建一次后重试成功');
    ok(ctx.__off.closeCalls === 1, '损坏时恰好重建一次（closeCalls=' + ctx.__off.closeCalls + '，非踩踏）');

    // 持续损坏：单次调用内至多重建一次（重试仍坏则原样返回错误，不退化成重建风暴）
    ctx = makeCtx({ offscreenResponder: () => ({ ok: false, error: "Cannot read properties of undefined (reading 'local')" }) });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && /reading 'local'/.test(r.error) && ctx.__off.closeCalls === 1,
        '持续损坏：单次调用至多重建一次并透传错误（closeCalls=' + ctx.__off.closeCalls + '）');

    // v2.2.3 缺口回归：命令走 sendMessage 通道（Port 不可用）返回上下文损坏时，也要重建重试（旧版漏了这条路径）
    calls = 0;
    ctx = makeCtx({ noPort: true, offscreenResponder: (msg) => {
        calls++;
        if (calls === 1) return { ok: false, error: "Cannot read properties of undefined (reading 'local')" };
        return { ok: true, echoed: msg.cmd };
    }});
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === true && r.echoed === 'toggle' && ctx.__off.closeCalls === 1,
        'sendMessage 通道的上下文损坏也触发自愈重建（closeCalls=' + ctx.__off.closeCalls + '）');

    console.log('\n[background v2.5.2 僵尸通道修复（D1 预算 / D2 保留 Port / D3 僵死自愈）]');
    // D1：单条命令响应预算放宽到 15s，与面板/内容页一致。现场实证：4s 预算把用户机器 4.73s 的
    // 冷启动 playIndex 误判为无响应，是僵尸按钮的起点。
    ctx = makeCtx();
    ok(vm.runInContext('CMD_TIMEOUT_MS', ctx) === 15000, 'D1：单条命令响应预算放宽到 15s（与面板/内容页对齐）');

    // D2：Port 超时不再丢弃连接。offscreen 只在 onDisconnect 时重连、bg 从不主动 disconnect，
    // 丢弃后 waitForPort 永远等不到新连接 → 文档活着但所有命令全死。现在保留连接、仅本条改走 sendMessage。
    ctx = makeCtx({ offscreenResponder: () => undefined });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && /音频模块通信失败/.test(r.error), 'D2：Port 超时本条降级 sendMessage，仍无响应则报错');
    ok(ctx.__portSent.length === 1 && ctx.__msgSent.some(m => m.target === 'offscreen' && m.cmd === 'toggle'),
        'D2：Port 尝试 + sendMessage 兜底各一次');
    r = await ctx.sendToOffscreen({ cmd: 'next' });
    ok(r.ok === false && ctx.__portSent.length === 2,
        'D2：超时后 Port 保留，下条命令仍优先走 Port（v2.5.1 在此置空 → 永久僵尸）');
    ok(ctx.__off.closeCalls === 0, 'D2：未达僵死阈值不重建（closeCalls=' + ctx.__off.closeCalls + '）');

    // D3：连续 3 次双通道无响应 = 通道僵死（文档活着、Port 看似连着、命令全不通），此状态无自然出口
    // （播放中的文档不会被回收）→ 强制重建一次并重试本条。重建后恢复者：第 3 条即成功。
    ctx = makeCtx({ offscreenResponder: (msg) => (ctx.__off.closeCalls > 0 ? { ok: true, echoed: msg.cmd } : undefined) });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && ctx.__off.closeCalls === 0, 'D3：第 1 次无响应只报错，不重建');
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && ctx.__off.closeCalls === 0, 'D3：第 2 次无响应仍不重建（未达阈值）');
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === true && r.echoed === 'toggle' && ctx.__off.closeCalls === 1,
        'D3：第 3 次无响应判定僵死 → 强制重建一次，重试本条成功');
    ok(vm.runInContext('offscreenFailCount', ctx) === 0, 'D3：恢复成功后失败计数归零');
    r = await ctx.sendToOffscreen({ cmd: 'next' });
    ok(r.ok === true && ctx.__off.closeCalls === 1, 'D3：通道恢复后续命令正常，不再重建');

    // D3 冷却闸：僵死未愈（重建后仍无响应）→ 10s 内至多重建一次，不退化成新一轮踩踏风暴
    ctx = makeCtx({ offscreenResponder: () => undefined });
    for (let k = 0; k < 6; k++) await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(ctx.__off.closeCalls === 1 && ctx.__off.createCalls === 2,
        'D3：6 次连续无响应仅重建一次（冷却闸防踩踏，closeCalls=' + ctx.__off.closeCalls + '）');

    console.log('\n[background 存储代理（供无 chrome.storage 的 offscreen 使用）]');
    ctx = makeCtx();
    ctx.__store.bpl_state = { playlistId: 'pl1', trackId: 'i2', index: 2, playing: true, mode: 'loop' };
    let r2 = await ctx.handleBg({ cmd: 'storageGet', keys: 'bpl_state' });
    ok(r2.ok === true && r2.values && r2.values.bpl_state && r2.values.bpl_state.index === 2, 'storageGet 代理读取');
    r2 = await ctx.handleBg({ cmd: 'storageSet', data: { bpl_volume: 0.3 } });
    ok(r2.ok === true && ctx.__store.bpl_volume === 0.3, 'storageSet 代理写入（落到 bg 存储）');
    r2 = await ctx.handleBg({ cmd: 'logMerge', entries: [{ s: 'x', level: 'error', scope: 'off', msg: 'hi' }] });
    ok(r2.ok === true && Array.isArray(ctx.__store.bpl_log) && ctx.__store.bpl_log.length === 1 && ctx.__store.bpl_log[0].msg === 'hi',
        'logMerge 代理并入无存储上下文的日志');

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
