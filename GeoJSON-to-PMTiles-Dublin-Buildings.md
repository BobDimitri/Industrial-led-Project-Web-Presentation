# GeoJSON to PMTiles Workflow: Dublin City Council Buildings

## Goal

Create a stable, self-hosted building layer for Dublin City Council (DCC), with approximately 207,876 features, so the web map does not depend on an unreliable external Building Information API.

**Pipeline:** QGIS reprojection → WSL Ubuntu → Tippecanoe → PMTiles → MapLibre

## 1. Reproject the data in QGIS

1. Open the original `dcc_buildings.geojson` in QGIS.
2. Right-click the layer and choose **Export → Save Features As…**.
3. Set **Format** to **GeoJSON** and choose an output file named `dcc_buildings_4326.geojson`.
4. Set the output CRS to **EPSG:4326 — WGS 84**.
5. Verify that the output CRS is EPSG:4326 and the feature count is still approximately 207,876.

Keep the original file unchanged. If area attributes need to be calculated from geometry, calculate them from the projected source data in EPSG:3035 before exporting to EPSG:4326; geographic coordinates are not suitable for planar area calculations.

## 2. Start WSL Ubuntu

From PowerShell, start Ubuntu:

```powershell
wsl -d Ubuntu
```

Then, in the WSL terminal:

```bash
cd ~
```

No separate Ubuntu ISO installation is needed if WSL Ubuntu is already installed.

## 3. Install build dependencies

In WSL:

```bash
sudo apt update
sudo apt install -y build-essential git libsqlite3-dev zlib1g-dev jq
```

The message `WSL in NAT mode does not support localhost proxies` can be ignored if `sudo apt update` completes successfully.

## 4. Build and install Tippecanoe

```bash
git clone --depth 1 https://github.com/felt/tippecanoe.git
cd ~/tippecanoe
make clean
make -j"$(nproc)"
sudo make install
tippecanoe --version
```

A version number, for example `v2.82.0`, indicates that Tippecanoe is installed.

## 5. Verify the GeoJSON from WSL

Replace `USERNAME` with your Windows account name. For example, `C:\Users\Alice\Documents\NBS_Project\data` is available in WSL as `/mnt/c/Users/Alice/Documents/NBS_Project/data`.

```bash
cd /mnt/c/Users/USERNAME/Documents/NBS_Project/data
ls -lh dcc_buildings_4326.geojson
head -c 300 dcc_buildings_4326.geojson
jq '.features | length' dcc_buildings_4326.geojson
```

The exported GeoJSON may be around 108 MB, depending on its properties and geometry detail. The feature count should be approximately 207,876. Inspect the first few hundred bytes to confirm the file contains valid GeoJSON.

## 6. Generate a PMTiles archive

Run Tippecanoe from the data directory:

```bash
tippecanoe \
  -o dcc_buildings.pmtiles \
  -l buildings \
  -zg \
  --drop-densest-as-needed \
  dcc_buildings_4326.geojson
```

The `-l buildings` option sets the vector tile layer name to `buildings`. The MapLibre `source-layer` must use exactly the same name.

### Optional: Generate an MVT tile directory

To output a directory containing individual `.pbf` tiles instead of one PMTiles archive:

```bash
tippecanoe \
  -e dcc_building_tiles \
  -zg \
  -l buildings \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  dcc_buildings_4326.geojson
```

The `-l buildings` option is deliberately the same as in the PMTiles command, so the MapLibre `source-layer` remains `buildings`.

## 7. Check the output

```bash
ls -lh dcc_buildings.pmtiles
```

An archive around 8.4 MB is a reasonable expectation for this dataset; the exact size depends on the input data and Tippecanoe options.

## 8. Load the archive with MapLibre

Load MapLibre GL JS and the PMTiles JavaScript library before running this code. Register the PMTiles protocol before creating the source:

```javascript
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const archiveUrl = new URL(
  './dcc_buildings.pmtiles',
  document.baseURI
).href;

map.addSource('buildings', {
  type: 'vector',
  url: 'pmtiles://' + archiveUrl
});

map.addLayer({
  id: 'buildings-fill',
  type: 'fill',
  source: 'buildings',
  'source-layer': 'buildings'
});

map.on('click', 'buildings-fill', event => {
  const feature = event.features?.[0];
  if (!feature) return;

  console.log(feature.properties);
});
```

Update the archive URL to match where the `.pmtiles` file is served. Serve the page and archive over HTTP/HTTPS; opening the page directly through `file://` does not provide the HTTP byte-range responses PMTiles needs.

## Key notes

### Coordinate reference systems

- The original `dcc_buildings.geojson` is in EPSG:3035 (ETRS89 / LAEA Europe), which is suitable for planar area calculations in QGIS.
- Export a copy in EPSG:4326 (WGS 84) for this web-mapping workflow.
- Keep the original EPSG:3035 file for source data and measurements. Use the EPSG:4326 export as the Tippecanoe input.

### Windows paths in WSL

| Windows path | WSL path |
|---|---|
| `C:\Users\USERNAME\Documents\NBS_Project\data` | `/mnt/c/Users/USERNAME/Documents/NBS_Project/data` |

Replace `USERNAME` with the actual Windows account name.

### Why Tippecanoe and WSL?

- Tippecanoe efficiently converts large GeoJSON files into vector tiles.
- WSL provides the Linux environment needed to build and run Tippecanoe on Windows.
- The WSL localhost proxy warning is not fatal if package installation succeeds.

### Why not use QuickMapTools?

In this workflow, the web converter was unreliable with more than 200,000 features. It produced a very small PMTiles file and reported CRS parsing, abnormal tile-extent, or missing-feature problems.

## Common build errors

| Error | Fix |
|---|---|
| `sqlite3.h` is missing | Install `libsqlite3-dev`. |
| `zlib.h` is missing | Install `zlib1g-dev`. |
| The build fails without a clear error | Run `make clean`, then retry with `make -j1` to expose the error without parallel build output. |

## Loading options

| Option | Result |
|---|---|
| GeoJSON + Leaflet | Simple to start with, but can lag with 200,000+ features. |
| MVT + MapLibre | Loads tiles on demand, but creates a directory containing many `.pbf` files. |
| PMTiles + MapLibre | Stores the vector tiles in one archive, making the data easier to deploy and serve. |

## Attribute queries

Properties included in the tiles remain available through `feature.properties` when a building is clicked. Confirm the actual fields in the PMTiles archive; depending on the source data, these may include area, height, floor count, and building class. The web page can then use the tile attributes instead of calling the external Building Information API.

## Layer-name consistency

The Tippecanoe layer name is set by `-l`. MapLibre's `source-layer` must match it exactly. This guide uses `buildings` for both the PMTiles command, the optional MVT command, and the MapLibre example.
