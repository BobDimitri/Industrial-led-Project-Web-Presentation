// waterlevel-data.js —— 水位数据获取与缓存模块
(function() {
    'use strict';

    // CORS 代理（支持多个备选方案）
    const CORS_PROXIES = [
        'https://cors-anywhere.herokuapp.com/',
        'https://api.allorigins.win/raw?url=',
        'https://proxy.cors.sh/'
    ];
    const WATER_API_URL = 'https://waterlevel.ie/geojson/latest/';
const WATER_CACHE_KEY = 'waterlevel_ie_latest_geojson';
const WATER_CACHE_TTL_MS = 30 * 60 * 1000;

function saveWaterCache(data) {
    try {
        localStorage.setItem(WATER_CACHE_KEY, JSON.stringify({
            savedAt: Date.now(),
            data
        }));
    } catch (error) {
        console.warn('[Water Level] Cache save failed:', error);
    }
}

function loadWaterCache(maxAgeMs = Infinity) {
    try {
        const raw = localStorage.getItem(WATER_CACHE_KEY);
        if (!raw) return null;

        const cached = JSON.parse(raw);
        if (!cached.data || !cached.savedAt) return null;

        const ageMs = Date.now() - cached.savedAt;
        if (ageMs > maxAgeMs) return null;

        return cached;
    } catch (error) {
        console.warn('[Water Level] Cache load failed:', error);
        return null;
    }
}

function applyWaterData(data, sourceLabel) {
    state.waterData = data;
    state.stations = parseWaterStations(data);
    state.lastUpdate = new Date();
    state.isLoading = false;

    console.log(`[Water Level] ${sourceLabel}: ${Object.keys(state.stations).length} stations`);
    return state.waterData;
}
    // 数据缓存与状态
    let state = {
        waterData: null,
        stations: {},
        lastUpdate: null,
        isLoading: false,
        error: null,
        updateInterval: null
    };

    // 数据转换函数：GeoJSON → 站点格式
    function parseWaterStations(geojson) {
        const stations = {};
        
        if (!geojson || !geojson.features) {
            console.warn('[Water Level] Invalid GeoJSON structure');
            return stations;
        }

        geojson.features.forEach((feature, idx) => {
            const props = feature.properties || {};
            const coords = feature.geometry?.coordinates || [];
            
            if (coords.length < 2) return;

            // 尝试多个可能的属性名称获取水位
            let level = parseFloat(props.level) || 
                       parseFloat(props.waterlevel) || 
                       parseFloat(props.water_level) || 
                       parseFloat(props.value) || 
                       0;

            // 尝试多个可能的属性名称获取名称
            let name = props.name || 
                      props.station_id || 
                      props.station_name || 
                      props.title || 
                      `Station ${idx + 1}`;

            const stationId = props.id || props.station_id || props.name || `station_${Math.random().toString(36).slice(2, 9)}`;
            
            function firstNumber(...values) {
    for (const value of values) {
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function getStationThresholds(props) {
    return {
        p75: firstNumber(props.p75, props.P75, props.percentile75, props.percentile_75),
        p95: firstNumber(props.p95, props.P95, props.percentile95, props.percentile_95),
        flood: firstNumber(
            props.flood_threshold,
            props.floodThreshold,
            props.significant_flood_threshold,
            props.significantFloodThreshold,
            props.alert_level,
            props.alertLevel
        )
    };
}

function classifyWaterLevel(level, thresholds) {
    if (!Number.isFinite(level)) {
        return {
            label: 'No reading',
            color: '#64748b',
            priority: 0
        };
    }

    if (Number.isFinite(thresholds.flood) && level >= thresholds.flood) {
        return {
            label: 'Flood threshold exceeded',
            color: '#ef4444',
            priority: 3
        };
    }

    if (Number.isFinite(thresholds.p95) && level >= thresholds.p95) {
        return {
            label: 'Very high',
            color: '#ef4444',
            priority: 3
        };
    }

    if (Number.isFinite(thresholds.p75) && level >= thresholds.p75) {
        return {
            label: 'High',
            color: '#f59e0b',
            priority: 2
        };
    }

    if (Number.isFinite(thresholds.p75)) {
        return {
            label: 'Normal',
            color: '#22c55e',
            priority: 1
        };
    }

    return {
        label: 'Normal',
        color: '#3078dc',
        priority: 0
    };
}
       
const thresholds = getStationThresholds(props);
const classification = classifyWaterLevel(parseFloat(level), thresholds);

            stations[stationId] = {
                id: stationId,
                name: name,
                description: props.description || props.remarks || '',
                lat: coords[1],
                lon: coords[0],
                elevation: props.elevation || props.altitude || null,
                level: parseFloat(level),
                thresholds,
                classification,
                timestamp: props.timestamp || props.updated || new Date().toISOString(),
                status: props.status || 'normal',
                history: props.history || [],
                rawData: props  // 保存原始数据便于调试
            };

            console.debug(`[Water Level] Parsed station: ${name} (${level}m)`);
        });

        return stations;
    }

    // 获取数据（支持 CORS 代理）
    async function fetchWaterData() {
        if (state.isLoading) {
            console.log('[Water Level] Fetch already in progress');
            return state.waterData;
        }
        const freshCache = loadWaterCache(WATER_CACHE_TTL_MS);
        if (freshCache) {
    return applyWaterData(freshCache.data, 'Loaded fresh cached data');
}
        state.isLoading = true;
        state.error = null;

        // 尝试直接访问
        try {
            console.log('[Water Level] Fetching from waterlevel.ie...');
            const res = await fetch(WATER_API_URL, {
                headers: { 'Accept': 'application/json' },
                mode: 'cors'
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const data = await res.json();
            state.waterData = data;
            state.stations = parseWaterStations(data);
            state.lastUpdate = new Date();
            state.isLoading = false;

            console.log(`✅ Water data fetched: ${Object.keys(state.stations).length} stations`);
            // 详细日志 - 显示前3个站点
            Object.values(state.stations).slice(0, 3).forEach(s => {
                console.log(`   → ${s.name}: ${s.level}m`);
            });
            return state.waterData;
        } catch (directError) {
            console.warn('[Water Level] Direct fetch failed, trying CORS proxy...', directError.message);

            // 尝试 CORS 代理
            for (const proxy of CORS_PROXIES) {
                try {
                    const proxyUrl = proxy.includes('?url=') 
                        ? `${proxy}${encodeURIComponent(WATER_API_URL)}`
                        : `${proxy}${WATER_API_URL}`;

                    console.log(`[Water Level] Trying proxy: ${proxy.split('/')[2]}`);
                    const res = await fetch(proxyUrl, {
                        headers: { 'Accept': 'application/json' },
                        timeout: 5000
                    });

                    if (!res.ok) continue;

                    let data;
                    const contentType = res.headers.get('content-type');
                    if (contentType?.includes('application/json')) {
                        data = await res.json();
                    } else {
                        const text = await res.text();
                        data = JSON.parse(text);
                    }

                    saveWaterCache(data);
                    applyWaterData(data, 'Live data fetched');
                    // 详细日志 - 显示前3个站点
                    Object.values(state.stations).slice(0, 3).forEach(s => {
                        console.log(`   → ${s.name}: ${s.level}m`);
                    });
                    return state.waterData;
                } catch (proxyError) {
                    console.debug(`[Water Level] Proxy failed: ${proxyError.message}`);
                    continue;
                }
            }

            // 所有方案都失败
            state.isLoading = false;
            state.error = 'Failed to fetch water level data from all sources';
            console.error('[Water Level] All fetch attempts failed');

            // No fallback data: keep the UI empty when the live API is unavailable.
            const staleCache = loadWaterCache();
if (staleCache) {
    state.error = 'Live water level data unavailable; showing last cached data';
    return applyWaterData(staleCache.data, 'Loaded stale cached data');
}

return null;
        }
    }


    // 获取单个站点详情
    function getStation(stationId) {
        return state.stations[stationId] || null;
    }

    // 获取所有站点
    function getAllStations() {
        return Object.values(state.stations);
    }

    // 获取缓存的数据
    function getCachedData() {
        return {
            data: state.waterData,
            stations: state.stations,
            lastUpdate: state.lastUpdate,
            error: state.error
        };
    }

    // 启动定时更新
    function startAutoRefresh(intervalMinutes = 5) {
        if (state.updateInterval) clearInterval(state.updateInterval);

        console.log(`[Water Level] Auto-refresh enabled: every ${intervalMinutes} minutes`);
        
        state.updateInterval = setInterval(() => {
            fetchWaterData().catch(err => console.error('[Water Level] Auto-refresh error:', err));
        }, intervalMinutes * 60 * 1000);
    }

    // 停止定时更新
    function stopAutoRefresh() {
        if (state.updateInterval) {
            clearInterval(state.updateInterval);
            state.updateInterval = null;
            console.log('[Water Level] Auto-refresh stopped');
        }
    }

    // 导出 API
    window.waterLevelAPI = {
        fetch: fetchWaterData,
        getStation,
        getAllStations,
        getCached: getCachedData,
        startAutoRefresh,
        stopAutoRefresh,
        getState: () => state
    };

    console.log('✅ Water Level Data Module Loaded');
})();
