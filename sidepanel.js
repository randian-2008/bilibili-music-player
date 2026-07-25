const DEF_STATE = { playlistId: null, index: 0, playing: false, mode: 'loop' };
const $ = s => document.querySelector(s);

const svg = d => '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const MODES = [
    { id: 'order', label: '顺序播放', icon: svg('<path d="M3 8h13M12 4l4 4-4 4"/><path d="M19 4v8" opacity=".45"/>') },
    { id: 'shuffle', label: '随机播放', icon: svg('<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>') },
    { id: 'one', label: '单曲循环', icon: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M10 10.3l2-1.8"/>') },
    { id: 'loop', label: '列表循环', icon: svg('<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/>') },
    { id: 'shuffleLoop', label: '随机循环', icon: svg('<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/><path d="M9.5 14.5l5-5M9.5 9.5l5 5" opacity=".8"/>') }
];
function modeIndex(id) { const i = MODES.findIndex(m => m.id === id); return i >= 0 ? i : 3; }
function normMode(st) {
    if (MODES.some(m => m.id === st.mode)) return st.mode;
    if (st.shuffle) return st.loop ? 'shuffleLoop' : 'shuffle';
    return st.loop ? 'loop' : 'order';
}

let playlists = [];
let activeId = null;
let state = Object.assign({}, DEF_STATE);
let position = 0;
let duration = 0;
let drag = null;
let lastDrop = 0;

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function httpsUrl(u) {
    u = String(u || '');
    return u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u;
}
function fmt(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}
const IN_FRAME = (window.self !== window.top);
function send(cmd, extra) {
    const payload = Object.assign({ target: 'bg', cmd }, extra || {});
    if (!IN_FRAME) {
        return new Promise(res => {
            chrome.runtime.sendMessage(payload, r => res(r));
        });
    }
    return new Promise(res => {
        const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        let done = false;
        const finish = v => { if (!done) { done = true; window.removeEventListener('message', onMsg); res(v); } };
        const onMsg = e => {
            if (e.source !== window.parent) return;
            const d = e.data;
            if (d && d.bplBridge === 'res' && d.id === id) finish(d.result);
        };
        window.addEventListener('message', onMsg);
        try { window.parent.postMessage({ bplBridge: 'req', id: id, payload: payload }, '*'); } catch (_) {}
        setTimeout(() => finish(undefined), 4000);
    });
}

let toastTimer = null;
function toast(text) {
    let t = document.getElementById('bplToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'bplToast';
        document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}
function act(cmd, extra) {
    return send(cmd, extra).then(res => {
        if (res && res.ok === false && res.error) toast('播放失败：' + res.error);
        return res;
    });
}

function activePlaylist() { return playlists.find(p => p.id === activeId) || null; }
function playingPlaylist() { return playlists.find(p => p.id === state.playlistId) || null; }
function playingItem() {
    const pl = playingPlaylist();
    return (pl && pl.items[state.index]) || null;
}
function itemUrl(s) {
    let url = 'https://www.bilibili.com/video/' + s.bvid;
    if (s.page && s.page > 1) url += '?p=' + s.page;
    return url;
}

function render() {
    const sel = $('#plSelect');
    sel.innerHTML = playlists.length
        ? playlists.map(p =>
            '<option value="' + esc(p.id) + '"' + (p.id === activeId ? ' selected' : '') + '>' +
            esc(p.name) + ' (' + p.items.length + ')</option>').join('')
        : '<option>（无歌单）</option>';

    const mode = MODES[modeIndex(state.mode)];
    const mb = $('#modeBtn');
    mb.innerHTML = mode.icon + '<span>' + mode.label + '</span>';
    mb.title = '播放模式：' + mode.label + '（点击切换）';
    mb.classList.toggle('active', state.mode !== 'order');
    document.body.classList.toggle('playing', !!state.playing);

    const it = playingItem();
    $('#curTitle').textContent = (it && it.title) || '未播放';
    const pic = (it && it.pic) ? httpsUrl(it.pic) : '';
    const coverEl = $('#npCover');
    if (coverEl.getAttribute('src') !== pic) coverEl.src = pic;
    $('#npBg').style.backgroundImage = pic ? 'url("' + pic.replace(/"/g, '') + '")' : '';

    const pl = activePlaylist();
    const items = (pl && pl.items) || [];
    const box = $('#list');
    const showPlaying = activeId === state.playlistId;
    if (!items.length) {
        box.innerHTML = '<div class="empty">这个歌单是空的<br>去B站视频页点「加入听歌列表」</div>';
    } else {
        box.innerHTML = items.map((s, i) => {
            const isPlaying = showPlaying && i === state.index;
            return '<div class="item' + (isPlaying ? ' playing' : '') + '" data-i="' + i + '">' +
                '<span class="chk"></span>' +
                '<img class="cover" src="' + esc(httpsUrl(s.pic)) + '" draggable="false" referrerpolicy="no-referrer">' +
                '<div class="t"><div class="track"><span class="txt">' + esc(s.title) + '</span></div></div>' +
                '<span class="dur">' + (s.duration ? fmt(s.duration) : '') + '</span>' +
                '<div class="ibtn" data-rename="' + i + '" title="重命名">✎</div>' +
                '</div>';
        }).join('');
    }
    applyMarquee($('.np-title'));
    box.querySelectorAll('.t').forEach(applyMarquee);
    if (selMode) refreshSelUI();
    updateProgress();
}

function applyMarquee(wrap) {
    if (!wrap) return;
    const track = wrap.querySelector('.track');
    const txt = wrap.querySelector('.txt');
    if (!track || !txt) return;
    wrap.classList.remove('overflow');
    const old = track.querySelector('.txt-clone');
    if (old) old.remove();
    track.style.removeProperty('--shift');
    track.style.removeProperty('--dur');
    const w = txt.offsetWidth;
    const overflow = w - wrap.clientWidth;
    if (overflow > 2) {
        const clone = txt.cloneNode(true);
        clone.classList.add('txt-clone');
        clone.removeAttribute('id');
        track.appendChild(clone);
        const dist = w + 28;
        track.style.setProperty('--shift', '-' + dist + 'px');
        track.style.setProperty('--dur', Math.max(6, dist / 28) + 's');
        wrap.classList.add('overflow');
    }
}

const PLAY_D = 'M8 5v14l11-7z';
const PAUSE_D = 'M6 5h4v14H6zm8 0h4v14h-4z';
function updateProgress() {
    const pp = $('#playBtn').querySelector('path');
    if (pp) pp.setAttribute('d', state.playing ? PAUSE_D : PLAY_D);
    document.body.classList.toggle('playing', !!state.playing);
    $('#time').textContent = fmt(position) + ' / ' + fmt(duration);
    const seek = $('#seek');
    seek.max = Math.floor(duration || 0);
    if (document.activeElement !== seek) seek.value = Math.floor(position || 0);
}

async function refresh() {
    const r = await chrome.storage.local.get(['bpl_playlists', 'bpl_active', 'bpl_state']);
    playlists = r.bpl_playlists || [];
    activeId = r.bpl_active || (playlists[0] && playlists[0].id) || null;
    state = Object.assign({}, DEF_STATE, r.bpl_state || {});
    state.mode = normMode(state);
    render();
    send('getStatus').then(res => {
        if (res && res.ok) {
            position = res.position || 0;
            duration = res.duration || 0;
            if (res.playing != null) state.playing = res.playing;
            updateProgress();
        }
    });
}

function renameItem(i) {
    const pl = activePlaylist();
    const s = pl && pl.items[i];
    if (!s) return;
    const itemEl = $('#list').querySelector('.item[data-i="' + i + '"]');
    if (!itemEl) return;
    const tEl = itemEl.querySelector('.t');
    if (!tEl || tEl.querySelector('input')) return;
    tEl.classList.add('editing');
    tEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 't-input';
    input.value = s.title;
    tEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v && v !== s.title) {
            s.title = v;
            render();
            send('renameItem', { index: i, title: v });
        } else {
            render();
        }
    };
    const cancel = () => { if (done) return; done = true; render(); };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', e => e.stopPropagation());
}

function downloadText(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function buildTxt(pl) {
    const lines = ['歌单：' + pl.name, '================================'];
    pl.items.forEach((s, i) => {
        lines.push((i + 1) + '. ' + s.title);
        if (s.owner) lines.push('   UP主：' + s.owner);
        lines.push('   ' + itemUrl(s));
    });
    return lines.join('\r\n');
}
function buildMd(pl) {
    const lines = ['# ' + pl.name, ''];
    pl.items.forEach((s, i) => {
        const title = String(s.title).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        const meta = [];
        if (s.owner) meta.push('UP：' + s.owner);
        if (s.duration) meta.push(fmt(s.duration));
        lines.push((i + 1) + '. [' + title + '](' + itemUrl(s) + ')' + (meta.length ? ' — ' + meta.join(' · ') : ''));
    });
    return lines.join('\r\n');
}
function buildJson(pl) {
    return JSON.stringify({
        app: 'bilibili-music-player',
        type: 'playlist',
        name: pl.name,
        exportedAt: new Date().toISOString(),
        items: pl.items.map(s => ({
            bvid: s.bvid, cid: s.cid || 0, title: s.title,
            pic: s.pic || '', owner: s.owner || '',
            duration: s.duration || 0, page: s.page || 1
        }))
    }, null, 2);
}
function exportAs(format) {
    const pl = activePlaylist();
    if (!pl || !pl.items.length) { alert('当前歌单是空的'); return; }
    const base = pl.name || '歌单';
    if (format === 'txt') downloadText(base + '.txt', buildTxt(pl), 'text/plain;charset=utf-8');
    else if (format === 'md') downloadText(base + '.md', buildMd(pl), 'text/markdown;charset=utf-8');
    else if (format === 'json') downloadText(base + '.json', buildJson(pl), 'application/json;charset=utf-8');
}

const fileInput = $('#importFile');
function handleImportFile(f) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            let name = '', items = [];
            if (Array.isArray(data)) items = data;
            else if (data && Array.isArray(data.items)) { name = data.name || ''; items = data.items; }
            else { alert('不是有效的歌单 JSON'); return; }
            items = items.filter(x => x && x.bvid);
            if (!items.length) { alert('JSON 里没有有效歌曲（需要包含 bvid）'); return; }
            send('importPlaylist', { name: name || f.name.replace(/\.json$/i, ''), items });
        } catch (err) {
            alert('JSON 解析失败：' + err.message);
        }
    };
    reader.readAsText(f);
}

$('#plSelect').addEventListener('change', e => send('setActive', { id: e.target.value }));
$('#plNew').addEventListener('click', () => {
    const name = prompt('新建歌单，名字：', '新歌单');
    if (name != null && name.trim()) send('createPlaylist', { name: name.trim() });
});

const menu = $('#plMenu');
$('#plMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
});
document.addEventListener('click', () => menu.classList.add('hidden'));
menu.addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act) return;
    e.stopPropagation();
    menu.classList.add('hidden');
    const pl = activePlaylist();
    if (act === 'import') { fileInput.click(); return; }
    if (!pl) return;
    if (act === 'rename') {
        const name = prompt('重命名歌单：', pl.name);
        if (name && name.trim()) send('renamePlaylist', { id: pl.id, name: name.trim() });
    } else if (act === 'export-txt') {
        exportAs('txt');
    } else if (act === 'export-md') {
        exportAs('md');
    } else if (act === 'export-json') {
        exportAs('json');
    } else if (act === 'clear') {
        if (pl.items.length && confirm('清空歌单「' + pl.name + '」？')) send('clear');
    } else if (act === 'delete') {
        if (confirm('删除歌单「' + pl.name + '」及其所有歌曲？')) send('deletePlaylist', { id: pl.id });
    }
});
fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (f) handleImportFile(f);
});

$('#playBtn').addEventListener('click', () => act('toggle').then(refresh));
$('#nextBtn').addEventListener('click', () => act('next'));
$('#prevBtn').addEventListener('click', () => act('prev'));
$('#stopBtn').addEventListener('click', () => act('stop').then(refresh));
$('#modeBtn').addEventListener('click', () => {
    const next = MODES[(modeIndex(state.mode) + 1) % MODES.length];
    send('setMode', { mode: next.id });
});
$('#seek').addEventListener('input', e => send('seek', { value: +e.target.value }));

const volSlider = $('#volSlider');
const muteBtn = $('#muteBtn');
let curMuted = false;
function paintVolume(v, muted) {
    volSlider.value = Math.round(v * 100);
    curMuted = muted;
    muteBtn.textContent = (muted || v === 0) ? '🔇' : (v < 0.5 ? '🔉' : '🔊');
    muteBtn.classList.toggle('muted', muted);
}
volSlider.addEventListener('input', () => {
    const v = (+volSlider.value) / 100;
    muteBtn.textContent = v === 0 ? '🔇' : (v < 0.5 ? '🔉' : '🔊');
    send('setVolume', { value: v });
});
muteBtn.addEventListener('click', () => {
    const m = !curMuted;
    send('setMute', { muted: m }).then(res => {
        if (res && res.ok) paintVolume(res.volume, res.muted);
    });
});
chrome.storage.local.get(['bpl_volume', 'bpl_mute']).then(r => {
    const v = (typeof r.bpl_volume === 'number') ? r.bpl_volume : 0.8;
    const m = !!r.bpl_mute;
    paintVolume(v, m);
});

const box = $('#list');

let selMode = false;
const selected = new Set();
function enterSelMode(firstIdx) {
    selMode = true;
    selected.clear();
    if (firstIdx != null) selected.add(firstIdx);
    refreshSelUI();
}
function exitSelMode() {
    selMode = false;
    selected.clear();
    $('#selMenu').classList.add('hidden');
    refreshSelUI();
}
function toggleSel(i) {
    if (selected.has(i)) selected.delete(i); else selected.add(i);
    refreshSelUI();
}
function refreshSelUI() {
    box.classList.toggle('selmode', selMode);
    box.querySelectorAll('.item').forEach(el => {
        const on = selected.has(+el.dataset.i);
        el.classList.toggle('selected', on);
        const chk = el.querySelector('.chk');
        if (chk) chk.classList.toggle('checked', on);
    });
    $('#selBar').classList.toggle('hidden', !selMode);
    $('#selCount').textContent = '已选 ' + selected.size + ' 首';
}

let lpTimer = null, lpStart = null, lpSupp = false;
let popTimer = null, hoverCover = null;

function findTargetIndex(clientY) {
    const items = [...box.querySelectorAll('.item')].filter(el => !el.classList.contains('dragging'));
    for (const el of items) {
        const r = el.getBoundingClientRect();
        if (clientY <= r.top + r.height / 2) return +el.dataset.i;
    }
    return items.length ? +items[items.length - 1].dataset.i : null;
}
function removeDragListeners() {
    window.removeEventListener('pointermove', dragMove);
    window.removeEventListener('pointerup', dragUp);
    window.removeEventListener('pointercancel', dragCancel);
}
function cleanupDrag() {
    if (!drag) return;
    drag.el.style.transform = '';
    drag.el.classList.remove('dragging');
    box.classList.remove('drag-on');
    box.querySelectorAll('.item.drag-over').forEach(x => x.classList.remove('drag-over'));
    drag = null;
}
function dragMove(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) > 5) {
        drag.moved = true;
        drag.el.classList.add('dragging');
        box.classList.add('drag-on');
        hideCoverPop();
    }
    if (drag.moved) {
        const lr = box.getBoundingClientRect();
        if (e.clientY < lr.top + 36) box.scrollTop -= 10;
        else if (e.clientY > lr.bottom - 36) box.scrollTop += 10;
        drag.el.style.transform = 'translateY(' + dy + 'px)';
        const target = findTargetIndex(e.clientY);
        box.querySelectorAll('.item.drag-over').forEach(x => x.classList.remove('drag-over'));
        if (target != null && target !== drag.from) {
            const tEl = box.querySelector('.item[data-i="' + target + '"]');
            if (tEl) tEl.classList.add('drag-over');
        }
    }
}
function dragUp(e) {
    removeDragListeners();
    if (!drag) return;
    const wasMoved = drag.moved, from = drag.from;
    let reordered = false;
    if (wasMoved) {
        const target = findTargetIndex(e.clientY);
        if (target != null && target !== from) {
            lastDrop = Date.now();
            const pl = playlists.find(p => p.id === activeId);
            if (pl) {
                const insertAt = from < target ? target - 1 : target;
                const mv = pl.items.splice(from, 1)[0];
                pl.items.splice(insertAt, 0, mv);
                reordered = true;
            }
            send('moveItem', { from: from, to: target });
        }
    }
    box.classList.remove('drag-on');
    box.querySelectorAll('.item.drag-over').forEach(x => x.classList.remove('drag-over'));
    drag.el.classList.remove('dragging');
    drag.el.style.transform = '';
    drag = null;
    if (reordered) {
        const sc = box.scrollTop;
        render();
        box.scrollTop = sc;
    }
}
function dragCancel() {
    removeDragListeners();
    cleanupDrag();
}
function showCoverPop(cover) {
    if (box.classList.contains('drag-on') || !cover.isConnected) return;
    const r = cover.getBoundingClientRect();
    const pop = $('#coverPop'), img = $('#coverPopImg');
    const W = r.width * 3, H = r.height * 3;
    img.src = cover.src;
    pop.style.width = W + 'px';
    pop.style.height = H + 'px';
    pop.style.left = r.left + 'px';
    pop.style.top = (r.bottom - H) + 'px';
    pop.classList.add('show');
}
function hideCoverPop() { $('#coverPop').classList.remove('show'); }

box.addEventListener('pointerdown', e => {
    if (drag) { removeDragListeners(); cleanupDrag(); }
    const it = e.target.closest('.item');
    if (!it) return;
    const cover = e.target.closest('.cover');
    if (cover && !selMode) {
        drag = { from: +it.dataset.i, el: it, startY: e.clientY, moved: false };
        window.addEventListener('pointermove', dragMove);
        window.addEventListener('pointerup', dragUp);
        window.addEventListener('pointercancel', dragCancel);
        return;
    }
    if (!selMode && !cover && !e.target.closest('.ibtn')) {
        lpStart = { x: e.clientX, y: e.clientY };
        const idx = +it.dataset.i;
        lpTimer = setTimeout(() => { lpTimer = null; lpSupp = true; enterSelMode(idx); }, 500);
    }
});
box.addEventListener('pointermove', e => {
    if (lpTimer && lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 6) {
        clearTimeout(lpTimer); lpTimer = null;
    }
});
box.addEventListener('pointerup', () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
});
box.addEventListener('pointercancel', () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
});

box.addEventListener('click', e => {
    if (lpSupp) { lpSupp = false; return; }
    if (Date.now() - lastDrop < 300) return;
    const rn = e.target.closest('[data-rename]');
    if (rn) { e.stopPropagation(); renameItem(+rn.dataset.rename); return; }
    const it = e.target.closest('.item');
    if (!it) return;
    const i = +it.dataset.i;
    if (selMode) { toggleSel(i); return; }
    act('playIndex', { index: i });
});

box.addEventListener('mouseover', e => {
    const cover = e.target.closest('.cover');
    if (cover === hoverCover) return;
    hoverCover = cover;
    if (popTimer) { clearTimeout(popTimer); popTimer = null; }
    hideCoverPop();
    if (cover && !box.classList.contains('drag-on') && !drag) {
        popTimer = setTimeout(() => { popTimer = null; showCoverPop(cover); }, 2000);
    }
});
box.addEventListener('mouseleave', () => {
    hoverCover = null;
    if (popTimer) { clearTimeout(popTimer); popTimer = null; }
    hideCoverPop();
});

let selAction = null;
function openSelMenu(action) {
    selAction = action;
    const others = playlists.filter(p => p.id !== activeId);
    $('#selMenu').innerHTML = others.length
        ? others.map(p => '<div data-plid="' + esc(p.id) + '">' + esc(p.name) + '</div>').join('')
        : '<div class="sel-none">（无其他歌单）</div>';
    $('#selMenu').classList.remove('hidden');
}
function selIndices() { return [...selected].sort((a, b) => a - b); }
$('#selMoveBtn').addEventListener('click', () => openSelMenu('move'));
$('#selCopyBtn').addEventListener('click', () => openSelMenu('copy'));
$('#selDelBtn').addEventListener('click', () => {
    const indices = selIndices();
    if (!indices.length) return;
    if (confirm('删除选中的 ' + indices.length + ' 首歌曲？')) {
        send('batchRemove', { indices: indices }).then(() => { exitSelMode(); refresh(); });
    }
});
$('#selCancelBtn').addEventListener('click', exitSelMode);
$('#selMenu').addEventListener('click', e => {
    const d = e.target.closest('[data-plid]');
    $('#selMenu').classList.add('hidden');
    if (!d) return;
    const indices = selIndices();
    if (!indices.length) return;
    const cmd = selAction === 'move' ? 'batchMove' : 'batchCopy';
    send(cmd, { indices: indices, toId: d.dataset.plid }).then(() => { exitSelMode(); refresh(); });
});
document.addEventListener('click', e => {
    if (!e.target.closest('#selMenu') && !e.target.closest('#selMoveBtn') && !e.target.closest('#selCopyBtn')) {
        $('#selMenu').classList.add('hidden');
    }
});

function handleBroadcast(msg) {
    if (!msg || msg.target !== 'all') return;
    if (msg.type === 'data') {
        playlists = msg.playlists || [];
        activeId = msg.activeId || (playlists[0] && playlists[0].id) || null;
        state = Object.assign({}, DEF_STATE, msg.state || {});
        render();
    } else if (msg.type === 'state') {
        state = Object.assign({}, DEF_STATE, msg.state || {});
        render();
    } else if (msg.type === 'progress') {
        position = msg.position || 0;
        duration = msg.duration || 0;
        if (msg.playing != null) state.playing = msg.playing;
        updateProgress();
    }
}

if (IN_FRAME) {
    window.addEventListener('message', e => {
        if (e.source !== window.parent) return;
        const d = e.data;
        if (d && d.bplBridge === 'broadcast') handleBroadcast(d.msg);
    });
} else {
    chrome.runtime.onMessage.addListener(handleBroadcast);
}

refresh();
