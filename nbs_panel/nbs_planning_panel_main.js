// ============================================
// NBS Planning Panel v2.1
// 修复：删除建筑状态点 / 使用真实 DCC 边界 / ITM->WGS84 转换
// ============================================
(function() {
    'use strict';

    const CFG = {
        center: [-6.2603, 53.3498],
        bbox: '53.30,-6.37,53.41,-6.12',
        dccBoundaryUrl: './boundaries/dcc_boundary.geojson',
        overpassEndpoints: [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter'
        ],
        cacheKey: 'nbs_v2_buildings',
        cacheTTL: 24 * 60 * 60 * 1000,
        rainfallEvent: 0.030,
        greenRoof: {
            runoffReduction: 0.65,
            carbonRate: 2.5,
            storageDepth: 20,
            color: '#22c55e',
            label: 'Green Roof',
            vBuilding: 0.70
        },
        catchmentAreaM2: 118 * 1_000_000,
        fiFormula: {
            rainCoeff: 0.72, rainMax: 84,
            apiCoeff: 0.28, apiMax: 167.56
        },
        today: { pt: 45, api: 80 },
        forecast: [
            { date: 'Today',     rain: 45, api: 80 },
            { date: 'Tomorrow',  rain: 32, api: 85 },
            { date: 'Day 3',     rain: 12, api: 78 },
            { date: 'Day 4',     rain: 58, api: 92 },
            { date: 'Day 5',     rain: 22, api: 70 }
        ]
    };

    const S = {
        map: null,
        buildings: null,
        assignments: {},
        zones: [],
        selectedUid: null,
        targetCoverage: 30,
        drawMode: false,
        drawPoints: [],
        zoneIdCounter: 0,
        chartBuilding: null,
        chartCoverage: null,
        popup: null,
        active: false,
        dccBoundary: null
    };

    // ===== ITM -> WGS84 =====
    function itmToWgs84(easting, northing) {
        const a = 6378137;
        const invF = 298.257222101;
        const f = 1 / invF;
        const e2 = 2 * f - f * f;
        const ep2 = e2 / (1 - e2);
        const lat0 = 53.5 * Math.PI / 180;
        const lon0 = -8 * Math.PI / 180;
        const k0 = 0.99982;
        const x0 = 600000;
        const y0 = 750000;
        const e4 = e2 * e2, e6 = e4 * e2;
        const m0 = a * ((1 - e2/4 - 3*e4/64 - 5*e6/256) * lat0
            - (3*e2/8 + 3*e4/32 + 45*e6/1024) * Math.sin(2*lat0)
            + (15*e4/256 + 45*e6/1024) * Math.sin(4*lat0)
            - (35*e6/3072) * Math.sin(6*lat0));
        const m = m0 + (northing - y0) / k0;
        const mu = m / (a * (1 - e2/4 - 3*e4/64 - 5*e6/256));
        const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
        const e1_2 = e1*e1, e1_3 = e1_2*e1, e1_4 = e1_3*e1;
        const phi1 = mu
            + (3*e1/2 - 27*e1_3/32) * Math.sin(2*mu)
            + (21*e1_2/16 - 55*e1_4/32) * Math.sin(4*mu)
            + (151*e1_3/96) * Math.sin(6*mu)
            + (1097*e1_4/512) * Math.sin(8*mu);
        const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1), tanPhi1 = Math.tan(phi1);
        const n1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
        const r1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
        const t1 = tanPhi1 * tanPhi1;
        const c1 = ep2 * cosPhi1 * cosPhi1;
        const d = (easting - x0) / (n1 * k0);
        const lat = phi1 - (n1 * tanPhi1 / r1) * (
            d*d/2 - (5 + 3*t1 + 10*c1 - 4*c1*c1 - 9*ep2) * Math.pow(d,4)/24
            + (61 + 90*t1 + 298*c1 + 45*t1*t1 - 252*ep2 - 3*c1*c1) * Math.pow(d,6)/720
        );
        const lon = lon0 + (
            d - (1 + 2*t1 + c1) * Math.pow(d,3)/6
            + (5 - 2*c1 + 28*t1 - 3*c1*c1 + 8*ep2 + 24*t1*t1) * Math.pow(d,5)/120
        ) / cosPhi1;
        return [lon * 180 / Math.PI, lat * 180 / Math.PI];
    }

    function convertGeoJSONToWgs84(gj) {
        const copy = JSON.parse(JSON.stringify(gj));
        function convertCoords(coords) {
            if (!Array.isArray(coords)) return coords;
            if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                const x = coords[0], y = coords[1];
                if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
                return itmToWgs84(x, y);
            }
            return coords.map(convertCoords);
        }
        function convertGeom(g) {
            if (!g || !g.coordinates) return g;
            g.coordinates = convertCoords(g.coordinates);
            return g;
        }
        if (copy.type === 'FeatureCollection') copy.features.forEach(f => convertGeom(f.geometry));
        else if (copy.type === 'Feature') convertGeom(copy.geometry);
        else convertGeom(copy);
        return copy;
    }

    // ===== 几何工具 =====
    function geoAreaM2(pts) {
        if (pts.length < 3) return 0;
        const R = 6371000;
        let s = 0;
        for (let i = 0, n = pts.length; i < n; i++) {
            const j = (i + 1) % n;
            const l1 = pts[i][0] * Math.PI / 180, p1 = pts[i][1] * Math.PI / 180;
            const l2 = pts[j][0] * Math.PI / 180, p2 = pts[j][1] * Math.PI / 180;
            s += (l2 - l1) * (2 + Math.sin(p1) + Math.sin(p2));
        }
        return Math.abs(s) * R * R / 2;
    }

    function pointInPolygon(point, polygon) {
        const x = point[0], y = point[1];
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-10) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function getFeatureCenter(feature) {
        const coords = feature?.geometry?.coordinates;
        if (!coords) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        function visit(c) {
            if (Array.isArray(c[0])) { c.forEach(visit); return; }
            minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]);
            maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]);
        }
        visit(coords);
        return [(minX + maxX) / 2, (minY + maxY) / 2];
    }

    function isInsideDcc(feature) {
        if (!S.dccBoundary) return true;
        const center = getFeatureCenter(feature);
        if (!center) return false;
        const features = S.dccBoundary.type === 'FeatureCollection' ? S.dccBoundary.features : [S.dccBoundary];
        for (const f of features) {
            const geom = f.geometry;
            if (!geom) continue;
            const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            for (const poly of polys) {
                if (pointInPolygon(center, poly[0])) {
                    let inHole = false;
                    for (let h = 1; h < poly.length; h++) {
                        if (pointInPolygon(center, poly[h])) { inHole = true; break; }
                    }
                    if (!inHole) return true;
                }
            }
        }
        return false;
    }

    function fmtArea(m2) {
        return m2 >= 10000 ? (m2 / 10000).toFixed(2) + ' ha' : Math.round(m2).toLocaleString() + ' m\u00B2';
    }

    function fmtCarbon(kg) {
        return kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
    }

    // ===== RFRI =====
    function calcBaseRFRI(pt, api) {
        const f = CFG.fiFormula;
        return f.rainCoeff * (pt / f.rainMax) + f.apiCoeff * (api / f.apiMax);
    }

    function calcVnbsMM() {
        let totalStorage = 0;
        if (S.buildings) {
            Object.entries(S.assignments).forEach(([uid, type]) => {
                if (type !== 'green_roof') return;
                const f = S.buildings.features.find(b => b.properties.uid == uid);
                if (!f) return;
                const area = Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1));
                totalStorage += area * (CFG.greenRoof.storageDepth / 1000);
            });
        }
        S.zones.forEach(z => {
            if (z.type === 'green_roof') totalStorage += z.area * (CFG.greenRoof.storageDepth / 1000);
        });
        return (totalStorage / CFG.catchmentAreaM2) * 1000;
    }

    function calcVnbsMMBuildings() {
        let totalStorage = 0;
        if (!S.buildings) return 0;
        Object.entries(S.assignments).forEach(([uid, type]) => {
            if (type !== 'green_roof') return;
            const f = S.buildings.features.find(b => b.properties.uid == uid);
            if (!f) return;
            const area = Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1));
            totalStorage += area * (CFG.greenRoof.storageDepth / 1000);
        });
        return (totalStorage / CFG.catchmentAreaM2) * 1000;
    }

    function calcVnbsMMCoverageTarget(pct) {
        return Math.max(0, Math.min(100, pct)) * CFG.greenRoof.storageDepth / 100;
    }

    function calcAdjustedRFRI(pt, api) {
        const vnbs = calcVnbsMM();
        const effectiveRain = Math.max(0, pt - vnbs);
        return calcBaseRFRI(effectiveRain, api);
    }

    function calcAdjustedRFRIBuildings(pt, api) {
        const vnbs = calcVnbsMMBuildings();
        const effectiveRain = Math.max(0, pt - vnbs);
        return calcBaseRFRI(effectiveRain, api);
    }

    function calcAdjustedRFRICoverage(pt, api, pct) {
        const vnbs = calcVnbsMMCoverageTarget(pct);
        const effectiveRain = Math.max(0, pt - vnbs);
        return calcBaseRFRI(effectiveRain, api);
    }

    function getCoverage() {
        if (!S.buildings) return 0;
        const buildingCoverageArea = S.buildings.features.reduce((sum, f) => {
            if (S.assignments[f.properties.uid] !== 'green_roof') return sum;
            return sum + (Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1)));
        }, 0);
        const zoneCoverageArea = S.zones.reduce((sum, z) => sum + z.area, 0);
        return CFG.catchmentAreaM2 ? Math.min(100, ((buildingCoverageArea + zoneCoverageArea) / CFG.catchmentAreaM2) * 100) : 0;
    }

    function getCoverage() {
        if (!S.buildings) return 0;
        const total = S.buildings.features.length;
        const assigned = Object.values(S.assignments).filter(v => v === 'green_roof').length;
        return total ? (assigned / total) * 100 : 0;
    }

    // ===== Fallback 建筑 =====
    const FB = generateFallbackBuildings();
    function generateFallbackBuildings() {
        const features = [];
        let uid = 0;
        const centerLat = 53.3498, centerLng = -6.2603;
        const latSpan = 0.06, lngSpan = 0.09;
        const rows = 10, cols = 14;
        const types = ['residential','commercial','office','retail','apartments','mixed_use','school','hotel'];
        const typeHeights = { residential: 8, commercial: 10, office: 16, retail: 6, apartments: 14, mixed_use: 12, school: 9, hotel: 18 };
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const lat = centerLat - latSpan/2 + (r + 0.5) * latSpan / rows;
                const lng = centerLng - lngSpan/2 + (c + 0.5) * lngSpan / cols;
                if ((r % 3 === 0 && c % 2 === 0) || Math.random() < 0.15) continue;
                const bType = types[Math.floor(Math.random() * types.length)];
                const h = typeHeights[bType] || 8;
                const w = 0.0006 + Math.random() * 0.0012;
                const d = 0.0005 + Math.random() * 0.0010;
                const coords = [
                    [lng - w/2, lat - d/2], [lng + w/2, lat - d/2],
                    [lng + w/2, lat + d/2], [lng - w/2, lat + d/2],
                    [lng - w/2, lat - d/2]
                ];
                const area = geoAreaM2(coords.slice(0, -1));
                features.push({
                    type: 'Feature', id: uid,
                    geometry: { type: 'Polygon', coordinates: [coords] },
                    properties: {
                        uid: uid++, height: h,
                        name: bType.charAt(0).toUpperCase() + bType.slice(1) + ' ' + (r*cols+c),
                        building: bType, building_type: bType,
                        footprint_area_m2: Math.round(area),
                        levels: Math.round(h / 3.2),
                        nbs: 'none', nbs_color: '#64748b'
                    }
                });
            }
        }
        return { type: 'FeatureCollection', features };
    }

    // ===== UI 构建 =====
    function init() {
        console.log('[NBS] init() called');
        let mapDiv = document.getElementById('map');
        if (!mapDiv) mapDiv = document.getElementById('mapid');
        if (!mapDiv) mapDiv = document.querySelector('.leaflet-container');
        if (!mapDiv) { console.warn('[NBS] #map not found, retrying...'); setTimeout(init, 300); return; }
        console.log('[NBS] map container found:', mapDiv.id || mapDiv.className);
        if (getComputedStyle(mapDiv).position === 'static') mapDiv.style.position = 'relative';

        if (!document.getElementById('nbs-panel-css')) {
            const link = document.createElement('link');
            link.id = 'nbs-panel-css';
            link.rel = 'stylesheet';
            const scriptElement = Array.from(document.scripts).find(s => s.src && s.src.includes('nbs_planning_panel_main.js'));
            const basePath = scriptElement ? new URL('.', scriptElement.src).toString() : '';
            link.href = basePath + 'nbs_panel_style.css';
            document.head.appendChild(link);
            console.log('[NBS] CSS injected:', link.href);
        }

        const openBtn = document.createElement('button');
        openBtn.id = 'nbs-open-btn';
        openBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 20l10-16 10 16H2z"/><line x1="2" y1="20" x2="22" y2="20"/></svg> NBS Planning Panel';
        openBtn.style.cssText = 'position:absolute !important;top:18px !important;left:12px !important;z-index:1001 !important;display:flex !important;align-items:center !important;gap:8px !important;background:rgba(15,22,35,0.95) !important;color:#e8ecf1 !important;border:1px solid rgba(255,255,255,0.12) !important;border-radius:10px !important;padding:10px 16px !important;font:600 12px Inter,sans-serif !important;cursor:pointer !important;box-shadow:0 8px 32px rgba(0,0,0,0.5) !important;letter-spacing:0.3px !important;';
        mapDiv.appendChild(openBtn);
        console.log('[NBS] entry button created');
        openBtn.onclick = enterMode;

        const panel = document.createElement('div');
        panel.id = 'nbs-panel';
        panel.innerHTML = '<div id="nbs-map"></div>' +
            '<div id="nbs-topbar"><button id="nbs-back-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>Back</button><div id="nbs-title">NBS Planning Panel \u2014 Dublin</div><div id="nbs-status"><div id="nbs-status-dot"></div><span id="nbs-status-text">Ready</span></div></div>' +
            '<div id="nbs-sidebar"><div id="nbs-sidebar-inner">' +
            '<div id="nbs-bldg-head"><button id="nbs-bldg-close">\u2715</button><div id="nbs-bldg-name">Select a building</div><div id="nbs-bldg-meta">Click any building to assign Green Roof</div></div>' +
            '<div id="nbs-assign-section"><div id="nbs-assign-title">Nature-Based Solution</div><div class="nbs-option" data-nbs="none"><span class="nbs-dot"></span><span class="nbs-label">No NBS</span><span class="nbs-check">Selected</span></div><div class="nbs-option" data-nbs="green_roof"><span class="nbs-dot" style="background:#22c55e"></span><span class="nbs-label">Green Roof</span><span class="nbs-check">Selected</span></div></div>' +
            '<div id="nbs-bldg-impact"><div id="nbs-bldg-impact-title">Building Impact</div><div class="impact-grid"><div class="impact-cell"><div class="impact-cell-label">Footprint</div><div class="impact-cell-value" id="imp-area">--</div></div><div class="impact-cell"><div class="impact-cell-label">Height</div><div class="impact-cell-value" id="imp-height">--</div></div><div class="impact-cell"><div class="impact-cell-label">Runoff Mitigated</div><div class="impact-cell-value" id="imp-runoff">--</div></div><div class="impact-cell"><div class="impact-cell-label">Carbon Saved / yr</div><div class="impact-cell-value" id="imp-carbon">--</div></div></div></div>' +
            '<div id="nbs-coverage-section"><div id="nbs-coverage-title">Coverage</div><div id="nbs-coverage-row"><input type="range" id="nbs-coverage-slider" min="0" max="100" value="30"><input type="number" id="nbs-coverage-input" min="0" max="100" step="1" value="30"><span id="nbs-coverage-val">30%</span></div><div id="nbs-coverage-current">Current: 0% (target: 30%)</div></div>' +
            '<div id="nbs-summary"><div id="nbs-summary-title">Coverage Summary</div><div class="summary-row"><span class="summary-label">NBS Coverage</span><div class="summary-bar-wrap"><div class="summary-bar" id="sum-bar-gr" style="width:0%"></div></div><span class="summary-count" id="sum-count-gr">0%</span></div><div id="nbs-coverage-badge"><span id="nbs-coverage-badge-label">Actual Coverage</span><span id="nbs-coverage-badge-pct">0%</span></div></div>' +
            '</div></div>' +
            '<div id="nbs-chart-box"><div class="nbs-chart-panel"><div class="nbs-chart-header"><h4 class="nbs-chart-title">📉 Building RFRI Forecast</h4><div class="nbs-chart-legend"><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#4452ef"></span>Original</span><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#22c55e"></span>With Building NBS</span><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#f97316"></span>Selected Building</span></div></div><canvas id="nbs-chart-canvas-building" height="140"></canvas></div><div class="nbs-chart-panel"><div class="nbs-chart-header"><h4 class="nbs-chart-title">📈 Coverage RFRI Forecast</h4><div class="nbs-chart-legend"><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#4452ef"></span>Original</span><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#22c55e"></span>With Coverage</span><span class="chart-legend-item"><span class="chart-legend-dot" style="background:#38bdf8"></span>Actual Coverage</span></div></div><canvas id="nbs-chart-canvas-coverage" height="140"></canvas></div></div>' +            '<div id="nbs-toolbar"><button class="nbs-tool-btn on" id="tb-buildings"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="10" width="4" height="11"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>Buildings</button><div class="nbs-tool-sep"></div><button class="nbs-tool-btn" id="tb-draw"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><line x1="12" y1="12" x2="12" y2="22"/><line x1="2" y1="17" x2="12" y2="22"/><line x1="22" y1="17" x2="12" y2="22"/></svg>Draw Zone</button><button class="nbs-tool-btn" id="tb-zones"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/></svg>Zones</button><div class="nbs-tool-sep"></div><button class="nbs-tool-btn" id="tb-export"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export</button></div>' +
            '<div id="nbs-draw-hint">Click to add points \u00B7 Double-click to finish \u00B7 Esc to cancel</div>' +
            '<div id="nbs-zones-panel"><div id="nbs-zones-inner"><div id="nbs-zones-head"><span id="nbs-zones-head-title">NBS Green Zones</span><button id="nbs-zones-close">\u2715</button></div><div id="nbs-zones-list"><div id="nbs-zones-empty">No zones drawn yet.<br>Click "Draw Zone" to start.</div></div><div id="nbs-zones-totals"><div class="zt-row"><span>Total Area</span><span id="zt-area">\u2014</span></div><div class="zt-row"><span>Coverage</span><span id="zt-coverage">\u2014</span></div><div class="zt-row"><span>Runoff Mitigated</span><span id="zt-runoff">\u2014</span></div><div class="zt-row"><span>Carbon Saved / yr</span><span id="zt-carbon">\u2014</span></div><button id="nbs-zones-clear">Clear All Zones</button></div></div></div>';
        mapDiv.appendChild(panel);
        bindEvents();
    }

    function bindEvents() {
        document.getElementById('nbs-back-btn').onclick = exitMode;
        document.getElementById('nbs-bldg-close').onclick = closeSidebar;
        document.querySelectorAll('.nbs-option').forEach(opt => {
            opt.onclick = () => {
                if (S.selectedUid === null) return;
                const type = opt.dataset.nbs;
                if (type === 'none') removeNBS(S.selectedUid);
                else assignNBS(S.selectedUid, type);
            };
        });
        const slider = document.getElementById('nbs-coverage-slider');
        const input = document.getElementById('nbs-coverage-input');
        const valDisplay = document.getElementById('nbs-coverage-val');
        function updateCoverage(value) {
            const pct = Math.max(0, Math.min(100, parseInt(value) || 0));
            S.targetCoverage = pct;
            slider.value = pct;
            input.value = pct;
            valDisplay.textContent = pct + '%';
            updateSummary();
            updateChart();
        }
        slider.oninput = () => updateCoverage(slider.value);
        input.oninput = () => updateCoverage(input.value);
        document.getElementById('tb-buildings').onclick = toggleBuildings;
        document.getElementById('tb-draw').onclick = toggleDrawMode;
        document.getElementById('tb-zones').onclick = toggleZonesPanel;
        document.getElementById('tb-export').onclick = exportData;
        document.getElementById('nbs-zones-close').onclick = () => {
            document.getElementById('nbs-zones-panel').classList.remove('open');
            document.getElementById('tb-zones').classList.remove('on');
        };
        document.getElementById('nbs-zones-clear').onclick = clearAllZones;
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawMode) cancelDraw(); });
    }

    function enterMode() {
        S.active = true;
        document.getElementById('nbs-panel').classList.add('active');
        document.getElementById('nbs-open-btn').style.display = 'none';
        const mapDiv = document.getElementById('map');
        mapDiv.querySelectorAll('.leaflet-pane, .leaflet-control-container').forEach(el => el.style.pointerEvents = 'none');
        loadMapLibre(() => initMap());
    }

    function exitMode() {
        S.active = false;
        document.getElementById('nbs-panel').classList.remove('active');
        document.getElementById('nbs-open-btn').style.display = '';
        const mapDiv = document.getElementById('map');
        mapDiv.querySelectorAll('.leaflet-pane, .leaflet-control-container, .leaflet-top, .leaflet-bottom').forEach(el => el.style.pointerEvents = '');
        if (S.map) {
            try { const c = S.map.getCenter(); const lm = window.map; if (lm?.setView) lm.setView([c.lat, c.lng], Math.round(S.map.getZoom())); } catch(e){}
        }
    }

    function loadMapLibre(cb) {
        if (window.maplibregl) { cb(); return; }
        if (!document.getElementById('nbs-ml-css')) {
            const l = document.createElement('link');
            l.id = 'nbs-ml-css'; l.rel = 'stylesheet';
            l.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
            document.head.appendChild(l);
        }
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
        s.onload = cb; s.onerror = () => setStatus('error', 'MapLibre failed');
        document.head.appendChild(s);
    }

    function loadChartJS(cb) {
        if (window.Chart) { cb(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
        s.onload = cb; document.head.appendChild(s);
    }

    // ===== 初始化地图 =====
    function initMap() {
        setStatus('loading', 'Loading map...');
        const view = getLeafletView();
        S.map = new maplibregl.Map({
            container: 'nbs-map',
            style: {
                version: 8,
                glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
                sources: {
                    osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '\u00A9 OpenStreetMap', maxzoom: 19 }
                },
                layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
            },
            center: [view.lng, view.lat], zoom: view.zoom,
            pitch: 0, bearing: 0, antialias: true, maxPitch: 0
        });
        S.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
        S.map.dragRotate.disable(); S.map.touchZoomRotate.disableRotation();

        S.map.on('load', () => {
            setStatus('loading', 'Loading DCC boundary...');
            loadDccBoundary().then(() => {
                setStatus('loading', 'Loading buildings...');
                return loadBuildings();
            }).then(gj => {
                if (S.dccBoundary) {
                    const before = gj.features.length;
                    gj.features = gj.features.filter(isInsideDcc);
                    console.log('[NBS] DCC filter: ' + gj.features.length + '/' + before + ' buildings kept');
                }
                S.buildings = gj;
                addBoundaryLayer();
                addBuildingLayers();
                addZoneLayers();
                setStatus('ready', gj.features.length + ' buildings loaded');
                updateChart(); updateSummary();
            }).catch(err => {
                console.warn('[NBS] Load failed, using fallback:', err);
                S.buildings = FB;
                addBoundaryLayer();
                addBuildingLayers();
                addZoneLayers();
                setStatus('ready', FB.features.length + ' buildings (demo mode)');
                updateChart(); updateSummary();
            });
        });
        S.map.on('error', e => console.warn('[ML]', e.error?.message));
    }

    function getLeafletView() {
        try { const m = window.map; if (m?.getCenter) { const c = m.getCenter(); return { lng: c.lng, lat: c.lat, zoom: Math.min(m.getZoom(), 18) }; } } catch(e){}
        return { lng: CFG.center[0], lat: CFG.center[1], zoom: 14 };
    }

    // ===== DCC 边界 =====
    async function loadDccBoundary() {
        try {
            const res = await fetch(CFG.dccBoundaryUrl);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const gj = await res.json();
            S.dccBoundary = convertGeoJSONToWgs84(gj);
            console.log('[NBS] DCC boundary loaded');
        } catch(e) {
            console.warn('[NBS] DCC boundary load failed:', e.message);
            S.dccBoundary = null;
        }
    }

    function simplifyBoundary(gj, maxPoints) {
        const copy = JSON.parse(JSON.stringify(gj));
        function simplifyRing(ring) {
            if (ring.length <= maxPoints) return ring;
            const step = Math.ceil(ring.length / maxPoints);
            const simplified = ring.filter((_, i) => i % step === 0);
            const first = simplified[0], last = simplified[simplified.length - 1];
            if (first && last && (first[0] !== last[0] || first[1] !== last[1])) simplified.push([...first]);
            return simplified;
        }
        function simplifyGeom(g) {
            if (!g || !g.coordinates) return;
            if (g.type === 'Polygon') g.coordinates = g.coordinates.map(simplifyRing);
            else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map(poly => poly.map(simplifyRing));
        }
        if (copy.type === 'FeatureCollection') copy.features.forEach(f => simplifyGeom(f.geometry));
        else if (copy.type === 'Feature') simplifyGeom(copy.geometry);
        else simplifyGeom(copy);
        return copy;
    }

    function addBoundaryLayer() {
        if (!S.map) return;
        const boundaryData = S.dccBoundary ? simplifyBoundary(S.dccBoundary, 800) : getBboxBoundaryGeoJSON();
        if (S.map.getSource('nbs-boundary')) {
            S.map.getSource('nbs-boundary').setData(boundaryData);
            return;
        }
        S.map.addSource('nbs-boundary', { type: 'geojson', data: boundaryData });
        S.map.addLayer({
            id: 'nbs-boundary-glow', type: 'line', source: 'nbs-boundary',
            paint: { 'line-color': '#38bdf8', 'line-width': 8, 'line-opacity': 0.12, 'line-blur': 4 }
        });
        S.map.addLayer({
            id: 'nbs-boundary-line', type: 'line', source: 'nbs-boundary',
            paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.8 }
        });
    }

    function getBboxBoundaryGeoJSON() {
        const b = CFG.bbox.split(',').map(Number);
        return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[b[1], b[0]], [b[3], b[0]], [b[3], b[2]], [b[1], b[2]], [b[1], b[0]]]] }, properties: {} }] };
    }

    // ===== 建筑数据 =====
    async function loadBuildings() {
        try {
            const cached = localStorage.getItem(CFG.cacheKey);
            if (cached) {
                const data = JSON.parse(cached);
                if (Date.now() - data.ts < CFG.cacheTTL && data.geojson?.features?.length) {
                    console.log('[NBS] Using cached buildings:', data.geojson.features.length);
                    return data.geojson;
                }
            }
        } catch(e) {}
        const gj = await fetchBuildingsFromOverpass();
        try { localStorage.setItem(CFG.cacheKey, JSON.stringify({ ts: Date.now(), geojson: gj })); } catch(e) {}
        return gj;
    }

    async function fetchBuildingsFromOverpass() {
        const q = '[out:json][timeout:25];(way["building"](' + CFG.bbox + '););out geom qt;';
        for (const ep of CFG.overpassEndpoints) {
            try {
                const ac = new AbortController();
                const ti = setTimeout(() => ac.abort(), 22000);
                const r = await fetch(ep + '?data=' + encodeURIComponent(q), { signal: ac.signal });
                clearTimeout(ti);
                if (!r.ok) continue;
                const j = await r.json();
                if (!j.elements?.length) continue;
                const gj = overpassToGeoJSON(j);
                if (gj.features.length < 5) continue;
                console.log('[NBS] Overpass success:', ep, gj.features.length, 'buildings');
                return gj;
            } catch(e) { console.warn('[NBS] ' + ep + ' failed:', e.message); }
        }
        throw new Error('All Overpass endpoints failed');
    }

    function overpassToGeoJSON(data) {
        const features = [];
        let uid = 0;
        const typeDefaults = { house: 6, detached: 7, semidetached_house: 6, terrace: 6, bungalow: 4, apartments: 14, residential: 9, commercial: 12, retail: 5, office: 16, mixed_use: 12, industrial: 8, warehouse: 9, school: 9, university: 10, hospital: 15, hotel: 20, supermarket: 8, yes: 8 };
        data.elements.forEach(el => {
            if (el.type !== 'way' || !el.geometry || el.geometry.length < 3) return;
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            if (coords[0][0] !== coords[coords.length-1][0]) coords.push([...coords[0]]);
            const tags = el.tags || {};
            let h = 8;
            if (tags.height) { const hv = parseFloat(tags.height); if (!isNaN(hv) && hv > 2) h = Math.round(hv); }
            else if (tags['building:levels']) { const lv = parseInt(tags['building:levels']); if (lv > 0) h = Math.round(lv * 3.2); }
            else { h = typeDefaults[tags.building] || 8; }
            const area = geoAreaM2(coords.slice(0, -1));
            const bType = tags.building || 'yes';
            features.push({
                type: 'Feature', id: uid,
                geometry: { type: 'Polygon', coordinates: [coords] },
                properties: {
                    uid: uid++, height: h, min_height: Math.max(parseFloat(tags.min_height) || 0, 0),
                    name: tags.name || tags['addr:street'] || '',
                    building: bType, building_type: bType,
                    footprint_area_m2: Math.round(area),
                    levels: parseInt(tags['building:levels']) || Math.round(h / 3.2),
                    nbs: 'none', nbs_color: '#64748b'
                }
            });
        });
        return { type: 'FeatureCollection', features };
    }

    // ===== 建筑图层（已删除 circle 点图层） =====
    function addBuildingLayers() {
        if (!S.map || !S.buildings) return;
        ['nbs-bldg-fill', 'nbs-bldg-line', 'nbs-bldg-highlight'].forEach(id => {
            if (S.map.getLayer(id)) S.map.removeLayer(id);
        });
        if (S.map.getSource('nbs-buildings')) S.map.removeSource('nbs-buildings');

        S.map.addSource('nbs-buildings', { type: 'geojson', data: S.buildings });
        S.map.addLayer({
            id: 'nbs-bldg-fill', type: 'fill', source: 'nbs-buildings',
            paint: {
                'fill-color': ['get', 'nbs_color'],
                'fill-opacity': ['case', ['==', ['get', 'nbs'], 'none'], 0.18, 0.55]
            }
        });
        S.map.addLayer({
            id: 'nbs-bldg-line', type: 'line', source: 'nbs-buildings',
            paint: { 'line-color': '#1e293b', 'line-width': 0.6, 'line-opacity': 0.6 }
        });
        S.map.addLayer({
            id: 'nbs-bldg-highlight', type: 'line', source: 'nbs-buildings',
            paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-opacity': 0.9 },
            filter: ['==', 'uid', -1]
        });
        S.map.on('click', 'nbs-bldg-fill', onBuildingClick);
        S.map.on('mouseenter', 'nbs-bldg-fill', () => { if (!S.drawMode) S.map.getCanvas().style.cursor = 'pointer'; });
        S.map.on('mouseleave', 'nbs-bldg-fill', () => { if (!S.drawMode) S.map.getCanvas().style.cursor = ''; });
    }

    // ===== 区域图层 =====
    function addZoneLayers() {
        if (!S.map) return;
        if (!S.map.getSource('nbs-draw-preview')) {
            S.map.addSource('nbs-draw-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            S.map.addLayer({ id: 'nbs-draw-fill', type: 'fill', source: 'nbs-draw-preview', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.15 } });
            S.map.addLayer({ id: 'nbs-draw-line', type: 'line', source: 'nbs-draw-preview', paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [5, 3] } });
            S.map.addLayer({ id: 'nbs-draw-dot', type: 'circle', source: 'nbs-draw-preview', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#38bdf8', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
        }
        if (!S.map.getSource('nbs-zones')) {
            S.map.addSource('nbs-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            S.map.addLayer({ id: 'nbs-zone-fill', type: 'fill', source: 'nbs-zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 } });
            S.map.addLayer({ id: 'nbs-zone-line', type: 'line', source: 'nbs-zones', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.85 } });
            S.map.addLayer({ id: 'nbs-zone-label', type: 'symbol', source: 'nbs-zones', layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'center' }, paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,0.7)', 'text-halo-width': 1.5 } });
        }
        S.map.on('click', 'nbs-zone-fill', e => {
            if (!e.features.length) return;
            const label = e.features[0].properties.label;
            const match = label.match(/Zone (\d+)/);
            if (!match) return;
            const zid = parseInt(match[1]);
            const zone = S.zones.find(z => z.id === zid);
            if (zone && confirm('Delete ' + zone.label + ' (' + fmtArea(zone.area) + ')?')) deleteZone(zid);
        });
        S.map.on('mouseenter', 'nbs-zone-fill', () => S.map.getCanvas().style.cursor = 'pointer');
        S.map.on('mouseleave', 'nbs-zone-fill', () => S.map.getCanvas().style.cursor = '');
    }

    // ===== 建筑点击 =====
    function onBuildingClick(e) {
        if (!e.features.length) return;
        const f = e.features[0]; const p = f.properties;
        S.selectedUid = p.uid;
        S.map.setFilter('nbs-bldg-highlight', ['==', 'uid', Number(p.uid)]);
        document.getElementById('nbs-sidebar').classList.add('open');
        const bldgType = p.building && p.building !== 'yes' ? p.building.replace(/_/g, ' ') : 'building';
        const area = Number(p.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1));
        document.getElementById('nbs-bldg-name').textContent = p.name || 'Building ' + p.uid;
        document.getElementById('nbs-bldg-meta').textContent = bldgType + ' \u00B7 ' + fmtArea(area) + ' footprint \u00B7 ' + p.levels + ' levels';
        const curType = S.assignments[p.uid] || 'none';
        document.querySelectorAll('.nbs-option').forEach(opt => opt.classList.toggle('active', opt.dataset.nbs === curType));
        updateBuildingImpact(p.uid, area);
        if (S.popup) S.popup.remove();
        S.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px' }).setLngLat(e.lngLat).setHTML(
            '<div style="padding:4px 0"><strong style="color:#fff;font-size:12px">' + (p.name || 'Building ' + p.uid) + '</strong>' +
            '<div style="font-size:10px;color:#8b95a8;margin-top:2px;text-transform:capitalize">' + bldgType + '</div>' +
            '<div style="margin-top:6px;font-size:10px;color:#8b95a8">' + fmtArea(area) + ' \u00B7 ' + p.levels + ' levels<br>NBS: <span style="color:' + (curType === 'green_roof' ? '#22c55e' : '#64748b') + '">' + (curType === 'green_roof' ? 'Green Roof' : 'None') + '</span></div></div>'
        ).addTo(S.map);
        updateChart();
    }

    function closeSidebar() {
        document.getElementById('nbs-sidebar').classList.remove('open');
        S.selectedUid = null;
        if (S.map) S.map.setFilter('nbs-bldg-highlight', ['==', 'uid', -1]);
        if (S.popup) { S.popup.remove(); S.popup = null; }
        updateChart();
    }

    // ===== NBS 分配 =====
    function assignNBS(uid, type) {
        if (!S.buildings) return;
        S.assignments[uid] = type;
        S.buildings.features.forEach(f => {
            if (f.properties.uid == uid) { f.properties.nbs = type; f.properties.nbs_color = CFG.greenRoof.color; }
        });
        if (S.map?.getSource('nbs-buildings')) S.map.getSource('nbs-buildings').setData(S.buildings);
        document.querySelectorAll('.nbs-option').forEach(opt => opt.classList.toggle('active', opt.dataset.nbs === type));
        const f = S.buildings.features.find(b => b.properties.uid == uid);
        if (f) { const area = Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1)); updateBuildingImpact(uid, area); }
        updateSummary(); updateChart(); setStatus('ready', 'Green Roof assigned');
    }

    function removeNBS(uid) {
        delete S.assignments[uid];
        if (!S.buildings) return;
        S.buildings.features.forEach(f => {
            if (f.properties.uid == uid) { f.properties.nbs = 'none'; f.properties.nbs_color = '#64748b'; }
        });
        if (S.map?.getSource('nbs-buildings')) S.map.getSource('nbs-buildings').setData(S.buildings);
        document.querySelectorAll('.nbs-option').forEach(opt => opt.classList.toggle('active', opt.dataset.nbs === 'none'));
        const f = S.buildings.features.find(b => b.properties.uid == uid);
        if (f) { const area = Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1)); updateBuildingImpact(uid, area); }
        updateSummary(); updateChart();
    }

    function updateBuildingImpact(uid, area) {
        const hasGR = S.assignments[uid] === 'green_roof';
        const imp = CFG.greenRoof;
        document.getElementById('imp-area').textContent = fmtArea(area);
        document.getElementById('imp-height').textContent = (S.buildings.features.find(b => b.properties.uid == uid)?.properties.height || '--') + ' m';
        if (hasGR) {
            document.getElementById('imp-runoff').textContent = (area * CFG.rainfallEvent * imp.runoffReduction).toFixed(1) + ' m\u00B3';
            document.getElementById('imp-carbon').textContent = fmtCarbon(area * imp.carbonRate);
        } else {
            document.getElementById('imp-runoff').textContent = '0 m\u00B3';
            document.getElementById('imp-carbon').textContent = '0 kg';
        }
    }

    // ===== 覆盖率 =====
    function updateSummary() {
        const coveragePct = getCoverage().toFixed(1);
        document.getElementById('sum-count-gr').textContent = coveragePct + '%';
        document.getElementById('sum-bar-gr').style.width = coveragePct + '%';
        document.getElementById('nbs-coverage-badge-pct').textContent = coveragePct + '%';
        document.getElementById('nbs-coverage-current').textContent = 'Current: ' + coveragePct + '% (target: ' + S.targetCoverage + '%)';
    }

    function autoAssign() {
        if (!S.buildings) return;
        const total = S.buildings.features.length;
        const targetCount = Math.floor(total * S.targetCoverage / 100);
        const currentlyAssigned = Object.keys(S.assignments).filter(uid => S.assignments[uid] === 'green_roof').length;
        const needed = targetCount - currentlyAssigned;
        if (needed <= 0) { setStatus('ready', 'Target already reached'); return; }
        const unassigned = S.buildings.features
            .filter(f => S.assignments[f.properties.uid] !== 'green_roof')
            .map(f => ({ uid: f.properties.uid, area: Number(f.properties.footprint_area_m2) || geoAreaM2(f.geometry.coordinates[0].slice(0, -1)) }))
            .sort((a, b) => b.area - a.area)
            .slice(0, needed);
        unassigned.forEach(b => assignNBS(b.uid, 'green_roof'));
        setStatus('ready', 'Auto-assigned ' + unassigned.length + ' buildings');
    }

    // ===== 工具栏 =====
    function toggleBuildings() {
        const btn = document.getElementById('tb-buildings');
        const on = btn.classList.toggle('on');
        if (!S.map) return;
        const vis = on ? 'visible' : 'none';
        ['nbs-bldg-fill', 'nbs-bldg-line', 'nbs-bldg-highlight'].forEach(id => {
            if (S.map.getLayer(id)) S.map.setLayoutProperty(id, 'visibility', vis);
        });
    }

    function toggleZonesPanel() {
        const panel = document.getElementById('nbs-zones-panel');
        const open = panel.classList.toggle('open');
        document.getElementById('tb-zones').classList.toggle('on', open);
        if (open) {
            document.getElementById('nbs-sidebar').classList.remove('open');
            S.selectedUid = null;
            if (S.map) S.map.setFilter('nbs-bldg-highlight', ['==', 'uid', -1]);
        }
    }

    // ===== 手绘区域 =====
    function toggleDrawMode() {
        if (S.drawMode) cancelDraw(); else startDraw();
    }

    function startDraw() {
        if (!S.map) return;
        S.drawMode = true; S.drawPoints = [];
        const btn = document.getElementById('tb-draw');
        btn.classList.add('active-draw');
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel';
        document.getElementById('nbs-draw-hint').classList.add('show');
        document.getElementById('nbs-panel').classList.add('drawing');
        S.map.on('click', onDrawClick);
        S.map.on('dblclick', onDrawDblClick);
    }

    function cancelDraw() {
        if (!S.drawMode) return;
        S.drawMode = false; S.drawPoints = [];
        const btn = document.getElementById('tb-draw');
        btn.classList.remove('active-draw');
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><line x1="12" y1="12" x2="12" y2="22"/><line x1="2" y1="17" x2="12" y2="22"/><line x1="22" y1="17" x2="12" y2="22"/></svg> Draw Zone';
        document.getElementById('nbs-draw-hint').classList.remove('show');
        document.getElementById('nbs-panel').classList.remove('drawing');
        if (S.map) {
            S.map.getCanvas().style.removeProperty('cursor');
            S.map.off('click', onDrawClick);
            S.map.off('dblclick', onDrawDblClick);
            if (S.map.getSource('nbs-draw-preview')) S.map.getSource('nbs-draw-preview').setData({ type: 'FeatureCollection', features: [] });
        }
    }

    function onDrawClick(e) {
        S.drawPoints.push([e.lngLat.lng, e.lngLat.lat]);
        updateDrawPreview();
    }

    function onDrawDblClick(e) {
        e.preventDefault();
        if (S.drawPoints.length > 0) S.drawPoints.pop();
        finishZone();
    }

    function updateDrawPreview() {
        if (!S.map?.getSource('nbs-draw-preview')) return;
        const feats = [];
        S.drawPoints.forEach(p => feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
        if (S.drawPoints.length >= 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...S.drawPoints, S.drawPoints[0]] }, properties: {} });
        if (S.drawPoints.length >= 3) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...S.drawPoints, S.drawPoints[0]]] }, properties: {} });
        S.map.getSource('nbs-draw-preview').setData({ type: 'FeatureCollection', features: feats });
    }

    function finishZone() {
        if (S.drawPoints.length < 3) { cancelDraw(); return; }
        const area = geoAreaM2(S.drawPoints);
        const imp = CFG.greenRoof;
        const runoff = area * CFG.rainfallEvent * imp.runoffReduction;
        const carbon = area * imp.carbonRate;
        const coveragePct = CFG.catchmentAreaM2 ? Math.min(100, (area / CFG.catchmentAreaM2) * 100) : 0;
        const id = ++S.zoneIdCounter;
        S.zones.push({ id, pts: S.drawPoints.slice(), type: 'green_roof', area, runoff, carbon, coveragePct, color: imp.color, label: 'Green Roof' });
        cancelDraw();
        syncZoneLayers();
        renderZonesList();
        updateChart();
        updateSummary();
        setStatus('ready', 'Zone ' + id + ' created');
    }

    function syncZoneLayers() {
        if (!S.map?.getSource('nbs-zones')) return;
        const feats = S.zones.map(z => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[...z.pts, z.pts[0]]] },
            properties: { color: z.color, label: 'Zone ' + z.id }
        }));
        S.map.getSource('nbs-zones').setData({ type: 'FeatureCollection', features: feats });
    }

    function renderZonesList() {
        const list = document.getElementById('nbs-zones-list');
        if (!S.zones.length) {
            list.innerHTML = '<div id="nbs-zones-empty">No zones drawn yet.<br>Click "Draw Zone" to start.</div>';
            document.getElementById('zt-area').textContent = '\u2014';
            document.getElementById('zt-coverage').textContent = '\u2014';
            document.getElementById('zt-runoff').textContent = '\u2014';
            document.getElementById('zt-carbon').textContent = '\u2014';
            return;
        }
        list.innerHTML = S.zones.map(z =>
            '<div class="zone-card"><div class="zone-card-top"><span class="zone-name">Zone ' + z.id + '</span>' +
            '<span class="zone-badge" style="background:' + z.color + '22;color:' + z.color + ';border:1px solid ' + z.color + '44">' + z.label + '</span>' +
            '<button class="zone-del" data-zid="' + z.id + '" title="Delete">\uD83D\uDDD1</button></div>' +
            '<div class="zone-stats"><div class="zone-stat"><div class="zone-stat-v">' + fmtArea(z.area) + '</div><div class="zone-stat-l">Area</div></div>' +
            '<div class="zone-stat"><div class="zone-stat-v" style="color:#16a34a">' + z.coveragePct.toFixed(1) + '%</div><div class="zone-stat-l">Coverage</div></div>' +
            '<div class="zone-stat"><div class="zone-stat-v" style="color:#38bdf8">' + z.runoff.toFixed(1) + ' m\u00B3</div><div class="zone-stat-l">Runoff</div></div></div></div>'
        ).join('');
        list.querySelectorAll('.zone-del').forEach(btn => {
            btn.onclick = e => { e.stopPropagation(); deleteZone(parseInt(btn.dataset.zid)); };
        });
        document.getElementById('zt-area').textContent = fmtArea(S.zones.reduce((s, z) => s + z.area, 0));
        document.getElementById('zt-runoff').textContent = S.zones.reduce((s, z) => s + z.runoff, 0).toFixed(1) + ' m\u00B3';
        document.getElementById('zt-carbon').textContent = fmtCarbon(S.zones.reduce((s, z) => s + z.carbon, 0));
        const coverageTotal = CFG.catchmentAreaM2 ? S.zones.reduce((s, z) => s + z.area, 0) / CFG.catchmentAreaM2 * 100 : 0;
        const coverageEl = document.getElementById('zt-coverage');
        if (coverageEl) coverageEl.textContent = coverageTotal.toFixed(1) + '%';
    }

    function deleteZone(id) {
        const zone = S.zones.find(z => z.id === id);
        if (!zone || !confirm('Delete Zone ' + id + ' (' + fmtArea(zone.area) + ')?')) return;
        S.zones = S.zones.filter(z => z.id !== id);
        syncZoneLayers();
        renderZonesList();
        updateChart();
        updateSummary();
    }

    function clearAllZones() {
        if (!S.zones.length) return;
        if (!confirm('Clear all drawn zones?')) return;
        S.zones = []; S.zoneIdCounter = 0;
        syncZoneLayers();
        renderZonesList();
        updateChart();
        updateSummary();
    }

    // ===== RFRI 图表 =====
    function updateChart() {
        loadChartJS(() => renderChart());
    }

    function renderChart() {
        const labels = CFG.forecast.map(d => d.date);
        const baseFI = CFG.forecast.map(d => calcBaseRFRI(d.rain, d.api));
        const buildingFI = CFG.forecast.map(d => calcAdjustedRFRIBuildings(d.rain, d.api));
        const coverageFI = CFG.forecast.map(d => calcAdjustedRFRICoverage(d.rain, d.api, S.targetCoverage));
        const actualCoverage = getCoverage();

        const buildingCanvas = document.getElementById('nbs-chart-canvas-building');
        if (buildingCanvas) {
            const ctx = buildingCanvas.getContext('2d');
            const selectedBuildingFI = (S.selectedUid !== null && S.assignments[S.selectedUid] === 'green_roof')
                ? baseFI.map(vv => vv * CFG.greenRoof.vBuilding)
                : null;
            const buildingData = {
                labels,
                datasets: [
                    { label: 'Original RFRI', data: baseFI, borderColor: '#4452ef', backgroundColor: 'rgba(68,82,239,0.06)', fill: false, tension: 0.2, pointRadius: 2, yAxisID: 'rfri' },
                    { label: 'With Building NBS', data: buildingFI, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.06)', fill: false, tension: 0.2, pointRadius: 2, borderDash: [5, 3], yAxisID: 'rfri' }
                ].concat(selectedBuildingFI ? [{ label: 'Selected Building', data: selectedBuildingFI, borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.06)', fill: false, tension: 0.2, pointRadius: 2, borderDash: [4, 4], yAxisID: 'rfri' }] : [])
            };
            if (S.chartBuilding) {
                S.chartBuilding.data = buildingData;
                S.chartBuilding.update();
            } else {
                S.chartBuilding = new Chart(ctx, {
                    type: 'line',
                    data: buildingData,
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(4) } } },
                        scales: {
                            x: { ticks: { color: '#5a6478', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                            rfri: { type: 'linear', position: 'left', ticks: { color: '#5a6478', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
                        }
                    }
                });
            }
        }

        const coverageCanvas = document.getElementById('nbs-chart-canvas-coverage');
        if (coverageCanvas) {
            const ctx = coverageCanvas.getContext('2d');
            const coverageData = {
                labels,
                datasets: [
                    { label: 'Original RFRI', data: baseFI, borderColor: '#4452ef', backgroundColor: 'rgba(68,82,239,0.06)', fill: false, tension: 0.2, pointRadius: 2, yAxisID: 'rfri' },
                    { label: 'With Coverage', data: coverageFI, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.06)', fill: false, tension: 0.2, pointRadius: 2, borderDash: [5, 3], yAxisID: 'rfri' },
                    { label: 'Actual Coverage', data: labels.map(() => actualCoverage), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', fill: false, tension: 0.2, pointRadius: 2, yAxisID: 'coverage' }
                ]
            };
            if (S.chartCoverage) {
                S.chartCoverage.data = coverageData;
                S.chartCoverage.update();
            } else {
                S.chartCoverage = new Chart(ctx, {
                    type: 'line',
                    data: coverageData,
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.dataset.yAxisID === 'coverage' ? ctx.parsed.y.toFixed(1) + '%' : ctx.parsed.y.toFixed(4)) } } },
                        scales: {
                            x: { ticks: { color: '#5a6478', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                            rfri: { type: 'linear', position: 'left', ticks: { color: '#5a6478', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
                            coverage: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { color: '#38bdf8', font: { size: 9 }, callback: value => value + '%' }, grid: { drawOnChartArea: false } }
                        }
                    }
                });
            }
        }
    }

    // ===== 导出 =====
    function exportData() {
        if (!S.buildings) return;
        const out = {
            exported_at: new Date().toISOString(),
            location: 'Dublin',
            target_coverage_pct: S.targetCoverage,
            actual_coverage_pct: getCoverage(),
            nbs_assignments: S.buildings.features.map(f => ({
                id: f.properties.uid, name: f.properties.name,
                building_type: f.properties.building_type,
                footprint_area_m2: f.properties.footprint_area_m2,
                nbs_type: f.properties.nbs,
                coords: f.geometry.coordinates[0][0]
            })),
            drawn_zones: S.zones.map(z => ({
                id: z.id, type: z.type, label: z.label,
                area_m2: z.area, runoff_mitigated_m3: z.runoff,
                carbon_saved_kg: z.carbon, coordinates: z.pts
            })),
            rfri_forecast: {
                base: CFG.forecast.map(d => ({ date: d.date, rfri: calcBaseRFRI(d.rain, d.api) })),
                with_nbs: CFG.forecast.map(d => ({ date: d.date, rfri: calcAdjustedRFRI(d.rain, d.api) })),
                vnbs_mm: calcVnbsMM()
            }
        };
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'dublin_nbs_plan_v2.json';
        a.click();
        setStatus('ready', 'Report exported');
    }

    // ===== 状态 =====
    function setStatus(type, text) {
        const dot = document.getElementById('nbs-status-dot');
        const txt = document.getElementById('nbs-status-text');
        if (!dot || !txt) return;
        dot.className = '';
        if (type === 'loading') dot.classList.add('loading');
        else if (type === 'ready') dot.classList.add('ready');
        else if (type === 'error') dot.classList.add('error');
        txt.textContent = text;
    }

    // ===== 启动 =====
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.NBSPlanningPanel = {
        enter: enterMode,
        exit: exitMode,
        isActive: () => S.active,
        getAssignments: () => ({ ...S.assignments }),
        getZones: () => S.zones.slice(),
        setTargetCoverage: pct => {
            S.targetCoverage = Math.max(0, Math.min(100, pct));
            const slider = document.getElementById('nbs-coverage-slider');
            const input = document.getElementById('nbs-coverage-input');
            if (slider) slider.value = S.targetCoverage;
            if (input) input.value = S.targetCoverage;
            document.getElementById('nbs-coverage-val').textContent = S.targetCoverage + '%';
            updateSummary();
            updateChart();
        }
    };

    console.log('[NBS Planning Panel v2.1] Loaded');
})();
