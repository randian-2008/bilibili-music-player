(function (root) {
    'use strict';

    const SOURCE_ID = 'netease';
    const LIMITS = [10, 25, 50];
    const CHARTS = [
        ['overview', '综合榜单', [[3778678, '热歌榜'], [3779629, '新歌榜'], [19723756, '飙升榜'], [8246775932, '实时热度榜'], [2884035, '原创榜']]],
        ['chinese', '华语风格', [[5059642708, '国风榜'], [991319590, '中文说唱榜'], [5059633707, '摇滚榜'], [5059661515, '民谣榜'], [6723173524, '网络热歌榜']]],
        ['acg', 'ACG', [[71385702, 'ACG榜'], [3001835560, 'ACG动画榜'], [3001795926, 'ACG游戏榜'], [3001890046, 'ACG VOCALOID榜']]],
        ['language', '语种与地区', [[2809513713, '欧美热歌榜'], [2809577409, '欧美新歌榜'], [745956260, '韩语榜'], [5059644681, '日语榜'], [6732051320, '俄语榜'], [7095271308, '泰语榜']]],
        ['global', '全球榜单', [[180106, 'UK排行榜周榜'], [60198, '美国Billboard榜'], [60131, '日本Oricon榜'], [3812895, 'Beatport电子舞曲榜']]],
        ['genre', '古典与电子', [[71384707, '古典榜'], [1978921795, '电音榜']]]
    ];

    function catalog() {
        return {
            id: SOURCE_ID,
            name: '网易云音乐',
            categories: CHARTS.map(category => ({
                id: category[0], name: category[1],
                charts: category[2].map(chart => ({ id: String(chart[0]), name: chart[1] }))
            }))
        };
    }

    function findChart(chartId) {
        const id = String(chartId || '');
        for (const category of CHARTS) {
            const chart = category[2].find(value => String(value[0]) === id);
            if (chart) return { id, name: chart[1] };
        }
        return null;
    }

    function normalizeResults(tracks) {
        return (Array.isArray(tracks) ? tracks : []).map((track, index) => {
            const artists = Array.isArray(track && track.artists) ? track.artists : (Array.isArray(track && track.ar) ? track.ar : []);
            return {
                rank: index + 1,
                title: String(track && track.name || '').trim(),
                artist: artists.map(value => value && value.name).filter(Boolean).join('/')
            };
        }).filter(song => song.title);
    }

    async function fetchChart(chartId, fetchJson, options) {
        const chart = findChart(chartId);
        if (!chart) throw new Error('不支持的网易云音乐榜单');
        if (typeof fetchJson !== 'function') throw new Error('榜单请求器不可用');
        const requested = Number(options && options.limit);
        const limit = LIMITS.includes(requested) ? requested : 50;
        const payload = await fetchJson('https://music.163.com/api/playlist/detail?id=' + encodeURIComponent(chart.id));
        if (!payload || Number(payload.code) !== 200 || !payload.result) {
            throw new Error(payload && payload.message || '网易云音乐榜单读取失败');
        }
        const items = normalizeResults(payload.result.tracks).slice(0, limit);
        if (!items.length) throw new Error('网易云音乐榜单没有可导入的歌曲');
        return { sourceId: SOURCE_ID, sourceName: '网易云音乐', chartId: chart.id, chartName: chart.name, items };
    }

    root.BPLChartNetease = { SOURCE_ID, LIMITS, catalog, findChart, normalizeResults, fetchChart };
})(typeof globalThis !== 'undefined' ? globalThis : this);
