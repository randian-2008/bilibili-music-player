const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'background', 'background.js'), 'utf8');
const renamerCode = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'rename', 'renamer.js'), 'utf8');
const appleCode = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'charts', 'apple.js'), 'utf8');
const qqCode = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'charts', 'qq.js'), 'utf8');
const neteaseCode = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'charts', 'netease.js'), 'utf8');
const matcherCode = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'charts', 'matcher.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx(opts) {
    opts = opts || {};
    let resp = {};
    let fetchCalls = 0;
    const fetchOptions = [];
    const store = {};
    const clone = value => JSON.parse(JSON.stringify(value));
    const off = { exists: false, createCalls: 0, closeCalls: 0, disconnectCalls: 0 };
    const offscreenResponder = opts.offscreenResponder || ((msg) => ({ ok: true, echoed: msg.cmd }));
    const connectHandlers = [];
    const portHandlers = [];
    const disconnectHandlers = [];
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
                if (!opts.noAck) Promise.resolve().then(() => portHandlers.forEach(fn => fn({ _id: msg._id, ack: true })));
                Promise.resolve().then(() => {
                    const res = offscreenResponder(msg);
                    Promise.resolve(res).then(r => {
                        if (r !== undefined) portHandlers.forEach(fn => fn({ _id: msg._id, result: r }));
                    });
                });
            }
        },
        onMessage: { addListener: (fn) => portHandlers.push(fn) },
        onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
        disconnect() { off.disconnectCalls++; connected = false; disconnectHandlers.slice().forEach(fn => fn()); }
    };
    let timerSeq = 0;
    const timers = new Map();
    let timerNow = 0, timerPump = null;
    const pumpTimers = () => {
        if (timerPump || !timers.size) return;
        timerPump = setImmediate(() => {
            timerPump = null;
            const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) return;
            const [id, timer] = next;
            timers.delete(id);
            timerNow = timer.due;
            timer.fn();
            // Promise continuations can cancel deadlines or schedule a shorter retry.
            pumpTimers();
        });
    };
    const fastSetTimeout = (fn, delay) => {
        const id = ++timerSeq;
        timers.set(id, { fn, due: timerNow + Math.max(0, Number(delay) || 0) });
        pumpTimers();
        return id;
    };
    const fastClearTimeout = id => {
        timers.delete(id);
    };
    const sandbox = {
        console, Math, JSON, Promise, Date,
        setTimeout: opts.realTimers ? setTimeout : fastSetTimeout,
        clearTimeout: opts.realTimers ? clearTimeout : fastClearTimeout,
        fetch: (url, options) => {
            fetchCalls++;
            fetchOptions.push(options || {});
            if (opts.fetchNever) return new Promise(() => {});
            const isRulesRequest = String(url).indexOf('/rename/rules.json') >= 0;
            const responseData = isRulesRequest ? (opts.renameRules || {}) : (opts.fetchResponder ? opts.fetchResponder(url) : resp);
            const httpStatus = responseData && typeof responseData === 'object' && responseData.__httpStatus
                ? Number(responseData.__httpStatus) : 200;
            const responseText = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
            return Promise.resolve({
                ok: httpStatus >= 200 && httpStatus < 300,
                status: httpStatus,
                json: () => Promise.resolve(typeof responseData === 'string' ? JSON.parse(responseData) : responseData),
                text: () => Promise.resolve(responseText),
                headers: { get: () => String(Buffer.byteLength(responseText, 'utf8')) }
            });
        },
        __setResp: r => { resp = r; },
        __fetchCalls: () => fetchCalls,
        __fetchOptions: () => fetchOptions.slice(),
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
                getContexts: () => Promise.resolve(off.exists ? [{}] : []),
                getURL: value => 'chrome-extension://test/' + value
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
    sandbox.importScripts = (...paths) => {
        if (paths.some(value => String(value).indexOf('rename/renamer.js') >= 0)) vm.runInContext(renamerCode, sandbox);
        if (paths.some(value => String(value).indexOf('charts/apple.js') >= 0)) vm.runInContext(appleCode, sandbox);
        if (paths.some(value => String(value).indexOf('charts/qq.js') >= 0)) vm.runInContext(qqCode, sandbox);
        if (paths.some(value => String(value).indexOf('charts/netease.js') >= 0)) vm.runInContext(neteaseCode, sandbox);
        if (paths.some(value => String(value).indexOf('charts/matcher.js') >= 0)) vm.runInContext(matcherCode, sandbox);
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
    ok(ctx.__fetchOptions().every(options => options.credentials === 'omit' && options.cache === 'no-store' &&
        options.referrer === 'https://www.bilibili.com/' && options.referrerPolicy === 'strict-origin-when-cross-origin'),
        'B站接口请求使用匿名且不读缓存的选项');

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
    try { await ctx.getAudioUrls('BV1', 1); } catch (e) { threw = /需要登录|未获取到.*音频流/.test(e.message); }
    ok(threw, '接口错误抛异常');

    ctx = makeCtx({ fetchNever: true });
    threw = false;
    try { await ctx.biliFetch('https://api.bilibili.com/hang'); } catch (e) { threw = /超时/.test(e.message); }
    ok(threw && ctx.__fetchCalls() === 2, '网络永久挂起会超时并仅重试一次');

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
    ctx.__store.bpl_playlists = [{ id: 'legacy', name: '旧播放列表', items: [
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
    let r = await ctx.handleBg({ cmd: 'batchRemove', playlistId: 'plA', itemIds: ['item3', 'item1'] }, null);
    let pl = ctx.__store.bpl_playlists[0];
    ok(r.ok && pl.items.length === 3, 'batchRemove 删除后剩 3 首');
    ok(pl.items.map(x => x.bvid).join(',') === 'BV0,BV2,BV4', '剩余顺序正确 (' + pl.items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 1,
        '按 trackId 重定位播放索引 (' + ctx.__store.bpl_state.index + ')');

    // 批量复制到 plB（不影响源）
    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchCopy', playlistId: 'plA', itemIds: ['item0', 'item2'], toId: 'plB' }, null);
    let src = ctx.__store.bpl_playlists[0], dst = ctx.__store.bpl_playlists[1];
    ok(r.ok && src.items.length === 5 && dst.items.length === 2, 'batchCopy 源不变、目标+2');
    ok(dst.items.map(x => x.bvid).join(',') === 'BV0,BV2', '复制内容正确 (' + dst.items.map(x => x.bvid).join(',') + ')');
    ok(dst.items[0].id !== src.items[0].id && dst.items[1].id !== src.items[2].id, '复制歌曲生成新的稳定 ID');

    // 批量复制到 plB 两次 → 去重
    r = await ctx.handleBg({ cmd: 'batchCopy', playlistId: 'plA', itemIds: ['item0', 'item2'], toId: 'plB' }, null);
    dst = ctx.__store.bpl_playlists[1];
    ok(dst.items.length === 2, '重复复制去重 (' + dst.items.length + ')');

    // 批量移动到 plB（源删除）
    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchMove', playlistId: 'plA', itemIds: ['item1', 'item2'], toId: 'plB' }, null);
    src = ctx.__store.bpl_playlists[0]; dst = ctx.__store.bpl_playlists[1];
    ok(r.ok && src.items.length === 3 && dst.items.length === 2, 'batchMove 源-2、目标+2');
    ok(src.items.map(x => x.bvid).join(',') === 'BV0,BV3,BV4', '移动后源正确 (' + src.items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === null && ctx.__store.bpl_state.playing === false && ctx.__store.bpl_position === null,
        '移走正在播放歌曲后停止并清除断点');

    ctx = seedBatch();
    r = await ctx.handleBg({ cmd: 'batchRemove', playlistId: 'plA', itemIds: ['item2'] }, null);
    ok(r.ok && ctx.__store.bpl_state.trackId === null && ctx.__store.bpl_state.playing === false,
        '删除正在播放歌曲后清除当前曲目身份');

    console.log('\n[background moveItem 拖拽排序]');
    // 向下拖：BV1 拖到 BV3 位置 → BV1 应落在 BV3 原位置
    ctx = seedBatch();
    await ctx.handleBg({ cmd: 'moveItem', playlistId: 'plA', itemId: 'item1', beforeItemId: 'item3' }, null);
    ok(ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') === 'BV0,BV2,BV1,BV3,BV4',
        '下拖落位准确 (' + ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 1,
        '下拖后按 trackId 保持当前歌曲');
    // 向上拖：BV3 拖到 BV1 位置 → BV3 应落在 BV1 原位置
    ctx = seedBatch();
    await ctx.handleBg({ cmd: 'moveItem', playlistId: 'plA', itemId: 'item3', beforeItemId: 'item1' }, null);
    ok(ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') === 'BV0,BV3,BV1,BV2,BV4',
        '上拖落位准确 (' + ctx.__store.bpl_playlists[0].items.map(x => x.bvid).join(',') + ')');
    ok(ctx.__store.bpl_state.trackId === 'item2' && ctx.__store.bpl_state.index === 3,
        '上拖后按 trackId 保持当前歌曲');

    console.log('\n[background 播放列表写入串行化]');
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

    console.log('\n[background Apple 热榜导入与B站匹配]');
    ctx = makeCtx({ fetchResponder: url => {
        if (String(url).includes('rss.applemarketingtools.com')) return { feed: { results: [
            { name: '晴天', artistName: '周杰伦', artworkUrl100: 'https://ignored/apple.jpg', id: 'ignored' },
            { name: '七里香', artistName: '周杰伦' }
        ] } };
        if (String(url).includes('/x/web-interface/search/type')) {
            const decoded = decodeURIComponent(String(url));
            if (decoded.includes('七里香')) return { code: 0, data: { result: [
                { bvid: 'BV1MATCH00002', title: '周杰伦 七里香 官方MV', author: 'B站音乐账号', pic: '//i0.hdslb.com/chart2.jpg', duration: '4:59' }
            ] } };
            return { code: 0, data: { result: [
                { bvid: 'BV1MATCH00001', title: '<em class="keyword">周杰伦</em>《晴天》官方MV', author: 'B站音乐账号', pic: '//i0.hdslb.com/chart.jpg', duration: '4:29' },
                { bvid: 'BV1SHORT00001', title: '晴天片段', author: '路人', pic: '', duration: '0:25' }
            ] } };
        }
        return { code: 0, data: {} };
    }});
    let chartCatalogResult = await ctx.handleBg({ cmd: 'getChartCatalog' }, null);
    ok(chartCatalogResult.ok && chartCatalogResult.sources.map(source => source.id).join(',') === 'apple,qq,netease' &&
        chartCatalogResult.sources[0].categories[0].charts[0].id === 'cn-most-played-songs',
        '后台返回 Apple、QQ、网易云的平台、分类和榜单目录');
    let chartImport = await ctx.handleBg({ cmd: 'importChart', sourceId: 'apple', chartId: 'cn-most-played-songs', limit: 25 }, null);
    let chartPlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === chartImport.playlistId);
    ok(chartImport.ok && chartImport.count === 2 && ctx.__store.bpl_active === chartImport.playlistId && chartPlaylist.chartSource === 'apple',
        '导入后创建并切换到独立热榜播放列表');
    ok(chartPlaylist.items[0].matchState === 'pending' && !chartPlaylist.items[0].bvid && !chartPlaylist.items[0].pic &&
        chartPlaylist.items[0].sourceTitle === '晴天' && chartPlaylist.items[0].sourceArtist === '周杰伦' && chartPlaylist.items[0].sourceRank === 1,
        '占位条目只保存榜单排名、歌曲名和歌手，不混入 Apple 资源字段');
    ctx.__store.bpl_playlists.push({ id: 'chart-copy', name: '榜单副本', items: [] });
    let chartCopy = await ctx.handleBg({ cmd: 'batchCopy', playlistId: chartPlaylist.id, itemIds: chartPlaylist.items.map(item => item.id), toId: 'chart-copy' }, null);
    ok(chartCopy.ok && chartCopy.added === 2 && ctx.__store.bpl_playlists.find(playlist => playlist.id === 'chart-copy').items.length === 2,
        '未匹配条目可按榜单身份复制，不会因空 bvid 被错误判重');
    let chartMatch = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: chartPlaylist.id, itemId: chartPlaylist.items[0].id }, null);
    chartPlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === chartImport.playlistId);
    const matchedChartItem = chartPlaylist.items[0];
    ok(chartMatch.ok && matchedChartItem.matchState === 'matched' && matchedChartItem.bvid === 'BV1MATCH00001' &&
        matchedChartItem.pic === 'https://i0.hdslb.com/chart.jpg' && matchedChartItem.duration === 269 && matchedChartItem.owner === 'B站音乐账号' &&
        matchedChartItem.title === '晴天 - 周杰伦',
        '匹配成功后写入B站播放元数据，但保留热榜的歌曲 - 歌手显示名');
    await ctx.repairResolvedItem({ playlistId: chartPlaylist.id, itemId: matchedChartItem.id, bvid: matchedChartItem.bvid, page: 1 }, {
        cid: 909,
        info: { bvid: matchedChartItem.bvid, title: 'B站原标题', pic: '//i0.hdslb.com/resolved.jpg', owner: { name: '另一个UP主' }, duration: 321 },
        page: { part: '', duration: 321 }
    });
    chartPlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === chartImport.playlistId);
    ok(chartPlaylist.items[0].cid === 909 && chartPlaylist.items[0].pic === 'https://i0.hdslb.com/resolved.jpg' &&
        chartPlaylist.items[0].title === '晴天 - 周杰伦',
        '榜单条目补齐 cid 时仍保留热榜标题，不被B站原标题覆盖');
    let nextChartMatch = await ctx.matchNextChartItem(chartPlaylist.id);
    chartPlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === chartImport.playlistId);
    ok(nextChartMatch.ok && chartPlaylist.items[1].matchState === 'matched' && chartPlaylist.items[1].bvid === 'BV1MATCH00002',
        '后台队列按排名继续匹配下一首待处理歌曲');

    console.log('\n[background 热榜匹配失败与手动重试]');
    ctx = makeCtx({ fetchResponder: url => {
        if (String(url).includes('/x/web-interface/search/type')) return { __httpStatus: 412 };
        return { code: 0, data: {} };
    }});
    ctx.__store.bpl_playlists = [{ id: 'chart-failed', name: '失败热榜', chartSource: 'apple', items: [{
        id: 'failed0', bvid: '', cid: 0, title: '晴天 - 周杰伦', pic: '', owner: '', duration: 0, page: 1,
        chartSource: 'apple', chartId: 'chart', sourceRank: 1, sourceTitle: '晴天', sourceArtist: '周杰伦',
        matchState: 'pending', matchAttempts: 0
    }] }];
    let failedMatch = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: 'chart-failed', itemId: 'failed0' }, null);
    const failedItem = ctx.__store.bpl_playlists[0].items[0];
    ok(failedMatch.ok === false && failedMatch.error === 'HTTP 412' && failedItem.matchState === 'failed' &&
        failedItem.matchError === 'HTTP 412' && !failedItem.bvid,
        'B站搜索返回 HTTP 412 时保留热榜占位条目的失败状态');
    const callsAfterFailure = ctx.__fetchCalls();
    const throttledMatch = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: 'chart-failed', itemId: 'failed0' }, null);
    ok(throttledMatch.ok === false && throttledMatch.throttled === true && ctx.__fetchCalls() === callsAfterFailure,
        '自动匹配失败后短时间内不重复请求，等待用户手动重试');
    const callsBeforeManual412 = ctx.__fetchCalls();
    const manual412 = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: 'chart-failed', itemId: 'failed0', manual: true, verifyPlayable: true }, null);
    ok(manual412.ok === false && manual412.error === 'HTTP 412' && ctx.__fetchCalls() === callsBeforeManual412 + 4,
        '手动重试对搜索接口 HTTP 412 进行有限退避重试后结束');

    let rateLimitedSearchCalls = 0;
    ctx = makeCtx({ fetchResponder: url => {
        const value = String(url);
        if (value.includes('/x/web-interface/search/type')) {
            rateLimitedSearchCalls++;
            if (rateLimitedSearchCalls <= 2) return { __httpStatus: 412 };
            return { code: 0, data: { result: [
                { bvid: 'BV1SEARCHOK01', title: '晴天 周杰伦 官方MV', author: '音乐账号', pic: '//img/search-ok.jpg', duration: '4:29' }
            ] } };
        }
        if (value.includes('/x/web-interface/view')) return { code: 0, data: {
            bvid: 'BV1SEARCHOK01', title: '晴天', pic: '//img/search-ok.jpg', owner: { name: '音乐账号' },
            pages: [{ page: 1, cid: 401, duration: 269, part: '晴天' }]
        } };
        return { code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/search-ok.m4s', bandwidth: 1 }] } } };
    }});
    ctx.__store.bpl_playlists = [{ id: 'chart-search-retry', name: '搜索退避', chartSource: 'apple', items: [{
        id: 'search-retry0', bvid: '', cid: 0, title: '晴天 - 周杰伦', pic: '', owner: '', duration: 0, page: 1,
        chartSource: 'apple', chartId: 'chart', sourceRank: 1, sourceTitle: '晴天', sourceArtist: '周杰伦',
        matchState: 'failed', matchError: '上次匹配失败', matchFailedAt: Date.now() - 20000
    }] }];
    const searchRetryMatch = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: 'chart-search-retry', itemId: 'search-retry0', manual: true, verifyPlayable: true }, null);
    const searchRetryItem = ctx.__store.bpl_playlists[0].items[0];
    ok(searchRetryMatch.ok && rateLimitedSearchCalls === 3 && searchRetryItem.matchState === 'matched' &&
        searchRetryItem.bvid === 'BV1SEARCHOK01' && searchRetryItem.cid === 401,
        '搜索前两次 HTTP 412 时自动退避，第三次成功并完成可播放验证');

    let searchRounds = 0;
    ctx = makeCtx({ fetchResponder: url => {
        const value = String(url);
        if (value.includes('/x/web-interface/search/type')) {
            searchRounds++;
            const bvid = 'BV1RETRY000' + searchRounds;
            return { code: 0, data: { result: [
                { bvid: bvid, title: '晴天 周杰伦 官方MV', author: '音乐账号', pic: '//img/retry.jpg', duration: '4:29' }
            ] } };
        }
        if (value.includes('/x/web-interface/view')) {
            if (value.includes('BV1RETRY0001') || value.includes('BV1RETRY0002')) {
                return { code: -404, message: '候选视频已失效' };
            }
            return { code: 0, data: {
                bvid: 'BV1RETRY0003', title: '晴天', pic: '//img/retry.jpg', owner: { name: '音乐账号' },
                pages: [{ page: 1, cid: 303, duration: 269, part: '晴天' }]
            } };
        }
        return { code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/retry.m4s', bandwidth: 1 }] } } };
    }});
    ctx.__store.bpl_playlists = [{ id: 'chart-retry', name: '重试热榜', chartSource: 'apple', items: [{
        id: 'retry0', bvid: '', cid: 0, title: '晴天 - 周杰伦', pic: '', owner: '', duration: 0, page: 1,
        chartSource: 'apple', chartId: 'chart', sourceRank: 1, sourceTitle: '晴天', sourceArtist: '周杰伦',
        matchState: 'failed', matchError: '上次匹配失败', matchFailedAt: Date.now() - 20000
    }] }];
    const retryMatch = await ctx.handleBg({ cmd: 'matchChartItem', playlistId: 'chart-retry', itemId: 'retry0', manual: true, verifyPlayable: true }, null);
    const retryItem = ctx.__store.bpl_playlists[0].items[0];
    ok(retryMatch.ok && searchRounds === 3 && retryItem.bvid === 'BV1RETRY0003' && retryItem.cid === 303 &&
        retryItem.matchState === 'matched',
        '手动重试按轮次重新搜索并跳过不可播放候选，最多十次后写入可播放来源');

    console.log('\n[background 手动添加条目与按需匹配]');
    ctx = makeCtx({ fetchResponder: url => {
        if (String(url).includes('/x/web-interface/search/type')) {
            return { code: 0, data: { result: [
                { bvid: 'BV1MANUAL0001', title: '手动歌曲 官方MV', author: '音乐账号', pic: '//i0.hdslb.com/manual.jpg', duration: '3:40' }
            ] } };
        }
        if (String(url).includes('/x/web-interface/view') || String(url).includes('/x/player/pagelist')) {
            return { code: 0, data: { cid: 1001, pages: [{ cid: 1001, page: 1, part: '手动歌曲' }] } };
        }
        if (String(url).includes('/x/player/playurl')) {
            return { code: 0, data: { dash: { audio: [{ id: 30280, baseUrl: 'https://cdn/manual.m4s' }] } } };
        }
        return { code: 0, data: {} };
    }});
    ctx.__store.bpl_playlists = [{ id: 'manual-pl', name: '手动测试', items: [] }];
    ctx.__store.bpl_active = 'manual-pl';
    let manualAdd = await ctx.handleBg({ cmd: 'addManualItem', title: '手动歌曲' }, null);
    let manualPlaylist = ctx.__store.bpl_playlists[0];
    const manualItem = manualPlaylist.items[0];
    ok(manualAdd.ok && manualItem.matchOrigin === 'manual' && !manualItem.bvid &&
        manualItem.matchState === 'pending' && manualItem.title === '手动歌曲' &&
        manualItem.matchTargetTitle === '手动歌曲',
        '手动添加只保存用户标题和待匹配目标，不立即联网');
    const manualMatch = await ctx.handleBg({ cmd: 'matchManualItem', playlistId: 'manual-pl', itemId: manualItem.id }, null);
    manualPlaylist = ctx.__store.bpl_playlists[0];
    ok(manualMatch.ok && manualPlaylist.items[0].matchState === 'matched' &&
        manualPlaylist.items[0].bvid === 'BV1MANUAL0001' &&
        manualPlaylist.items[0].title === '手动歌曲' &&
        manualPlaylist.items[0].pic === 'https://i0.hdslb.com/manual.jpg',
        '手动匹配写入B站播放元数据但保留用户标题');
    const restoredManual = await ctx.handleBg({ cmd: 'importPlaylist', name: '手动恢复', items: [{
        matchOrigin: 'manual', matchTargetTitle: '待匹配歌曲', matchState: 'pending', title: '待匹配歌曲'
    }] }, null);
    const manualRestoredPlaylist = ctx.__store.bpl_playlists.find(p => p.name === '手动恢复');
    ok(restoredManual.ok && manualRestoredPlaylist && manualRestoredPlaylist.items.length === 1 &&
        manualRestoredPlaylist.items[0].matchOrigin === 'manual' && !manualRestoredPlaylist.items[0].bvid,
        '完整JSON可恢复未匹配的手动占位条目');
    const rejectedManual = await ctx.handleBg({ cmd: 'importPlaylist', name: '非法恢复', items: [{
        title: '没有来源'
    }] }, null);
    ok(rejectedManual.ok === false, '任意无来源空条目不会被JSON恢复');

    let qqRequestUrl = '';
    ctx = makeCtx({ fetchResponder: url => {
        qqRequestUrl = String(url);
        return { code: 0, songlist: [
            { data: { songname: '东风破', singer: [{ name: '周杰伦' }] } },
            { data: { songname: '牵丝戏', singer: [{ name: '银临' }, { name: 'Aki阿杰' }] } }
        ] };
    }});
    let qqImport = await ctx.handleBg({ cmd: 'importChart', sourceId: 'qq', chartId: '65', limit: 10 }, null);
    let qqPlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === qqImport.playlistId);
    ok(qqImport.ok && qqRequestUrl.includes('topid=65') && qqRequestUrl.includes('song_num=10') &&
        qqPlaylist.name === 'QQ音乐 - 国风热歌榜' && qqPlaylist.items[1].sourceArtist === '银临/Aki阿杰',
        'QQ 音乐导入把数量传给适配器，并创建只含榜单身份的占位播放列表');

    let neteaseRequestUrl = '';
    ctx = makeCtx({ fetchResponder: url => {
        neteaseRequestUrl = String(url);
        return { code: 200, result: { tracks: [
            { name: '动画主题曲', ar: [{ name: '歌手甲' }] },
            { name: '游戏配乐', artists: [{ name: '歌手乙' }] }
        ] } };
    }});
    let neteaseImport = await ctx.handleBg({ cmd: 'importChart', sourceId: 'netease', chartId: '71385702', limit: 25 }, null);
    let neteasePlaylist = ctx.__store.bpl_playlists.find(playlist => playlist.id === neteaseImport.playlistId);
    ok(neteaseImport.ok && neteaseRequestUrl.includes('id=71385702') && neteasePlaylist.name === '网易云音乐 - ACG榜' &&
        neteasePlaylist.items.length === 2 && !neteasePlaylist.items[0].pic && !neteasePlaylist.items[0].bvid,
        '网易云音乐导入识别榜单和数量，并等待后续B站匹配补全播放字段');

    console.log('\n[background 合集解析与导入]');
    ctx = makeCtx({ fetchResponder: url => ({ code: 0, data: {
        bvid: 'BV1SEASON001', title: '当前集', pic: '//img/season.jpg',
        ugc_season: { title: '测试合集', cover: '//img/cover.jpg', season_type: 1, sections: [
            { title: '正片', episodes: [
                { bvid: 'BV1ITEM00001', cid: 101, title: '剧集一', arc: { pic: '//img/1.jpg', author: { name: 'UP' } }, page: { page: 1, cid: 101, duration: 10, part: '剧集一' } },
                { bvid: 'BV2ITEM00002', cid: 201, title: '剧集二', arc: { pic: '//img/2.jpg', author: { name: 'UP' } }, pages: [
                    { page: 1, cid: 201, duration: 20, part: '剧集二' },
                    { page: 2, cid: 202, duration: 30, part: '第二部分' },
                    { page: 2, cid: 202, duration: 30, part: '第二部分（重复引用）' }
                ] }
            ] },
            { title: '番外', episodes: [{ bvid: 'BV3ITEM00003', cid: 301, title: '剧集三', arc: { pic: '//img/3.jpg', author: {} }, page: { page: 1, cid: 301, duration: 40, part: '剧集三' } }] }
        ] }
    }}) });
    ctx.__store.bpl_playlists = [{ id: 'targetA', name: '当前播放列表', items: [{ id: 'old', bvid: 'BV2ITEM00002', cid: 202, title: '已存在' }] }];
    ctx.__store.bpl_active = 'targetA';
    let summary = await ctx.handleBg({ cmd: 'getCollection', bvid: 'BV1SEASON001' }, null);
    ok(summary.ok && summary.kind === 'season' && summary.count === 4 && summary.title === '测试合集' &&
        summary.activePlaylistId === 'targetA' && summary.activePlaylistName === '当前播放列表',
        '合集摘要返回类型、数量和当前播放列表');
    ok(ctx.__fetchCalls() === 1, '合集检测只请求一次 view API');
    let cached = await ctx.handleBg({ cmd: 'getCollection', bvid: 'BV1SEASON001' }, null);
    ok(cached.ok && cached.count === 4 && ctx.__fetchCalls() === 1, '同一 BVID 命中后台缓存');
    let imported = await ctx.handleBg({ target: 'bg', cmd: 'importCollection', bvid: 'BV1SEASON001', importTarget: 'current', targetPlaylistId: 'targetA' }, null);
    let targetItems = ctx.__store.bpl_playlists[0].items;
    ok(imported.ok && imported.added === 3 && imported.dup === 1 && targetItems.length === 4,
        '导入当前播放列表按 bvid+cid 去重并返回 added/dup');
    ok(targetItems[1].title === '剧集一' && targetItems[2].title === '剧集二' &&
        targetItems[3].title === '剧集三', '非嵌套合集条目只使用分P名，不添加分区或视频标题');
    ctx.__store.bpl_playlists.push({ id: 'smartTarget', name: '智能目标', items: [] });
    const renamedCurrent = await ctx.handleBg({
        target: 'bg', cmd: 'importCollection', bvid: 'BV1SEASON001', importTarget: 'current',
        targetPlaylistId: 'smartTarget', smartRename: true, renamePrefix: '周杰伦'
    }, null);
    const smartTargetItems = ctx.__store.bpl_playlists.find(p => p.id === 'smartTarget').items;
    ok(renamedCurrent.ok && renamedCurrent.added === 4 &&
        smartTargetItems.length === 4 && smartTargetItems.every(item => item.title.indexOf('周杰伦 - ') === 0),
        '智能重命名同时作用于当前播放列表导入并保留 bvid+cid 去重');
    let newImported = await ctx.handleBg({ target: 'bg', cmd: 'importCollection', bvid: 'BV1SEASON001', importTarget: 'new', name: '新合集播放列表' }, null);
    const newPlaylist = ctx.__store.bpl_playlists.find(p => p.id === newImported.playlistId);
    ok(newImported.ok && newImported.added === 4 && ctx.__store.bpl_active === newImported.playlistId &&
        newPlaylist && newPlaylist.items.length === 4 && newPlaylist.items[1].title === '剧集二' &&
        newPlaylist.items[2].title === '剧集二 · 第二部分',
        '合集内嵌多P仅在分P名前添加所属视频标题，并避免重复前缀');

    let renamedImport = await ctx.handleBg({
        target: 'bg', cmd: 'importCollection', bvid: 'BV1SEASON001', importTarget: 'new',
        name: '智能重命名合集', smartRename: true, renamePrefix: '周杰伦'
    }, null);
    const renamedPlaylist = ctx.__store.bpl_playlists.find(p => p.id === renamedImport.playlistId);
    ok(renamedImport.ok && renamedPlaylist && renamedPlaylist.items.length === 4 &&
        renamedPlaylist.items.every(item => item.title.indexOf('周杰伦 - ') === 0) &&
        renamedPlaylist.items.every(item => !Object.prototype.hasOwnProperty.call(item, 'originalTitle')),
        '智能重命名同时作用于新播放列表导入，且不保存原始标题');

    ctx = makeCtx({ fetchResponder: () => ({ code: 0, data: {
        bvid: 'BV1OKSEASON1', title: '含占位分P名的合集',
        ugc_season: { title: '含占位分P名的合集', sections: [{ episodes: [
            { bvid: 'BV1OKITEM001', title: '原视频一', pages: [
                { page: 1, cid: 501, duration: 10, part: '无法拒绝的条件 BGM ok' }
            ] },
            { bvid: 'BV1OKITEM002', title: '原视频二', pages: [
                { page: 1, cid: 502, duration: 11, part: '无法拒绝的条件 ok' }
            ] },
            { bvid: 'BV1OKITEM003', title: '原视频三', pages: [
                { page: 1, cid: 503, duration: 12, part: '猫没有主人ok' }
            ] },
            { bvid: 'BV1OKITEM004', title: '应回退的标题', pages: [
                { page: 1, cid: 504, duration: 13, part: 'ok' }
            ] }
        ] }] }
    }}) });
    ctx.__store.bpl_playlists = [{ id: 'okTarget', name: '占位测试', items: [] }];
    ctx.__store.bpl_active = 'okTarget';
    const okImport = await ctx.handleBg({
        target: 'bg', cmd: 'importCollection', bvid: 'BV1OKSEASON1', importTarget: 'current',
        targetPlaylistId: 'okTarget', smartRename: true
    }, null);
    const okItems = ctx.__store.bpl_playlists[0].items;
    ok(okImport.ok && okItems.map(item => item.title).join('|') ===
        '无法拒绝的条件|无法拒绝的条件|猫没有主人|应回退的标题' &&
        okItems.every(item => !Object.prototype.hasOwnProperty.call(item, 'renameTitle')),
        '真实合集映射链路使用临时标题上下文清理重复短后缀，且不把辅助字段写入播放列表 (' +
        okItems.map(item => item.title).join('|') + ')');

    ctx = makeCtx({ fetchResponder: () => ({ code: 0, data: {
        bvid: 'BV1PAGES0001', title: '多P视频', pic: 'http://img/pages.jpg', owner: { name: '作者' },
        pages: [{ page: 1, cid: 11, duration: 5, part: '多P视频' }, { page: 2, cid: 12, duration: 6, part: '第二P' }]
    }}) });
    ctx.__store.bpl_playlists = [{ id: 'p', name: 'P', items: [] }]; ctx.__store.bpl_active = 'p';
    summary = await ctx.handleBg({ cmd: 'getCollection', bvid: 'BV1PAGES0001' }, null);
    ok(summary.ok && summary.kind === 'pages' && summary.count === 2, '普通多P视频识别为 pages');
    let pageImport = await ctx.handleBg({ target: 'bg', cmd: 'importCollection', bvid: 'BV1PAGES0001', importTarget: 'current', targetPlaylistId: 'p' }, null);
    ok(pageImport.ok && ctx.__store.bpl_playlists[0].items.map(item => item.title).join(',') === '多P视频,第二P',
        '普通多P条目只使用分P名，不添加视频标题前缀');
    ctx = makeCtx({ fetchResponder: () => ({ code: 0, data: { bvid: 'BV1NONE00001', title: '普通视频', pages: [{ page: 1, cid: 1 }] } }) });
    let none = await ctx.handleBg({ cmd: 'getCollection', bvid: 'BV1NONE00001' }, null);
    ok(none.ok === false && none.notCollection === true && /不属于合集/.test(none.error) && ctx.__fetchCalls() === 1,
        '普通单视频返回可缓存的非合集结果，不显示合集入口');

    console.log('\n[background 新建播放列表点播路由 / 残缺条目修复]');
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
        'playIndex 自动携带活动播放列表 ID，不再按默认播放列表解释索引');

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

    console.log('\n[background 失效来源识别与用户触发修复]');
    ok(!ctx.canRematchSource({ bvid: 'BV1MANUAL001', title: '手动来源' }) &&
        ctx.canRematchSource({ bvid: 'BV1LEGACY001', chartSource: 'apple', sourceTitle: '旧热榜条目', matchState: 'matched' }) &&
        ctx.canRematchSource({ bvid: 'BV1BROKEN001', sourceUnavailable: true }),
        '正常手动来源不可换源，旧版自动匹配条目和确认失效来源可以重新匹配');
    ctx = makeCtx({ fetchResponder: url => {
        if (url.includes('/x/web-interface/view')) return {
            code: 0, data: { bvid: 'BV1NETWORK001', title: '仍然存在', pages: [{ page: 1, cid: 33 }] }
        };
        return { code: -352, message: '风控校验失败' };
    }});
    ctx.__store.bpl_playlists = [{ id: 'repair', name: '修复', items: [
        { id: 'network0', bvid: 'BV1NETWORK001', cid: 33, title: '网络失败不换源', pic: '', duration: 180, page: 1 }
    ] }];
    r = await ctx.handleResolveAudio({ bvid: 'BV1NETWORK001', cid: 33, page: 1, playlistId: 'repair', itemId: 'network0' });
    ok(r.ok === false && !r.sourceUnavailable && !ctx.__store.bpl_playlists[0].items[0].sourceUnavailable,
        '风控或临时取源失败不会把条目标记为永久失效');

    ctx = makeCtx({ fetchResponder: () => ({ code: -404, message: '啥都木有' }) });
    ctx.__store.bpl_playlists = [{ id: 'repair', name: '修复', items: [
        { id: 'dead0', bvid: 'BV1OLDDEAD01', cid: 44, title: '已经失效', pic: 'https://img/old.jpg', duration: 180, page: 1 }
    ] }];
    r = await ctx.handleResolveAudio({ bvid: 'BV1OLDDEAD01', cid: 44, page: 1, playlistId: 'repair', itemId: 'dead0' });
    ok(r.ok === false && r.sourceUnavailable === true && ctx.__store.bpl_playlists[0].items[0].sourceUnavailable === true,
        '明确的 -404 响应才持久化失效标记');

    ctx = makeCtx({ fetchResponder: url => {
        if (url.includes('/x/web-interface/view') && url.includes('BV1OLDDEAD01')) {
            return { code: -404, message: '原视频已删除' };
        }
        if (url.includes('/x/web-interface/search/type')) {
            return { code: 0, data: { result: [
                { bvid: 'BV1COVER0001', title: '<em>保留的播放列表标题</em>', author: '翻唱UP', typename: '翻唱', tag: 'COVER,翻唱', pic: '//img/cover.jpg', duration: '3:00', rank_index: 1, play: 100000 },
                { bvid: 'BV1REPLACE01', title: '<em>保留的播放列表标题</em> 完整版', author: '新UP', pic: '//img/new-search.jpg', duration: '3:01' },
                { bvid: 'BV1UNRELATED', title: '完全无关的视频', author: '其他', duration: '20:00' }
            ] } };
        }
        if (url.includes('/x/web-interface/view') && url.includes('BV1REPLACE01')) {
            return { code: 0, data: {
                bvid: 'BV1REPLACE01', title: '新视频原标题', pic: 'http://i0.hdslb.com/new.jpg',
                owner: { name: '新UP' }, pages: [{ page: 1, cid: 909, duration: 181, part: '新视频原标题' }]
            } };
        }
        return { code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/new.m4s', bandwidth: 1 }] } } };
    }});
    ctx.__store.bpl_playlists = [{ id: 'repair', name: '修复', items: [
        { id: 'dead0', bvid: 'BV1OLDDEAD01', cid: 44, title: '保留的播放列表标题', pic: 'https://img/old.jpg', duration: 180, page: 1, sourceUnavailable: true }
    ] }];
    ctx.__store.bpl_active = 'repair';
    r = await ctx.handleBg({ cmd: 'repairSource', playlistId: 'repair', itemId: 'dead0' }, null);
    const replaced = ctx.__store.bpl_playlists[0].items[0];
    ok(r.ok === true && r.replaced === true && replaced.bvid === 'BV1REPLACE01' && replaced.cid === 909 &&
        replaced.title === '保留的播放列表标题' && !replaced.sourceUnavailable,
        '用户触发后排除同名翻唱，完整验证替代视频并原子替换来源，同时保留播放列表标题');
    ok(ctx.__portSent.some(message => message.cmd === 'playIndex' && message.playlistId === 'repair'),
        '替代源写入成功后立即按新来源播放');
    ok(replaced.matchOrigin === 'repair' && replaced.matchTargetTitle === '保留的播放列表标题' &&
        replaced.matchHistory.join(',') === 'BV1OLDDEAD01,BV1REPLACE01',
        '失效源修复后保存固定匹配目标及条目级来源历史');

    ctx = makeCtx({ fetchResponder: url => {
        if (url.includes('/x/web-interface/search/type')) return { code: 0, data: { result: [
            { bvid: 'BV1MATCHOLD01', title: '周杰伦 晴天 官方MV', author: '旧账号', pic: '//img/old.jpg', duration: '4:29', rank_index: 1, play: 500000 },
            { bvid: 'BV1MATCHNEW01', title: '周杰伦《晴天》高音质', author: '新账号', pic: '//img/new.jpg', duration: '4:28', rank_index: 2, play: 300000 }
        ] } };
        if (url.includes('/x/web-interface/view') && url.includes('BV1MATCHNEW01')) return { code: 0, data: {
            bvid: 'BV1MATCHNEW01', title: 'B站新标题', pic: '//img/new.jpg', owner: { name: '新账号' },
            pages: [{ page: 1, cid: 707, duration: 268, part: 'B站新标题' }]
        } };
        return { code: 0, data: { dash: { audio: [{ baseUrl: 'https://cdn/rematched.m4s', bandwidth: 1 }] } } };
    }});
    ctx.__store.bpl_playlists = [{ id: 'chart-rematch', name: '热榜', chartSource: 'apple', items: [{
        id: 'chart0', bvid: 'BV1MATCHOLD01', cid: 101, title: '晴天 - 周杰伦', pic: '//img/old.jpg',
        owner: '旧账号', duration: 269, page: 1, chartSource: 'apple', chartId: 'chart', sourceRank: 1,
        sourceTitle: '晴天', sourceArtist: '周杰伦', matchState: 'matched', matchOrigin: 'chart',
        matchTargetTitle: '晴天', matchTargetArtist: '周杰伦', matchTargetDuration: 269,
        matchHistory: ['BV1MATCHOLD01']
    }] }];
    ctx.__store.bpl_active = 'chart-rematch';
    r = await ctx.handleBg({ cmd: 'rematchSource', playlistId: 'chart-rematch', itemId: 'chart0' }, null);
    const rematched = ctx.__store.bpl_playlists[0].items[0];
    ok(r.ok === true && rematched.bvid === 'BV1MATCHNEW01' && rematched.cid === 707 &&
        rematched.title === '晴天 - 周杰伦' && rematched.matchHistory.join(',') === 'BV1MATCHOLD01,BV1MATCHNEW01',
        '自动匹配条目可重新匹配，并排除当前来源、保留固定显示标题和完整来源历史');
    r = await ctx.handleBg({ cmd: 'rematchSource', playlistId: 'chart-rematch', itemId: 'chart0' }, null);
    ok(r.ok === false && /没有找到/.test(r.error) && ctx.__store.bpl_playlists[0].items[0].bvid === 'BV1MATCHNEW01',
        '来源历史中的全部 BVID 均被排除，无新候选时保留当前可用来源');

    console.log('\n[background 播放列表 JSON 完整备份恢复]');
    ctx = makeCtx();
    const backupItem = JSON.parse('{"id":"backup-item","bvid":"BV1BACKUP001","cid":321,"title":"完整备份条目",' +
        '"pic":"http://i0.hdslb.com/backup.jpg","owner":"原UP","duration":245,"page":2,' +
        '"matchOrigin":"repair","matchTargetTitle":"固定匹配目标","matchTargetArtist":"目标作者",' +
        '"matchTargetDuration":244,"matchTargetOwner":"原UP","matchHistory":["BV1OLDMATCH01","bad","BV1OLDMATCH01","BV1BACKUP001"],' +
        '"sourceUnavailable":true,"customData":{"enabled":true},"__proto__":{"polluted":true},"constructor":{"polluted":true}}');
    const placeholderItem = {
        id: 'backup-placeholder', bvid: '', cid: 0, title: '待匹配歌曲 - 歌手', pic: '', owner: '', duration: 0, page: 1,
        chartSource: 'apple', chartId: 'chart-id', sourceRank: 3, sourceTitle: '待匹配歌曲', sourceArtist: '歌手', matchState: 'pending'
    };
    r = await ctx.handleBg({
        cmd: 'importPlaylist', name: '恢复后的播放列表',
        playlist: JSON.parse('{"id":"backup-playlist","name":"备份名称","chartSource":"apple","customSettings":{"limit":25},"__proto__":{"polluted":true}}'),
        items: [backupItem, placeholderItem, { id: 'invalid', bvid: 'not-a-bvid', title: '无效条目' }]
    }, null);
    const restoredPlaylist = ctx.__store.bpl_playlists[0];
    const restoredItem = restoredPlaylist.items[0];
    const restoredPlaceholder = restoredPlaylist.items[1];
    ok(r.ok === true && r.count === 2 && restoredPlaylist.id !== 'backup-playlist' &&
        restoredPlaylist.name === '恢复后的播放列表' && restoredPlaylist.chartSource === 'apple' &&
        restoredPlaylist.customSettings.limit === 25,
        '恢复播放列表级元数据、过滤无效条目，并重新生成播放列表 ID');
    ok(restoredItem.id !== 'backup-item' && restoredItem.bvid === 'BV1BACKUP001' && restoredItem.cid === 321 &&
        restoredItem.pic === 'https://i0.hdslb.com/backup.jpg' && restoredItem.matchOrigin === 'repair' &&
        restoredItem.matchTargetTitle === '固定匹配目标' && restoredItem.matchTargetArtist === '目标作者' &&
        restoredItem.matchTargetDuration === 244 && restoredItem.matchTargetOwner === '原UP' &&
        restoredItem.customData.enabled === true,
        '完整恢复条目字段和固定匹配目标，同时重新生成条目 ID');
    ok(restoredItem.matchHistory.join(',') === 'BV1OLDMATCH01,BV1BACKUP001' &&
        !Object.prototype.hasOwnProperty.call(restoredItem, '__proto__') &&
        !Object.prototype.hasOwnProperty.call(restoredItem, 'constructor') && !({}).polluted,
        '匹配历史去重并过滤无效 BVID，危险对象键不会进入存储');
    ok(restoredPlaceholder.bvid === '' && restoredPlaceholder.matchState === 'pending' &&
        restoredPlaceholder.chartSource === 'apple' && restoredPlaceholder.sourceTitle === '待匹配歌曲',
        '未匹配的热榜占位条目可由完整 JSON 备份恢复');

    ctx = makeCtx();
    r = await ctx.handleBg({ cmd: 'importPlaylist', name: '旧版备份', items: [{
        id: 'legacy-id', bvid: 'BV1LEGACY001', cid: 11, title: '旧版条目', pic: '', owner: '', duration: 90, page: 1
    }] }, null);
    ok(r.ok === true && ctx.__store.bpl_playlists[0].items[0].bvid === 'BV1LEGACY001' &&
        ctx.__store.bpl_playlists[0].items[0].id !== 'legacy-id',
        '旧版仅含基础字段的 JSON 仍可导入并获得新的条目 ID');

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

    // 双通道均未 ACK/响应时，本条命令内重建一次；冷却闸阻止反复踩踏。
    ctx = makeCtx({ offscreenResponder: () => undefined, noAck: true });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(r.ok === false && /音频模块通信失败/.test(r.error), 'offscreen 无响应返回错误');
    ok(ctx.__off.closeCalls === 1, '单次调用内有界重建一次（closeCalls=' + ctx.__off.closeCalls + '）');

    // 业务错误（如播放列表为空）经 Port 原样返回、不重试
    ctx = makeCtx({ offscreenResponder: (msg) => ({ ok: false, error: '当前播放列表为空' }) });
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

    console.log('\n[background 有界通信（分级预算 / ACK / 去重 requestId / 自愈）]');
    ctx = makeCtx();
    ok(vm.runInContext('LONG_CMD_TIMEOUT_MS', ctx) === 110000 && vm.runInContext('FAST_CMD_TIMEOUT_MS', ctx) === 7000,
        '播放取源与快速控制使用不同响应预算');

    // 未 ACK 的 Port 主动断开；sendMessage 复用同一 requestId，offscreen 可据此去重。
    ctx = makeCtx({ noAck: true, offscreenResponder: msg => msg.target === 'offscreen' ? { ok: true, echoed: msg.cmd } : undefined });
    r = await ctx.sendToOffscreen({ cmd: 'toggle' });
    const portReq = ctx.__portSent.find(m => m.cmd === 'toggle');
    const msgReq = ctx.__msgSent.find(m => m.target === 'offscreen' && m.cmd === 'toggle');
    ok(r.ok === true && ctx.__off.disconnectCalls === 1, '未 ACK 的陈旧 Port 立即断开并由消息通道恢复');
    ok(portReq && msgReq && portReq._requestId === msgReq._requestId, '双通道复用稳定 requestId，避免重复执行');

    // 收到 ACK 后允许慢命令完成，不走第二通道。该真实延迟覆盖现场 4.73s 冷启动。
    ctx = makeCtx({ realTimers: true, offscreenResponder: msg => new Promise(resolve => setTimeout(() => resolve({ ok: true, echoed: msg.cmd }), 4730)) });
    const slowStarted = Date.now();
    r = await ctx.sendToOffscreen({ cmd: 'playIndex' });
    ok(r.ok === true && Date.now() - slowStarted >= 4700 && !ctx.__msgSent.some(m => m.target === 'offscreen'),
        'Port ACK 后 4.73s 慢响应成功且不跨通道重发');

    // 持续僵死时 10s 冷却窗内至多重建一次。
    ctx = makeCtx({ offscreenResponder: () => undefined, noAck: true });
    for (let k = 0; k < 3; k++) await ctx.sendToOffscreen({ cmd: 'toggle' });
    ok(ctx.__off.closeCalls === 1 && ctx.__off.createCalls === 2,
        '连续无响应仅重建一次（冷却闸防踩踏，closeCalls=' + ctx.__off.closeCalls + '）');

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
