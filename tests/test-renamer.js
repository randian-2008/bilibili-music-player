const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'rename', 'renamer.js'), 'utf8');
let pass = 0;
let fail = 0;
function ok(condition, message) {
    if (condition) { pass++; console.log('  PASS: ' + message); }
    else { fail++; console.log('  FAIL: ' + message); }
}

const context = { console, Math, JSON, Promise, Date };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(code, context);
const renamer = context.BPLRenamer;

(async () => {
    console.log('[renamer 默认逻辑]');
    let result = await renamer.renameItems([
        { bvid: 'BV1', title: '小吵闹最爱东风破', originalTitle: 'should not survive' },
        { bvid: 'BV2', title: '小吵闹最爱七里香' },
        { bvid: 'BV3', title: '小吵闹最爱晴天' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '东风破|七里香|晴天', '空 rules 仍启用默认公共前缀检测');
    ok(!Object.prototype.hasOwnProperty.call(result[0], 'originalTitle'), '重命名结果不保存 originalTitle');

    result = await renamer.renameItems([
        { title: '* - 周杰伦 - 晴天' },
        { title: '* - 周杰伦 - 夜曲' },
        { title: '* - 周杰伦 - 星晴' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '晴天|夜曲|星晴', '连续公共前缀会继续过滤下一层的歌手或系列名');

    result = await renamer.renameItems([
        { title: '001.周杰伦-晴天' },
        { title: '002.周杰伦-夜曲' },
        { title: '010.周杰伦_Lara梁心颐-珊瑚海' },
        { title: '095.周杰伦_张惠妹-不该' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '晴天|夜曲|珊瑚海|不该', '合作歌手导致首段变长时仍能识别并删除公共歌手前缀');

    result = await renamer.renameItems([
        { title: '歌曲甲你还记得' },
        { title: '歌曲乙你还记得' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '歌曲甲|歌曲乙', '默认逻辑检测并删除公共后缀');

    result = await renamer.renameItems([
        { title: '合集前缀-相思-这是一段很长的页面说明文案' },
        { title: '合集前缀-晴天-这是另一段很长的页面说明文案' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '相思|晴天', '分段后删除超过十个字符的可疑片段');

    result = await renamer.renameItems([{ title: '这是一个超过十个字符的完整歌曲名称' }], { rules: {} });
    ok(result[0].title === '这是一个超过十个字符的完整歌曲名称', '唯一剩余的长片段会被保留');

    result = await renamer.renameItems([{ title: '01 - Song' }], { rules: {} });
    ok(result[0].title === 'Song', '分段后的纯数字序号会作为明确元数据移除');

    result = await renamer.renameItems([
        { title: '在百万豪装录音棚大声听陶喆《孙子兵法》【Hi-res】' },
        { title: '在百万豪装录音棚大声听陶喆《飞机场的10:30》【Hi-res】' },
        { title: '陶喆《Angel》百万豪装录音棚大声听【Hi-res】' },
        { title: '陶喆&蔡依林《今天你要嫁给我》百万豪装录音棚大声听【Hi-res】' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '孙子兵法|飞机场的10:30|Angel|今天你要嫁给我',
        '括号内的连字符不会误分割，混合标题结构会提取书名号内的歌名');
    ok(result.every(item => !/Hi-res|录音棚|[【】]/.test(item.title)),
        '重命名结果不残留音质标签、宣传文案或括号碎片');

    result = await renamer.renameItems([
        { title: '《绝区零》沙罗黄金周「走格子」BGM' },
        { title: '“生旦净末丑，喜怒哀乐愁。”《绝区零》青衣角色曲「红透晚烟青」' },
        { title: '摇起来了！《绝区零》「凯撒」角色展示｜卡吕冬的骑行' },
        { title: '完整版来了！《绝区零》OP | 覆灭重生 Come Alive' },
        { title: '《绝区零》「耀嘉音」角色曲《乐园游梦记》' },
        { title: '百万级录音棚听《绝区零》耀嘉音「闪亮」-天琴座+' },
        { title: '《绝区零》耀嘉音「丽都假日」完整版｜百万级录音棚试听' },
        { title: '边打BOSS边抖腿！《绝区零》侵蚀之剑' },
        { title: '听说多听BGM会出金？《绝区零》抽卡出金BGM' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === [
        '走格子', '红透晚烟青', '卡吕冬的骑行', '覆灭重生 Come Alive', '乐园游梦记',
        '闪亮', '丽都假日', '侵蚀之剑', '抽卡出金'
    ].join('|'), '合集级高频作品标签会被过滤，并从引号或强分隔符后提取歌名');
    ok(result.every(item => !/绝区零|录音棚|[《》「」]/.test(item.title)),
        '系列标签和营销文案不会覆盖已识别的歌曲名');

    result = await renamer.renameItems([
        { title: '无法拒绝的条件 BGM ok' },
        { title: '无法拒绝的条件 ok' },
        { title: '猫没有主人ok' },
        { title: '无法拒绝的条件 BGM · ok' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '无法拒绝的条件|无法拒绝的条件|猫没有主人|无法拒绝的条件',
        '至少三个标题共有的短后缀会按合集统计删除，且不会阻碍 BGM 后缀清理');

    result = await renamer.renameItems([
        { title: '恋爱OK' },
        { title: 'OK Computer' },
        { title: 'Artist - Untitled' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '恋爱OK|OK Computer|Artist - Untitled',
        '未形成批量公共后缀时保留 OK、Untitled 等可能属于歌曲名的内容');

    result = await renamer.renameItems([
        { title: '《任意系列》「角色甲」《百万级录音棚试听》' },
        { title: '《任意系列》「角色乙」《豪装录音棚大声听》' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '百万级录音棚试听|豪装录音棚大声听',
        '核心候选选择不根据特定营销文案内容进行硬编码排除');

    result = await renamer.renameItems([
        { title: '歌曲甲zz' },
        { title: '歌曲乙zz' },
        { title: '歌曲丙zz' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '歌曲甲|歌曲乙|歌曲丙',
        '任意重复短后缀均使用同一统计规则处理，不依赖后缀的具体文本');

    console.log('\n[renamer 静态正则规则]');
    result = await renamer.renameItems([
        { title: 'Track 01 - Alpha' },
        { title: 'Track 02 - Beta' }
    ], { rules: { filters: [{ enabled: true, scope: 'title', pattern: '^Track\\s+\\d+\\s*-\\s*', flags: 'i', replace: '' }] } });
    ok(result.map(item => item.title).join('|') === 'Alpha|Beta', '启用的静态正则规则可以过滤标题');

    result = await renamer.renameItems([{ title: '[Tag] Song' }], {
        rules: { filters: [{ enabled: true, scope: 'title', pattern: '(', flags: '', replace: '' }] }
    });
    ok(result[0].title === 'Song', '非法正则规则被忽略且默认过滤仍可用');

    result = await renamer.renameItems([{ title: 'Song' }], { rules: {}, prefix: '周杰伦 - ' });
    ok(result[0].title === '周杰伦 - Song', '自定义前缀会规范化并添加分隔符');
    result = await renamer.renameItems([{ title: '周杰伦 - Song' }], { rules: {}, prefix: '周杰伦' });
    ok(result[0].title === '周杰伦 - Song', '已有相同前缀时不会重复添加');

    console.log('\n[renamer 受限正则与工作量边界]');
    const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/rename/rules.json'), 'utf8'));
    const enabled = examples.filters.map(rule => ({ ...rule, enabled: true }));
    const normalized = renamer.normalizeRules({ filters: enabled });
    ok(normalized.filters.length === enabled.length, 'rules.json 中每个示例启用后均能编译');
    const exampleInputs = ['[Tag] Song', 'Song，这是一段足够长的说明文案', 'Artist FT. Singer'];
    const exampleExpected = ['Song', 'Song', 'Artist feat Singer'];
    ok(normalized.filters.every((rule, index) =>
        rule.matcher.replace(exampleInputs[index], rule.replacement, { remaining: 25000 }) === exampleExpected[index]),
        '三个现有示例实际执行结果正确');

    const unsupported = [
        '^(a|aa)+$', '^(?:a|aa)+$', '(?:a+)+$', '(?:a{1,8}){1,8}', '(a)',
        '(?=a)a', '(?!b)a', '(?<=a)b', '\\1', '\\k<name>', '\\bword\\b',
        'a+?', 'a**', 'a{241}', 'a{999999999999}', 'a{3,2}', '[a-z', '\\u{61}', '\\cA'
    ];
    ok(unsupported.every(pattern => !renamer.normalizeRules({ filters: [{ pattern }] }).filters.length),
        '分组量词、捕获与回溯引用、断言及不支持语法均在执行前拒绝');
    ok(!renamer.normalizeRules({ filters: [{ pattern: 'a', flags: 'gg' }] }).filters.length,
        '重复 flags 被拒绝');
    ok(!renamer.normalizeRules({ filters: [{ pattern: 'a{240}b{240}c{240}' }] }).filters.length,
        '量词展开超过状态上限的规则被拒绝');

    const equivalentCases = [
        ['a*a*ab', '', 'aaaab', 'X'], ['a*a*a*b$', '', 'aaaa!', 'X'],
        ['a?aa?', 'g', 'aaaaa', '<$&>'], ['(?:ab|a)b?', 'g', 'a abb ab', '[$&]'],
        ['(?:a|ab)b?', '', 'abb', 'X'], ['a{0,3}a{1,2}b', '', 'aaaaab', 'X'],
        ['(?:|a)', 'g', 'aba', '_'], ['[a-z]+', 'gi', 'AZ 中文 abc', '$$:$&'],
        ['^a+$', 'gm', 'aa\nb\raa\u2028a', 'X'], ['\\u4e2d[文语]+', '', '中文文', 'X'],
        ['\\x61\\d{1,3}', 'g', 'a12 a2345', 'N'], ['\\w+\\s+\\W', 'g', 'abc !', 'X'],
        ['a$', '', 'a\n', 'X'], ['^', 'gm', 'ab\ncd', '>'], ['$', 'gm', 'ab\ncd', '<'],
        ['.', 'g', '😀中', '$&'], ['a', '', 'bac', "$`/$&/$'/$$/$1"]
    ];
    ok(equivalentCases.every(([pattern, flags, input, replacement]) => {
        const rule = renamer.normalizeRules({ filters: [{ pattern, flags, replace: replacement }] }).filters[0];
        return rule && rule.matcher.replace(input, replacement, { remaining: 25000 }) === input.replace(new RegExp(pattern, flags), replacement);
    }), '支持语法的贪婪、分支优先、空匹配、多行、字符集及替换标记与 JavaScript 行为一致');

    // Fixed deterministic combinations exercise overlapping quantifiers without trusting wall-clock benchmarks.
    const atoms = ['a*', 'a?', '[ab]+', 'b{0,3}', '(?:ab|a)', '\\s*'];
    const inputs = ['', 'a', 'aaaaab', 'ababab!', 'aa bb', 'bbaa'];
    let equivalent = true;
    for (const first of atoms) for (const second of atoms) {
        const pattern = first + second + 'b?';
        const rule = renamer.normalizeRules({ filters: [{ pattern, flags: 'g' }] }).filters[0];
        for (const input of inputs) {
            if (rule.matcher.replace(input, '<$&>', { remaining: 25000 }) !== input.replace(new RegExp(pattern, 'g'), '<$&>')) equivalent = false;
        }
    }
    ok(equivalent, '216 组短字符串交叉验证覆盖重叠量词与分支组合');

    context.adversarialRules = { filters: [
        { scope: 'title', pattern: '^(a|aa)+$', replace: '' },
        { scope: 'title', pattern: '^a*a*a*a*a*a*a*a*a*a*b$', replace: '' },
        { scope: 'title', pattern: '^' + 'a?'.repeat(100) + 'b$', replace: '' }
    ] };
    context.adversarialTitle = 'a'.repeat(239) + '!';
    // VM timeout ensures a future accidental native-regex regression fails this test instead of hanging the suite.
    vm.runInContext('globalThis.adversarialResult = BPLRenamer.renameItems([{ title: adversarialTitle }], { rules: adversarialRules });', context, { timeout: 1000 });
    result = await context.adversarialResult;
    ok(result[0].title === context.adversarialTitle, '指数/多项式回溯形状不会阻塞，无法匹配时保留默认结果');

    const expensive = renamer.normalizeRules({ filters: [{ pattern: '^a{0,120}a{0,120}b$' }] }).filters[0];
    const tinyBudget = { remaining: 20 };
    let exhausted = false;
    try { expensive.matcher.replace('a'.repeat(200) + '!', '', tinyBudget); }
    catch (error) { exhausted = /work limit/.test(error.message); }
    ok(exhausted && tinyBudget.remaining < 0, '匹配器执行步数达到预算会立即中止');

    const growthRules = { filters: Array.from({ length: 32 }, () => ({
        scope: 'title', pattern: '.', flags: 'g', replace: 'Z'.repeat(200)
    })) };
    context.growthRules = growthRules;
    vm.runInContext('globalThis.growthResult = BPLRenamer.renameItems([{ title: "Song" }], { rules: growthRules });', context, { timeout: 1000 });
    result = await context.growthResult;
    ok(result[0].title.length === 240, '连续替换不能使中间标题指数膨胀，输出限制为 240 个字符');
    const growth = renamer.normalizeRules({ filters: [{ pattern: '(?:)', flags: 'g', replace: "$`$&$'" }] }).filters[0];
    ok(growth.matcher.replace('x'.repeat(240), growth.replacement, { remaining: 25000 }).length === 240,
        '零宽全局匹配与上下文替换标记同样受到长度限制');

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(error => { console.error('测试异常:', error); process.exit(1); });
