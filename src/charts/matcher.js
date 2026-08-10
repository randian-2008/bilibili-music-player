(function (root) {
    'use strict';

    const POSITIVE_WORDS = ['official', '官方', '完整版', '高音质', '无损', 'mv', '歌词'];
    const NEGATIVE_WORDS = ['翻唱', '伴奏', '教程', '教学', 'reaction', '反应', '解说', '盘点', '片段', '加速', '慢速', 'remix'];

    function stripHtml(value) {
        return String(value || '')
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .trim();
    }

    function compact(value) {
        return stripHtml(value).toLowerCase().replace(/[\s\-—_·•|｜/\\:：,，.。!！?？'"“”‘’()（）\[\]【】《》<>]/g, '');
    }

    function parseDuration(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
        const parts = String(value || '').trim().split(':').map(Number);
        if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return 0;
        return parts.reduce((total, part) => total * 60 + part, 0);
    }

    function scoreCandidate(song, candidate) {
        const sourceTitle = compact(song && song.title);
        const sourceArtist = compact(song && song.artist);
        const titleText = stripHtml(candidate && candidate.title);
        const title = compact(titleText);
        const author = compact(candidate && candidate.author);
        if (!sourceTitle || !title) return -Infinity;

        let score = 0;
        if (title === sourceTitle) score += 42;
        else if (title.includes(sourceTitle)) score += 30;
        else if (sourceTitle.includes(title) && title.length >= 3) score += 12;

        if (sourceArtist) {
            if (title.includes(sourceArtist)) score += 14;
            else if (author.includes(sourceArtist)) score += 10;
        }

        const lower = titleText.toLowerCase();
        for (const word of POSITIVE_WORDS) if (lower.includes(word)) score += 3;
        for (const word of NEGATIVE_WORDS) if (lower.includes(word)) score -= 9;

        const duration = parseDuration(candidate && candidate.duration);
        if (duration >= 90 && duration <= 600) score += 6;
        else if (duration > 0 && duration < 60) score -= 16;
        else if (duration > 900) score -= 8;

        return score;
    }

    function chooseCandidate(song, candidates, manual) {
        let best = null;
        for (const candidate of (Array.isArray(candidates) ? candidates : [])) {
            if (!candidate || !candidate.bvid) continue;
            const score = scoreCandidate(song, candidate);
            if (!best || score > best.score) best = { candidate, score };
        }
        const minimum = manual ? 18 : 24;
        return best && best.score >= minimum ? best : null;
    }

    root.BPLChartMatcher = { stripHtml, compact, parseDuration, scoreCandidate, chooseCandidate };
})(typeof globalThis !== 'undefined' ? globalThis : this);
