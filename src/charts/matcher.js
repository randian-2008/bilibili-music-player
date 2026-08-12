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

    function bigrams(value) {
        const text = compact(value);
        if (text.length < 2) return text ? [text] : [];
        const result = [];
        for (let index = 0; index < text.length - 1; index++) result.push(text.slice(index, index + 2));
        return result;
    }

    function diceSimilarity(left, right) {
        const a = bigrams(left);
        const b = bigrams(right);
        if (!a.length || !b.length) return 0;
        const counts = new Map();
        for (const value of a) counts.set(value, (counts.get(value) || 0) + 1);
        let common = 0;
        for (const value of b) {
            const count = counts.get(value) || 0;
            if (!count) continue;
            common++;
            counts.set(value, count - 1);
        }
        return (2 * common) / (a.length + b.length);
    }

    const DERIVATIVE_GROUPS = [
        { words: ['翻唱', 'cover'] },
        { words: ['伴奏', 'karaoke', '卡拉ok', '纯音乐'] },
        { words: ['改编', '重制', 'remix', 'rework', '重新演绎', '老歌新唱', 'suno', 'ai翻唱', 'ai合成'] },
        { words: ['教程', '教学', '曲谱', '乐谱', '鼓谱', '吉他谱'] },
        { words: ['舞台', '现场', '演唱会', '直拍', 'live', '纯享', '合唱', '对唱', '弹唱', '演奏'] },
        { words: ['舞蹈', '跟练', '健身', '燃脂', '有氧'] },
        { words: ['片段', '剪辑', '混剪', '二创', '粉丝创作', 'reaction', '反应', '解说', '盘点'] },
        { words: ['加速', '慢速', 'slowed', 'reverb', '升调', '降调', '变调'] }
    ];
    const AUTHENTIC_GROUPS = [
        { words: ['官方', 'official'], bonus: 4 },
        { words: ['正版', '原版', '原唱', '原声', 'mv'], bonus: 2 },
        { words: ['无损', 'hi-res', 'hifi', '高音质', 'cd音轨', '录音棚', '黑胶'], bonus: 2 }
    ];

    function containsMarker(text, marker) {
        text = String(text || '').toLowerCase();
        marker = String(marker || '').toLowerCase();
        if (!marker) return false;
        if (!/^[a-z0-9]+$/.test(marker)) return text.includes(marker);
        const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text);
    }

    function hasAnyMarker(text, words) {
        return words.some(word => containsMarker(text, word));
    }

    function replacementMetadata(candidate) {
        return [candidate && candidate.title, candidate && candidate.author,
            candidate && candidate.typename, candidate && candidate.tags,
            candidate && candidate.description]
            .filter(Boolean).join(' ');
    }

    function hasDerivativeConflict(sourceText, candidateText) {
        return DERIVATIVE_GROUPS.some(group =>
            !hasAnyMarker(sourceText, group.words) && hasAnyMarker(candidateText, group.words));
    }

    function authenticityBonus(candidateText) {
        let score = 0;
        for (const group of AUTHENTIC_GROUPS) {
            if (hasAnyMarker(candidateText, group.words)) score += group.bonus;
        }
        return Math.min(6, score);
    }

    function searchRankBonus(value) {
        const rank = Number(value) || 0;
        return rank > 0 ? Math.max(0, 12 - (rank - 1) * 0.5) : 0;
    }

    function popularityBonus(value) {
        const plays = Math.max(0, Number(value) || 0);
        return plays > 0 ? Math.min(14, Math.log10(plays + 1) * 2.2) : 0;
    }

    // Replacement matching stays content-neutral by interpreting derivative
    // markers relative to the source title. A tutorial may replace a tutorial,
    // but an undeclared cover/tutorial/live edit is not an equivalent source.
    function scoreReplacementCandidate(item, candidate) {
        const sourceTitle = compact(item && item.title);
        const candidateTitle = compact(candidate && candidate.title);
        if (!sourceTitle || !candidateTitle) return -Infinity;

        let score = Math.round(diceSimilarity(sourceTitle, candidateTitle) * 55);
        if (candidateTitle === sourceTitle) score += 3;
        else if (candidateTitle.includes(sourceTitle)) score += 8;
        else if (sourceTitle.includes(candidateTitle) && candidateTitle.length >= 4) score += 6;

        const sourceText = stripHtml(item && item.title).toLowerCase();
        const candidateText = replacementMetadata(candidate).toLowerCase();
        if (hasDerivativeConflict(sourceText, candidateText)) return -Infinity;
        score += authenticityBonus(candidateText);

        const sourceArtist = compact(item && (item.sourceArtist || item.artist));
        const sourceOwner = compact(item && item.owner);
        const candidateMetadata = compact(candidateText);
        const candidateAuthor = compact(candidate && candidate.author);
        if (sourceArtist) score += candidateMetadata.includes(sourceArtist) ? 16 : -12;
        if (sourceOwner && candidateAuthor === sourceOwner) score += 8;

        score += searchRankBonus(candidate && candidate.rank);
        score += popularityBonus(candidate && candidate.play);

        const sourceDuration = parseDuration(item && item.duration);
        const candidateDuration = parseDuration(candidate && candidate.duration);
        if (sourceDuration > 0 && candidateDuration > 0) {
            const ratio = Math.abs(sourceDuration - candidateDuration) / Math.max(sourceDuration, candidateDuration);
            if (ratio > 0.5) return -Infinity;
            if (ratio <= 0.05) score += 24;
            else if (ratio <= 0.15) score += 16;
            else if (ratio <= 0.3) score += 6;
            else score -= 8;
        } else if (sourceDuration > 0) score -= 6;
        return score;
    }

    function rankReplacementCandidates(item, candidates, minimumScore) {
        const minimum = Number.isFinite(Number(minimumScore)) ? Number(minimumScore) : 48;
        return (Array.isArray(candidates) ? candidates : [])
            .filter(candidate => candidate && candidate.bvid)
            .map(candidate => ({ candidate, score: scoreReplacementCandidate(item, candidate) }))
            .filter(entry => Number.isFinite(entry.score) && entry.score >= minimum)
            .sort((left, right) => right.score - left.score);
    }

    root.BPLChartMatcher = {
        stripHtml, compact, parseDuration, scoreCandidate, chooseCandidate,
        diceSimilarity, scoreReplacementCandidate, rankReplacementCandidates
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
