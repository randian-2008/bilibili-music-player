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
        { title: '歌曲乙你还记得' },
        { title: '歌曲丙你还记得' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '歌曲甲|歌曲乙|歌曲丙', '至少三个不同标题支持时才删除无分隔符公共后缀');

    result = await renamer.renameItems([
        { title: '合集前缀-相思-这是一段很长的页面说明文案' },
        { title: '合集前缀-晴天-这是另一段很长的页面说明文案' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '相思 - 这是一段很长的页面说明文案|晴天 - 这是另一段很长的页面说明文案',
        '删除有批量依据的公共前缀，但不只凭长度丢弃含义不明的剩余片段');

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
    ok(result.map(item => item.title).join('|') === '「角色甲」《百万级录音棚试听》|「角色乙」《豪装录音棚大声听》',
        '移除已确认的系列标签后保留多个不确定名称，不按位置或宣传文案词表猜测');

    result = await renamer.renameItems([
        { title: '歌曲甲zz' },
        { title: '歌曲乙zz' },
        { title: '歌曲丙zz' }
    ], { rules: {} });
    ok(result.map(item => item.title).join('|') === '歌曲甲|歌曲乙|歌曲丙',
        '任意重复短后缀均使用同一统计规则处理，不依赖后缀的具体文本');

    console.log('\n[renamer 真实合集与结构回归]');
    const collection = require('./fixtures/collection-titles.json');
    result = await renamer.renameItems(collection.titles.map(title => ({ title })), { rules: {} });
    ok(result.slice(0, 22).every((item, index) => item.title.startsWith(collection.titles[index].split(' -')[0])),
        '真实混合合集的前 22 条保留歌曲主体，不再全部变成 Hi');
    ok(result.every(item => !/Hi|Res|无损音质|𝐇𝐢|𝐑𝐞𝐬/.test(item.title)), '完整重复音质块按统计去除，支持字体变体');
    ok(result[25].title === '画离弦' && result[24].title.startsWith('江湖如梦'), '引号内歌名正确提取，歧义歌词不覆盖左侧歌名');
    for (const label of ['Studio-Edition附加说明', '另一种任意标签']) {
        const renamed = await renamer.renameItems(['春风', '夏夜', '秋雨'].map(title => ({ title: title + ' | ' + label })), { rules: {} });
        ok(renamed.map(item => item.title).join('|') === '春风|夏夜|秋雨', '统计规则不依赖具体音质标签：' + label);
    }
    result = await renamer.renameItems([{ title: '春风 | 副标题' }], { rules: {} });
    ok(result[0].title === '春风 - 副标题', '只有分隔符时保留两侧不确定内容，不擅自舍弃左侧');
    result = await renamer.renameItems(['春风', '夏夜', '秋雨'].map(title => ({ title: '共同说明 | ' + title })), { rules: {} });
    ok(result.map(item => item.title).join('|') === '春风|夏夜|秋雨', '重复完整前置说明与后置说明采用一致规则');

    console.log('\n[renamer 保守过滤边界]');
    const preservedBatches = [
        ['不能说的秘密', '不能说的再见'],
        ['不能说的秘密', '不能说的秘密', '不能说的再见'],
        ['歌曲甲你还记得', '歌曲乙你还记得'],
        ['我爱你', '谁爱你', '偏爱你'],
        ['Running', 'Runner', 'Runway'],
        ['Shopping', 'Shipping', 'Hopping'],
        ['[真实歌名] 作者'],
        ['(Stay) Artist'],
        ['（真实歌名） 作者'],
        ['〔只有歌名〕'],
        ['[未知标签] 晴天', '[未知标签] 晴天', '[未知标签] 夜曲'],
        ['青春！未完'],
        ['非常长的完整名称（另一个版本） - 短片段'],
        ['这是一个很长但是完整的歌曲名字 - 作者'],
        ['这是一个很长但是完整的歌曲名字 - 这是另外一个长标题名称'],
        ['春日笔记 | 这是很长但是有实际意义的副标题'],
        ['《晴天》与《夜曲》串烧'],
        ['《长标题中的上半部分》 / 《另一个很长的下半部分》'],
        ['《第一首》《第二首》'],
        ['我喜欢的歌曲 | 片段一']
    ];
    for (const titles of preservedBatches) {
        const renamed = await renamer.renameItems(titles.map(title => ({ title })), { rules: {} });
        // Separators may be normalized; the title content must not be dropped.
        const normalized = titles.map(title => title.replace(/\s*\|\s*/g, ' - '));
        ok(renamed.map(item => item.title).join('|') === normalized.join('|'), '不足以删除时保留：' + titles.join(' / '));
    }
    result = await renamer.renameItems(['SongOP | 备注', 'Hope | 文案', 'Mixed | 提示'].map(title => ({ title })), { rules: {} });
    ok(result.map(item => item.title).join('|') === 'SongOP - 备注|Hope - 文案|Mixed - 提示', '英文缩写不匹配单词内部，也不据此丢弃左侧');
    result = await renamer.renameItems(['晴天', '夜曲', '稻香'].map(title => ({ title: '[共同频道] ' + title })), { rules: {} });
    ok(result.map(item => item.title).join('|') === '晴天|夜曲|稻香', '三个不同标题支持时移除共同括号标签');
    for (const separator of [' | ', ' - ']) {
        result = await renamer.renameItems(['短标题', '短标题', '另一首'].map(title => ({ title: title + separator + '任意说明' })), { rules: {} });
        const unique = await renamer.renameItems(['短标题', '另一首'].map(title => ({ title: title + separator + '任意说明' })), { rules: {} });
        ok(result.map(item => item.title).join('|') === '短标题|短标题|另一首' && unique.map(item => item.title).join('|') === '短标题|另一首',
            '完整分段采用一致的两条不同标题证据，重复项不改变结论：' + separator.trim());
    }
    result = await renamer.renameItems(['不能说的秘密', '不能说的再见', '不能说的爱你'].map(title => ({ title: '《' + title + '》作者' })), { rules: {} });
    ok(result.map(item => item.title).join('|') === '不能说的秘密|不能说的再见|不能说的爱你', '明确引号内的歌曲名称不会再按公共前缀截短');
    result = await renamer.renameItems(['《晴天》甲作者', '《晴天》乙作者', '《晴天》丙作者'].map(title => ({ title })), { rules: {} });
    ok(result.every(item => item.title === '晴天'), '同一歌曲的不同版本不因重复引号被当成系列标签');
    result = await renamer.renameItems(['《晴天》 | 甲作者', '《晴天》 | 乙作者', '《晴天》 | 丙作者'].map(title => ({ title })), { rules: {} });
    ok(result.every(item => item.title === '晴天'), '完整重复块过滤同样保护引号内的真实标题');
    result = await renamer.renameItems(['《STOP》', '《Hope》', '《Mixed》', '「梦-序章」', '『夜，回声』', '《夜に駆ける》'].map(title => ({ title })), { rules: {} });
    ok(result.map(item => item.title).join('|') === 'STOP|Hope|Mixed|梦-序章|夜，回声|夜に駆ける', '明确标题中的缩写、分隔符和非汉字文字完整保留');
    result = await renamer.renameItems([{ title: 'Song BGM' }, { title: '抽卡出金BGM' }], { rules: {} });
    ok(result.map(item => item.title).join('|') === 'Song|抽卡出金', '独立英文描述词和汉字旁的标记仍可正常清理');
    result = await renamer.renameItems([{ title: '𝄞𝄞𝄞𝄞𝄞𝄞 - 短名' }], { rules: {} });
    ok(result[0].title === '𝄞𝄞𝄞𝄞𝄞𝄞 - 短名', '包含代理对字符的片段同样完整保留');
    for (const separator of [' | ', ' - ']) {
        const titles = ['作者甲', '作者乙'].flatMap(author => ['曲目甲', '曲目乙'].map(title => author + separator + title));
        result = await renamer.renameItems(titles.map(title => ({ title })), { rules: {} });
        ok(result.every((item, index) => item.title === titles[index]), '两侧都重复时不猜测哪侧应删除：' + separator.trim());
    }
    result = await renamer.renameItems([{ title: 'OP | 歌曲正文 | 不确定的附加信息' }], { rules: {} });
    ok(result[0].title === '歌曲正文 - 不确定的附加信息', '明确上下文后仍保留多个不确定片段，不盲取最后一段');
    result = await renamer.renameItems([{ title: '01. 这是一个很长但是完整的歌曲名字 - 作者' }], { rules: {} });
    ok(result[0].title === '这是一个很长但是完整的歌曲名字 - 作者', '清理明确序号不引发后续长度误删');
    const uncertain = ['[共同频道] 不能说的秘密', '[共同频道] 不能说的再见'];
    const lessEvidence = await renamer.renameItems(uncertain.map(title => ({ title })), { rules: {} });
    ok(lessEvidence.every((item, index) => item.title === uncertain[index]), '样本不足时同时保留未知标签和相似歌名，不连锁缩短');
    const batch = collection.titles.concat(preservedBatches.flat()).map((title, id) => ({ id, title }));
    const inputSnapshot = JSON.stringify(batch);
    const baseline = await renamer.renameItems(batch, { rules: {} });
    const reversed = await renamer.renameItems(batch.slice().reverse(), { rules: {} });
    const duplicated = await renamer.renameItems(batch.concat(batch.slice(0, 7)), { rules: {} });
    const namesById = new Map(baseline.map(item => [item.id, item.title]));
    ok(reversed.concat(duplicated).every(item => item.title === namesById.get(item.id)), '改变导入顺序或增加重复副本不会改变统计结果');
    ok(JSON.stringify(batch) === inputSnapshot && baseline.every((item, index) => item !== batch[index] && item.id === batch[index].id && item.title),
        '批处理保持输入对象与条目身份不变，始终返回非空的新对象');

    console.log('\n[renamer BGM 标签与原标题核对]');
    const musicTag = name => ({ tag_type: 'bgm', tag_name: '发现《' + name + '》', music_id: 'MA-test' });
    for (const [name, title, expected] of [
        ['画离弦', '《画离弦》等什么君 | 怎将情话递心间', '画离弦'],
        ['游山恋', '游山恋 - 崔天琪&韩晴 | 无损音质', '游山恋'],
        ['Ｈｅｌｌｏ World', 'Artist - hello   world - Version', 'Ｈｅｌｌｏ World'],
        ['晴天', '周杰伦 - 晴 天', '晴天'],
        ['晴天', '总有一个晴天来临', ''],
        ['爱', '爱情转移', ''],
        ['爱', '作者《爱》', '爱'],
        ['Love', 'Glove', ''],
        ['Love', 'Love Story', 'Love'],
        ['A+B (Live)', 'Artist - A+B (Live)', 'A+B (Live)'],
        ['相思', '想思', ''],
        ['甲曲', '《乙曲》', '']
    ]) {
        ok(renamer.selectBgmTitle([musicTag(name)], [title]) === expected, '音乐标签交叉验证：' + name + ' / ' + title);
    }
    ok(renamer.selectBgmTitle([{ ...musicTag('晴天'), tag_type: 'old_channel' }], ['晴天']) === '', '普通标签即使与标题一致也不作为已确认曲名');
    ok(renamer.selectBgmTitle([musicTag('晴天'), musicTag('夜曲')], ['《晴天》与《夜曲》串烧']) === '', '多个不同曲名均命中时回退，不按接口顺序选取');
    ok(renamer.selectBgmTitle([musicTag('晴天'), musicTag('晴天')], ['《晴天》']) === '晴天', '相同音乐标签重复出现不构成歧义');
    ok(renamer.selectBgmTitle([musicTag('画离弦')], ['画离', '弦']) === '', '不同来源字段不能拼成标签曲名');
    ok(renamer.selectBgmTitle([null, { tag_type: 'bgm' }, { ...musicTag('晴天'), tag_name: '发现《晴天' }], ['晴天']) === '',
        '不完整标签或损坏的包装文本不作为确认结果');
    const names = ['不能说的秘密', '不能说的再见', '不能说的爱你'];
    result = await renamer.renameItems(names.map(title => ({ title: title + ' - 作者' })), {
        rules: {}, bgmTags: names.map(title => [musicTag(title)]), prefix: '自定义'
    });
    ok(result.every((item, index) => item.title === '自定义 - ' + names[index]), '标签确认的曲名不再被公共前后缀截短，统一前缀仍会添加');
    result = await renamer.renameItems([{ title: '视频标题 | 画离弦 - 作者' }], {
        rules: {}, bgmTags: [[musicTag('画离弦')]], titleSources: [['视频标题', '画离弦 - 作者']]
    });
    ok(result[0].title === '画离弦', '独立的原视频标题与对应分P标题均可提供真实匹配证据');
    const fallbackInput = [{ title: '较长但不能随意删除的标题 - 短片段' }];
    const withoutTags = await renamer.renameItems(fallbackInput, { rules: {} });
    const unmatchedTags = await renamer.renameItems(fallbackInput, { rules: {}, bgmTags: [[musicTag('不存在的歌')]] });
    ok(unmatchedTags[0].title === withoutTags[0].title, '标签不匹配时完整沿用保守的本地规则');
    result = await renamer.renameItems([{ title: '画离弦 - 作者' }], {
        rules: { filters: [{ scope: 'title', pattern: '^画离弦$', replace: '用户指定名' }] }, bgmTags: [[musicTag('画离弦')]]
    });
    ok(result[0].title === '用户指定名', '主动启用的自定义规则仍能调整标签确认后的名称');
    result = await renamer.renameItems([{ title: '原始文本' }], {
        rules: { filters: [{ scope: 'title', pattern: '^原始文本$', replace: '画离弦 - 附加信息' }] }, bgmTags: [[musicTag('画离弦')]]
    });
    ok(result[0].title === '画离弦 - 附加信息', '自定义规则新生成的文字不能伪造原始标题与标签一致的证据');

    console.log('\n[renamer 静态正则规则]');
    result = await renamer.renameItems([
        { title: 'Track 01 - Alpha' },
        { title: 'Track 02 - Beta' }
    ], { rules: { filters: [{ enabled: true, scope: 'title', pattern: '^Track\\s+\\d+\\s*-\\s*', flags: 'i', replace: '' }] } });
    ok(result.map(item => item.title).join('|') === 'Alpha|Beta', '启用的静态正则规则可以过滤标题');

    result = await renamer.renameItems([{ title: '[Tag] Song' }], {
        rules: { filters: [{ enabled: true, scope: 'title', pattern: '(', flags: '', replace: '' }] }
    });
    ok(result[0].title === '[Tag] Song', '非法正则规则被忽略，未知括号内容不会被默认规则盲删');
    result = await renamer.renameItems([{ title: '[Tag] Song' }], {
        rules: { filters: [{ enabled: true, scope: 'segment', pattern: '^\\[[^\\]]+\\]\\s*', replace: '' }] }
    });
    ok(result[0].title === 'Song', '用户明确启用的括号删除规则仍可覆盖保守默认行为');

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
