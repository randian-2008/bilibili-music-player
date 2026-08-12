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

    const replacements = matcher.rankReplacementCandidates({ title: 'JavaScript 入门教程 第一课', duration: 1250 }, [
        { bvid: 'BVUNRELATED01', title: 'JavaScript 音乐混剪', duration: '3:20', rank: 1 },
        { bvid: 'BVCOURSE0001', title: 'JavaScript入门教程 第一课 完整版', duration: '20:48', rank: 2 }
    ]);
    ok(replacements.length && replacements[0].candidate.bvid === 'BVCOURSE0001',
        '通用替代源评分按源标题解释衍生词，并结合标题与时长选择课程视频');
    const songReplacements = matcher.rankReplacementCandidates({ title: '孤单北半球', duration: 0 }, [
        { bvid: 'BVCOVER00001', title: '孤单北半球', typename: '翻唱', tags: 'COVER,男声,翻唱', play: 201, rank: 1 },
        { bvid: 'BVAMBIGUOUS1', title: '孤单北半球', typename: '音乐综合', tags: '歌曲', play: 1075, rank: 12 },
        { bvid: 'BVORIGINAL01', title: '孤单北半球----欧得洋', typename: '音乐综合', tags: '歌曲,流行音乐,听歌', play: 642616, rank: 4 }
    ]);
    ok(songReplacements.length && songReplacements[0].candidate.bvid === 'BVORIGINAL01' &&
        !songReplacements.some(entry => entry.candidate.bvid === 'BVCOVER00001'),
        '先排除与原条目意图冲突的同名翻唱，再按排名和热度选择高可信音源');
    const coverReplacements = matcher.rankReplacementCandidates({ title: '孤单北半球 翻唱', duration: 0 }, [
        { bvid: 'BVCOVER00002', title: '孤单北半球 翻唱完整版', typename: '翻唱', tags: 'COVER,翻唱', play: 3000, rank: 2 }
    ]);
    ok(coverReplacements.length && coverReplacements[0].candidate.bvid === 'BVCOVER00002',
        '原条目本身声明翻唱时不会机械排除翻唱候选');
    const durationReplacements = matcher.rankReplacementCandidates({ title: '完整课程 第一课', duration: 1200 }, [
        { bvid: 'BVSHORTCLIP1', title: '完整课程 第一课', duration: '2:00', rank: 1, play: 100000 },
        { bvid: 'BVFULLCOURSE1', title: '完整课程 第一课 新版', duration: '19:58', rank: 8, play: 2000 }
    ]);
    ok(durationReplacements.length && durationReplacements[0].candidate.bvid === 'BVFULLCOURSE1' &&
        !durationReplacements.some(entry => entry.candidate.bvid === 'BVSHORTCLIP1'),
        '原时长已知时直接排除长度明显不符的同名片段');
    const artistReplacements = matcher.rankReplacementCandidates({ title: '同名歌曲', sourceArtist: '目标歌手' }, [
        { bvid: 'BVPOPULAR001', title: '同名歌曲', author: '其他歌手', rank: 1, play: 100000 },
        { bvid: 'BVARTIST0001', title: '目标歌手《同名歌曲》', author: '音乐账号', rank: 7, play: 10000 }
    ]);
    ok(artistReplacements.length && artistReplacements[0].candidate.bvid === 'BVARTIST0001',
        '原条目带有歌手元数据时优先选择歌手一致的候选');
    ok(matcher.diceSimilarity('完全相同的标题', '完全相同的标题') === 1,
        '通用标题相似度对相同标题返回 1');

    console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
    if (fail) process.exit(1);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
