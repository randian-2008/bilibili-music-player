const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'theme.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log('  PASS: ' + msg); }
    else { fail++; console.log('  FAIL: ' + msg); }
}

console.log('[theme.js 固定主题]');
const api = sandbox.BPLTheme;
ok(!!api, '导出 BPLTheme API');
ok(api.themes.length === 6, '提供 6 套固定主题');
ok(new Set(api.themes.map(theme => theme.id)).size === api.themes.length &&
    !api.themes.some(theme => ['classic', 'ocean', 'forest', 'rain', 'firefly'].includes(theme.id)),
    '主题 ID 唯一且已移除旧配色');
ok(api.get('glass').name === '冰川玻璃', '按 ID 获取主题');
ok(api.get('missing').id === api.DEFAULT_ID, '未知主题回退到默认主题');

const required = [
    '--bpl-page', '--bpl-surface', '--bpl-raised', '--bpl-control', '--bpl-hover',
    '--bpl-text', '--bpl-accent', '--bpl-accent-soft', '--bpl-danger', '--bpl-shadow',
    '--bpl-control-shadow', '--bpl-control-active-shadow', '--bpl-surface-highlight'
];
ok(api.themes.every(theme => required.every(key => theme.vars[key])), '每套主题包含完整核心语义变量');
ok(api.themes.every(theme => /^linear-gradient\(/.test(theme.swatch)), '每套主题提供可视色块');
ok(['gold', 'paper'].every(id => /0 50%,#[0-9a-f]{6} 50%\)$/i.test(api.get(id).swatch)),
    '硬分割双色主题色块保持 50/50 等分');
const jade = api.get('jade');
ok(/^linear-gradient\(/.test(jade.vars['--bpl-page-bg']) && Number(jade.vars['--bpl-decor-opacity']) > 0 &&
    ['forest', 'rain', 'firefly'].every(id => api.get(id).id === 'jade'),
    '仅保留古典墨玉，并迁移旧绿色主题选择');
const starry = api.get('starry');
const starPositions = Array.from(starry.vars['--bpl-decor-image'].matchAll(/at (\d+)% (\d+)%/g));
ok(/^linear-gradient\(/.test(starry.vars['--bpl-page-bg']) && Number(starry.vars['--bpl-decor-opacity']) > 0 &&
    starry.vars['--bpl-decor-repeat'] === 'no-repeat' && starry.vars['--bpl-decor-size'] === '100% 100%' &&
    starPositions.length >= 36 && new Set(starPositions.map(match => match[1] + ':' + match[2])).size === starPositions.length,
    '星夜主题使用整面不重复的非规则星点');
const glass = api.get('glass');
const glassPanelAlphas = Array.from(glass.vars['--bpl-panel-bg'].matchAll(/rgba\([^)]*,([\d.]+)\)/g), match => Number(match[1]));
ok(glass.vars['--bpl-page-bg'] === 'transparent' && Math.max(...glassPanelAlphas) <= 0.1 &&
    /blur\(5px\)/.test(glass.vars['--bpl-panel-backdrop']) && glass.vars['--bpl-mini-bg'],
    '冰川玻璃限制为低色层与轻量整面模糊');
const clear = api.get('clear');
ok(clear.vars['--bpl-page-bg'] === 'transparent' && clear.vars['--bpl-panel-bg'] === 'transparent' &&
    clear.vars['--bpl-panel-backdrop'] === 'none' && Number(clear.vars['--bpl-ambient-opacity']) === 0,
    '纯净玻璃移除面板色层、整面滤镜与封面环境光');
ok([glass, clear].every(theme => theme.vars['--bpl-list-bg'] === 'transparent' &&
    /drop-shadow\(/.test(theme.vars['--bpl-mini-icon-filter']) && theme.vars['--bpl-mini-icon-outline'] &&
    /^#[0-9a-f]{6}$/i.test(theme.vars['--bpl-swatch-border'])),
    '两套玻璃主题提供透明列表与浅色背景可见的胶囊图标');

const contentCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'content.js'), 'utf8');
const sidepanelCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'sidepanel.js'), 'utf8');
const sidepanelCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'sidepanel.css'), 'utf8');
const sidepanelHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'panel', 'sidepanel.html'), 'utf8');
ok(/bplBridge:\s*'theme'/.test(contentCode) && /bplBridge === 'theme'/.test(sidepanelCode),
    '外壳直接同步主题到播放列表 iframe');
const listwrapStart = sidepanelHtml.indexOf('<div class="listwrap">');
const listwrapEnd = sidepanelHtml.indexOf('\n    </div>', listwrapStart);
const playlistMenu = sidepanelHtml.indexOf('<div id="plMenu"');
ok(listwrapStart >= 0 && listwrapEnd > listwrapStart && playlistMenu > listwrapEnd,
    '播放列表菜单是 listwrap 外的视口级浮层，不受播放器层叠上下文限制');
const toolbarStart = sidepanelHtml.indexOf('<div class="pl-bar">');
const addButton = sidepanelHtml.indexOf('id="addItemBtn"');
const chartButton = sidepanelHtml.indexOf('id="chartBtn"');
ok(toolbarStart >= 0 && addButton > toolbarStart && chartButton > addButton &&
    !sidepanelHtml.includes('id="plNew"') && sidepanelHtml.includes('data-act="create"') &&
    sidepanelHtml.includes('title="更多操作"') && /manualItemDialog/.test(sidepanelHtml) &&
    /addManualItem/.test(sidepanelCode) && /matchManualItem/.test(sidepanelCode) &&
    /data-manual-match/.test(sidepanelCode),
    '工具栏按“播放列表、添加、热榜、更多操作”布局，并接入手动条目入口');
const selectionMenu = sidepanelHtml.indexOf('<div id="selMenu"');
ok(selectionMenu > listwrapEnd && /\.sel-menu\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*70;/.test(sidepanelCss) &&
    /function positionSelectionMenu\(\)/.test(sidepanelCode),
    '批量移动和复制菜单是列表外的视口级浮层，可覆盖歌曲并按可用空间定位');
ok(contentCode.includes("THEME_PICKER_ORDER = ['paper', 'gold', 'jade', 'starry'") &&
    contentCode.includes('.theme-picker.open .theme-swatches{max-width:112px') &&
    contentCode.includes('.theme-swatch{appearance:none;flex:none;width:16px;height:16px') &&
    contentCode.includes('.theme-toggle{appearance:none') && contentCode.includes('padding:0;border:0;outline:none;border-radius:50%') &&
    contentCode.includes('<button class="theme-toggle"') && !contentCode.includes('<button class="pbtn theme-toggle"') &&
    contentCode.includes('.theme-swatch{appearance:none') && contentCode.includes('background-clip:padding-box') &&
    contentCode.includes('<button class="theme-swatch"') && !contentCode.includes('<button class="pbtn theme-swatch"') &&
    !contentCode.includes('.theme-swatch:hover{background:var(--swatch);transform:scale') &&
    contentCode.includes('height:1px;border-radius:.5px') &&
    contentCode.includes('.resize-grip::before{right:2px;bottom:7px;width:12px}') &&
    contentCode.includes('.resize-grip::after{right:2px;bottom:4px;width:6px}') &&
    /body:not\(\.has-track\) \.player::after\s*\{ display: none; \}/.test(sidepanelCss) &&
    /\.cbtn\.stop\s*\{ color: var\(--bpl-accent\); \}/.test(sidepanelCss),
    '停止态与标题栏紧凑控件遵循主题和几何约束');
ok(/function volumeIcon\(v, muted\)/.test(sidepanelCode) &&
    /muteBtn\.innerHTML = volumeIcon\(v, muted\)/.test(sidepanelCode) &&
    !/[🔇🔉🔊]/u.test(sidepanelCode) &&
    /id="muteBtn"[^>]*><svg[^>]*stroke="currentColor"/.test(sidepanelHtml) &&
    /\.vbtn\s*\{[\s\S]*?color: var\(--bpl-muted\)/.test(sidepanelCss),
    '音量图标使用 currentColor SVG 并随主题着色');
ok(/data-rematch=/.test(sidepanelCode) && /title="重新匹配音源"/.test(sidepanelCode) &&
    /function canRematchItem\(item\)/.test(sidepanelCode) &&
    /function isFailedChartItem\(item\)/.test(sidepanelCode) && /data-chart-rematch=/.test(sidepanelCode) &&
    /send\('matchChartItem', \{ playlistId: activeId, itemId: item.id, manual: true, verifyPlayable: true \}\)/.test(sidepanelCode) &&
    /sourceUnavailable \? '' : httpsUrl\(s\.pic\)/.test(sidepanelCode) &&
    /sourceUnavailable \? ' unavailable' : ''/.test(sidepanelCode) &&
    /\.source-slot\s*\{/.test(sidepanelCss) && /\.source-slot\.rematchable:hover \.source-rematch/.test(sidepanelCss) &&
    /\.source-slot\.unavailable \.source-rematch/.test(sidepanelCss) &&
    !/\.item:hover \.source-slot\.rematchable \.source-rematch/.test(sidepanelCss) &&
    /width: 42px; height: 22px/.test(sidepanelCss),
    '自动匹配条目仅悬浮时长槽才显示按钮，失效条目则持续显示重新匹配按钮');
ok((sidepanelHtml.match(/data-locate-playing/g) || []).length === 2 &&
    /async function locatePlayingItem\(\)/.test(sidepanelCode) &&
    /send\('setActive', \{ id: pl\.id \}\)/.test(sidepanelCode) &&
    /item\.id === state\.trackId/.test(sidepanelCode) &&
    /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/.test(sidepanelCode) &&
    /\.item\.located\s*\{ animation: locateItem/.test(sidepanelCss),
    '点击当前封面或标题可切换到所属播放列表，并按 trackId 定位和高亮当前条目');
const txtExportCode = sidepanelCode.slice(sidepanelCode.indexOf('function buildTxt'), sidepanelCode.indexOf('function buildMd'));
const mdExportCode = sidepanelCode.slice(sidepanelCode.indexOf('function buildMd'), sidepanelCode.indexOf('function buildJson'));
const jsonExportCode = sidepanelCode.slice(sidepanelCode.indexOf('function buildJson'), sidepanelCode.indexOf('function exportAs'));
const internalExportFields = /matchHistory|matchTarget|matchOrigin|matchState|chartSource|sourceUnavailable/;
ok(!internalExportFields.test(txtExportCode) && !internalExportFields.test(mdExportCode) &&
    /s\.title/.test(txtExportCode) && /itemUrl\(s\)/.test(txtExportCode) &&
    /s\.title/.test(mdExportCode) && /itemUrl\(s\)/.test(mdExportCode),
    'TXT 和 Markdown 仅导出标题、作者、时长、链接等显式信息');
ok(/formatVersion:\s*2/.test(jsonExportCode) && /playlist:\s*playlist/.test(jsonExportCode) &&
    /pl\.items\.map\(item => Object\.assign\(\{\}, item\)\)/.test(jsonExportCode),
    'JSON v2 导出播放列表元数据和完整条目字段，可保留匹配历史');

function luminance(hex) {
    const rgb = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
ok(api.themes.every(theme => contrast(theme.vars['--bpl-text'], theme.vars['--bpl-page']) >= 4.5),
    '每套主题的正文与主背景对比度不低于 4.5:1');

const applied = {};
const attrs = {};
const target = {
    style: {
        setProperty: (key, value) => { applied[key] = value; },
        removeProperty: key => { delete applied[key]; }
    },
    setAttribute: (key, value) => { attrs[key] = value; }
};
api.apply(target, 'starry');
const selected = api.apply(target, 'paper');
ok(selected.id === 'paper' && attrs['data-bpl-theme'] === 'paper' && !applied['--bpl-page-bg'],
    '应用主题并标记当前主题 ID，切换时清除专用变量');
ok(applied['--bpl-page'] === selected.vars['--bpl-page'] && applied['--bpl-accent'] === selected.vars['--bpl-accent'],
    '将主题语义变量写入目标元素');

console.log('\n=================');
console.log('通过: ' + pass + '  失败: ' + fail);
process.exit(fail > 0 ? 1 : 0);
