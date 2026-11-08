const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'test-offscreen.js'), 'utf8');
const { makeCtx, setupPlaylist } = new Function('require', '__dirname',
    source.slice(0, source.indexOf('\nasync function testPlayIndex()')) +
    '\nreturn { makeCtx, setupPlaylist };')(require, __dirname);

function fixture(count, mode = 'shuffle', options = {}) {
    const store = setupPlaylist(count);
    store.bpl_state.mode = mode;
    store.bpl_playlists[0].items.forEach(item => { item.duration = 180; });
    const player = makeCtx({ ...options, store });
    player.Math = Object.create(Math);
    let randomValue = 0, draws = 0;
    player.Math.random = () => { draws++; return randomValue; };
    return { player, store, random: value => { randomValue = value; }, draws: () => draws };
}
const current = f => f.store.bpl_state.trackId;
const emit = (f, type) => (f.player.__audio.ls[type] || []).slice().forEach(listener => listener());
const round = f => JSON.parse(vm.runInContext(
    'JSON.stringify([...shuffleRounds].map(([id, r]) => ({id, played: [...r.played], listened: [...r.listened], history: r.history})))', f.player));
async function until(condition) {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
    assert(condition(), 'asynchronous playback completed');
}
async function play(f, index, playlistId = 'pl1') {
    assert.equal((await f.player.pPlayIndex(index, false, null, playlistId)).ok, true);
    f.player.__listen(30);
}
async function next(f) {
    const result = await f.player.pNext();
    assert.equal(result.ok, true, result.error);
    f.player.__listen(30);
    return current(f);
}
async function prev(f) {
    await f.player.handleCmd({ cmd: 'seek', value: 0 });
    const result = await f.player.pPrev();
    assert.equal(result.ok, true, result.error);
    return current(f);
}

(async () => {
    let f = fixture(5);
    await f.player.pPlayIndex(0);
    assert.deepEqual(round(f)[0].played, []);
    assert.deepEqual(round(f)[0].history, ['id:item0']);
    f.player.__listen(29.5);
    assert.deepEqual(round(f)[0].played, [], '29.5 秒仍保留在未播放池');
    f.player.__listen(0.5);
    assert.deepEqual(round(f)[0].played, ['id:item0'], '满 30 秒才移出未播放池');
    assert.equal(round(f)[0].listened[0][1], 30000);
    console.log('PASS: successful starts enter history immediately but exactly thirty listening seconds consume the item');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    for (let i = 0; i < 12; i++) {
        await f.player.pNext();
        assert.equal(current(f), 'item1', '刚离开的条目未达门槛仍可立即再次被随机选中');
        f.player.__listen(0.5);
        await f.player.pPrev();
        assert.equal(current(f), 'item0', '上一首固定回到实际的播放历史');
        f.player.__listen(0.5);
    }
    assert.deepEqual(round(f)[0].played, [], '快速交替点击不会按起播次数耗尽本轮');
    assert.equal(f.store.bpl_state.playing, true);
    f.player.__listen(24);
    assert.deepEqual(round(f)[0].played, ['id:item0'], '分段收听在同一轮累计到 30 秒');
    f.random(0.999);
    await f.player.pNext();
    assert.equal(current(f), 'item2', '下一首仍重新抽选而非固定沿历史前进');
    await f.player.pPrev();
    assert.equal(current(f), 'item0');
    console.log('PASS: rapid next/previous clicks retain the pool, accumulate actual time and keep previous deterministic');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    f.player.__listen(12);
    await f.player.pToggle();
    f.player.__listen(60);
    assert.equal(round(f)[0].listened[0][1], 12000, '暂停时间不累计');
    await f.player.pToggle();
    f.player.__listen(5);
    f.player.__audio.readyState = 2;
    emit(f, 'waiting');
    f.player.__listen(60);
    assert.equal(round(f)[0].listened[0][1], 17000, '缓冲等待时间不累计');
    f.player.__audio.readyState = 4;
    emit(f, 'playing');
    f.player.__elapse(60000);
    emit(f, 'timeupdate');
    assert.equal(round(f)[0].listened[0][1], 17000, '进度不前进时不能仅按墙钟时间记为已播放');
    f.player.__listen(13);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    console.log('PASS: pause, buffering and stalled progress do not count as listening');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    f.player.__listen(5);
    await f.player.handleCmd({ cmd: 'seek', value: 90 });
    emit(f, 'timeupdate');
    assert.equal(round(f)[0].listened[0][1], 5000, '拖到 90 秒不等于已收听 90 秒');
    f.player.__listen(5);
    f.player.__audio.seeking = true;
    f.player.__audio.currentTime = 150;
    emit(f, 'seeking');
    f.player.__listen(10);
    f.player.__audio.seeking = false;
    emit(f, 'seeked');
    f.player.__listen(20);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    assert.equal(round(f)[0].listened[0][1], 30000);
    console.log('PASS: panel and native seeks change progress without inflating actual listening');

    f = fixture(2);
    await f.player.pPlayIndex(0);
    f.player.__audio.playbackRate = 2;
    emit(f, 'ratechange');
    f.player.__listen(15);
    assert.equal(f.player.__audio.currentTime, 30);
    assert.deepEqual(round(f)[0].played, [], '倍速跳过 30 秒内容但实际只听 15 秒时仍未达门槛');
    f.player.__audio.playbackRate = 0.5;
    emit(f, 'ratechange');
    f.player.__listen(15);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    console.log('PASS: playback speed changes preserve the real-time thirty-second threshold');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    await f.player.pNext();
    f.player.__listen(3);
    await f.player.pPrev();
    assert.equal(current(f), 'item0', '正好 3 秒仍返回上一首');
    await f.player.pNext();
    f.player.__listen(3.1);
    await f.player.pPrev();
    assert.equal(current(f), 'item1', '超过 3 秒先回当前条目的开头');
    assert.equal(f.player.__audio.currentTime, 0);
    await f.player.pPrev();
    assert.equal(current(f), 'item0', '再次点击固定回到上一首');
    assert.deepEqual(round(f)[0].played, []);
    console.log('PASS: the previous button retains its exact three-second restart boundary');

    f = fixture(2, 'shuffleLoop');
    await f.player.pPlayIndex(0);
    f.player.__listen(30);
    await f.player.pNext();
    f.player.__listen(30);
    await f.player.pNext();
    assert.deepEqual(round(f)[0].played, [], '新一轮不会继承上一轮的达标记录');
    assert.deepEqual(round(f)[0].listened, []);
    f.player.__listen(29);
    assert.deepEqual(round(f)[0].played, []);
    f.player.__listen(1);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    console.log('PASS: each new round resets accumulated listening time');

    f = fixture(1);
    await f.player.pPlayIndex(0);
    f.player.__listen(10);
    emit(f, 'ended');
    await until(() => f.player.__audio.playCalls === 2 &&
        vm.runInContext('shuffleListening !== null', f.player));
    assert.deepEqual(round(f)[0].played, [], '不足 30 秒的短音频自然结束不绕过门槛');
    f.player.__listen(20);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    console.log('PASS: short audio also follows cumulative thirty-second listening without an early-end exception');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    f.player.__listen(29);
    f.player.__elapse(1000);
    f.player.__audio.currentTime += 1;
    await f.player.pNext();
    assert.deepEqual(round(f)[0].played, ['id:item0'], '切歌前补记最后不足一个采样周期的播放时间');
    console.log('PASS: navigation flushes the last unreported playback interval before drawing');

    let finishLoading;
    f = fixture(3, 'shuffle', { resolveAudioResponder: payload => payload.bvid === 'BV1' && !finishLoading
        ? new Promise(resolve => { finishLoading = resolve; })
        : { ok: true, urls: ['https://cdn/audio.m4s'] } });
    await f.player.pPlayIndex(0);
    f.player.__listen(25);
    const loading = f.player.pNext();
    for (let i = 0; i < 100 && !finishLoading; i++) await Promise.resolve();
    assert(finishLoading);
    f.player.__listen(5);
    assert.deepEqual(round(f)[0].played, ['id:item0'], '后台取新音源时仍在播的旧曲累计到旧条目');
    finishLoading({ ok: true, urls: ['https://cdn/new'] });
    assert.equal((await loading).ok, true);
    assert.equal(current(f), 'item1');
    assert(!round(f)[0].listened.some(([id]) => id === 'id:item1'), '加载等待不能算作新条目的收听时长');
    f.player.__listen(30);
    assert.deepEqual(round(f)[0].played, ['id:item0', 'id:item1']);
    console.log('PASS: source resolution credits still-playing old audio but not the pending new track');

    f = fixture(3);
    await f.player.pPlayIndex(0);
    f.player.__listen(15);
    f.player.__audio.error = { code: 2, message: 'network interrupted' };
    emit(f, 'error');
    await until(() => f.player.__resolveAudioCalls() >= 2 && f.player.__audio.playCalls >= 2 &&
        vm.runInContext('shuffleListening !== null && !recoveryRunning', f.player));
    assert.equal(f.player.__audio.currentTime, 15);
    assert.equal(round(f)[0].listened[0][1], 15000);
    f.player.__listen(15);
    assert.deepEqual(round(f)[0].played, ['id:item0']);
    assert.deepEqual(round(f)[0].history, ['id:item0'], '自恢复不会添加重复的上一首历史');
    console.log('PASS: automatic source recovery preserves partial listening without counting its seek or loading time');

    f = fixture(2);
    f.store.bpl_playlists.push({ id: 'other', mode: 'shuffle', items: [
        { id: 'other0', bvid: 'BVOTHER0', cid: 10 }
    ] });
    await f.player.pPlayIndex(0);
    f.player.__listen(15);
    await f.player.pPlayIndex(0, false, null, 'other');
    f.player.__listen(30);
    await f.player.pPlayIndex(0, false, null, 'pl1');
    assert.deepEqual(round(f).find(r => r.id === 'pl1').played, []);
    f.player.__listen(15);
    assert.deepEqual(round(f).find(r => r.id === 'pl1').played, ['id:item0']);
    assert.deepEqual(round(f).find(r => r.id === 'other').played, ['id:other0']);
    console.log('PASS: switching playlists keeps independent partial listening totals');

    f = fixture(5);
    await play(f, 0);
    const firstNext = await next(f);
    assert.equal(await prev(f), 'item0');
    const secondNext = await next(f);
    assert(!['item0', firstNext].includes(secondNext), '上一曲后再点下一曲，不回到本轮已经播放的条目');
    console.log('PASS: previous followed by next draws a new unplayed item');

    f = fixture(5);
    await play(f, 0);
    assert.equal(f.draws(), 0, '点播不预排后续随机队列');
    f.random(0.999);
    assert.equal(await next(f), 'item4');
    f.random(0);
    assert.equal(await next(f), 'item1');
    assert.equal(f.draws(), 2, '每次下一曲才从剩余候选中抽取一次');
    await prev(f);
    f.random(0.999);
    assert.equal(await next(f), 'item3');
    assert.equal(await next(f), 'item2');
    await prev(f);
    await next(f);
    assert.equal(f.store.bpl_state.playing, false, '回退历史不增加未播放候选，普通随机一轮结束即停止');
    console.log('PASS: each next uses fresh randomness and history cannot reopen an exhausted round');

    f = fixture(4, 'shuffleLoop');
    await play(f, 0);
    const firstRound = ['item0'];
    for (let i = 0; i < 3; i++) firstRound.push(await next(f));
    assert.equal(new Set(firstRound).size, 4);
    const secondRound = [];
    for (let i = 0; i < 4; i++) secondRound.push(await next(f));
    assert.equal(new Set(secondRound).size, 4, '随机循环的新一轮也不重复');
    assert.notEqual(secondRound[0], firstRound.at(-1), '换轮时有其他候选则不紧接着重复末曲');
    console.log('PASS: shuffle loop draws complete nonrepeating rounds without boundary repeats');

    for (const mode of ['shuffle', 'shuffleLoop']) {
        f = fixture(1, mode);
        await play(f, 0);
        await prev(f);
        await next(f);
        assert.equal(f.store.bpl_state.playing, mode === 'shuffleLoop');
    }
    console.log('PASS: single-item shuffle stops while single-item shuffle loop can repeat');

    f = fixture(4);
    await play(f, 0);
    assert.equal(await next(f), 'item1');
    f.store.bpl_playlists[0].items.reverse();
    f.store.bpl_playlists[0].items.find(item => item.id === 'item1').title = '新标题';
    assert.equal(await prev(f), 'item0', '排序和改名后仍按稳定身份回退');
    assert.equal(await next(f), 'item3', '排序不重置已播放集合');
    f.store.bpl_playlists[0].items = f.store.bpl_playlists[0].items.filter(item => item.id !== 'item2');
    f.store.bpl_playlists[0].items.push({ id: 'new', bvid: 'BVNEW', cid: 5, title: '新条目' });
    assert.equal(await next(f), 'new', '新增条目加入候选，删除条目不再抽取');
    await next(f);
    assert.equal(f.store.bpl_state.playing, false);
    console.log('PASS: reorder, rename, additions and removals preserve the current round by item ID');

    f = fixture(4);
    await play(f, 0);
    await next(f);
    await play(f, 2);
    assert.equal(await next(f), 'item3', '手动点播也计入当前轮，不重置已播集合');
    console.log('PASS: manual selection joins the same round');

    f = fixture(4);
    f.store.bpl_playlists.push({ id: 'other', mode: 'shuffle', items: [
        { id: 'other0', bvid: 'BVOTHER0', cid: 10 }, { id: 'other1', bvid: 'BVOTHER1', cid: 11 }
    ] });
    await play(f, 0);
    assert.equal(await next(f), 'item1');
    await play(f, 0, 'other');
    assert.equal(await next(f), 'other1');
    await play(f, 0);
    assert.equal(await next(f), 'item2', '切回列表继续该列表自己的未播放集合');
    console.log('PASS: playlists maintain independent shuffle rounds');

    let fail = true;
    f = fixture(3, 'shuffle', { resolveAudioResponder: payload =>
        payload.bvid === 'BV1' && fail ? { ok: false, error: '临时网络错误' } :
            { ok: true, urls: ['https://cdn/audio.m4s'] } });
    await play(f, 0);
    assert.equal((await f.player.pNext()).ok, false);
    fail = false;
    assert.equal(await next(f), 'item1', '未起播的失败候选不误算为已播放');
    console.log('PASS: failed startup does not consume an unplayed item');

    fail = false;
    f = fixture(3, 'shuffleLoop', { resolveAudioResponder: payload =>
        payload.bvid === 'BV0' && fail ? { ok: false, error: '临时网络错误' } :
            { ok: true, urls: ['https://cdn/audio.m4s'] } });
    await play(f, 0);
    await next(f);
    await next(f);
    fail = true;
    assert.equal((await f.player.pNext()).ok, false);
    assert.deepEqual(round(f)[0].played, [], '新一轮首曲失败，不提前记入任何已播放条目');
    fail = false;
    assert.equal(await next(f), 'item0');
    assert.equal(await next(f), 'item1');
    assert.equal(await next(f), 'item2', '失败后重试仍包含上一轮末曲，不误算进本轮');
    console.log('PASS: retrying a failed round transition does not silently consume the previous track');

    f = fixture(4);
    f.store.bpl_playlists[0].items[1].sourceUnavailable = true;
    await play(f, 0);
    assert.equal(await next(f), 'item2');
    assert.equal(await prev(f), 'item0', '上一首仅回到实际起播过的历史，不回到失败候选');
    assert.equal(await next(f), 'item3');
    console.log('PASS: failed candidates are skipped without entering backward history');

    f = fixture(4);
    await play(f, 0);
    await next(f);
    await next(f);
    assert.equal(await prev(f), 'item1');
    assert.equal(await prev(f), 'item0');
    assert.equal(await prev(f), 'item0', '无上一首历史时不按列表索引播放未听过的条目');
    assert.equal(await next(f), 'item3');
    console.log('PASS: repeated backward navigation preserves the complete played set');

    f = fixture(3);
    await play(f, 0);
    await next(f);
    await f.player.pToggle();
    await f.player.pToggle();
    assert.equal(await next(f), 'item2', '暂停与恢复不会重置轮次');
    await f.player.pStopPlayback();
    assert.equal(round(f).length, 0);
    await play(f, 0);
    assert.equal(await next(f), 'item1');
    console.log('PASS: pause preserves the round and stop explicitly resets it');

    f = fixture(4);
    await play(f, 0);
    f.random(0.999);
    f.player.__audio.ls.ended.forEach(listener => listener());
    await until(() => current(f) === 'item3');
    f.player.__listen(30);
    f.random(0);
    assert.equal(await next(f), 'item1');
    console.log('PASS: natural track completion and button navigation use the same unplayed pool');

    let finishResolution;
    f = fixture(4, 'shuffle', { resolveAudioResponder: payload => payload.bvid === 'BV1' && !finishResolution
        ? new Promise(resolve => { finishResolution = resolve; })
        : { ok: true, urls: ['https://cdn/audio.m4s'] } });
    await play(f, 0);
    const pending = f.player.pNext();
    for (let i = 0; i < 100 && !finishResolution; i++) await Promise.resolve();
    assert(finishResolution);
    await play(f, 2);
    finishResolution({ ok: true, urls: ['https://cdn/old'] });
    assert.equal((await pending).cancelled, true);
    assert.equal(current(f), 'item2');
    assert.deepEqual(round(f)[0].played, ['id:item0', 'id:item2']);
    assert.equal(await next(f), 'item1', '已取消、未起播的候选下次仍可抽取');
    console.log('PASS: a cancelled pending next cannot play late or consume its candidate');

    f = fixture(2, 'shuffleLoop');
    await play(f, 0);
    for (let i = 0; i < 20; i++) await next(f);
    assert(round(f)[0].history.length <= 4);
    console.log('PASS: backward history remains bounded across many loop rounds');
})().catch(error => { console.error(error); process.exitCode = 1; });
