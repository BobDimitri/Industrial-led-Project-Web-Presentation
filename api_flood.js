// api_flood.js —— RFRI 监控面板 + 历史/预测趋势图
(async function () {
    'use strict';

    const DUBLIN = { label: 'Dublin', latlng: [53.3498, -6.2603], color: '#38bdf8' };
    const RFRI_THRESHOLDS = [
        { key: 'NO_RISK', name: 'No Risk / Normal', threshold: 0, color: '#6B7280' },
        { key: 'ALERT', name: 'ALERT', threshold: 0.102, color: '#3B82F6' },
        { key: 'WATCH', name: 'WATCH', threshold: 0.138, color: '#EAB308' },
        { key: 'WARNING', name: 'WARNING', threshold: 0.264, color: '#F97316' },
        { key: 'EXTREME', name: 'EXTREME', threshold: 0.407, color: '#DC2626' }
    ];

    let state = { dublin: null };
    let historyPayload = null;
    let forecastPayload = null;
    let chartModal = null;
    let sharedReadyPromise = null;
    const RFRI_FORMULA = { rainCoeff: 0.68, rainMax: 84.0, apiCoeff: 0.32, apiMax: 176.44 };

    function getK(month) {
        if (month === 1) return 0.980;
        if (month === 2) return 0.964;
        if (month === 3) return 0.935
        if (month === 4) return 0.898
        if (month === 5) return 0.858
        if (month === 6) return 0.822
        if (month === 7) return 0.800
        if (month === 8) return 0.822
        if (month === 9) return 0.858
        if (month === 10) return 0.898
        if (month === 11) return 0.935
        if (month === 12) return 0.964;   
    }

    function getRFRIRisk(rfri) {
        if (rfri >= RFRI_THRESHOLDS[4].threshold) return { ...RFRI_THRESHOLDS[4], order: 4 };
        if (rfri >= RFRI_THRESHOLDS[3].threshold) return { ...RFRI_THRESHOLDS[3], order: 3 };
        if (rfri >= RFRI_THRESHOLDS[2].threshold) return { ...RFRI_THRESHOLDS[2], order: 2 };
        if (rfri >= RFRI_THRESHOLDS[1].threshold) return { ...RFRI_THRESHOLDS[1], order: 1 };
        return { ...RFRI_THRESHOLDS[0], order: 0 };
    }

    function formatDateLabel(dateStr) {
        return new Date(dateStr).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' });
    }

    function formatDateTime(dateStr) {
        return new Date(dateStr).toLocaleDateString('en-IE', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function toFixed3(value) {
        return Number(value.toFixed(3));
    }

    function calcRFRIValue(pt, api) {
        return toFixed3((RFRI_FORMULA.rainCoeff * (pt / RFRI_FORMULA.rainMax)) + (RFRI_FORMULA.apiCoeff * (api / RFRI_FORMULA.apiMax)));
    }

    function animateValue(element, endValue) {
        if (!element) return;
        const startValue = 0;
        const duration = 900;
        const startTime = performance.now();
        const step = (now) => {
            const progress = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = startValue + (endValue - startValue) * eased;
            element.textContent = current.toFixed(3);
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        };
        requestAnimationFrame(step);
    }

    function pulseBadge(element) {
        if (!element) return;
        element.classList.remove('risk-badge-pulse');
        void element.offsetWidth;
        element.classList.add('risk-badge-pulse');
        setTimeout(() => element.classList.remove('risk-badge-pulse'), 1200);
    }

    function buildForecastSeries(historyApiValues, historyDates, historyRain, forecastRainValues, forecastDates, todayApi, todayRain, todayDate) {
        const forecastSeries = [];
        let currentApi = todayApi;
        forecastDates.forEach((date, index) => {
            const rainForDate = Number(forecastRainValues[index] || 0);
            // Determine previous day's rain to compute API(date)
            const prevRain = (date === todayDate)
                ? Number(todayRain || 0)
                : Number((index === 0 ? todayRain : (forecastRainValues[index - 1] || 0)) || 0);

            if (date === todayDate) {
                currentApi = todayApi;
                forecastSeries.push({
                    date,
                    api: toFixed3(todayApi),
                    rain: Number(todayRain.toFixed(1)),
                    rfri: calcRFRIValue(todayRain, todayApi)
                });
                return;
            }

            const month = new Date(date).getMonth() + 1;
            // Use previous day's rain when computing API for this date
            const kVal = getK(month);
            const apiForDate = kVal * (currentApi + prevRain);

            // Debug trace (safe to keep) — helpful when verifying forecast steps in browser console
            if (window && window.console && window.console.debug) {
                console.debug('[RFRI forecast step]', { index, date, prevApi: currentApi, prevRain, k: kVal, apiForDate: Number(apiForDate.toFixed(6)) });
            }

            currentApi = apiForDate;

            forecastSeries.push({
                date,
                api: toFixed3(apiForDate),
                rain: Number(rainForDate.toFixed(1)),
                rfri: calcRFRIValue(rainForDate, apiForDate)
            });
        });
        return forecastSeries;
    }

    async function fetchHistoricalData() {
        const todayStr = new Date().toISOString().split('T')[0];
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${DUBLIN.latlng[0]}&longitude=${DUBLIN.latlng[1]}&daily=precipitation_sum&timezone=Europe/Dublin&start_date=2010-01-01&end_date=${todayStr}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function fetchForecastData() {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${DUBLIN.latlng[0]}&longitude=${DUBLIN.latlng[1]}&daily=precipitation_sum&timezone=Europe/Dublin&forecast_days=5`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function calculateDublinAPI(retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                historyPayload = await fetchHistoricalData();
                forecastPayload = await fetchForecastData();

                const historyDates = historyPayload.daily.time || [];
                const historyRain = (historyPayload.daily.precipitation_sum || []).map(value => Number(value || 0));
                const forecastDates = (forecastPayload.daily.time || []).slice(0, 5);
                const forecastRain = (forecastPayload.daily.precipitation_sum || []).slice(0, 5).map(value => Number(value || 0));

                if (!historyDates.length) throw new Error('No historical data returned');

                const todayStr = new Date().toISOString().split('T')[0];
                const todayIndex = historyDates.findIndex(date => date === todayStr);
                if (todayIndex === -1) throw new Error(`Today ${todayStr} not found`);

                const apiSeries = [];
                let currentApi = 10.1;
                historyRain.forEach((rainValue, index) => {
                    apiSeries.push(toFixed3(currentApi));
                    if (index < historyRain.length - 1) {
                        const nextMonth = new Date(historyDates[index + 1]).getMonth() + 1;
                        currentApi = getK(nextMonth) * (currentApi + rainValue);
                    }
                });

                const todayApi = apiSeries[todayIndex] || 10.1;
                const todayRain = historyRain[todayIndex] || 0;
                const todayRFRI = calcRFRIValue(todayRain, todayApi);
                const todayRisk = getRFRIRisk(todayRFRI);

                const historySeries = historyDates.map((date, index) => ({
                    date,
                    api: apiSeries[index],
                    rain: historyRain[index],
                    rfri: calcRFRIValue(historyRain[index], apiSeries[index]),
                    isForecast: false
                }));

                const forecastSeries = buildForecastSeries(
                    apiSeries,
                    historyDates,
                    historyRain,
                    forecastRain,
                    forecastDates,
                    todayApi,
                    todayRain,
                    todayStr
                ).map(item => ({ ...item, isForecast: true }));

                state.dublin = {
                    api: Number(todayApi.toFixed(1)),
                    fi: todayRFRI,
                    fiRisk: { label: todayRisk.name, col: todayRisk.color, key: todayRisk.key },
                    todayPt: Number(todayRain.toFixed(1)),
                    todayDate: todayStr,
                    todayK: getK(new Date(todayStr).getMonth() + 1),
                    todayRFRI,
                    forecast: forecastSeries.map(item => ({
                        date: formatDateTime(item.date),
                        api: Number(item.api.toFixed(1)),
                        rain: item.rain.toFixed(1),
                        rfri: item.rfri,
                        risk: getRFRIRisk(item.rfri)
                    })),
                    historyValues: apiSeries,
                    historySeries,
                    forecastSeries,
                    historyDates,
                    forecastDates,
                    todayIndex,
                    todayLabel: formatDateLabel(todayStr),
                    riskMeta: todayRisk
                };

                console.log(`✅ RFRI data ready. Today API: ${todayApi.toFixed(1)}, RFRI: ${todayRFRI.toFixed(3)}`);
                return;
            } catch (error) {
                console.warn(`[RFRI] Attempt ${attempt} failed:`, error.message);
                if (attempt === retries) {
                    state.dublin = {
                        api: 0,
                        fi: 0,
                        fiRisk: { label: 'No Risk / Normal', col: '#6B7280', key: 'NO_RISK' },
                        todayPt: 0,
                        todayDate: null,
                        todayK: null,
                        todayRFRI: 0,
                        forecast: [],
                        historyValues: [],
                        historySeries: [],
                        forecastSeries: [],
                        historyDates: [],
                        forecastDates: [],
                        todayIndex: 0,
                        todayLabel: 'No data',
                        riskMeta: { ...RFRI_THRESHOLDS[0], order: 0 }
                    };
                } else {
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                }
            }
        }
    }

    function renderPanel() {
        const panel = document.getElementById('api-dublin-panel');
        if (!panel) return;
        const s = state.dublin;
        if (!s) return;
        const valueEl = document.getElementById('panel-rfri-value');
        const badgeEl = document.getElementById('panel-risk-badge');
        const cardEl = document.getElementById('panel-risk-summary');
        if (valueEl) {
            valueEl.textContent = s.todayRFRI.toFixed(3);
            animateValue(valueEl, s.todayRFRI);
        }
        if (badgeEl) {
            badgeEl.textContent = s.riskMeta.name;
            badgeEl.style.background = `${s.riskMeta.color}22`;
            badgeEl.style.color = s.riskMeta.color;
            badgeEl.style.borderColor = `${s.riskMeta.color}44`;
            pulseBadge(badgeEl);
        }
        if (cardEl) {
            cardEl.innerHTML = `
                <div class="metric-card">
                    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's Rainfall</div>
                    <div style="font-size:15px; font-weight:700; margin-top:4px;">${s.todayPt.toFixed(1)} mm</div>
                </div>
                <div class="metric-card">
                    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's API</div>
                    <div style="font-size:15px; font-weight:700; margin-top:4px;">${s.api}</div>
                </div>
                <div class="metric-card">
                    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's RFRI</div>
                    <div style="font-size:15px; font-weight:700; margin-top:4px;">${s.todayRFRI.toFixed(3)}</div>
                </div>
                <div class="metric-card">
                    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Current Level</div>
                    <div style="font-size:15px; font-weight:700; margin-top:4px;">${s.riskMeta.name}</div>
                </div>
            `;
        }
    }

    function createPanel() {
        if (document.getElementById('api-dublin-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'api-dublin-panel';
        panel.style.cssText = `
            position: absolute; bottom: 20px; right: 20px;
            background: rgba(15,23,42,0.95); color: white;
            border-radius: 16px; padding: 16px; width: 300px;
            box-shadow: 0 10px 32px rgba(0,0,0,0.5); z-index: 998 !important;
            font-family: system-ui, sans-serif; backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.15);
        `;
        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <strong style="font-size:14px; opacity:0.9;">Dublin RFRI Monitoring</strong>
                <span id="panel-toggle" style="font-size:11px; opacity:0.7;">●</span>
            </div>
            <div style="margin-bottom:10px;">
                <div id="panel-rfri-value" style="font-size:42px; line-height:1; font-weight:800;">--</div>
                <div style="margin-top:8px;">
                    <span id="panel-risk-badge" class="risk-badge" style="background:rgba(107,114,128,0.2); color:#6B7280; border:1px solid rgba(107,114,128,0.35);">--</span>
                </div>
            </div>
            <div id="panel-risk-summary" style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;"></div>
            <button id="btn-current-risk" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.25); color:#ffffff; padding:10px; border-radius:8px; width:100%; margin:6px 0; cursor:pointer; font-weight:600;">
                Current Risk
            </button>
            <button id="btn-history" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#ffffff; padding:10px; border-radius:8px; width:100%; margin:6px 0; cursor:pointer; font-weight:600;">
                RFRI Trend & Forecast
            </button>
        `;
        const container = (typeof map !== 'undefined') ? map.getContainer() : document.body;
        container.appendChild(panel);

        // small footer at bottom-left for project name and author
        if (!document.getElementById('rfri-footer')) {
            const footer = document.createElement('div');
            footer.id = 'rfri-footer';
            footer.style.cssText = 'position: absolute; left: 20px; bottom: 20px; color: #111827; background: #ffffff; font-size:12px; padding:8px 10px; border-radius:6px; z-index: 998; font-family: system-ui, sans-serif; pointer-events: auto; text-align: left; box-shadow: 0 2px 8px rgba(0,0,0,0.18);';
            footer.innerHTML = '<a href="index.html" style="font-weight:600; font-size:13px; color:#111827; text-decoration:none;">NBS Ditital Twin Project</a><div style="font-size:12px; color:#374151; margin-top:2px;">Weitao Zhang</div>';
            container.appendChild(footer);
        }

        document.getElementById('btn-history').onclick = () => showHistoryChart();
        document.getElementById('btn-current-risk').onclick = showCurrentRiskPopup;
        renderPanel();
    }

    function buildForecastTableRows(s) {
        if (!s.forecast || s.forecast.length === 0) {
            return '<div style="margin-top:12px; font-size:13px; opacity:0.6;">No forecast data available</div>';
        }
        return `
            <div style="margin-top:16px; border-top:1px solid rgba(255,255,255,0.2); padding-top:12px;">
                <h4 style="margin:0 0 8px 0; font-size:14px; opacity:0.9;">5-Day Forecast</h4>
                <table style="width:100%; font-size:13px; text-align:center; border-collapse:collapse;">
                    <thead>
                        <tr>
                            <th style="padding:4px 0;">Date</th>
                            <th>API</th>
                            <th>Rain (mm)</th>
                            <th>Risk</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${s.forecast.map(item => `
                            <tr>
                                <td style="padding:6px 0;">${item.date}</td>
                                <td>${item.api}</td>
                                <td>${item.rain}</td>
                                <td><span class="risk-badge" style="background:${item.risk.color}22; color:${item.risk.color}; border:1px solid ${item.risk.color}44; padding:4px 8px; font-size:11px;">${item.risk.name}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function showCurrentRiskPopup() {
        const s = state.dublin;
        if (!s) return;
        let modal = document.getElementById('risk-modal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'risk-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(2,6,23,0.85); z-index:2000; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); padding:16px;';
        modal.innerHTML = `
            <div class="risk-modal-content" style="width:min(96vw, 540px); max-height:min(90vh, 860px); overflow:auto; position:relative; padding:24px; border-radius:20px; border:1px solid rgba(255,255,255,0.15);">
                <button id="risk-modal-close" style="position:absolute; top:14px; right:16px; background:none; border:none; color:white; font-size:28px; cursor:pointer;">×</button>
                <div style="display:flex; flex-direction:column; align-items:center; gap:8px; margin-bottom:18px;">
                    <div style="font-size:13px; text-transform:uppercase; letter-spacing:0.16em; opacity:0.7;">Current RFRI</div>
                    <div id="risk-current-value" style="font-size:54px; font-weight:800; line-height:1;">${s.todayRFRI.toFixed(3)}</div>
                    <div id="risk-badge" class="risk-badge" style="background:${s.riskMeta.color}22; color:${s.riskMeta.color}; border:1px solid ${s.riskMeta.color}44; padding:7px 12px; font-size:12px; margin-top:6px;">${s.riskMeta.name}</div>
                </div>
                <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:16px;">
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's Rainfall</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.todayPt.toFixed(1)} mm</div>
                    </div>
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's API</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.api}</div>
                    </div>
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Today's RFRI</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.todayRFRI.toFixed(3)}</div>
                    </div>
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Current Level</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.riskMeta.name}</div>
                    </div>
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Current Date</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.todayDate ? formatDateLabel(s.todayDate) : '—'}</div>
                    </div>
                    <div class="metric-card">
                        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; opacity:0.65;">Current K Value</div>
                        <div style="font-size:16px; font-weight:700; margin-top:4px;">${s.todayK == null ? '—' : s.todayK.toFixed(3)}</div>
                    </div>
                </div>
                ${buildForecastTableRows(s)}
            </div>
        `;
        document.body.appendChild(modal);

        const badgeEl = modal.querySelector('#risk-badge');
        const valueEl = modal.querySelector('#risk-current-value');
        animateValue(valueEl, s.todayRFRI);
        pulseBadge(badgeEl);

        modal.querySelector('#risk-modal-close').onclick = () => modal.remove();
        modal.addEventListener('click', (event) => {
            if (event.target === modal) modal.remove();
        });
    }

    function downsamplePoints(points, maxPoints = 220) {
        if (!points.length || points.length <= maxPoints) return points;
        const result = [];
        const step = Math.ceil(points.length / maxPoints);
        for (let index = 0; index < points.length; index += step) {
            const chunk = points.slice(index, index + step);
            const valueSum = chunk.reduce((sum, item) => sum + item.rfri, 0);
            const apiSum = chunk.reduce((sum, item) => sum + item.api, 0);
            const sample = { ...chunk[0], rfri: valueSum / chunk.length, api: apiSum / chunk.length };
            result.push(sample);
        }
        if (result[result.length - 1]?.date !== points[points.length - 1]?.date) {
            result.push({ ...points[points.length - 1] });
        }
        return result;
    }

    function selectRangePoints(historySeries, forecastSeries) {
        const historyPoints = [...historySeries];
        const forecastPoints = [...forecastSeries];
        const windowHistory = historyPoints.slice(Math.max(0, historyPoints.length - 90));
        return {
            history: windowHistory,
            forecast: forecastPoints
        };
    }

    function buildChartData() {
        const s = state.dublin;
        if (!s) return null;

        const { history: historySubset, forecast: forecastSubset } = selectRangePoints(s.historySeries || [], s.forecastSeries || []);
        const combined = [...historySubset, ...forecastSubset].sort((a, b) => new Date(a.date) - new Date(b.date));
        const downsampled = downsamplePoints(combined);
        const labels = downsampled.map(item => formatDateLabel(item.date));
        const historyValues = downsampled.map(item => (item.isForecast ? null : item.rfri));
        const forecastValues = downsampled.map(item => (item.isForecast ? item.rfri : null));
        return { labels, historyValues, forecastValues, downsampled };
    }

    function showHistoryChart() {
        const s = state.dublin;
        if (!s || !s.historySeries || !s.forecastSeries) return;

        if (chartModal) chartModal.remove();
        chartModal = document.createElement('div');
        chartModal.id = 'history-modal';
        chartModal.style.cssText = 'position:fixed; inset:0; background:rgba(2,6,23,0.9); z-index:2000; display:flex; align-items:center; justify-content:center; padding:16px; backdrop-filter:blur(8px);';
        chartModal.innerHTML = `
            <div class="history-modal-content" style="width:min(96vw, 980px); max-height:min(90vh, 900px); overflow:auto; position:relative; padding:20px; border-radius:20px; border:1px solid rgba(255,255,255,0.15);">
                <button id="history-modal-close" style="position:absolute; top:12px; right:16px; background:none; border:none; color:white; font-size:28px; cursor:pointer;">×</button>
                <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:16px;">
                    <div>
                        <h3 style="margin:0 0 6px 0; font-size:22px;">RFRI Trend & Forecast</h3>
                        <div style="font-size:13px; opacity:0.7;">Last 90 days of historical RFRI trend, with 5-day forecast and threshold lines.</div>
                    </div>
                </div>
                <div class="chart-shell">
                    <canvas id="history-chart"></canvas>
                </div>
            </div>
        `;
        document.body.appendChild(chartModal);

        const chartCanvas = chartModal.querySelector('#history-chart');
        const chartData = buildChartData();
        if (!chartData) return;

        const datasets = [
            {
                label: 'RFRI History',
                data: chartData.historyValues,
                borderColor: '#1E40AF',
                backgroundColor: 'rgba(30,64,175,0.22)',
                fill: false,
                tension: 0.28,
                pointRadius: 0,
                pointHoverRadius: 4,
                segment: {
                    borderColor: (ctx) => {
                        const risk = getRFRIRisk(ctx.p1?.parsed?.y ?? ctx.p0?.parsed?.y ?? 0);
                        return risk.color;
                    }
                }
            },
            {
                label: 'RFRI Forecast',
                data: chartData.forecastValues,
                borderColor: '#10B981',
                backgroundColor: 'rgba(16,185,129,0.16)',
                fill: false,
                tension: 0.28,
                borderDash: [6, 4],
                pointRadius: 3,
                pointHoverRadius: 4,
                pointBackgroundColor: '#10B981',
                pointBorderColor: '#34D399'
            },
            {
                label: 'ALERT 0.102',
                data: chartData.labels.map(() => 0.102),
                borderColor: '#3B82F6',
                borderDash: [5, 4],
                pointRadius: 0,
                fill: false
            },
            {
                label: 'WATCH 0.138',
                data: chartData.labels.map(() => 0.138),
                borderColor: '#EAB308',
                borderDash: [5, 4],
                pointRadius: 0,
                fill: false
            },
            {
                label: 'WARNING 0.264',
                data: chartData.labels.map(() => 0.264),
                borderColor: '#F97316',
                borderDash: [5, 4],
                pointRadius: 0,
                fill: false
            },
            {
                label: 'EXTREME 0.407',
                data: chartData.labels.map(() => 0.407),
                borderColor: '#DC2626',
                borderDash: [5, 4],
                pointRadius: 0,
                fill: false
            }
        ];

        new Chart(chartCanvas, {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 900, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        labels: { color: '#E5E7EB', boxWidth: 12, padding: 12, font: { size: 11 } }
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const value = context.parsed.y;
                                const label = context.dataset.label || '';
                                if (label.includes('RFRI')) {
                                    return `${label}: ${Number(value).toFixed(3)}`;
                                }
                                if (label.includes('API')) {
                                    return `${label}: ${Number(value).toFixed(2)}`;
                                }
                                return `${label}: ${Number(value).toFixed(3)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#CBD5E1', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
                        grid: { color: 'rgba(255,255,255,0.08)' },
                        border: { color: 'rgba(255,255,255,0.12)' }
                    },
                    y: {
                        beginAtZero: true,
                        max: 0.5,
                        ticks: { color: '#CBD5E1', stepSize: 0.1 },
                        grid: { color: 'rgba(255,255,255,0.08)' },
                        border: { color: 'rgba(255,255,255,0.12)' }
                    }
                }
            }
        });

        chartModal.querySelector('#history-modal-close').onclick = () => chartModal.remove();
        chartModal.addEventListener('click', (event) => {
            if (event.target === chartModal) chartModal.remove();
        });
    }

    function getSharedForecastItems() {
        const s = state.dublin;
        if (!s) return null;
        return (s.forecastSeries || []).map((item, index) => ({
            date: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : `Day ${index + 1}`,
            rain: Number(Number(item.rain).toFixed(1)),
            api: Number(item.api.toFixed(1)),
            rfri: Number(Number(item.rfri).toFixed(3))
        }));
    }

    window.state = state;
    window.RFRIShared = {
        getFormula: () => ({ ...RFRI_FORMULA }),
        isReady: () => Boolean(state.dublin),
        getState: () => state.dublin,
        getCurrentSnapshot: () => {
            if (!state.dublin) return null;
            return {
                todayRain: Number(state.dublin.todayPt.toFixed(1)),
                todayApi: Number(state.dublin.api),
                todayRFRI: Number(state.dublin.todayRFRI.toFixed(3)),
                forecast: getSharedForecastItems()
            };
        },
        getForecastSeries: () => getSharedForecastItems(),
        waitForReady: async () => {
            if (state.dublin) return window.RFRIShared.getCurrentSnapshot();
            if (!sharedReadyPromise) {
                sharedReadyPromise = calculateDublinAPI(3).then(() => window.RFRIShared.getCurrentSnapshot());
            }
            return sharedReadyPromise;
        }
    };

    // Expose init() and ready promise for explicit handshake
    window.RFRIShared.init = function() {
        if (!sharedReadyPromise) {
            sharedReadyPromise = calculateDublinAPI(3).then(() => window.RFRIShared.getCurrentSnapshot());
        }
        return sharedReadyPromise;
    };
    window.RFRIShared.ready = window.RFRIShared.init();

    window.RFRIShared.ready.then(() => {
        createPanel();
        window.dispatchEvent(new Event('fi-ready'));
        console.log('[FI Module] Ready');
    }).catch(err => {
        console.error('[FI Module] init failed', err);
    });
})();