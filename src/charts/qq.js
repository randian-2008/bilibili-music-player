(function (root) {
    'use strict';

    const SOURCE_ID = 'qq';
    const LIMITS = [10, 25, 50];
    const CHARTS = [
        ['overview', '综合榜单', [[4, '流行指数'], [26, '热歌榜'], [27, '新歌榜'], [62, '飙升榜']]],
        ['chinese', '华语与地区', [[78, '国乐榜'], [28, '网络歌曲榜'], [5, '内地榜'], [59, '香港地区榜'], [61, '台湾地区榜'], [65, '国风热歌榜']]],
        ['global', '海外榜单', [[3, '欧美榜'], [16, '韩国榜'], [17, '日本榜']]],
        ['genre', '风格榜单', [[58, '说唱榜'], [57, '电音榜'], [63, 'DJ舞曲榜'], [72, '动漫音乐榜'], [73, '游戏音乐榜']]],
        ['scene', '场景与趋势', [[60, '抖音热歌榜'], [29, '影视金曲榜'], [36, 'K歌金曲榜'], [64, '综艺新歌榜'], [67, '听歌识曲榜'], [201, 'MV榜'], [75, '有声榜']]]
    ];

    function catalog() {
        return {
            id: SOURCE_ID,
            name: 'QQ音乐',
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

    function normalizeResults(songList) {
        return (Array.isArray(songList) ? songList : []).map((entry, index) => {
            const song = entry && (entry.data || entry) || {};
            const singers = Array.isArray(song.singer) ? song.singer.map(value => value && value.name).filter(Boolean).join('/') : '';
            return {
                rank: index + 1,
                title: String(song.songname || song.songName || '').trim(),
                artist: String(singers || song.singername || '').trim()
            };
        }).filter(song => song.title);
    }

    async function fetchChart(chartId, fetchJson, options) {
        const chart = findChart(chartId);
        if (!chart) throw new Error('不支持的 QQ 音乐榜单');
        if (typeof fetchJson !== 'function') throw new Error('榜单请求器不可用');
        const requested = Number(options && options.limit);
        const limit = LIMITS.includes(requested) ? requested : 50;
        const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?format=json&page=detail&type=top' +
            '&topid=' + encodeURIComponent(chart.id) + '&song_begin=0&song_num=' + limit;
        const payload = await fetchJson(url);
        if (!payload || Number(payload.code) !== 0) throw new Error(payload && payload.message || 'QQ 音乐榜单读取失败');
        const items = normalizeResults(payload.songlist).slice(0, limit);
        if (!items.length) throw new Error('QQ 音乐榜单没有可导入的歌曲');
        return { sourceId: SOURCE_ID, sourceName: 'QQ音乐', chartId: chart.id, chartName: chart.name, items };
    }

    root.BPLChartQQ = { SOURCE_ID, LIMITS, catalog, findChart, normalizeResults, fetchChart };
})(typeof globalThis !== 'undefined' ? globalThis : this);
