const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'theme.js'), 'utf8');
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
ok(new Set(api.themes.map(theme => theme.id)).size === api.themes.length, '主题 ID 唯一');
ok(api.get('ocean').name === '钴蓝黄', '按 ID 获取主题');
ok(api.get('missing').id === api.DEFAULT_ID, '未知主题回退到默认主题');

const required = [
    '--bpl-page', '--bpl-surface', '--bpl-raised', '--bpl-control', '--bpl-hover',
    '--bpl-text', '--bpl-accent', '--bpl-accent-soft', '--bpl-danger', '--bpl-shadow',
    '--bpl-control-shadow', '--bpl-control-active-shadow', '--bpl-surface-highlight'
];
ok(api.themes.every(theme => required.every(key => theme.vars[key])), '每套主题包含完整核心语义变量');
ok(api.themes.every(theme => /^linear-gradient\(/.test(theme.swatch)), '每套主题提供可视色块');
const starry = api.get('starry');
ok(/^linear-gradient\(/.test(starry.vars['--bpl-page-bg']) && Number(starry.vars['--bpl-stars-opacity']) > 0,
    '星夜主题提供渐变背景与星空装饰');

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
