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
let dragFrom = null;
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
            return '<div class="item' + (isPlaying ? ' playing' : '') + '" draggable="true" data-i="' + i + '">' +
                '<span class="grip" title="拖动排序">⋮⋮</span>' +
                '<img class="cover" src="' + esc(httpsUrl(s.pic)) + '" referrerpolicy="no-referrer">' +
                '<div class="t"><span class="txt">' + esc(s.title) + '</span></div>' +
                '<span class="dur">' + (s.duration ? fmt(s.duration) : '') + '</span>' +
                '<div class="ibtn" data-rename="' + i + '" title="重命名">✎</div>' +
                '<div class="ibtn del" data-del="' + i + '" title="删除">×</div>' +
                '</div>';
        }).join('');
    }
    applyMarquee($('.np-title'));
    box.querySelectorAll('.t').forEach(applyMarquee);
    updateProgress();
}

function applyMarquee(wrap) {
    if (!wrap) return;
    const txt = wrap.querySelector('.txt');
    if (!txt) return;
    wrap.classList.remove('overflow');
    txt.style.removeProperty('--shift');
    txt.style.removeProperty('--dur');
    const overflow = txt.offsetWidth - wrap.clientWidth;
    if (overflow > 2) {
        txt.style.setProperty('--shift', '-' + (overflow + 8) + 'px');
        txt.style.setProperty('--dur', Math.max(5, overflow / 22) + 's');
        wrap.classList.add('overflow');
    }
}

function updateProgress() {
    $('#playBtn').textContent = state.playing ? '⏸' : '▶';
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
        if (v && v !== s.title) send('renameItem', { index: i, title: v });
        else render();
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
box.addEventListener('click', e => {
    if (Date.now() - lastDrop < 300) return;
    const rn = e.target.closest('[data-rename]');
    if (rn) { e.stopPropagation(); renameItem(+rn.dataset.rename); return; }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); send('remove', { index: +del.dataset.del }); return; }
    const it = e.target.closest('.item');
    if (it) act('playIndex', { index: +it.dataset.i });
});

box.addEventListener('dragstart', e => {
    const it = e.target.closest('.item');
    if (!it) return;
    dragFrom = +it.dataset.i;
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_) {}
});
box.addEventListener('dragover', e => {
    if (dragFrom == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const it = e.target.closest('.item');
    box.querySelectorAll('.item.drag-over').forEach(x => x.classList.remove('drag-over'));
    if (it) it.classList.add('drag-over');
});
box.addEventListener('drop', e => {
    e.preventDefault();
    const it = e.target.closest('.item');
    if (it && dragFrom != null) {
        const to = +it.dataset.i;
        if (to !== dragFrom) { lastDrop = Date.now(); send('moveItem', { from: dragFrom, to }); }
    }
    dragFrom = null;
    box.querySelectorAll('.item.drag-over,.item.dragging').forEach(x => x.classList.remove('drag-over', 'dragging'));
});
box.addEventListener('dragend', () => {
    dragFrom = null;
    box.querySelectorAll('.item.drag-over,.item.dragging').forEach(x => x.classList.remove('drag-over', 'dragging'));
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
