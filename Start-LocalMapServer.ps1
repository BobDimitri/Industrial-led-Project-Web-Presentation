$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:8765/')
$listener.Start()

Write-Output "Serving $root at http://127.0.0.1:8765/Main.html"
Write-Output 'PMTiles byte-range requests are enabled. Press Ctrl+C to stop.'

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $response = $context.Response
        $stream = $null

        try {
            if ($context.Request.HttpMethod -ne 'GET' -and $context.Request.HttpMethod -ne 'HEAD') {
                $response.StatusCode = 405
                $response.Headers['Allow'] = 'GET, HEAD'
                continue
            }

            $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
            if ([string]::IsNullOrWhiteSpace($requestPath)) {
                $requestPath = 'Main.html'
            }

            $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $requestPath))
            if (-not $filePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $response.StatusCode = 403
                continue
            }
            if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                $response.StatusCode = 404
                continue
            }

            $fileInfo = Get-Item -LiteralPath $filePath
            $length = [long]$fileInfo.Length
            $start = [long]0
            $end = $length - 1
            $range = $context.Request.Headers['Range']

            $response.Headers['Accept-Ranges'] = 'bytes'
            if ($range) {
                if ($range -notmatch '^bytes=(\d*)-(\d*)$' -or $length -eq 0) {
                    $response.StatusCode = 416
                    $response.Headers['Content-Range'] = "bytes */$length"
                    continue
                }

                if ($Matches[1]) {
                    $start = [long]$Matches[1]
                    if ($Matches[2]) {
                        $end = [long]$Matches[2]
                    }
                } elseif ($Matches[2]) {
                    $suffixLength = [long]$Matches[2]
                    $start = [Math]::Max(0, $length - $suffixLength)
                } else {
                    $response.StatusCode = 416
                    $response.Headers['Content-Range'] = "bytes */$length"
                    continue
                }

                if ($start -ge $length -or $end -lt $start) {
                    $response.StatusCode = 416
                    $response.Headers['Content-Range'] = "bytes */$length"
                    continue
                }
                $end = [Math]::Min($end, $length - 1)
                $response.StatusCode = 206
                $response.Headers['Content-Range'] = "bytes $start-$end/$length"
            }

            $contentLength = $end - $start + 1
            $response.ContentLength64 = $contentLength
            $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
            $response.ContentType = switch ($extension) {
                '.html' { 'text/html; charset=utf-8' }
                '.js' { 'text/javascript; charset=utf-8' }
                '.css' { 'text/css; charset=utf-8' }
                '.json' { 'application/json; charset=utf-8' }
                '.geojson' { 'application/geo+json; charset=utf-8' }
                '.pmtiles' { 'application/vnd.pmtiles' }
                '.png' { 'image/png' }
                '.jpg' { 'image/jpeg' }
                '.jpeg' { 'image/jpeg' }
                '.svg' { 'image/svg+xml' }
                '.ico' { 'image/x-icon' }
                '.woff' { 'font/woff' }
                '.woff2' { 'font/woff2' }
                default { 'application/octet-stream' }
            }

            if ($context.Request.HttpMethod -eq 'GET' -and $contentLength -gt 0) {
                $stream = [System.IO.File]::OpenRead($filePath)
                [void]$stream.Seek($start, [System.IO.SeekOrigin]::Begin)
                $buffer = New-Object byte[] 65536
                $remaining = $contentLength
                while ($remaining -gt 0) {
                    $readLength = [int][Math]::Min($buffer.Length, $remaining)
                    $read = $stream.Read($buffer, 0, $readLength)
                    if ($read -eq 0) {
                        break
                    }
                    $response.OutputStream.Write($buffer, 0, $read)
                    $remaining -= $read
                }
            }
        } catch {
            Write-Warning $_.Exception.Message
            if ($response.OutputStream.CanWrite) {
                $response.StatusCode = 500
            }
        } finally {
            if ($stream) {
                $stream.Dispose()
            }
            $response.Close()
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
