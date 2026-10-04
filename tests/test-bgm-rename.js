const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const harness = fs.readFileSync(path.join(__dirname, 'test-background.js'), 'utf8');
const { makeCtx } = new Function('require', '__dirname',
    harness.slice(0, harness.indexOf('\n(async () =>')) + '\nreturn { makeCtx };')(require, __dirname);
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; console.log('  PASS: ' + label); }
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const tag = name => ({ tag_type: 'bgm', tag_name: '发现《' + name + '》', music_id: 'MA-test' });
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data,
    text: async () => JSON.stringify(data), headers: { get: () => null } });
const entries = [
    { bvid: 'BV1tbFrzyEbC', cid: 35858154441, title: '《画离弦》等什么君 | 怎将情话递心间', name: '画离弦' },
    { bvid: 'BV1t1yuBUEyw', cid: 34148254068, title: '那一别你眉轻抚 -C.D/Cathy月月 | Hi-Res无损音质', name: '' },
    { bvid: 'BV1VUSzBoEoy', cid: 34405744712, title: '游山恋 -崔天琪&韩晴 | Hi-Res无损音质', name: '游山恋' },
    { bvid: 'BV1iXSnB3EE6', cid: 34433598540, title: '西楼别序 -赵兮月 | Hi-Res无损音质', name: '西楼别序' }
];
function fixture(options = {}) {
    const ctx = makeCtx(options);
    ctx.AbortController = AbortController;
    const calls = [];
    ctx.fetch = async (url, init) => {
        calls.push({ url, init });
        if (url.includes('/rename/rules.json')) return response({});
        if (url.includes('/view/detail/tag')) {
            const entry = entries.find(item => String(item.cid) === new URL(url).searchParams.get('cid'));
            return response({ code: 0, data: entry && entry.name ? [tag(entry.name)] :
                [{ tag_type: 'old_channel', tag_name: '那一别你眉轻抚', music_id: '' }] });
        }
        return response({ code: 0, data: { title: '合集', ugc_season: { title: '合集', sections: [{
            episodes: entries.map(item => ({ bvid: item.bvid, title: item.title,
                pages: [{ cid: item.cid, page: 1, part: item.title }] }))
        }] } } });
    };
    return { ctx, calls };
}
const importRequest = { cmd: 'importCollection', bvid: 'BV1tbFrzyEbC', importTarget: 'new', smartRename: true };

(async () => {
    console.log('[BGM 重命名真实导入链路]');
    let { ctx, calls } = fixture();
    const source = await ctx.loadCollection(importRequest.bvid);
    const snapshot = JSON.stringify(source);
    const baseline = await ctx.BPLRenamer.renameItems(source.items.map(item => ({ ...item, title: item.renameTitle })), { rules: {} });
    const imported = await ctx.handleBg({ ...importRequest, renamePrefix: '前缀' });
    const saved = ctx.__store.bpl_playlists.find(pl => pl.id === imported.playlistId).items;
    check(imported.ok && saved.every((item, index) => item.title === '前缀 - ' + (entries[index].name || baseline[index].title)),
        '实际导入处理器优先采用有原标题证据的音乐标签，缺失时沿用本地结果');
    const tagCalls = () => calls.filter(call => call.url.includes('/view/detail/tag'));
    check(tagCalls().length === 4 && tagCalls().every(call => call.init.credentials === 'omit' &&
        !call.init.headers && new URL(call.url).searchParams.has('cid')), '仅按 BVID + CID 匿名查询，无 Cookie 或账户依赖');
    check(JSON.stringify(source) === snapshot && saved.every(item =>
        !['renameTitle', 'renameSources', 'renamePreferredTitle', 'bgmTags', 'originalTitle'].some(key => key in item)),
        '共享合集缓存保持不变，临时名称证据和音乐标签不写入播放列表');
    await ctx.handleBg(importRequest);
    check(tagCalls().length === 4, '重复导入复用短期标签缓存，包括成功返回但没有音乐标签的条目');

    ({ ctx, calls } = fixture());
    await ctx.handleBg({ ...importRequest, smartRename: false });
    check(!calls.some(call => call.url.includes('/view/detail/tag')), '未勾选智能重命名时不查询音乐标签');

    ({ ctx } = fixture());
    ctx.fetch = async url => {
        if (url.includes('/rename/rules.json')) return response({});
        if (url.includes('/view/detail/tag')) return response({ code: 0,
            data: [tag(new URL(url).searchParams.get('cid') === '101' ? '甲曲' : '乙曲')] });
        return response({ code: 0, data: { bvid: 'BV1PART00001', title: '《甲曲》与《乙曲》', pages: [
            { cid: 101, page: 1, part: '甲曲 - 作者甲' }, { cid: 102, page: 2, part: '乙曲 - 作者乙' }
        ] } });
    };
    const partsImport = await ctx.handleBg({ ...importRequest, bvid: 'BV1PART00001' });
    check(ctx.__store.bpl_playlists.find(pl => pl.id === partsImport.playlistId).items.map(item => item.title).join('|') === '甲曲|乙曲',
        '同一 BVID 的不同分P独立查询和匹配，不串用第一P的音乐标签');

    console.log('\n[BGM 查询的异常与异步边界]');
    const many = Array.from({ length: 20 }, (_, index) => ({ bvid: 'BV1PART00001', cid: index + 1, title: '测试' }));
    ({ ctx } = fixture());
    const waiting = [];
    ctx.fetch = (url, init) => new Promise(resolve => waiting.push({ resolve, signal: init.signal }));
    const timedOut = await ctx.loadCollectionBgmTags(many);
    check(waiting.length === 3 && timedOut.every(tags => tags.length === 0) && waiting.every(call => call.signal.aborted),
        '超时取消请求且停止后续查询，并发不超过三条，全部可回退本地');
    const timeoutSnapshot = JSON.stringify(timedOut);
    waiting.forEach(call => call.resolve(response({ code: 0, data: [tag('迟到曲名')] })));
    await flush();
    check(JSON.stringify(timedOut) === timeoutSnapshot && vm.runInContext('bgmTagCache.size', ctx) === 0,
        '超时后的迟到响应不能改写已返回结果或污染缓存');

    for (const failure of ['412', 'offline', 'api-error', 'malformed']) {
        ({ ctx } = fixture());
        let count = 0;
        ctx.fetch = async () => {
            count++;
            if (count === 1) return response({ code: 0, data: [tag('已确认曲名')] });
            if (failure === '412') return response({}, 412);
            if (failure === 'offline') throw new TypeError('Failed to fetch');
            return response(failure === 'api-error' ? { code: -403, message: 'forbidden' } : { code: 0, data: {} });
        };
        const result = await ctx.loadCollectionBgmTags(many);
        check(count <= 4 && result[0][0].tag_name === '发现《已确认曲名》' && result.slice(1).every(tags => tags.length === 0),
            '保留已完成查询并停止异常批次，不重试轰炸接口：' + failure);
    }

    ({ ctx } = fixture());
    let now = 1000, started = 0;
    ctx.Date = class extends Date { static now() { return now; } };
    ctx.fetch = async () => { started++; now += 1000; return response({ code: 0, data: [] }); };
    const bounded = await ctx.loadCollectionBgmTags(many);
    check(started < many.length && bounded.length === many.length, '达到整批时间预算后停止新增请求，余下条目仍保留');

    ({ ctx } = fixture({ realTimers: true }));
    ctx.__store.bpl_playlists = [{ id: 'target', name: '目标', items: [] }, { id: 'other', name: '其他列表', items: [] }];
    ctx.__store.bpl_active = 'target';
    const fetchNormally = ctx.fetch;
    const deferred = [];
    ctx.fetch = (url, init) => url.includes('/view/detail/tag')
        ? new Promise(resolve => deferred.push(resolve)) : fetchNormally(url, init);
    const pendingImport = ctx.handleBg({ ...importRequest, importTarget: 'current', targetPlaylistId: 'target' });
    await flush();
    let released = false;
    await Promise.race([
        ctx.withPlaylistMutation(async () => { ctx.__store.bpl_playlists = ctx.__store.bpl_playlists.filter(pl => pl.id !== 'target'); released = true; }),
        new Promise(resolve => setTimeout(resolve, 50))
    ]);
    // A failure stops the queued fourth lookup; successful results could start it.
    deferred.forEach(resolve => resolve(response({}, 412)));
    const disappeared = await pendingImport;
    check(released && !disappeared.ok && ctx.__store.bpl_playlists.length === 1 &&
        ctx.__store.bpl_playlists[0].id === 'other' && ctx.__store.bpl_playlists[0].items.length === 0,
        '查询不占用列表写入锁；等待期间目标被删除时不会误写其他列表或重建目标');

    console.log('\n通过: ' + checks + '  失败: 0');
})().catch(error => { console.error(error); process.exitCode = 1; });
