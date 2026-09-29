# How to Load Local PMTiles Building Data in a Web Page

This project uses MapLibre GL JS and the PMTiles protocol to display vector tiles. A browser does not download the entire `.pmtiles` file at once; it requests byte ranges as needed. The page and data must therefore be served over HTTP/HTTPS. Opening the HTML file directly with `file://` will not work.

## 1. Place the PMTiles file

Put the archive inside the website directory. Make sure the path, capitalization, and spaces match the code. This project uses:

```text
Project root/
├─ Main.html
├─ Building files/
│  └─ dcc_buildings.pmtiles
└─ nbs_panel/
   └─ nbs_planning_panel_main.js
```

The archive must contain vector tiles supported by MapLibre. Check its vector-layer and property names. This project's archive has a `buildings` layer with properties such as `fid`, `height`, `floors`, and `area`. The layer name must match MapLibre's `source-layer` setting.

## 2. Run locally

In Windows PowerShell, start the local HTTP server included with the project:

```powershell
cd "D:\My Climate Map\Presentation with Front Welcompage"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-LocalMapServer.ps1
```

Open this URL in your browser:

```text
http://127.0.0.1:8765/Main.html
```

Keep the PowerShell window open while using the site. Close it or press `Ctrl+C` to stop the server. Do not open the page as `file:///.../Main.html`.

Check that the server supports byte-range requests:

```powershell
curl.exe -i -H "Range: bytes=0-126" "http://127.0.0.1:8765/Building%20files/dcc_buildings.pmtiles"
```

A successful response should return `206 Partial Content` and headers similar to:

```text
Accept-Ranges: bytes
Content-Range: bytes 0-126/8767582
Content-Length: 127
```

## 3. Configure the web page

### Register the PMTiles protocol

After loading the MapLibre and PMTiles JavaScript libraries, register the `pmtiles` protocol with MapLibre:

```javascript
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
```

This project loads the libraries from a CDN and registers the protocol before creating the map.

### Add a vector source and layer

```javascript
const archiveUrl = new URL(
  './Building files/dcc_buildings.pmtiles',
  document.baseURI
).href;

map.addSource('nbs-buildings', {
  type: 'vector',
  url: 'pmtiles://' + archiveUrl,
  promoteId: { buildings: 'fid' }
});

map.addLayer({
  id: 'nbs-bldg-fill',
  type: 'fill-extrusion',
  source: 'nbs-buildings',
  'source-layer': 'buildings',
  paint: {
    'fill-extrusion-color': '#64748b',
    'fill-extrusion-height': [
      'coalesce',
      ['to-number', ['get', 'height']],
      ['*', ['to-number', ['get', 'floors']], 3.2],
      3
    ]
  }
});
```

`promoteId` identifies the unique building ID property, used for selecting buildings and setting feature state. Replace the example layer and property names if your PMTiles archive uses different names.

## 4. Deploy to Vercel

1. Deploy the page, scripts, and `Building files/dcc_buildings.pmtiles` together. Keep the directory structure unchanged.
2. Confirm that the `.pmtiles` file is included in the Vercel deployment. This project's file is about 8.8 MB, below the Vercel Hobby static-file upload limit.
3. After deployment, replace the domain below with your own and test a byte-range request:

   ```powershell
   curl.exe -i -H "Range: bytes=0-126" "https://your-domain/Building%20files/dcc_buildings.pmtiles"
   ```

   Confirm the response is `206 Partial Content` and includes correct `Content-Range` and `Content-Length` headers. If it returns `200`, `404`, or another error, check that the file was deployed, the URL is correct, and the CDN/static host preserves range responses.
4. Open the deployed page and enter the NBS panel. The building status should show how many local buildings have loaded. You can also inspect `.pmtiles` requests in the browser's developer tools under Network.

A Vercel website cannot read files from your computer's local drive. Upload the PMTiles archive with the deployment or host it on object storage/CDN that supports HTTP Range requests. If the archive is hosted on a different origin, that host must also allow the website's origin through CORS.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Building load fails when using `file://` | Open the page through the local HTTP server or its deployed HTTPS URL. |
| The PMTiles request returns `404` | Check that the file was deployed and verify the URL, directory name, and capitalization. |
| Error mentions missing `Content-Length`, unsupported byte serving, or Range does not return `206` | The static host or proxy is not serving byte-range responses correctly. |
| No buildings appear even though the request succeeds | Check the `source-layer` name, `promoteId` property, map center, and zoom level. |
| The browser reports a CORS error | Check CORS settings on the PMTiles host. Hosting the archive on the same origin usually avoids cross-origin requests for the data file. |
