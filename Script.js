// ==================== Global Variables ====================
let map;
let nbsLayer = null;
let waterLevelLayer = L.layerGroup();

// ==================== Map Initialisation ====================
// Set the initial view to Dublin [53.3498, -6.2603], zoom level 11.
map = L.map('map', { maxZoom: 19 }).setView([53.3498, -6.2603], 11);

// Base map definitions.
const baseLayers = {
    "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19
    }),
    "ESRI Satellite": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    }),
    "ESRI Topo Map": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    }),
    "CartoDB Light": L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap & CARTO',
        maxZoom: 19
    })
};

// Default base map.
baseLayers["ESRI Topo Map"].addTo(map);

// ==================== Layer Control Drawer ====================
const drawerCSS = `
.custom-drawer-toggle {
    position: absolute;
    top: 20px;
    right: 20px;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    padding: 10px 16px;
    cursor: pointer;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-weight: bold;
    color: #ffffff;
    transition: all 0.3s;
}
.custom-drawer-toggle:hover {
    background: rgba(30, 41, 59, 0.95);
    border-color: rgba(255, 255, 255, 0.4);
}
.layer-drawer {
    position: absolute;
    top: 0;
    right: -340px;        /* Keep the hidden drawer fully off-screen. */
    width: 340px;
    height: 100%;
    background: rgba(15, 23, 42, 0.9);
    backdrop-filter: blur(10px);
    box-shadow: -8px 0 25px rgba(0,0,0,0.18);
    transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 10000;
    padding: 25px 20px;
    box-sizing: border-box;
    overflow-y: auto;
    overflow-x: hidden;
    color: #ffffff;
}
.layer-drawer.open {
    right: 0;
}
.drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 2px solid rgba(255, 255, 255, 0.2);
}
.drawer-header h3 {
    margin: 0;
    color: #ffffff;
    font-size: 18px;
}
.drawer-close {
    cursor: pointer;
    font-size: 28px;
    color: rgba(255, 255, 255, 0.5);
    line-height: 1;
}
.drawer-close:hover { color: #ef4444; }
.drawer-section-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: rgba(255, 255, 255, 0.6);
    margin: 25px 0 10px 0;
    font-weight: bold;
}
.drawer-item {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 8px 0;
    font-size: 14px;
    color: #ffffff;
    cursor: pointer;
    padding: 8px;
    border-radius: 6px;
}
.drawer-item:hover {
    background: rgba(255, 255, 255, 0.1);
}
`;

const styleSheet = document.createElement("style");
styleSheet.innerText = drawerCSS;
document.head.appendChild(styleSheet);

// Create drawer UI.
const mapContainer = map.getContainer();

const toggleBtn = document.createElement('div');
toggleBtn.className = 'custom-drawer-toggle';
toggleBtn.innerHTML = 'Layers';
mapContainer.appendChild(toggleBtn);

const drawer = document.createElement('div');
drawer.className = 'layer-drawer';
drawer.innerHTML = `
    <div class="drawer-header">
        <h3>Map Layers</h3>
        <div class="drawer-close">×</div>
    </div>
    <div class="drawer-section-title">Base Maps</div>
    <div id="drawer-base-layers"></div>
    <div class="drawer-section-title">Overlays</div>
    <div id="drawer-overlays"></div>
`;
mapContainer.appendChild(drawer);

// Drawer event handlers.
toggleBtn.addEventListener('click', () => {
    drawer.classList.toggle('open');
    toggleBtn.classList.toggle('open');
});
drawer.querySelector('.drawer-close').addEventListener('click', () => {
    drawer.classList.remove('open');
    toggleBtn.classList.remove('open');
});

// Layer control proxy.
const layerControl = {
    _baseLayers: {},
    _overlays: {},
    addBaseLayer: function(layer, name) {
        this._baseLayers[name] = layer;
        this._renderItem(layer, name, 'radio', 'drawer-base-layers', 'basemap');
        return this;
    },
    addOverlay: function(layer, name) {
        this._overlays[name] = layer;
        this._renderItem(layer, name, 'checkbox', 'drawer-overlays');
        return this;
    },
    _renderItem: function(layer, name, type, containerId, groupName = '') {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        const label = document.createElement('label');
        label.className = 'drawer-item';
        
        const input = document.createElement('input');
        input.type = type;
        if (groupName) input.name = groupName;
        input.value = name;
        input.setAttribute('data-layer-id', layer._leaflet_id || Math.random().toString(36));

        if (map.hasLayer(layer)) input.checked = true;

        input.addEventListener('change', () => {
            if (type === 'radio') {
                Object.values(this._baseLayers).forEach(l => map.removeLayer(l));
                map.addLayer(layer);
            } else {
                input.checked ? map.addLayer(layer) : map.removeLayer(layer);
            }
        });

        label.appendChild(input);
        label.appendChild(document.createTextNode(name));
        container.appendChild(label);
    }
};

// Add base maps.
Object.keys(baseLayers).forEach(name => layerControl.addBaseLayer(baseLayers[name], name));

// ==================== Water Levels ====================
waterLevelLayer.addTo(map);
layerControl.addOverlay(waterLevelLayer, 'Real-time Water Levels');

// ==================== NBS Projects ====================
fetch('DATA/testprojects.geojson')
    .then(response => response.json())
    .then(data => {
        nbsLayer = L.geoJSON(data, {
            pointToLayer: function(feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 8,
                    fillColor: "#2ecc71",
                    color: "#000",
                    weight: 1.5,
                    fillOpacity: 0.85
                });
            },
            onEachFeature: function(feature, layer) {
                const p = feature.properties;
                layer.bindPopup(`<b>${p.name || 'NBS Project'}</b><br>${p.description || 'No description'}`);
            }
        });
        layerControl.addOverlay(nbsLayer, 'NBS Adaptation Projects');
        nbsLayer.addTo(map);
    })
    .catch(err => console.log('NBS data not loaded (optional)'));

// ==================== Planning Boundaries ====================
let boundaryLayer = null;

fetch('Boundaries/Whole country Planning_Boundary_Data.geojson')
    .then(response => {
        if (!response.ok) throw new Error(`边界加载失败: ${response.status}`);
        return response.json();
    })
    .then(data => {
        console.log('边界数据加载成功，特征数：', data.features.length);

        boundaryLayer = L.geoJSON(data, {
            style: {
                color: '#ff7800',        // 橙色
                weight: 2.5,
                opacity: 0.9,
                fillColor: 'transparent',
                fillOpacity: 0
            },
            onEachFeature: function(feature, layer) {
                // 如果有名称属性，显示在popup
                if (feature.properties && feature.properties.name) {
                    layer.bindPopup(`<b>${feature.properties.name}</b>`);
                }
            }
        });

        // 添加到图层控制，默认显示
        layerControl.addOverlay(boundaryLayer, 'Planning Boundaries');
        boundaryLayer.addTo(map);
    })
    .catch(err => {
        console.error('边界加载失败:', err);
        // 可选：显示提示给用户
    });

// ==================== Layer Visibility by Zoom ====================
function updateLayerVisibility() {
    const z = map.getZoom();
    
    // Show NBS projects at closer zoom levels.
    if (nbsLayer) {
        if (z >= 12) nbsLayer.addTo(map);
        else map.removeLayer(nbsLayer);
    }
    
    // Show water level stations at medium zoom levels.
    if (waterLevelLayer) {
        if (z >= 8 && z <= 17) waterLevelLayer.addTo(map);
        else map.removeLayer(waterLevelLayer);
    }
}

map.on('zoomend', updateLayerVisibility);
setTimeout(updateLayerVisibility, 1200);

// ==================== Water Level Updates ===================
function renderWaterLevelMarkers(stations) {
    if (!stations || stations.length === 0) return;

    waterLevelLayer.clearLayers();

    stations.forEach(station => {
        const { lat, lon, name, level } = station;
        const classification = station.classification || {
            color: '#4886e4'
        };

        const color = classification.color;

        const marker = L.circleMarker([lat, lon], {
            radius: 8,
            fillColor: color,
            color: '#000',
            weight: 1.5,
            opacity: 1,
            fillOpacity: 0.8
        });

        marker.bindPopup(`
            <div style="font-family: system-ui; line-height: 1.6;">
                <b style="font-size: 16px; color: #2c3e50;">${name}</b><br>
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                    <div style="display: flex; justify-content: space-between; margin: 4px 0;">
                        <span>Water Level:</span>
                        <span style="font-weight: 700; color: ${color};">${level.toFixed(2)} m</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin: 4px 0;">
                        <span>Status:</span>
                        <span style="font-weight: 700; color: ${color};">${classification.label}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin: 4px 0; font-size: 12px; color: #666;">
                        <span>Updated:</span>
                        <span>${new Date(station.timestamp).toLocaleTimeString('en-IE')}</span>
                    </div>
                </div>
            </div>
        `);

        marker.stationData = station;
        marker.addTo(waterLevelLayer);
    });

    console.log(`[Water Levels] Rendered ${stations.length} stations on map`);
}
async function updateWaterLevels() {
    try {
        if (!window.waterLevelAPI) {
            console.warn('[Water Levels] API not loaded yet');
            return;
        }

        const cached = window.waterLevelAPI.getCached();
        const cachedStations = Object.values(cached.stations || {});
        if (cachedStations.length > 0) {
            renderWaterLevelMarkers(cachedStations);
        }

        await window.waterLevelAPI.fetch();

        const stations = window.waterLevelAPI.getAllStations();
        if (!stations || stations.length === 0) {
            console.warn('[Water Levels] No stations found');
            return;
        }

        renderWaterLevelMarkers(stations);

    } catch (error) {
        console.error('[Water Levels] Update error:', error);
    }
}

window.addEventListener('load', () => {
    if (window.waterLevelAPI) {
        updateWaterLevels();
        // Start automatic refresh every 30 minutes.
        window.waterLevelAPI.startAutoRefresh(30);
    }
});


// ==================== Quick Location Navigation ====================
const locations = {
    "Dublin City": { center: [53.3498, -6.2603], zoom: 13 },
    "Swords": { center: [53.4597, -6.2181], zoom: 14 },

};

const navCSS = `
.location-nav {
    position: absolute;
    top: 100px;
    left: 20px;
    background: rgba(15, 23, 42, 0.9);
    padding: 10px;
    border-radius: 12px;
    z-index: 1000;
    border: 1px solid rgba(255,255,255,0.1);
    display: flex;
    flex-direction: column;
    gap: 8px;
    backdrop-filter: blur(8px);
}
.nav-btn {
    background: rgba(255,255,255,0.1);
    color: white;
    border: none;
    padding: 8px 15px;
    border-radius: 6px;
    cursor: pointer;
    font-family: system-ui;
    font-size: 13px;
    text-align: left;
    transition: all 0.2s;
}
.nav-btn:hover {
    background: #38bdf8;
    transform: translateX(5px);
}
`;

const navStyle = document.createElement("style");
navStyle.innerText = navCSS;
document.head.appendChild(navStyle);

const navContainer = document.createElement('div');
navContainer.className = 'location-nav';

Object.keys(locations).forEach(locName => {
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.innerHTML = `📍 ${locName}`;
    btn.onclick = () => {
        const loc = locations[locName];
        map.flyTo(loc.center, loc.zoom, {
            animate: true,
            duration: 1.5 // Fly animation duration in seconds.
        });
    };
    navContainer.appendChild(btn);
});

document.body.appendChild(navContainer);

// Initial view is set to Dublin above.


// ==================== Complete ====================
console.log('Complete Map Loaded: Layer Switcher + Flood API + NBS Planning');