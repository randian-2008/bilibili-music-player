const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(file, marker, exports) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    return new Function('require', '__dirname', source.slice(0, source.indexOf(marker)) + '\nreturn ' + exports)(require, __dirname);
}
const bg = fixture('test-background.js', '\n(async () =>', '{ makeCtx }');
const off = fixture('test-offscreen.js', '\nasync function testPlayIndex()', '{ makeCtx, setupPlaylist }');
const panel = fixture('test-panel-dialogs.js', '\n(async () =>', '{ fixture }');
const snapshot = player => vm.runInContext('JSON.stringify([...shuffleRounds].map(([id, r]) => ({id,mode:r.mode,played:[...r.played],skipped:[...r.skipped],history:r.history})))', player);

(async () => {
    const ctx = bg.makeCtx();
    Object.assign(ctx.__store, off.setupPlaylist(3));
    ctx.__store.bpl_schema_version = 1;
    ctx.__store.bpl_state.mode = 'shuffle';
    ctx.__store.bpl_playlists.push({ id: 'pl2', name: '课程', items: [{ id: 'lesson', bvid: 'BVTEST000001', cid: 4 }] });
    await ctx.migrate();
    assert.deepEqual(ctx.__store.bpl_playlists.map(pl => pl.mode), ['shuffle', 'shuffle']);
    assert.equal(ctx.__store.bpl_schema_version, 2);
    assert.equal((await ctx.handleBg({ cmd: 'setMode', playlistId: 'pl2', mode: 'order' })).ok, true);
    assert.equal((await ctx.getState()).mode, 'shuffle');
    assert.equal(ctx.__off.createCalls, 0, 'changing mode requires no audio document or network');
    await ctx.migrate();
    assert.deepEqual(ctx.__store.bpl_playlists.map(pl => pl.mode), ['shuffle', 'order']);
    console.log('PASS: global mode migrates once; editing another list preserves playback mode');

    const player = off.makeCtx({ store: ctx.__store });
    const send = player.chrome.runtime.sendMessage;
    player.chrome.runtime.sendMessage = (message, callback) => {
        if (message.cmd === 'patchPlayerState') { ctx.handleBg(message).then(callback); return; }
        return send(message, callback);
    };
    assert.equal((await player.handleCmd({ cmd: 'playIndex', playlistId: 'pl1', index: 0 })).ok, true);
    assert.deepEqual(JSON.parse(snapshot(player))[0].history, ['id:item0'], 'successful start enters backward history');
    assert.deepEqual(JSON.parse(snapshot(player))[0].played, [], 'successful start alone does not consume a shuffle candidate');
    player.__listen(30);
    assert.deepEqual(JSON.parse(snapshot(player))[0].played, ['id:item0'], 'thirty actual seconds qualify the item');
    const before = snapshot(player);
    await ctx.handleBg({ cmd: 'player', payload: { cmd: 'setMode', playlistId: 'pl2', mode: 'one' } });
    player.onPlaylistsChanged();
    await Promise.resolve();
    assert.equal(snapshot(player), before, 'unrelated list setting does not reset random history');
    await ctx.handleBg({ cmd: 'setActive', id: 'pl2' });
    assert.equal((await player.pGetState()).mode, 'shuffle', 'browsing another list does not change active audio');
    assert.equal((await player.handleCmd({ cmd: 'playIndex', playlistId: 'pl2', index: 0 })).ok, true);
    assert.equal(ctx.__store.bpl_state.mode, 'one');
    const resumed = off.makeCtx({ store: ctx.__store, noStorage: true });
    assert.equal((await resumed.pGetState()).mode, 'one', 'recreated offscreen reads saved list mode via proxy');
    await ctx.handleBg({ cmd: 'setMode', playlistId: 'pl2', mode: 'order' });
    assert.equal((await player.pGetState()).mode, 'order');
    await player.pNext();
    assert.equal(ctx.__store.bpl_state.playing, false, 'ordered list stops at end even if previous list shuffled');
    await ctx.patchPlayerState({ mode: 'shuffleLoop' });
    assert.equal(ctx.__store.bpl_state.mode, 'order', 'late/global state patches cannot overwrite list preference');
    console.log('PASS: actual background/player flow switches, restores and obeys each playlist mode');

    const ui = await panel.fixture();
    ui.bg.__store.bpl_playlists[0].mode = 'order';
    ui.bg.__store.bpl_playlists[1].mode = 'shuffle';
    ui.bg.__store.bpl_active = 'B';
    ui.bg.__store.bpl_state = { playlistId: 'A', trackId: 'a1', index: 0, mode: 'order' };
    await ui.sync();
    assert.match(ui.el('#modeBtn').title, /随机播放/);
    await ui.el('#modeBtn').fire('click');
    await ui.sync();
    assert.equal(ui.bg.__store.bpl_playlists[1].mode, 'one');
    assert.equal(ui.bg.__store.bpl_playlists[0].mode, 'order');
    const backup = JSON.parse(ui.ctx.buildJson(ui.bg.__store.bpl_playlists[1]));
    const restored = await ui.bg.handleBg({ cmd: 'importPlaylist', ...backup });
    assert.equal(restored.ok, true);
    assert.equal(ui.bg.__store.bpl_playlists.at(-1).mode, 'one');
    const created = await ctx.handleBg({ cmd: 'createPlaylist', name: '新列表' });
    assert.equal(ctx.__store.bpl_playlists.find(pl => pl.id === created.id).mode, 'loop');
    for (const request of [{ mode: 'order' }, { playlistId: 'deleted', mode: 'order' }, { playlistId: 'pl1', mode: 'bad' }]) {
        assert.equal((await ctx.handleBg({ cmd: 'setMode', ...request })).ok, false);
    }
    await Promise.all([
        ctx.handleBg({ cmd: 'setMode', playlistId: 'pl1', mode: 'shuffleLoop' }),
        ctx.handleBg({ cmd: 'renamePlaylist', id: 'pl1', name: '新名称' })
    ]);
    assert.equal(ctx.__store.bpl_playlists[0].mode, 'shuffleLoop');
    assert.equal(ctx.__store.bpl_playlists[0].name, '新名称');
    console.log('PASS: UI targets viewed playlist, JSON round-trips mode, concurrent edits and invalid requests are safe');

    const { titles } = require('./fixtures/collection-titles.json');
    const collection = bg.makeCtx({ fetchResponder: () => ({ code: 0, data: {
        title: '合集', ugc_season: { title: '国风&古风', sections: [{ episodes: titles.map((title, index) => ({
            title, bvid: 'BV' + String(index).padStart(10, '0'),
            pages: [{ part: title, page: 1, cid: index + 1, duration: 200 }]
        })) }] }
    } }) });
    const imported = await collection.handleBg({ cmd: 'importCollection', bvid: 'BV1tbFrzyEbC', importTarget: 'new', smartRename: true });
    assert.equal(imported.ok, true);
    const saved = collection.__store.bpl_playlists.find(pl => pl.id === imported.playlistId);
    assert.equal(saved.items.length, 33);
    assert.equal(saved.mode, 'loop');
    assert(saved.items.slice(0, 22).every((item, index) => item.title.startsWith(titles[index].split(' -')[0])));
    assert.equal(saved.items[25].title, '画离弦');
    assert(saved.items.every(item => !/Hi|Res|无损音质|𝐇𝐢/.test(item.title)));
    console.log('PASS: real collection import handler stores all 33 renamed items with valid source identities');
})().catch(error => { console.error(error); process.exitCode = 1; });
