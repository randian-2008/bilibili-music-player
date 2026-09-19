const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const testPath = path.join(__dirname, 'test-background.js');
const harness = { require: createRequire(testPath), __dirname, console, setImmediate, clearImmediate, setTimeout, clearTimeout, Buffer };
vm.createContext(harness);
vm.runInContext(fs.readFileSync(testPath, 'utf8').split('(async () => {')[0], harness);
const makeCtx = harness.makeCtx;
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; console.log('  PASS: ' + label); }
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function seed() {
    const ctx = makeCtx();
    ctx.__store.bpl_playlists = [
        { id: 'A', name: 'A', items: [{ id: 'a1', bvid: 'BV1TEST00001', cid: 1, title: 'Alpha' }, { id: 'a2', bvid: 'BV1TEST00002', cid: 2, title: 'Beta' }] },
        { id: 'B', name: 'B', items: [{ id: 'b1', bvid: 'BV1TEST00003', cid: 3, title: 'Gamma' }] }
    ];
    ctx.__store.bpl_active = 'A';
    return ctx;
}
async function manualRenameRace(oldFails) {
    const ctx = makeCtx({ realTimers: true });
    ctx.__store.bpl_playlists = [{ id: 'A', name: 'A', items: [] }];
    ctx.__store.bpl_active = 'A';
    const searches = [];
    // Defer the network boundary while running the real command, mutation, identity and task-map logic.
    ctx.searchBiliChartItem = snapshot => new Promise((resolve, reject) => {
        searches.push({ title: snapshot.matchTargetTitle, revision: snapshot.matchRevision || 0, resolve, reject });
    });
    ctx.resolveCid = async () => ({ cid: 99, page: { page: 1, cid: 99 } });
    ctx.getAudioUrls = async () => ['https://media.example/audio.m4s'];
    ctx.verifyCandidateMedia = async () => ({ ok: true });
    const added = await ctx.handleBg({ cmd: 'addManualItem', playlistId: 'A', title: 'Query A' });
    const command = { cmd: 'matchManualItem', playlistId: 'A', itemId: added.itemId };
    const old = ctx.handleBg(command);
    await flush();
    assert.equal(searches.length, 1, 'Original manual search reached the deferred boundary');
    await ctx.handleBg({ cmd: 'renameItem', playlistId: 'A', itemId: added.itemId, title: 'Query B' });
    await ctx.handleBg({ cmd: 'renameItem', playlistId: 'A', itemId: added.itemId, title: 'Query A' });
    const current = ctx.handleBg(command);
    await flush();
    assert.equal(searches.length, 2, 'Renaming detaches the old task and permits the new search');
    const label = oldFails ? '旧失败' : '旧成功';
    check(searches[0].title === searches[1].title && searches[0].revision === 0 && searches[1].revision === 2,
        label + '场景：A→B→A 仍拥有不同的匹配修订号');
    const beforeOldResult = JSON.stringify(ctx.__store.bpl_playlists[0].items[0]);
    if (oldFails) {
        const error = new Error('Old search returned HTTP 412');
        error.status = 412;
        searches[0].reject(error);
    } else searches[0].resolve({ bvid: 'BV1MATCHOLD01', title: 'Old source', duration: '3:00' });
    const oldResult = await old;
    await flush();
    check(!oldResult.ok && JSON.stringify(ctx.__store.bpl_playlists[0].items[0]) === beforeOldResult,
        label + '结果不会覆盖新任务的 matching 状态、错误、时间戳或来源');
    const repeated = ctx.handleBg(command);
    await flush();
    check(searches.length === 2 && ctx.__store.bpl_playlists[0].items[0].matchAttempts === 1,
        label + ' task.finally 不会清除新任务；第三次点击复用新搜索');
    searches[1].resolve({ bvid: 'BV1MATCHNEW01', title: 'New source', duration: '3:01' });
    const results = await Promise.all([current, repeated]);
    const item = ctx.__store.bpl_playlists[0].items[0];
    check(results.every(result => result.ok && result.bvid === 'BV1MATCHNEW01') &&
        item.matchState === 'matched' && item.bvid === 'BV1MATCHNEW01' && item.title === 'Query A' &&
        item.matchHistory.join(',') === 'BV1MATCHNEW01' && !item.matchError,
        label + '任务结束后只有最新匹配能写入来源和历史');
}
(async () => {
    console.log('[data 稳定条目身份与任务恢复]');
    let ctx = seed();
    await ctx.handleBg({ cmd: 'setActive', id: 'B' });
    await ctx.handleBg({ cmd: 'renameItem', playlistId: 'A', itemId: 'a1', title: 'Renamed' });
    check(ctx.__store.bpl_playlists[0].items[0].title === 'Renamed' && ctx.__store.bpl_playlists[1].items[0].title === 'Gamma', '切换活动列表后重命名仍指向原条目');
    let result = await ctx.handleBg({ cmd: 'batchMove', playlistId: 'B', itemIds: ['b1'], toId: 'B' });
    check(!result.ok && ctx.__store.bpl_playlists[1].items.length === 1, '同列表移动被拒绝，内容不丢失');
    result = await ctx.handleBg({ cmd: 'batchRemove', indices: [0] });
    check(!result.ok && ctx.__store.bpl_playlists[1].items.length === 1, '旧界面无身份的删除请求失败关闭');
    await ctx.handleBg({ cmd: 'moveItem', playlistId: 'A', itemId: 'a1', beforeItemId: null });
    check(ctx.__store.bpl_playlists[0].items.map(item => item.id).join() === 'a2,a1', '按条目 ID 拖到列表末尾时追加');
    result = await ctx.handleBg({ cmd: 'moveItem', playlistId: 'A', itemId: 'a1', beforeItemId: 'deleted' });
    check(!result.ok && ctx.__store.bpl_playlists[0].items.map(item => item.id).join() === 'a2,a1', '拖拽目标已删除时不改变顺序');
    ctx.__store.bpl_playlists[0].items.reverse();
    await ctx.handleBg({ cmd: 'remove', playlistId: 'A', itemId: 'a1' });
    check(ctx.__store.bpl_playlists[0].items.map(item => item.id).join() === 'a2', '异步重排后仍删除指定 ID');
    await ctx.handleBg({ cmd: 'clear', playlistId: 'A' });
    check(ctx.__store.bpl_playlists[0].items.length === 0 && ctx.__store.bpl_playlists[1].items.length === 1, '清空指定列表不受全局活动列表影响');

    result = await ctx.handleBg({ cmd: 'addManualItem', playlistId: 'A', title: 'old query' });
    const itemId = result.itemId;
    await ctx.handleBg({ cmd: 'renameItem', playlistId: 'A', itemId, title: 'new query' });
    let item = ctx.__store.bpl_playlists[0].items[0];
    check(item.title === 'new query' && item.matchTargetTitle === 'new query' && item.matchState === 'pending', '无源手动条目改名同步搜索目标');
    item.bvid = 'BV1TEST00004'; item.matchState = 'matched';
    await ctx.handleBg({ cmd: 'renameItem', playlistId: 'A', itemId, title: 'display only' });
    check(ctx.__store.bpl_playlists[0].items[0].matchTargetTitle === 'new query', '已有来源的显示重命名不改变匹配目标');
    result = await ctx.handleBg({ cmd: 'addManualItem', playlistId: 'deleted', title: 'x' });
    check(!result.ok && ctx.__store.bpl_playlists[1].items.length === 1, '目标已删除时不把条目加入其他列表');

    await manualRenameRace(false);
    await manualRenameRace(true);

    const pending = { title: 'Pending', bvid: '', matchOrigin: 'manual', matchTargetTitle: 'Pending', matchState: 'matching', matchStartedAt: 1 };
    const restored = ctx.restorePlaylistItem(pending);
    check(restored.matchState === 'pending' && !restored.matchStartedAt, '恢复 JSON 不带入失效的进行中任务');
    ctx.__store.bpl_playlists[0].items = [Object.assign({ id: 'waiting' }, pending)];
    await ctx.handleBg({ cmd: 'recoverMatchTasks' });
    check(ctx.__store.bpl_playlists[0].items[0].matchState === 'pending', '后台重启后回收孤立的匹配中状态');
    ctx.__store.bpl_playlists[0].items[0].matchState = 'matching';
    vm.runInContext("chartMatchInflight.set('A:waiting', Promise.resolve({ok:true}))", ctx);
    await ctx.handleBg({ cmd: 'recoverMatchTasks' });
    check(ctx.__store.bpl_playlists[0].items[0].matchState === 'matching', '回收不干扰仍有活动任务的条目');
    await ctx.handleBg({ cmd: 'batchCopy', playlistId: 'A', itemIds: ['waiting'], toId: 'B' });
    check(ctx.__store.bpl_playlists[1].items[1].matchState === 'pending', '复制进行中条目不会复制失效任务');

    console.log('[data 热榜导入幂等与慢网络]');
    ctx = seed();
    let release, fetches = 0;
    ctx.BPLChartApple.fetchChart = () => { fetches++; return new Promise(resolve => { release = resolve; }); };
    const request = { cmd: 'importChart', sourceId: 'apple', chartId: 'daily', requestId: 'chart-audit-request-123', name: 'Daily' };
    const first = ctx.handleBg(request);
    await flush();
    const retry = ctx.handleBg(request);
    await flush();
    check(fetches === 1, '超时重试复用同一个后台导入请求');
    release({ sourceId: 'apple', sourceName: 'Apple', chartId: 'daily', chartName: 'Daily', items: [{ title: 'Song', artist: 'Singer', rank: 1 }] });
    const results = await Promise.all([first, retry]);
    check(results.every(r => r.ok) && results[0].playlistId === results[1].playlistId && ctx.__store.bpl_playlists.length === 3, '迟到响应和重试只创建一份列表');
    await ctx.handleBg(request);
    check(fetches === 1 && ctx.__store.bpl_playlists.length === 3, '已完成请求再次确认不会新增列表或重新联网');
    const restarted = makeCtx();
    Object.assign(restarted.__store, JSON.parse(JSON.stringify(ctx.__store)));
    const repeated = await restarted.handleBg(request);
    check(repeated.ok && restarted.__store.bpl_playlists.length === 3 && restarted.__fetchCalls() === 0, '后台重启后仍能识别已持久化的导入结果');

    ctx = seed();
    let resolveBuild;
    ctx.buildItem = () => new Promise(resolve => { resolveBuild = resolve; });
    const adding = ctx.handleBg({ cmd: 'add', playlistId: 'A', bvid: 'BV1TEST00009' });
    await flush();
    let switched = false;
    const switching = ctx.handleBg({ cmd: 'setActive', id: 'B' }).then(() => { switched = true; });
    await flush();
    check(switched, '慢速读取视频元数据不持有列表写入锁');
    resolveBuild({ bvid: 'BV1TEST00009', cid: 9, title: 'New' });
    await Promise.all([adding, switching]);
    check(ctx.__store.bpl_playlists[0].items.length === 3 && ctx.__store.bpl_playlists[1].items.length === 1, '网络完成后仍提交到操作开始时的目标');
    console.log('通过: ' + checks + '  失败: 0');
})().catch(error => { console.error(error); process.exitCode = 1; });
