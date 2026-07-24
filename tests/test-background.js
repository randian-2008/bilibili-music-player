const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS: ' + msg); } else { fail++; console.log('  FAIL: ' + msg); } }

function makeCtx() {
    let resp = {};
    const store = {};
    const sandbox = {
        console, Math, JSON, Promise, Date,
        setTimeout: () => 0, clearTimeout: () => {},
        fetch: () => Promise.resolve({ json: () => Promise.resolve(resp) }),
        __setResp: r => { resp = r; },
        chrome: {
            runtime: {
                onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
                sendMessage: () => Promise.resolve(undefined)
            },
            action: { onClicked: { addListener() {} } },
            commands: { onCommand: { addListener() {} } },
            tabs: { sendMessage: () => Promise.resolve(), query: () => Promise.resolve([]) },
            windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
            storage: {
                local: {
                    get: () => Promise.resolve(Object.assign({}, store)),
                    set: o => { Object.assign(store, o); return Promise.resolve(); },
                    remove: () => Promise.resolve()
                }
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

(async () => {
    console.log('[background getAudioUrl（B站音频源解析）]');

    let ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: { audio: [
        { baseUrl: 'https://cdn/low.m4s', bandwidth: 1000 },
        { baseUrl: 'https://cdn/high.m4s', bandwidth: 5000 } ] } } });
    ok(await ctx.getAudioUrl('BV1', 1) === 'https://cdn/high.m4s', 'dash 选最高码率');

    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { dash: {
        audio: [{ baseUrl: 'https://cdn/normal.m4s', bandwidth: 3000 }],
        flac: { audio: { baseUrl: 'https://cdn/flac.m4s', bandwidth: 9000 } } } } });
    ok(await ctx.getAudioUrl('BV1', 1) === 'https://cdn/flac.m4s', '合并 flac 选最高');

    ctx = makeCtx();
    ctx.__setResp({ code: 0, data: { durl: [{ url: 'https://cdn/fb.mp4' }] } });
    ok(await ctx.getAudioUrl('BV1', 1) === 'https://cdn/fb.mp4', 'durl 回退');

    ctx = makeCtx();
    ctx.__setResp({ code: -403, message: '需要登录' });
    let threw = false;
    try { await ctx.getAudioUrl('BV1', 1); } catch (e) { threw = /需要登录|code=-403/.test(e.message); }
    ok(threw, '接口错误抛异常');

    console.log('\n[background resolveCid]');
    ctx = makeCtx();
    ctx.__setResp({ data: { cid: 999, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }], title: 'T' } });
    let rc = await ctx.resolveCid('BV1', 2);
    ok(rc.cid === 222, '按分P取 cid (' + rc.cid + ')');
    rc = await ctx.resolveCid('BV1', 1);
    ok(rc.cid === 111, '第一P cid (' + rc.cid + ')');

    console.log('\n[background buildItem（加入视频时拉元数据）]');
    ctx = makeCtx();
    ctx.__setResp({ data: { bvid: 'BV1', cid: 9, title: '歌曲', pic: 'http://i0.hdslb.com/x.jpg', owner: { name: 'UP' }, duration: 200, pages: [{ page: 1, cid: 9 }] } });
    const it = await ctx.buildItem('BV1', 1, 'fallback');
    ok(it.cid === 9 && it.title === '歌曲' && it.owner === 'UP', '元数据正确 (cid=' + it.cid + ',title=' + it.title + ')');
    ok(it.pic === 'https://i0.hdslb.com/x.jpg', '封面 http→https (' + it.pic + ')');

    // buildItem 失败回退
    ctx = makeCtx();
    ctx.__setResp({ code: -404, message: '啥都木有' });
    const it2 = await ctx.buildItem('BV1', 1, '兜底标题');
    ok(it2.cid === 0 && it2.title === '兜底标题', '解析失败用兜底 (' + it2.title + ')');

    console.log('\n=================');
    console.log('通过: ' + pass + '  失败: ' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
