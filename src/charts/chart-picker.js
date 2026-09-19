(function () {
    'use strict';

    const $ = selector => document.querySelector(selector);
    const sourceSelect = $('#sourceSelect');
    const categorySelect = $('#categorySelect');
    const chartSelect = $('#chartSelect');
    const limitSelect = $('#limitSelect');
    const playlistName = $('#playlistName');
    const confirmBtn = $('#confirmBtn');
    const errorEl = $('#error');
    const statusEl = $('#sourceStatus');
    let sources = [];
    let busy = false;
    let importAttempt = null;

    function resetImportAttempt() { importAttempt = null; }
    function importRequestId(options) {
        const key = JSON.stringify(options);
        if (!importAttempt || importAttempt.key !== key) {
            const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
                ? globalThis.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
            importAttempt = { key, id: 'chart-' + id };
        }
        return importAttempt.id;
    }

    const theme = globalThis.BPLTheme;
    if (theme) {
        chrome.storage.local.get(theme.STORAGE_KEY).then(values => {
            theme.apply(document.documentElement, values[theme.STORAGE_KEY] || theme.DEFAULT_ID);
        }).catch(() => theme.apply(document.documentElement, theme.DEFAULT_ID));
    }

    function send(cmd, extra) {
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            // 超时只表示未收到结果，后台可能仍在创建列表。重试必须保留同一个请求 ID。
            const timer = setTimeout(() => finish({ ok: false, uncertain: true, error: '后台响应超时，可重试确认导入结果' }),
                cmd === 'importChart' ? 35000 : 20000);
            try {
                chrome.runtime.sendMessage(Object.assign({ target: 'bg', cmd }, extra || {}), result => {
                    const lastError = chrome.runtime.lastError;
                    finish(lastError || !result
                        ? { ok: false, uncertain: true, error: lastError && lastError.message || '后台未返回结果，请重试' }
                        : result);
                });
            } catch (error) {
                finish({ ok: false, uncertain: true, error: String(error && error.message || error) });
            }
        });
    }

    function selectedSource() { return sources.find(item => item.id === sourceSelect.value) || null; }
    function selectedCategory() {
        const source = selectedSource();
        return source && source.categories.find(item => item.id === categorySelect.value) || null;
    }
    function selectedChart() {
        const category = selectedCategory();
        return category && category.charts.find(item => item.id === chartSelect.value) || null;
    }
    function fillSelect(select, items) {
        select.innerHTML = items.map(item => '<option value="' + String(item.id).replace(/"/g, '&quot;') + '">' +
            String(item.name).replace(/[&<>]/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value])) + '</option>').join('');
        select.disabled = !items.length || busy;
    }
    function updateChartName() {
        const source = selectedSource();
        const chart = selectedChart();
        if (source && chart) playlistName.value = source.name + ' - ' + chart.name;
        confirmBtn.disabled = busy || !chart;
    }
    function updateCharts() {
        const category = selectedCategory();
        fillSelect(chartSelect, category ? category.charts : []);
        updateChartName();
    }
    function updateCategories() {
        const source = selectedSource();
        fillSelect(categorySelect, source ? source.categories : []);
        updateCharts();
    }
    function setBusy(value) {
        busy = value;
        sourceSelect.disabled = value || !sources.length;
        categorySelect.disabled = value || !selectedSource();
        chartSelect.disabled = value || !selectedCategory();
        playlistName.disabled = value;
        limitSelect.disabled = value;
        confirmBtn.disabled = value || !selectedChart();
        $('#cancelBtn').disabled = value;
    }

    sourceSelect.addEventListener('change', () => { resetImportAttempt(); updateCategories(); });
    categorySelect.addEventListener('change', () => { resetImportAttempt(); updateCharts(); });
    chartSelect.addEventListener('change', () => { resetImportAttempt(); updateChartName(); });
    limitSelect.addEventListener('change', resetImportAttempt);
    playlistName.addEventListener('input', resetImportAttempt);
    $('#cancelBtn').addEventListener('click', () => window.close());
    confirmBtn.addEventListener('click', async () => {
        const source = selectedSource();
        const chart = selectedChart();
        if (busy || !source || !chart) return;
        errorEl.textContent = '';
        statusEl.textContent = '正在读取并创建播放列表';
        setBusy(true);
        const options = {
            sourceId: source.id,
            chartId: chart.id,
            limit: Number(limitSelect.value) || 50,
            name: playlistName.value.trim()
        };
        const result = await send('importChart', Object.assign({ requestId: importRequestId(options) }, options));
        if (result && result.ok) {
            window.close();
            return;
        }
        errorEl.textContent = result && result.error ? result.error : '榜单导入失败，请重试';
        statusEl.textContent = '请选择要导入的榜单';
        if (result && result.ok === false && !result.uncertain) resetImportAttempt();
        setBusy(false);
    });

    send('getChartCatalog').then(result => {
        if (!result || !result.ok || !Array.isArray(result.sources) || !result.sources.length) {
            throw new Error(result && result.error || '没有可用的榜单来源');
        }
        sources = result.sources;
        fillSelect(sourceSelect, sources);
        updateCategories();
        statusEl.textContent = '请选择要导入的榜单';
    }).catch(error => {
        errorEl.textContent = String(error && error.message || error);
        statusEl.textContent = '榜单来源读取失败';
    });
})();
