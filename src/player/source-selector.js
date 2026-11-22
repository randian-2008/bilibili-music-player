// Only endpoint timings are persisted; signed URLs and media never enter this cache.
globalThis.BPLSources = (() => {
    const MAX_HOSTS = 32;
    const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
    function endpoint(url) {
        try { return new URL(url).origin; } catch (_) { return ''; }
    }
    function createHistory(saved, now = () => Date.now()) {
        const entries = new Map();
        for (const row of Array.isArray(saved) ? saved : []) {
            if (!row || !/^https?:\/\//.test(row.host) || endpoint(row.host) !== row.host ||
                !Number.isFinite(row.at) || now() - row.at > MAX_AGE || row.at > now() ||
                !Number.isFinite(row.ms) || !Number.isFinite(row.deviation) || !Number.isFinite(row.failures)) continue;
            entries.set(row.host, { host: row.host, at: row.at, ms: clamp(row.ms, 0, 12000),
                deviation: clamp(row.deviation, 0, 12000), failures: clamp(row.failures, 0, 4) });
        }
        function snapshot() {
            const rows = [...entries.values()].filter(row => now() - row.at <= MAX_AGE)
                .sort((a, b) => b.at - a.at).slice(0, MAX_HOSTS);
            entries.clear();
            for (const row of rows) entries.set(row.host, row);
            return rows.map(row => ({ ...row }));
        }
        function recent(url) {
            const row = entries.get(endpoint(url));
            return row && now() - row.at <= MAX_AGE ? row : null;
        }
        function record(url, result, elapsed) {
            if (result.cancelled || result.blocked) return;
            const host = endpoint(url);
            if (!host) return;
            const row = recent(url) || { host, ms: 0, deviation: 0, failures: 0 };
            if (result.ok) {
                const ms = clamp(elapsed, 1, 12000);
                row.deviation = row.ms ? row.deviation * 0.75 + Math.abs(row.ms - ms) * 0.25 : ms / 2;
                row.ms = row.ms ? row.ms * 0.75 + ms * 0.25 : ms;
                row.failures = 0;
            } else row.failures = Math.min(4, row.failures + 1);
            row.at = now();
            entries.set(host, row);
            snapshot();
        }
        function timeout(url) {
            snapshot();
            const row = recent(url);
            const samples = [...entries.values()].filter(x => x.ms > 0);
            const baseline = samples.length ? samples.reduce((sum, x) => sum + x.ms + 4 * x.deviation, 0) / samples.length : 6000;
            // A floor protects slow networks; failed attempts lengthen, never shorten, the next wait.
            const normal = clamp(Math.max(baseline, row ? row.ms + 4 * row.deviation : 0), 4000, 12000);
            return clamp(normal * (1 + (row ? row.failures : 0) * 0.5), 4000, 12000);
        }
        function rank(sources) {
            snapshot();
            const score = url => { const row = recent(url); return row ? (row.ms || 1500) + row.failures * 3000 : 1500; };
            return sources.map((source, index) => ({ ...source, index })).sort((a, b) =>
                a.group - b.group || score(a.url) - score(b.url) || a.index - b.index);
        }
        snapshot();
        return { record, timeout, rank, snapshot };
    }

    // Two live attempts maximum. A slow attempt stays alive while the other slot
    // tries alternatives. The caller supplies real media startup and cleanup.
    function race(sources, attempt, { signal, deadline, timeout, onResult = () => {} }) {
        return new Promise(resolve => {
            let cursor = 0, settled = false;
            const active = new Set();
            const failures = [];
            const finish = (result, winner) => {
                if (settled) return;
                settled = true;
                if (signal) signal.removeEventListener('abort', cancel);
                for (const controller of active) if (controller !== winner) controller.abort();
                resolve({ ...result, failures, attempted: cursor });
            };
            const cancel = () => finish({ cancelled: true });
            if (signal && signal.aborted) { cancel(); return; }
            if (signal) signal.addEventListener('abort', cancel, { once: true });
            const launch = () => {
                if (settled) return;
                while (active.size < 2 && cursor < sources.length && Date.now() < deadline) {
                    const source = sources[cursor++];
                    const controller = new AbortController();
                    active.add(controller);
                    const started = Date.now();
                    Promise.resolve().then(() => attempt(source, Math.max(1, Math.min(timeout(source.url), deadline - Date.now())), controller.signal))
                        .catch(error => ({ ok: false, error }))
                        .then(result => {
                            active.delete(controller);
                            if (settled) { if (result.release) result.release(); return; }
                            onResult(source.url, result, Date.now() - started);
                            if (result.ok) { finish({ ...result, source }, controller); return; }
                            failures.push({ source, result });
                            if (result.blocked) { finish({ blocked: true }); return; }
                            launch();
                        });
                }
                if (!active.size && !settled) finish({ ok: false });
            };
            launch();
        });
    }
    return { createHistory, race, endpoint };
})();
