'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

// Reuse the established VM browser doubles without running their test mains.
// Those doubles execute the actual source files, not copied implementations.
function fixture(file, marker, exports) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const end = source.indexOf(marker);
    assert(end > 0, 'fixture boundary exists');
    return new Function('require', '__dirname', source.slice(0, end) + '\nreturn ' + exports)(require, __dirname);
}
const bg = fixture('test-background.js', '\n(async () =>', '{ makeCtx }');
const off = fixture('test-offscreen.js', '\nasync function testPlayIndex()', '{ makeCtx, setupPlaylist }');
const ticks = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const chart = () => ({ id: 'a', chartSource: 'qq', sourceTitle: 'Song', matchState: 'pending', bvid: '' });

async function testManualJoinsAutomaticMatch() {
    const ctx = bg.makeCtx({ realTimers: true });
    ctx.__store.bpl_playlists = [{ id: 'p', items: [chart()] }];
    let finishSearch, searches = 0, probes = 0;
    ctx.searchBiliChartItem = async (item, manual, excluded) => {
        searches++;
        if (searches === 1) return await new Promise(resolve => { finishSearch = resolve; });
        assert(manual && excluded.has('BV1LTisBHESH'));
        return { bvid: 'BV1sM4y1x7Bx', title: 'Song', score: 99 };
    };
    ctx.resolveCid = async () => ({ cid: 1, info: {}, page: { page: 1 } });
    ctx.getAudioUrls = async bvid => ['https://cdn/' + bvid];
    ctx.sendToOffscreen = async msg => {
        assert.equal(msg.cmd, 'probeAudio');
        probes++;
        return msg.urls[0].endsWith('BV1LTisBHESH')
            ? { ok: false, error: 'decode failure' } : { ok: true };
    };
    const automatic = ctx.matchChartItem('p', 'a', false, false);
    for (let turn = 0; turn < 120 && !finishSearch; turn++) await Promise.resolve();
    assert(finishSearch);
    const manual = ctx.matchChartItem('p', 'a', true, true);
    const repeatedClick = ctx.matchChartItem('p', 'a', true, true);
    finishSearch({ bvid: 'BV1LTisBHESH', title: 'Song', score: 90 });
    const results = await Promise.all([automatic, manual, repeatedClick]);
    assert(results.every(result => result.ok));
    assert.equal(searches, 2);
    assert.equal(probes, 2);
    assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, 'BV1sM4y1x7Bx');
    console.log('PASS: manual clicks joining automatic matching still verify media, retry bad source and share work');
}

async function testMatchDeadlines() {
    for (const kind of ['chart', 'replacement']) {
        for (const stalledStage of ['search', 'resolve', 'urls', 'probe']) {
            const ctx = bg.makeCtx();
            let now = 1000;
            let timerId = 0;
            const timers = new Map();
            ctx.Date = class extends Date { static now() { return now; } };
            ctx.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; };
            ctx.clearTimeout = id => timers.delete(id);
            const originalBvid = kind === 'chart' ? '' : 'BV1ar421b77b';
            ctx.__store.bpl_playlists = [{ id: 'p', items: [kind === 'chart' ? chart() : {
                id: 'a', title: 'Song', bvid: originalBvid, cid: 1, matchOrigin: 'repair'
            }] }];
            let finishStalled;
            let finishedValue;
            const stages = [];
            const phase = (name, value) => {
                stages.push(name);
                // Earlier phases consumed almost all of the shared budget.
                // The stalled phase only gets the remainder, not another 105s.
                if (name === stalledStage) {
                    finishedValue = value;
                    return new Promise(resolve => { finishStalled = resolve; });
                }
                now += name === 'search' ? 103000 : 1;
                return Promise.resolve(value);
            };
            const candidate = { bvid: 'BV1LTisBHESH', title: 'Song', score: 99 };
            ctx.searchBiliChartItem = () => phase('search', candidate);
            ctx.searchReplacementCandidates = () => phase('search', [{ candidate, score: 99 }]);
            ctx.resolveCid = () => phase('resolve', { cid: 2, info: {}, page: { page: 1 } });
            ctx.getAudioUrls = () => phase('urls', ['https://cdn/candidate']);
            ctx.sendToOffscreen = msg => {
                assert.equal(msg.cmd, 'probeAudio', 'timeout cannot trigger main playback');
                return phase('probe', { ok: true });
            };
            const operation = kind === 'chart' ? ctx.matchChartItem('p', 'a', true, true) : ctx.rematchSource('p', 'a');
            for (let turn = 0; turn < 120 && !finishStalled; turn++) await Promise.resolve();
            assert(finishStalled, kind + ' reaches ' + stalledStage);
            now = 106000;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) { timers.delete(id); timer.fn(); }
            }
            const result = await operation;
            assert.equal(result.ok, false, kind + '/' + stalledStage);
            assert.match(result.error, /超时/);
            assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, originalBvid);
            if (kind === 'chart') assert.equal(ctx.__store.bpl_playlists[0].items[0].matchState, 'failed');
            const callsAfterTimeout = stages.length;
            finishStalled(finishedValue);
            for (let turn = 0; turn < 30; turn++) await Promise.resolve();
            assert.equal(stages.length, callsAfterTimeout, 'late result cannot start another phase');
            assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, originalBvid, 'late result cannot replace source');
            assert.equal(timers.size, 0, 'deadline timers are released');
        }
    }
    console.log('PASS: chart and replacement search/resolve/URL/probe phases share a strict deadline; late results never commit');

    const ctx = bg.makeCtx();
    let now = 0;
    ctx.Date = class extends Date { static now() { return now; } };
    ctx.__store.bpl_playlists = [{ id: 'p', items: [chart()] }];
    ctx.searchBiliChartItem = async () => {
        now = 105001; // Resolve before the queued timeout callback runs.
        return { bvid: 'BV1LTisBHESH', title: 'Song', score: 99 };
    };
    const result = await ctx.matchChartItem('p', 'a', false, false);
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, '');
    console.log('PASS: overdue successful response is rejected even before timeout callback runs');

    const queued = bg.makeCtx();
    let queuedNow = 0;
    let releaseMutation;
    queued.Date = class extends Date { static now() { return queuedNow; } };
    queued.__store.bpl_playlists = [{ id: 'p', items: [chart()] }];
    queued.searchBiliChartItem = async () => {
        queued.withPlaylistMutation(() => new Promise(resolve => { releaseMutation = resolve; }));
        return { bvid: 'BV1LTisBHESH', title: 'Song', score: 99 };
    };
    const queuedMatch = queued.matchChartItem('p', 'a', false, false);
    for (let turn = 0; turn < 120; turn++) await Promise.resolve();
    assert(releaseMutation);
    queuedNow = 105001;
    releaseMutation();
    const queuedResult = await queuedMatch;
    assert.equal(queuedResult.ok, false);
    assert.match(queuedResult.error, /超时/);
    assert.equal(queued.__store.bpl_playlists[0].items[0].bvid, '');
    assert.equal(queued.__store.bpl_playlists[0].items[0].matchState, 'failed');
    console.log('PASS: successful search queued behind another edit cannot commit after its deadline');
}

async function testMatchPlaybackBudget() {
    for (const kind of ['chart', 'replacement']) {
        for (const resolveTime of [10000, 40000]) {
            let now = 1000;
            let player;
            const messages = [];
            const ctx = bg.makeCtx({ realTimers: true, offscreenResponder(msg) {
                messages.push(msg);
                return msg.cmd === 'probeAudio' ? { ok: true } : player.handleCmd(msg);
            } });
            const clock = class extends Date { static now() { return now; } };
            ctx.Date = clock;
            Object.assign(ctx.__store, {
                bpl_active: 'p', bpl_state: { playlistId: 'p', trackId: null, index: 0, mode: 'loop', playing: false },
                bpl_playlists: [{ id: 'p', items: [kind === 'chart' ? chart() : {
                    id: 'a', title: 'Song', bvid: 'BV1ar421b77b', cid: 1, matchOrigin: 'repair'
                }] }]
            });
            player = off.makeCtx({ store: ctx.__store, resolveAudioResponder() {
                now += resolveTime;
                return { ok: true, urls: ['https://cdn/valid'], cid: 2 };
            } });
            player.Date = clock;
            ctx.matchChartItem = async () => {
                now += 100000;
                Object.assign(ctx.__store.bpl_playlists[0].items[0], { bvid: 'BV1LTisBHESH', cid: 2, matchState: 'matched' });
                return { ok: true };
            };
            ctx.searchReplacementCandidates = async () => {
                now += 100000;
                return [{ candidate: { bvid: 'BV1LTisBHESH', title: 'Song' }, score: 99 }];
            };
            ctx.resolveCid = async () => ({ cid: 2, info: {}, page: { page: 1 } });
            ctx.getAudioUrls = async () => ['https://cdn/valid'];
            const result = kind === 'chart' ? await ctx.playChartItem('p', 'a') : await ctx.rematchSource('p', 'a');
            const playCommand = messages.find(msg => msg.cmd === 'playIndex');
            assert(playCommand);
            assert.equal(playCommand.playbackDeadline, 141000, 'outer deadline starts before matching');
            assert.equal(playCommand.deadline, 136000, 'media finishes with five seconds left for transport/state');
            if (resolveTime === 10000) {
                assert.equal(result.ok, true);
                assert.equal(player.__audio.playCalls, 1, 'remaining budget permits prompt media startup');
            } else {
                assert.equal(result.ok, false);
                assert.match(result.error, /超时/);
                assert.equal(player.__audio.playCalls, 0, 'late URL cannot start audible playback');
                assert.equal(ctx.__store.bpl_state.trackId, null);
            }
        }
    }
    console.log('PASS: chart and replacement matching share their outer budget with audible playback; late URLs never start');

    const ctx = bg.makeCtx();
    let now = 1000;
    let releaseDocument;
    const timers = new Map();
    let nextTimer = 0;
    ctx.Date = class extends Date { static now() { return now; } };
    ctx.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; };
    ctx.clearTimeout = id => timers.delete(id);
    ctx.ensureOffscreen = () => new Promise(resolve => { releaseDocument = resolve; });
    const waiting = ctx.sendToOffscreen({ cmd: 'playIndex', playlistId: 'p', itemId: 'a', index: 0, playbackDeadline: 41000 });
    for (let turn = 0; turn < 30 && !releaseDocument; turn++) await Promise.resolve();
    assert(releaseDocument);
    now = 41000;
    for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
    assert.equal((await waiting).ok, false, 'even document creation is inside the remaining transport budget');
    releaseDocument();
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    assert.equal(ctx.__portSent.filter(msg => msg.cmd === 'playIndex').length, 0);
    assert.equal(ctx.__msgSent.filter(msg => msg.cmd === 'playIndex').length, 0);
    console.log('PASS: expired outer transport deadline prevents a late document from starting playback');
}

async function run() {
    await testManualJoinsAutomaticMatch();
    await testMatchDeadlines();
    await testMatchPlaybackBudget();
    let ctx = bg.makeCtx();
    let finishMatch;
    ctx.__store.bpl_playlists = [{ id: 'p', items: [chart()] }];
    ctx.matchChartItem = () => new Promise(resolve => {
        finishMatch = () => {
            Object.assign(ctx.__store.bpl_playlists[0].items[0], { bvid: 'BV1ar421b77b', matchState: 'matched' });
            resolve({ ok: true });
        };
    });
    const oldPlay = ctx.playChartItem('p', 'a');
    for (let i = 0; i < 20 && !finishMatch; i++) await Promise.resolve();
    assert(finishMatch);
    await ctx.handleBg({ cmd: 'player', payload: { cmd: 'stop' } });
    finishMatch();
    assert.equal((await oldPlay).cancelled, true);
    assert.deepEqual(ctx.__portSent.filter(msg => msg.cmd).map(msg => msg.cmd), ['stop']);
    console.log('PASS: stop prevents late chart match from restarting playback');

    ctx = bg.makeCtx();
    ctx.__store.bpl_state = { playlistId: 'p', trackId: 'a', index: 0, mode: 'order', playing: false };
    ctx.__store.bpl_playlists = [{ id: 'p', items: [{ id: 'b' }, { id: 'a' }] }];
    await Promise.all([
        ctx.patchPlayerState({ mode: 'shuffle' }),
        ctx.patchPlayerState({ playing: true }),
        ctx.reconcileStoredState(ctx.__store.bpl_playlists)
    ]);
    assert.equal(ctx.__store.bpl_state.mode, 'shuffle');
    assert.equal(ctx.__store.bpl_state.playing, true);
    assert.equal(ctx.__store.bpl_state.index, 1);
    await ctx.patchPlayerState({ playing: false }, { trackId: 'stale-track' });
    assert.equal(ctx.__store.bpl_state.playing, true);
    console.log('PASS: state patches and list reconciliation preserve independent updates');

    ctx = bg.makeCtx({ offscreenResponder(msg) {
        return msg.cmd === 'probeAudio' && msg.urls[0].includes('bad')
            ? { ok: false, transient: false, error: 'decode failure' } : { ok: true };
    } });
    ctx.__store.bpl_playlists = [{ id: 'p', items: [{ id: 'a', title: 'Song', bvid: 'BV1ar421b77b', cid: 1,
        matchOrigin: 'repair', matchTargetTitle: 'Song' }] }];
    let searches = 0;
    ctx.searchReplacementCandidates = async item => {
        searches++;
        const bvid = searches === 1 ? 'BV1LTisBHESH' : 'BV1sM4y1x7Bx';
        if (searches === 2) assert(item.matchHistory.includes('BV1LTisBHESH'));
        return [{ score: 90, candidate: { bvid, title: 'Song' } }];
    };
    ctx.resolveCid = async bvid => ({ cid: 2, info: { bvid }, page: { page: 1 } });
    ctx.getAudioUrls = async bvid => ['https://cdn/' + (bvid === 'BV1LTisBHESH' ? 'bad' : 'good')];
    const rematched = await ctx.rematchSource('p', 'a');
    assert(rematched.ok);
    assert.equal(searches, 2);
    assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, 'BV1sM4y1x7Bx');
    assert(!ctx.__store.bpl_playlists[0].items[0].matchHistory.includes('BV1LTisBHESH'));
    console.log('PASS: failed media probe causes another search without committing bad source');

    ctx = bg.makeCtx({ offscreenResponder: () => ({ ok: false, transient: true, error: 'network timeout' }) });
    ctx.__store.bpl_playlists = [{ id: 'p', items: [{ id: 'a', title: 'Song', bvid: 'BV1ar421b77b', cid: 1, matchOrigin: 'repair' }] }];
    searches = 0;
    ctx.searchReplacementCandidates = async () => { searches++; return [{ candidate: { bvid: 'BV1LTisBHESH' } }]; };
    ctx.resolveCid = async () => ({ cid: 2, info: {}, page: { page: 1 } });
    ctx.getAudioUrls = async () => ['https://cdn/slow'];
    assert.equal((await ctx.rematchSource('p', 'a')).ok, false);
    assert.equal(searches, 1);
    assert.equal(ctx.__store.bpl_playlists[0].items[0].bvid, 'BV1ar421b77b');
    console.log('PASS: transient network failure preserves source and stops replacement churn');

    ctx = bg.makeCtx();
    delete ctx.chrome.offscreen.hasDocument;
    delete ctx.chrome.runtime.getContexts;
    ctx.clients = { matchAll: async () => [{ url: ctx.chrome.runtime.getURL('src/player/offscreen.html') }] };
    assert.equal(await ctx.hasOffscreen(), true);
    await ctx.ensureOffscreen();
    assert.equal(ctx.__off.createCalls, 0);
    console.log('PASS: Chrome 109 fallback finds existing offscreen without duplicate creation');

    const player = off.makeCtx({ store: off.setupPlaylist(1) });
    await player.pPlayIndex(0);
    const initialSrc = player.__audio.src;
    const probes = [];
    player.document.createElement = () => {
        const probe = {
            src: '', error: null, muted: false, volume: 1, listeners: {},
            addEventListener(type, handler) { this.listeners[type] = handler; },
            removeEventListener(type) { delete this.listeners[type]; },
            play() {
                assert(this.muted && this.volume === 0);
                return this.src.includes('bad') ? Promise.reject(Object.assign(new Error('decode'), { name: 'NotSupportedError' })) : Promise.resolve();
            },
            pause() { this.paused = true; }, removeAttribute() { this.src = ''; }, load() {}
        };
        probes.push(probe);
        return probe;
    };
    assert((await player.probeAudioUrls(['https://cdn/bad', 'https://cdn/good'], 12000)).ok);
    assert.equal(player.__audio.src, initialSrc);
    assert.equal(player.__store.bpl_state.trackId, 'item0');
    assert.equal(probes[0].src, '');
    console.log('PASS: silent media probe tests actual startup and cleans up without replacing current audio');
    await ticks(2);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
