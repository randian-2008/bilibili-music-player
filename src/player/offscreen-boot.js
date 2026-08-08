// offscreen 文档的最早期诊断信号：由 offscreen.html 在 <head> 第一个载入。
// 用途：当音频播不出来时，仅凭日志/存储即可判定故障层级——
//   1) 后台日志出现 "offscreen ping：offscreen-boot" 且 bpl_boot.phase=loaded
//        → 脚本执行正常、消息通道正常，问题在后续逻辑；
//   2) bpl_boot.phase=boot 但后台没有 boot ping
//        → 脚本能执行，但 offscreen→后台的消息通道是断的；
//   3) bpl_boot.phase=script-error → 后续脚本抛错（含文件名/行号）；
//   4) bpl_boot.phase=resource-error → 某脚本资源加载失败（如 logger.js/offscreen.js 404，附 src）；
//   5) 存储里根本没有 bpl_boot → offscreen 文档的脚本从未执行（疑后台挂起/效率模式）。
// offscreen 是唯一音频宿主（无页内兜底），故本信号是定位“播不出来”的第一手依据。
// 注意：MV3 扩展页 CSP 禁止内联脚本，本文件必须独立存在。
(function () {
    'use strict';
    var at = Date.now();
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    function mark(obj) {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.storage.local.set) {
                chrome.storage.local.set({ bpl_boot: obj });
            }
        } catch (e) {}
    }
    // 信号一：向后台发 ping（检验 offscreen→后台消息通道）
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            var p = chrome.runtime.sendMessage({ bplPing: 'offscreen-boot', at: at });
            if (p && p.catch) p.catch(function () {});
        }
    } catch (e) {}
    // 信号二：直接写存储（不依赖消息通道与日志节流，哪怕下一秒文档被关闭也能留下痕迹）
    mark({ phase: 'boot', at: at, s: new Date(at).toISOString(), ua: ua });
    // 捕获 offscreen.html 后续脚本（logger.js / offscreen.js）的执行错误
    try {
        window.addEventListener('error', function (e) {
            mark({
                phase: 'script-error',
                at: Date.now(),
                msg: String((e && e.message) || e),
                src: (e && e.filename) || '',
                line: (e && e.lineno) || 0,
                ua: ua
            });
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e && e.reason;
            mark({
                phase: 'promise-error',
                at: Date.now(),
                msg: String(r ? (r.message || r) : e),
                ua: ua
            });
        });
    } catch (e) {}
    // 捕获相位补齐：外部脚本/样式加载失败（如 logger.js/offscreen.js 404）的 error 事件
    // 只停在目标元素上、不冒泡，冒泡相位的 window.onerror 抓不到。用 capture=true 记录，
    // 以区分“脚本没执行”与“脚本资源加载失败”两类故障。
    try {
        window.addEventListener('error', function (e) {
            var tgt = e && e.target;
            if (tgt && (tgt.tagName === 'SCRIPT' || tgt.tagName === 'LINK') && !e.message) {
                mark({
                    phase: 'resource-error',
                    at: Date.now(),
                    src: (tgt.src || tgt.href) || '',
                    ua: ua
                });
            }
        }, true);
    } catch (e) {}
})();
