const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(condition, message) {
    if (condition) { pass++; console.log('  PASS: ' + message); }
    else { fail++; console.log('  FAIL: ' + message); }
}

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'charts', 'apple.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'charts', 'qq.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'charts', 'netease.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'charts', 'matcher.js'), 'utf8'), context);

(async () => {
    console.log('[charts Apple 榜单适配器]');
    const catalog = context.BPLChartApple.catalog();
    ok(catalog.id === 'apple' && catalog.categories[0].charts[0].id === 'cn-most-played-songs',
        '目录保留“平台 → 分类 → 榜单”三级结构');

    const chart = await context.BPLChartApple.fetchChart('cn-most-played-songs', async url => ({
        feed: { results: [
            { name: '晴天', artistName: '周杰伦', id: 'ignored', artworkUrl100: 'ignored' },
            { name: '七里香', artistName: '周杰伦' },
            { name: '', artistName: '空标题' }
        ] }
    }));
    ok(chart.items.length === 2 && chart.items[0].rank === 1 && chart.items[0].title === '晴天' && chart.items[0].artist === '周杰伦',
        '只归一化排名、歌曲名和歌手名');
    ok(Object.keys(chart.items[0]).sort().join(',') === 'artist,rank,title',
        'Apple 封面、链接和歌曲 ID 不进入统一榜单条目');
    let appleUrl = '';
    await context.BPLChartApple.fetchChart('cn-most-played-songs', async url => {
        appleUrl = url;
        return { feed: { results: [{ name: '测试', artistName: '歌手' }] } };
    }, { limit: 25 });
    ok(appleUrl.includes('/25/songs.json'), 'Apple 适配器按用户选择请求 10/25/50 条');

    console.log('\n[charts QQ 音乐适配器]');
    const qqCatalog = context.BPLChartQQ.catalog();
    ok(qqCatalog.categories.some(value => value.charts.some(chart => chart.name === '国风热歌榜')),
        'QQ 音乐目录包含分类及国风榜单');
    let qqUrl = '';
    const qqChart = await context.BPLChartQQ.fetchChart('65', async url => {
        qqUrl = url;
        return { code: 0, songlist: [
            { data: { songname: '东风破', singer: [{ name: '周杰伦' }], albummid: 'ignored' } },
            { data: { songname: '牵丝戏', singer: [{ name: '银临' }, { name: 'Aki阿杰' }] } }
        ] };
    }, { limit: 10 });
    ok(qqUrl.includes('topid=65') && qqUrl.includes('song_num=10') && qqChart.items[1].artist === '银临/Aki阿杰',
        'QQ 详情接口按榜单和数量拉取并归一化歌手');
    ok(Object.keys(qqChart.items[0]).sort().join(',') === 'artist,rank,title', 'QQ 统一条目不保存平台资源字段');

    console.log('\n[charts 网易云音乐适配器]');
    const neteaseCatalog = context.BPLChartNetease.catalog();
    ok(neteaseCatalog.categories.some(value => value.charts.some(chart => chart.name === 'ACG榜')),
        '网易云目录包含分类及 ACG 榜单');
    const neteaseChart = await context.BPLChartNetease.fetchChart('71385702', async url => ({
        code: 200,
        result: { tracks: [
            { name: '动画主题曲', artists: [{ name: '歌手甲' }] },
            { name: '游戏配乐', ar: [{ name: '歌手乙' }, { name: '歌手丙' }] }
        ] }
    }), { limit: 25 });
    ok(neteaseChart.items.length === 2 && neteaseChart.items[1].artist === '歌手乙/歌手丙',
        '网易云适配器兼容 artists 与 ar 两种歌手字段');
    ok(Object.keys(neteaseChart.items[0]).sort().join(',') === 'artist,rank,title', '网易云统一条目不保存平台资源字段');

    console.log('\n[charts B站候选评分]');
    const matcher = context.BPLChartMatcher;
    const song = { title: '晴天', artist: '周杰伦' };
    const best = matcher.chooseCandidate(song, [
        { bvid: 'BVSHORT00001', title: '晴天 片段', author: '路人', duration: '0:25' },
        { bvid: 'BVBEST000001', title: '周杰伦《晴天》官方MV', author: '音乐账号', duration: '4:29' },
        { bvid: 'BVCOVER00001', title: '晴天 翻唱教程', author: '教学账号', duration: '8:12' }
    ], false);
    ok(best && best.candidate.bvid === 'BVBEST000001', '歌曲名、歌手、时长和负面词共同参与通用评分');
    ok(matcher.parseDuration('1:02:03') === 3723 && matcher.stripHtml('<em>晴天</em>') === '晴天',
        '搜索结果时长和高亮标题可正常归一化');

    console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
    if (fail) process.exit(1);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
