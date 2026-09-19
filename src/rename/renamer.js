(function (root) {
    'use strict';

    // Keep the default policy in code so an empty or unavailable rules file is valid.
    const MAX_TITLE_LENGTH = 240;
    const MAX_SEGMENT_LENGTH = 10;
    const MIN_COMMON_AFFIX_LENGTH = 3;
    const MIN_COMMON_TAIL_LENGTH = 2;
    const MIN_COMMON_TAIL_SUPPORT = 3;
    const MAX_RULES_FILE_BYTES = 64 * 1024;
    const MAX_RULE_COUNT = 32;
    const MAX_PATTERN_LENGTH = 256;
    const MAX_REPLACEMENT_LENGTH = 200;
    const MAX_RULE_STATES = 512;
    const MAX_RULE_STEPS = 25000;
    const ALLOWED_FLAGS = /^[gim]*$/;
    const TITLE_QUOTE_PAIRS = [
        ['\u300A', '\u300B'],
        ['\u300C', '\u300D'],
        ['\u300E', '\u300F'],
        ['\u3008', '\u3009']
    ];
    const TITLE_DESCRIPTOR_RE = /(?:BGM|OST|EP|PV|OP|ED|\u89d2\u8272\u5c55\u793a|\u89d2\u8272\u66f2|\u4e3b\u9898\u66f2|\u63d2\u66f2|\u914d\u4e50|\u65b0\u6b4c|\u6b4c\u66f2)/i;
    const TRAILING_TITLE_METADATA_RE = /(?:\s*(?:BGM|OST)|(?:^|\s)(?:EP|PV|OP|ED)|\s*(?:\u5b8c\u6574\u7248|\u7eaf\u4eab\u7248|\u8bd5\u542c\u7248))\s*$/i;

    let rulesCache = null;
    let rulesPromise = null;

    function text(value) {
        return String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanSegment(value) {
        const result = text(value)
            .replace(/^[\s\-\u2013\u2014|\uFF5C\u4E28\uFF0F\/\u00B7\u2022]+/, '')
            .replace(/[\s\-\u2013\u2014|\uFF5C\u4E28\uFF0F\/\u00B7\u2022]+$/, '')
            .trim();
        for (const pair of TITLE_QUOTE_PAIRS) {
            if (result.startsWith(pair[0]) && result.endsWith(pair[1])) {
                return text(result.slice(pair[0].length, -pair[1].length));
            }
        }
        return result;
    }

    function stripLeadingMetadata(value) {
        let result = cleanSegment(value);
        let previous;
        do {
            previous = result;
            result = result
                .replace(/^(?:\[[^\]]{1,80}\]|\u3010[^\u3011]{1,80}\u3011|\([^)]{1,80}\)|\u3014[^\u3015]{1,80}\u3015)\s*/, '')
                .replace(/\s*(?:\[[^\]]{1,80}\]|\u3010[^\u3011]{1,80}\u3011|\([^)]{1,80}\)|\u3014[^\u3015]{1,80}\u3015)\s*$/, '')
                .replace(/^\d{1,3}\s*[-.\u3001:：]\s*/, '')
                .trim();
        } while (result && result !== previous);
        return cleanSegment(result.replace(TRAILING_TITLE_METADATA_RE, ''));
    }

    function splitTitle(value) {
        const source = text(value);
        if (!source) return [];
        // Split only outside paired brackets so metadata such as [Hi-res] stays intact.
        const opening = new Set(['[', '\u3010', '(', '\uFF08', '\u3014', '\u300A', '\u3008']);
        const closing = new Set([']', '\u3011', ')', '\uFF09', '\u3015', '\u300B', '\u3009']);
        const separators = new Set(['-', '\u2013', '\u2014', '|', '\uFF5C', '\u4E28', '/', '\uFF0F', ',', '\uFF0C', ';', '\uFF1B', '\u00B7', '\u2022']);
        const parts = [];
        let start = 0;
        let depth = 0;
        for (let i = 0; i < source.length; i++) {
            const ch = source[i];
            if (opening.has(ch)) { depth++; continue; }
            if (closing.has(ch)) { depth = Math.max(0, depth - 1); continue; }
            if (depth === 0 && separators.has(ch)) {
                const part = cleanSegment(source.slice(start, i));
                if (part) parts.push(part);
                start = i + 1;
            }
        }
        const tail = cleanSegment(source.slice(start));
        if (tail) parts.push(tail);
        return parts;
    }

    function quoteKey(value) {
        return text(value).toLowerCase();
    }

    function extractQuotedCandidates(value) {
        const source = text(value);
        const candidates = [];
        for (const pair of TITLE_QUOTE_PAIRS) {
            let cursor = 0;
            while (cursor < source.length) {
                const start = source.indexOf(pair[0], cursor);
                if (start < 0) break;
                const end = source.indexOf(pair[1], start + pair[0].length);
                if (end < 0) break;
                const candidate = text(source.slice(start + pair[0].length, end));
                if (candidate) {
                    candidates.push({
                        value: candidate,
                        key: quoteKey(candidate),
                        start: start,
                        end: end + pair[1].length
                    });
                }
                cursor = end + pair[1].length;
            }
        }
        return candidates.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    function findCommonTails(values) {
        const clusters = new Map();
        for (const raw of values) {
            const value = text(raw);
            if (!value) continue;
            const key = value.slice(-1).toLowerCase();
            if (!clusters.has(key)) clusters.set(key, []);
            clusters.get(key).push(value);
        }
        const tails = new Set();
        for (const cluster of clusters.values()) {
            if (cluster.length < MIN_COMMON_TAIL_SUPPORT) continue;
            const suffix = trimAffix(commonSuffix(cluster.map(value => value.toLowerCase())));
            if (suffix.length < MIN_COMMON_TAIL_LENGTH) continue;
            if (!cluster.every(value => value.length > suffix.length)) continue;
            tails.add(suffix);
        }
        return Array.from(tails).sort((a, b) => b.length - a.length);
    }

    function removeCommonTails(value, context) {
        const source = text(value);
        const lower = source.toLowerCase();
        for (const suffix of context.commonTails) {
            if (!lower.endsWith(suffix) || source.length <= suffix.length) continue;
            return cleanSegment(source.slice(0, -suffix.length));
        }
        return source;
    }

    function buildTitleContext(values) {
        const titles = values.filter(Boolean);
        const counts = new Map();
        for (const title of titles) {
            const seen = new Set(extractQuotedCandidates(title).map(candidate => candidate.key));
            for (const key of seen) counts.set(key, (counts.get(key) || 0) + 1);
        }
        const commonQuoted = new Set();
        const threshold = Math.max(2, Math.ceil(titles.length * 0.5));
        for (const [key, count] of counts) {
            if (count >= threshold) commonQuoted.add(key);
        }
        return { commonQuoted: commonQuoted, commonTails: findCommonTails(titles) };
    }

    function removeCommonQuoted(value, context) {
        const source = text(value);
        const spans = extractQuotedCandidates(source)
            .filter(candidate => context.commonQuoted.has(candidate.key));
        if (!spans.length) return source;
        let result = '';
        let cursor = 0;
        for (const span of spans) {
            if (span.start < cursor) continue;
            result += source.slice(cursor, span.start);
            cursor = span.end;
        }
        result += source.slice(cursor);
        return text(result);
    }

    function cleanTitleCandidate(value) {
        let result = stripLeadingMetadata(value);
        let previous;
        do {
            previous = result;
            result = cleanSegment(result
                .replace(/[\s!\uFF01?\uFF1F~\uFF5E]+$/, '')
                .replace(TRAILING_TITLE_METADATA_RE, ''));
        } while (result && result !== previous);
        return result;
    }

    function findStrongDelimiters(value) {
        const source = text(value);
        const opening = new Set(['[', '\u3010', '(', '\uFF08', '\u3014', '\u300A', '\u3008', '\u300C', '\u300E']);
        const closing = new Set([']', '\u3011', ')', '\uFF09', '\u3015', '\u300B', '\u3009', '\u300D', '\u300F']);
        const separators = new Set(['|', '\uFF5C', '\u4E28', '!', '\uFF01', '?', '\uFF1F', '~', '\uFF5E']);
        let depth = 0;
        const found = [];
        for (let i = 0; i < source.length; i++) {
            const ch = source[i];
            if (opening.has(ch)) { depth++; continue; }
            if (closing.has(ch)) { depth = Math.max(0, depth - 1); continue; }
            if (depth === 0 && separators.has(ch)) found.push(i);
        }
        return found;
    }

    function looksLikeTitleCandidate(value) {
        const candidate = text(value);
        if (!candidate || candidate.length > 80) return false;
        if (!/[A-Za-z0-9\u3400-\u9fff]/.test(candidate)) return false;
        return !/^(?:BGM|OST|EP|PV|OP|ED)$/i.test(candidate);
    }

    function selectTitleCandidate(value, context) {
        const source = text(value);
        const quoted = extractQuotedCandidates(source)
            .filter(candidate => !context.commonQuoted.has(candidate.key))
            .filter(candidate => looksLikeTitleCandidate(candidate.value));
        const quotedChoice = quoted.length ? quoted[quoted.length - 1] : null;

        const delimiters = findStrongDelimiters(source);
        let delimiter = -1;
        let delimitedChoice = '';
        for (let i = delimiters.length - 1; i >= 0; i--) {
            const position = delimiters[i];
            const candidate = cleanTitleCandidate(removeCommonQuoted(source.slice(position + 1), context));
            if (!looksLikeTitleCandidate(candidate)) continue;
            delimiter = position;
            delimitedChoice = candidate;
            break;
        }

        if (delimitedChoice && quotedChoice) {
            const between = source.slice(quotedChoice.end, delimiter);
            if (delimiter > quotedChoice.end && TITLE_DESCRIPTOR_RE.test(between)) return delimitedChoice;
        }
        if (quotedChoice) return cleanTitleCandidate(quotedChoice.value);
        return delimitedChoice;
    }

    function commonPrefix(values) {
        if (!values.length) return '';
        let end = values[0].length;
        for (let i = 1; i < values.length; i++) {
            end = Math.min(end, values[i].length);
            let j = 0;
            while (j < end && values[0][j] === values[i][j]) j++;
            end = j;
            if (!end) break;
        }
        return values[0].slice(0, end);
    }

    function commonSuffix(values) {
        if (!values.length) return '';
        let end = Math.min.apply(null, values.map(value => value.length));
        for (let i = 1; i < values.length && end; i++) {
            let j = 0;
            while (j < end && values[0][values[0].length - 1 - j] === values[i][values[i].length - 1 - j]) j++;
            end = j;
        }
        return values[0].slice(values[0].length - end);
    }

    function trimAffix(value) {
        return String(value || '')
            .replace(/[\s\-\u2013\u2014|\uFF5C\uFF0F\/,:;\uFF0C\uFF1B]+$/g, '')
            .replace(/^[\s\-\u2013\u2014|\uFF5C\uFF0F\/,:;\uFF0C\uFF1B]+/g, '')
            .trim();
    }

    function validAffix(affix, values, allowWholeValue) {
        const candidate = trimAffix(affix);
        const markerOnly = /^[^A-Za-z0-9\u3400-\u9fff]+$/.test(candidate);
        if (candidate.length < MIN_COMMON_AFFIX_LENGTH && !(allowWholeValue && markerOnly)) return '';
        if (!values.every(value => value.length > candidate.length) && !allowWholeValue) return '';
        return candidate;
    }

    function groupClusters(groups, key) {
        const clusters = new Map();
        for (const group of groups) {
            const value = key(group);
            if (!value) continue;
            if (!clusters.has(value)) clusters.set(value, []);
            clusters.get(value).push(group);
        }
        return Array.from(clusters.values()).filter(cluster => cluster.length >= 2);
    }

    function applyCommonAffixes(groups, includeSuffix) {
        if (groups.length < 2) return;
        // Work within simple title-shape clusters. This supports mixed collections
        // where one group uses a leading description and another uses a trailing one.
        const prefixClusters = groupClusters(groups, group => (group[0] || '').slice(0, 1));
        for (const cluster of prefixClusters) {
            // Strip at most three layers. This also handles a user prefix followed by
            // a shared artist/series segment without hard-coding any artist names.
            for (let round = 0; round < 3; round++) {
                const firstValues = cluster.map(group => group[0] || '');
                const prefix = validAffix(commonPrefix(firstValues), firstValues, cluster.every(group => group.length > 1));
                if (!prefix) break;
                const candidate = cluster.map(group => {
                    const next = group.slice();
                    next[0] = cleanSegment(next[0].slice(prefix.length));
                    // A shared artist prefix can leave a connector and collaborator
                    // segment before the actual title.
                    if (next.length > 1 && /^[\s_\u00b7&+]+/.test(next[0])) next.shift();
                    return next.filter(Boolean);
                });
                if (!candidate.every(group => group.length && group.join(' - ').length)) break;
                candidate.forEach((next, index) => cluster[index].splice(0, cluster[index].length, ...next));
            }
        }

        if (includeSuffix === false) return;
        const suffixClusters = groupClusters(groups, group => {
            const last = group[group.length - 1] || '';
            return last.slice(-1);
        });
        for (const cluster of suffixClusters) {
            const lastValues = cluster.map(group => group[group.length - 1] || '');
            const suffix = validAffix(commonSuffix(lastValues), lastValues, cluster.every(group => group.length > 1));
            if (!suffix) continue;
            const candidate = cluster.map(group => {
                const next = group.slice();
                const last = next.length - 1;
                next[last] = cleanSegment(next[last].slice(0, -suffix.length));
                return next.filter(Boolean);
            });
            if (!candidate.every(group => group.length && group.join(' - ').length)) continue;
            candidate.forEach((next, index) => cluster[index].splice(0, cluster[index].length, ...next));
        }
    }

    function filterLongSegments(groups) {
        return groups.map(group => {
            const retained = group.filter(segment => segment.length <= MAX_SEGMENT_LENGTH);
            if (retained.length) return retained;
            // If every candidate is long, preserve the shortest one instead of producing an empty title.
            return group.slice().sort((a, b) => a.length - b.length).slice(0, 1);
        });
    }

    function compilePattern(pattern, flags) {
        // Parse a positive syntax subset, then match state/position pairs once.
        // Native RegExp only tests one validated character atom, never a user-supplied whole expression.
        let cursor = 0;
        const fail = () => { throw new Error('unsupported rule pattern'); };
        const escape = inClass => {
            const start = cursor++;
            const kind = pattern[cursor++];
            if (!kind) fail();
            if (kind === 'x' || kind === 'u') {
                const size = kind === 'x' ? 2 : 4;
                if (!new RegExp('^[0-9a-fA-F]{' + size + '}$').test(pattern.slice(cursor, cursor + size))) fail();
                cursor += size;
            } else if (!'dDsSwWfnrtv'.includes(kind) && !(inClass && kind === 'b') &&
                !'^$\\.*+?()[]{}|/-'.includes(kind)) fail();
            return pattern.slice(start, cursor);
        };
        const expression = nested => {
            const branches = [[]];
            while (cursor < pattern.length && pattern[cursor] !== ')') {
                const ch = pattern[cursor];
                if (ch === '|') { cursor++; branches.push([]); continue; }
                let node;
                if (ch === '(') {
                    if (pattern.slice(cursor, cursor + 3) !== '(?:') fail();
                    cursor += 3;
                    node = expression(true);
                    if (pattern[cursor++] !== ')') fail();
                } else if (ch === '^' || ch === '$') {
                    cursor++;
                    node = { kind: ch };
                } else {
                    let atom;
                    if (ch === '[') {
                        const start = cursor++;
                        if (pattern[cursor] === '^') cursor++;
                        const contentStart = cursor;
                        while (cursor < pattern.length && pattern[cursor] !== ']') {
                            if (pattern[cursor] === '\\') escape(true);
                            else {
                                if (pattern[cursor] === '[') fail();
                                cursor++;
                            }
                        }
                        if (cursor === contentStart || pattern[cursor++] !== ']') fail();
                        atom = pattern.slice(start, cursor);
                    } else if (ch === '\\') atom = escape(false);
                    else {
                        if ('*+?{}]'.includes(ch)) fail();
                        atom = pattern[cursor++];
                    }
                    node = { kind: 'char', test: new RegExp('^(?:' + atom + ')$', flags.includes('i') ? 'i' : ''), min: 1, max: 1 };
                    const quantifier = pattern[cursor];
                    if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
                        cursor++;
                        node.min = quantifier === '+' ? 1 : 0;
                        node.max = quantifier === '?' ? 1 : Infinity;
                    } else if (quantifier === '{') {
                        const match = pattern.slice(cursor).match(/^\{(\d+)(?:,(\d*))?\}/);
                        if (!match) fail();
                        node.min = Number(match[1]);
                        node.max = match[2] === undefined ? node.min : match[2] === '' ? Infinity : Number(match[2]);
                        if (node.min > MAX_TITLE_LENGTH || node.max < node.min ||
                            (node.max !== Infinity && node.max > MAX_TITLE_LENGTH)) fail();
                        cursor += match[0].length;
                    }
                }
                // Groups and anchors cannot be quantified. Lazy quantifiers are outside this subset too.
                if ('*+?{'.includes(pattern[cursor] || '\0')) fail();
                branches[branches.length - 1].push(node);
            }
            if (!nested && cursor !== pattern.length) fail();
            return { kind: 'branches', branches: branches };
        };
        const tree = expression(false);
        const states = [];
        const add = state => {
            if (states.length >= MAX_RULE_STATES) fail();
            states.push(state);
            return states.length - 1;
        };
        const compile = (node, next) => {
            if (node.kind === 'branches') {
                const alternatives = node.branches.map(branch => {
                    let start = next;
                    for (let i = branch.length - 1; i >= 0; i--) start = compile(branch[i], start);
                    return start;
                });
                let start = alternatives.pop();
                while (alternatives.length) start = add({ kind: 'split', first: alternatives.pop(), next: start });
                return start;
            }
            if (node.kind !== 'char') return add({ kind: node.kind, next: next });
            let start = next;
            if (node.max === Infinity) {
                const loop = add({ kind: 'split', first: null, next: next });
                states[loop].first = add({ kind: 'char', test: node.test, next: loop });
                start = loop;
            } else {
                for (let i = node.min; i < node.max; i++) {
                    start = add({ kind: 'split', first: add({ kind: 'char', test: node.test, next: start }), next: start });
                }
            }
            for (let i = 0; i < node.min; i++) start = add({ kind: 'char', test: node.test, next: start });
            return start;
        };
        const start = compile(tree, add({ kind: 'end' }));
        return {
            replace(input, replacement, budget) {
                const source = input.slice(0, MAX_TITLE_LENGTH), memo = new Map();
                const multiline = flags.includes('m'), global = flags.includes('g');
                const lineBreak = ch => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
                const match = (stateId, position) => {
                    const key = stateId * (source.length + 1) + position;
                    if (memo.has(key)) return memo.get(key);
                    if (--budget.remaining < 0) throw new Error('rule work limit');
                    const state = states[stateId];
                    let end = -1;
                    if (state.kind === 'end') end = position;
                    else if (state.kind === 'char') {
                        if (position < source.length && state.test.test(source[position])) end = match(state.next, position + 1);
                    } else if (state.kind === 'split') {
                        end = match(state.first, position);
                        if (end < 0) end = match(state.next, position);
                    } else if (state.kind === '^') {
                        if (!position || multiline && lineBreak(source[position - 1])) end = match(state.next, position);
                    } else if (state.kind === '$') {
                        if (position === source.length || multiline && lineBreak(source[position])) end = match(state.next, position);
                    }
                    memo.set(key, end);
                    return end;
                };
                let output = '', copied = 0;
                for (let position = 0; position <= source.length; position++) {
                    const end = match(start, position);
                    if (end < 0) continue;
                    const insert = replacement.replace(/\$([$&`'])/g, (_, token) =>
                        token === '$' ? '$' : token === '&' ? source.slice(position, end) :
                            token === '`' ? source.slice(0, position) : source.slice(end));
                    output = (output + source.slice(copied, position) + insert).slice(0, MAX_TITLE_LENGTH);
                    copied = end;
                    if (!global || output.length === MAX_TITLE_LENGTH) break;
                    // Empty matches advance by one UTF-16 code unit, as with RegExp without the u flag.
                    position = end > position ? end - 1 : position;
                }
                return (output + source.slice(copied)).slice(0, MAX_TITLE_LENGTH);
            }
        };
    }

    function replaceWithRule(input, rule, budget) {
        if (budget.remaining <= 0) return input;
        try { return rule.matcher.replace(input, rule.replacement, budget); }
        catch (_) { return input; } // Exhausted user-rule work never interrupts the default policy.
    }

    function normalizeRules(value) {
        const source = value && typeof value === 'object' ? value : {};
        const list = Array.isArray(source.filters) ? source.filters : [];
        const filters = [];
        for (const raw of list.slice(0, MAX_RULE_COUNT)) {
            if (!raw || raw.enabled === false) continue;
            const pattern = typeof raw.pattern === 'string' ? raw.pattern : '';
            const flags = typeof raw.flags === 'string' ? raw.flags : '';
            const replacement = typeof raw.replace === 'string' ? raw.replace : '';
            const scope = raw.scope === 'title' ? 'title' : 'segment';
            if (!pattern || pattern.length > MAX_PATTERN_LENGTH || replacement.length > MAX_REPLACEMENT_LENGTH ||
                !ALLOWED_FLAGS.test(flags) || new Set(flags).size !== flags.length) continue;
            try {
                filters.push({ scope: scope, matcher: compilePattern(pattern, flags), replacement: replacement });
            } catch (_) {
                // Invalid user rules are ignored individually.
            }
        }
        return { filters: filters };
    }

    async function loadRules() {
        if (rulesCache) return rulesCache;
        if (rulesPromise) return rulesPromise;
        rulesPromise = (async () => {
            try {
                if (typeof root.fetch !== 'function') return normalizeRules({});
                const runtime = root.chrome && root.chrome.runtime;
                const url = runtime && typeof runtime.getURL === 'function'
                    ? runtime.getURL('src/rename/rules.json') : 'src/rename/rules.json';
                const response = await root.fetch(url, { credentials: 'same-origin' });
                if (!response || response.ok === false) throw new Error('rules unavailable');
                const contentLength = Number(response.headers && response.headers.get && response.headers.get('content-length')) || 0;
                if (contentLength > MAX_RULES_FILE_BYTES) throw new Error('rules too large');
                const raw = await response.text();
                if (raw.length > MAX_RULES_FILE_BYTES) throw new Error('rules too large');
                return normalizeRules(JSON.parse(raw));
            } catch (_) {
                return normalizeRules({});
            }
        })();
        rulesCache = await rulesPromise;
        rulesPromise = null;
        return rulesCache;
    }

    function applyTitleRules(title, rules, budget) {
        let full = title;
        for (const rule of rules.filters) {
            if (rule.scope === 'title') full = replaceWithRule(full, rule, budget);
        }
        return full;
    }

    function applyRules(title, groups, rules, titleRulesApplied, budget) {
        const full = titleRulesApplied ? title : applyTitleRules(title, rules, budget);
        let next = splitTitle(full).map(stripLeadingMetadata).filter(Boolean);
        if (next.length > 1) {
            next = next.filter(segment => !/^#?\d{1,3}$/.test(segment));
        }
        for (const rule of rules.filters) {
            if (rule.scope !== 'segment') continue;
            next = next.map(segment => cleanSegment(replaceWithRule(segment, rule, budget))).filter(Boolean);
        }
        groups.push(next.length ? next : splitTitle(title).map(stripLeadingMetadata).filter(Boolean));
    }

    function sanitizePrefix(value) {
        return trimAffix(text(value)).slice(0, 80);
    }

    function addPrefix(name, prefix) {
        const p = sanitizePrefix(prefix);
        const n = cleanSegment(name);
        if (!p) return n;
        if (!n) return p;
        if (n === p || n.indexOf(p + ' - ') === 0) return n;
        return p + ' - ' + n;
    }

    async function renameItems(items, options) {
        options = options || {};
        const source = Array.isArray(items) ? items : [];
        const rules = options.rules == null ? await loadRules() : normalizeRules(options.rules);
        const groups = [];
        const originals = [];
        const budgets = source.map(() => ({ remaining: MAX_RULE_STEPS }));
        for (const item of source) {
            const original = text(item && item.title);
            originals.push(original);
        }
        const preparedTitles = originals.map((original, index) =>
            applyTitleRules(original.slice(0, MAX_TITLE_LENGTH), rules, budgets[index]));
        const context = buildTitleContext(preparedTitles);
        for (let index = 0; index < originals.length; index++) {
            const original = originals[index];
            const ruleFiltered = preparedTitles[index];
            const structural = removeCommonTails(ruleFiltered, context);
            const candidate = selectTitleCandidate(structural, context);
            const prepared = candidate || removeCommonQuoted(structural, context);
            const local = [];
            applyRules(prepared, local, rules, true, budgets[index]);
            groups.push(local[0] && local[0].length ? local[0] : [stripLeadingMetadata(original) || original]);
        }
        // Detect common prefixes before dropping long candidates. This preserves a
        // prefix shared by most items even when a few items include collaborators.
        applyCommonAffixes(groups, false);
        const filtered = filterLongSegments(groups);
        applyCommonAffixes(filtered, true);
        return source.map((item, index) => {
            const fallback = stripLeadingMetadata(originals[index]) || originals[index] || String(item && item.bvid || '');
            const name = (filtered[index] && filtered[index].join(' - ')) || fallback;
            const copy = Object.assign({}, item || {});
            copy.title = addPrefix(name, options.prefix);
            delete copy.originalTitle;
            return copy;
        });
    }

    root.BPLRenamer = {
        MAX_SEGMENT_LENGTH: MAX_SEGMENT_LENGTH,
        normalizeRules: normalizeRules,
        splitTitle: splitTitle,
        loadRules: loadRules,
        renameItems: renameItems,
        sanitizePrefix: sanitizePrefix
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
