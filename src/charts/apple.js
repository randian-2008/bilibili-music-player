(function (root) {
    'use strict';

    const SOURCE_ID = 'apple';
    const CHART_ID = 'cn-most-played-songs';
    const FEED_BASE = 'https://rss.applemarketingtools.com/api/v2/cn/music/most-played/';
    const LIMITS = [10, 25, 50];

    function catalog() {
        return {
            id: SOURCE_ID,
            name: 'Apple Music',
            categories: [{
                id: 'popular',
                name: '热门榜单',
                charts: [{ id: CHART_ID, name: '中国区热门歌曲' }]
            }]
        };
    }

    function normalizeResults(results) {
        return (Array.isArray(results) ? results : []).map((song, index) => ({
            rank: index + 1,
            title: String(song && song.name || '').trim(),
            artist: String(song && song.artistName || '').trim()
        })).filter(song => song.title);
    }

    function normalizeLimit(value) {
        const limit = Number(value);
        return LIMITS.includes(limit) ? limit : 50;
    }

    async function fetchChart(chartId, fetchJson, options) {
        if (chartId !== CHART_ID) throw new Error('不支持的 Apple Music 榜单');
        if (typeof fetchJson !== 'function') throw new Error('榜单请求器不可用');
        const limit = normalizeLimit(options && options.limit);
        const payload = await fetchJson(FEED_BASE + limit + '/songs.json');
        const items = normalizeResults(payload && payload.feed && payload.feed.results).slice(0, limit);
        if (!items.length) throw new Error('Apple Music 榜单没有可导入的歌曲');
        return {
            sourceId: SOURCE_ID,
            sourceName: 'Apple Music',
            chartId: CHART_ID,
            chartName: '中国区热门歌曲',
            items: items
        };
    }

    root.BPLChartApple = {
        SOURCE_ID,
        CHART_ID,
        FEED_BASE,
        LIMITS,
        FEED_URL: FEED_BASE + '50/songs.json',
        catalog,
        normalizeLimit,
        normalizeResults,
        fetchChart
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
