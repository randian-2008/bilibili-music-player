const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(file, names) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n\(async \(\) => \{/)[0];
    return new Function('require', '__dirname', source + '\nreturn {' + names + '};')(require, __dirname);
}
const { makeCtx: makePlayer, setupPlaylist } = harness('test-offscreen.js', 'makeCtx, setupPlaylist');
const { makeCtx: makeBackground } = harness('test-background.js', 'makeCtx');
const { fixture: makePanel } = harness('test-panel-dialogs.js', 'fixture');
const { makeTab, storageBus } = harness('test-panel-boundaries.js', 'makeTab, storageBus');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const check = (condition, text) => { assert.ok(condition, text); console.log('PASS: ' + text); };

// Controlled time exercises real media deadlines and grace periods; no network
// or browser is used, and a hung first play() really remains pending.
function clock() {
    let at = 0, serial = 0;
    const timers = new Map();
    return {
        setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: at + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        Date: class extends Date { static now() { return 1700000000000 + at; } },
        async advance(ms) {
            await flush();
            const target = at + ms;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > target) break;
                at = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
            }
            at = target; await flush();
        }
    };
}
function playerFixture(delays, options = {}) {
    const time = clock();
    const started = [];
    let peak = 0, player;
    player = makePlayer({ store: setupPlaylist(2), ...options,
        setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
        resolveAudioRes: { ok: true, urls: Object.keys(delays) },
        playResponder(media) {
            const url = media.src;
            started.push(url);
            peak = Math.max(peak, player.__audios.filter(a => a.src && a !== player.__audio).length);
            return new Promise((resolve, reject) => {
                if (delays[url] === Infinity) return;
                time.setTimeout(() => {
                    if (delays[url] < 0) { const error = new Error('bad media'); error.name = 'NotSupportedError'; reject(error); }
                    else { if (media.src === url) media.paused = false; resolve(); }
                }, Math.abs(delays[url] || 0));
            });
        }
    });
    player.Date = time.Date;
    return { player, time, started, peak: () => peak };
}
const loading = player => player.__sent.filter(m => m.cmd === 'relay' && m.data.type === 'loading').map(m => m.data.loading);

(async () => {
    let f = playerFixture({ 'https://slow/a': Infinity, 'https://fast/a': 100, 'https://unused/a': 20 });
    f.player.navigator.mediaSession = { setActionHandler() {} };
    f.player.MediaMetadata = class { constructor(fields) { Object.assign(this, fields); } };
    await f.player.handleCmd({ cmd: 'setVolume', value: 0.35 });
    let task = f.player.pPlayIndex(0);
    await flush();
    check((await f.player.handleCmd({ cmd: 'getStatus' })).loading && f.started.length === 2, 'loading starts during preparation; exactly two candidates start');
    check(f.player.__audios.filter(a => a.src).every(a => a.muted), 'all candidates stay muted before selection');
    await f.time.advance(450);
    check((await task).ok && f.player.__audio.src === 'https://fast/a', 'backup starts at 450ms without waiting for the hung primary or fetching its blob');
    check(f.started.length === 2 && f.peak() === 2 && !f.player.__fetchOptions().length, 'winner reuses its media connection; no third request or full-file probe');
    check(f.player.__audios.filter(a => a !== f.player.__audio).every(a => !a.src && a.paused), 'losers and retired audio are released');
    check(f.player.__audio.volume === 0.35 && !f.player.__audio.muted && f.player.navigator.mediaSession.playbackState === 'playing',
        'adopting the winning connection preserves volume and updates system media playback state');
    check(f.player.__store.bpl_source_history.every(row => row.host !== 'https://slow'), 'cancelled loser is not recorded as a failure');
    assert.deepEqual(loading(f.player), [true, false]);
    check(!('loading' in f.player.__store.bpl_state), 'loading remains runtime state, never saved in playback configuration');

    f = playerFixture({ 'https://a/audio': 700, 'https://b/audio': 900 });
    task = f.player.pPlayIndex(0);
    await f.time.advance(500);
    check((await f.player.handleCmd({ cmd: 'getStatus' })).loading, 'a generally slow network does not cause premature abandonment');
    await f.time.advance(550);
    check((await task).ok && f.player.__audio.src === 'https://a/audio', 'a slower original connection can still win when it becomes playable');

    f = playerFixture({ 'https://bad/a': -20, 'https://hung/a': Infinity, 'https://third/a': 40 });
    task = f.player.pPlayIndex(0);
    await f.time.advance(450);
    check((await task).ok && f.player.__audio.src === 'https://third/a' && f.peak() === 2, 'failed slot tries the next candidate while the other slot keeps waiting');

    f = playerFixture({ 'https://a/audio': Infinity, 'https://b/audio': Infinity });
    task = f.player.pPlayIndex(0);
    await flush();
    check((await f.player.pToggle()).cancelled, 'clicking the loading button cancels playback preparation');
    check((await task).cancelled && !(await f.player.handleCmd({ cmd: 'getStatus' })).loading, 'cancellation clears loading and completes the request');
    check(f.player.__audios.every(a => !a.src && a.paused), 'cancellation releases both candidates');

    f = playerFixture({ 'https://a/audio': Infinity, 'https://b/audio': Infinity });
    task = f.player.pPlayIndex(0);
    await f.time.advance(6000);
    check(!(await task).ok && !(await f.player.handleCmd({ cmd: 'getStatus' })).loading, 'all stalled sources finish within the budget and clear the spinner');
    check(f.player.__fetchOptions().length === 0, 'timeouts do not trigger a second full download of the same unreachable hosts');

    const oldResolve = gate(), newResolve = gate();
    const player = makePlayer({ store: setupPlaylist(2), resolveAudioResponder: (_, n) => n === 1 ? oldResolve.promise : newResolve.promise });
    const oldPlay = player.pPlayIndex(0); await flush();
    const newPlay = player.pPlayIndex(1); await flush();
    oldResolve.resolve({ ok: false, error: 'old failed' }); await flush();
    check((await oldPlay).cancelled && (await player.handleCmd({ cmd: 'getStatus' })).loading, 'old failure cannot clear loading for the new track');
    newResolve.resolve({ ok: true, urls: ['https://new/audio'] });
    check((await newPlay).ok && player.__store.bpl_state.trackId === 'item1', 'only the latest selection updates playback identity');
    const retired = player.__audio;
    await player.pPlayIndex(0);
    for (const type of ['pause', 'error', 'ended']) for (const fn of retired.ls[type] || []) fn();
    await flush();
    check(player.__store.bpl_state.trackId === 'item0' && player.__store.bpl_state.playing, 'events from a retired element cannot pause or advance the new track');

    const pendingSource = gate();
    const previousPlayer = makePlayer({ store: setupPlaylist(2), resolveAudioResponder: (_, n) =>
        n === 1 ? { ok: true, urls: ['https://original/audio'] } : pendingSource.promise });
    await previousPlayer.pPlayIndex(0);
    previousPlayer.__audio.currentTime = 8;
    const pendingPlay = previousPlayer.handleCmd({ cmd: 'playIndex', index: 1 }); await flush();
    await previousPlayer.handleCmd({ cmd: 'prev' });
    pendingSource.resolve({ ok: true, urls: ['https://stale/audio'] });
    check((await pendingPlay).cancelled && previousPlayer.__audio.currentTime === 0 && previousPlayer.__audio.src === 'https://original/audio',
        'previous-track restart invalidates an older pending selection even when it only seeks to zero');

    const history = player.BPLSources.createHistory([], () => 1000);
    history.record('https://fast/a?secret=1', { ok: true }, 200);
    history.record('https://bad/a', { ok: false }, 6000);
    const ranked = history.rank([{ url: 'https://bad/a', group: 0 }, { url: 'https://fast/b?fresh=1', group: 0 }, { url: 'https://fast/low', group: 1 }]);
    check(ranked[0].url.includes('/b?fresh') && ranked[2].group === 1, 'ranking uses endpoint history within quality groups and keeps fresh signed URLs');
    check(!JSON.stringify(history.snapshot()).includes('secret'), 'history contains no signed URL paths or query parameters');
    check(history.timeout('https://bad/a') > history.timeout('https://fast/a'), 'failure lengthens patience; healthy observations still have a conservative timeout floor');
    const reloaded = player.BPLSources.createHistory(history.snapshot(), () => 1000);
    check(reloaded.rank(ranked)[0].url === ranked[0].url, 'local endpoint rankings survive an offscreen restart');
    check(player.BPLSources.createHistory(history.snapshot(), () => 1000 + 8 * 86400000).snapshot().length === 0, 'old network history expires');
    for (let i = 0; i < 50; i++) history.record('https://host' + i + '/a', { ok: true }, 800);
    check(history.snapshot().length === 32, 'endpoint history stays bounded');

    const first = gate(), second = gate();
    const bg = makeBackground({ offscreenResponder: msg => msg.cmd === 'playIndex' ? (msg.index === 0 ? first.promise : second.promise) : { ok: true } });
    const bgOld = bg.handleBg({ cmd: 'player', payload: { cmd: 'playIndex', index: 0, playlistId: 'A' } }); await flush();
    check(bg.playbackIsLoading(), 'background announces loading before the offscreen result');
    const bgNew = bg.handleBg({ cmd: 'player', payload: { cmd: 'playIndex', index: 1, playlistId: 'A' } }); await flush();
    first.resolve({ ok: false, error: 'old failure' });
    check((await bgOld).cancelled, 'obsolete transport failures are not presented as errors for a newer selection');
    check(bg.playbackIsLoading(), 'old transport response cannot clear a newer pending command');
    second.resolve({ ok: false, error: 'network failed' }); await bgNew;
    check(!bg.playbackIsLoading(), 'failed command clears background loading');
    const match = gate();
    bg.__store.bpl_playlists = [{ id: 'A', items: [{ id: 'pending', chartSource: 'apple', sourceTitle: 'Song', matchState: 'pending' }] }];
    bg.matchChartItem = () => match.promise;
    const chartPlay = bg.playChartItem('A', 'pending'); await flush();
    check(bg.playbackIsLoading(), 'foreground chart matching shows loading before media selection');
    await bg.handleBg({ cmd: 'player', payload: { cmd: 'toggle' } });
    check(bg.__portSent.some(m => m.cmd === 'cancelPlayback') && !bg.playbackIsLoading(), 'loading toggle cancels instead of accidentally starting or pausing a different command');
    match.resolve({ ok: false, error: 'cancelled match' }); await chartPlay;
    const probeBg = makeBackground();
    await probeBg.sendToOffscreen({ cmd: 'probeAudio', urls: ['https://probe/audio'] });
    check(!probeBg.__msgSent.some(msg => msg.type === 'loading' && msg.loading), 'background media verification never starts the playback spinner');
    probeBg.__setResp({ code: 0, data: { dash: { audio: [
        { bandwidth: 100, baseUrl: 'https://low/audio' },
        { bandwidth: 200, baseUrl: 'https://high/audio', backupUrl: ['https://backup/audio'] }
    ] } } });
    const sources = await probeBg.handleResolveAudio({ bvid: 'BVtest', cid: 1 });
    check(sources.sources.map(s => s.group).join(',') === '0,0,1' && sources.urls[0] === 'https://high/audio',
        'resolver preserves quality boundaries for endpoint ranking without changing the existing URL array');

    const panel = await makePanel();
    const tab = makeTab(storageBus({})); await flush();
    for (const value of [true, false]) {
        const msg = { type: 'loading', loading: value };
        panel.ctx.handleBroadcast({ target: 'all', ...msg }); tab.broadcast(msg);
        panel.ctx.handleBroadcast({ target: 'all', type: 'progress', playing: true });
        tab.broadcast({ type: 'progress', playing: true });
        check(panel.el('#playBtn').classList.contains('loading') === value && tab.miniPlay.classList.contains('loading') === value,
            'expanded and collapsed buttons agree; progress cannot overwrite loading=' + value);
        check(panel.el('#playBtn').getAttribute('aria-busy') === String(value) && tab.miniPlay.getAttribute('aria-busy') === String(value), 'both buttons expose busy state to assistive technology');
    }
    tab.broadcast({ type: 'loading', loading: true });
    check(tab.mini.classList.contains('loaded'), 'first connection exposes the collapsed playback controls before any track exists');
    const panelHtml = fs.readFileSync(path.join(__dirname, '../src/panel/sidepanel.html'), 'utf8');
    const contentJs = fs.readFileSync(path.join(__dirname, '../src/content/content.js'), 'utf8');
    check(!/<button id="playBtn"[^>]*title=/.test(panelHtml) && !/<button class="m-btn m-play"[^>]*title=/.test(contentJs), 'neither play button adds a hover tooltip');
})().catch(error => { console.error(error); process.exitCode = 1; });
