/* logger.js — 跨上下文共享的本地日志（Service Worker / offscreen / sidepanel / content 通用）
 *
 * 设计：
 *  - 环境无关：不依赖 window/document，SW 与页面均可用，挂载到 globalThis.BPLLog。
 *  - 内存环形缓冲 + 批量落盘：调用只写内存并 console 输出，每 FLUSH_MS 合并一次写入
 *    chrome.storage.local[bpl_log]（上限 MAX 条），避免高频命令造成存储抖动。
 *  - 级别：info/warn/error；sidepanel 读取 bpl_log 渲染并支持导出/清空。
 *  - 任意上下文加载本文件即可获得同一个存储键下的统一日志流（按时间合并）。
 */
(function (g) {
    'use strict';
    if (g.BPLLog && g.BPLLog.__bpl) return;

    var KEY = 'bpl_log';
    var MAX = 500;          // 持久化条数上限
    var FLUSH_MS = 1000;    // 批量落盘间隔

    var hasChrome = (typeof chrome !== 'undefined') && chrome && chrome.storage && chrome.storage.local;
    // 无 chrome.storage 但有 runtime 的上下文（现场实锤：此 Edge 的 offscreen）改经 background 代理落盘：
    // 把整批条目发给 bg 的 logMerge 并入 bpl_log。否则该上下文的日志会因写存储失败而整片静默。
    var hasRelay = !hasChrome && (typeof chrome !== 'undefined') && chrome && chrome.runtime && chrome.runtime.sendMessage;
    var pending = [];       // 尚未落盘的条目
    var recent = [];        // 本上下文内存中的近期条目
    var timer = null;
    var chain = Promise.resolve();
    var flushFails = 0;     // 连续落盘失败计数（用于自诊断，避免日志无声丢失）

    function pad(n, w) { return String(n).padStart(w || 2, '0'); }
    function stamp(t) {
        var d = new Date(t);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
    }

    function scheduleFlush(soon) {
        if (!hasChrome && !hasRelay) return;
        // error 级走短延时，避免文档/SW 在 1s 批量窗口内被杀导致关键错误丢失
        var delay = soon ? 30 : FLUSH_MS;
        if (timer) {
            if (soon) { clearTimeout(timer); timer = setTimeout(flush, delay); }
            return;
        }
        timer = setTimeout(flush, delay);
    }
    function flush() {
        timer = null;
        if ((!hasChrome && !hasRelay) || !pending.length) return;
        var batch = pending; pending = [];
        chain = chain.then(function () {
            if (hasChrome) {
                return chrome.storage.local.get(KEY).then(function (r) {
                    var arr = (r && Array.isArray(r[KEY])) ? r[KEY] : [];
                    arr = arr.concat(batch);
                    if (arr.length > MAX) arr = arr.slice(-MAX);
                    return chrome.storage.local.set((function () { var o = {}; o[KEY] = arr; return o; })());
                });
            }
            // relay 路径：交给 background 的 logMerge 并入（bg 侧统一截断上限）
            return new Promise(function (res, rej) {
                try {
                    chrome.runtime.sendMessage({ target: 'bg', cmd: 'logMerge', entries: batch }, function (r) {
                        if (r && r.ok) res(); else rej(new Error('logMerge 无应答'));
                    });
                } catch (e) { rej(e); }
            });
        }).then(function () {
            flushFails = 0;
        }).catch(function () {
            // 落盘失败不再无声吞掉：累计计数并经 console 告警（不走 BPLLog 以免递归）
            flushFails++;
            try { console.warn('[bpl][logger][warn] 日志落盘失败(连续' + flushFails + '次)，存储可能不可用'); } catch (_) {}
        });
    }

    function push(level, scope, msg) {
        var text;
        try { text = (typeof msg === 'string') ? msg : JSON.stringify(msg); }
        catch (_) { text = String(msg); }
        var t = Date.now();
        var entry = { t: t, s: stamp(t), level: level, scope: scope, msg: text };
        recent.push(entry);
        if (recent.length > MAX) recent = recent.slice(-MAX);
        pending.push(entry);
        try {
            var line = '[bpl][' + scope + '][' + level + '] ' + text;
            if (level === 'error' && console.error) console.error(line);
            else if (level === 'warn' && console.warn) console.warn(line);
            else console.log(line);
        } catch (_) {}
        scheduleFlush(level === 'error');
        return entry;
    }

    var api = {
        __bpl: true,
        info: function (scope, msg) { return push('info', scope, msg); },
        log: function (scope, msg) { return push('info', scope, msg); },
        warn: function (scope, msg) { return push('warn', scope, msg); },
        error: function (scope, msg) { return push('error', scope, msg); },
        flush: flush,
        recent: function () { return recent.slice(); },
        KEY: KEY,
        MAX: MAX
    };
    g.BPLLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
