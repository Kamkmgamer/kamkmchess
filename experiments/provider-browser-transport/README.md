# Reproduce provider transport checks

Disposable evidence for [Verify provider browser preflights and synthetic streaming](https://linear.app/kamkm/issue/KHA-21). Read the [report and limits](../../research/provider-browser-transport.md) first. This is a test client and service, not the chess application.

## Prerequisites

Use Node 24+, installed Windows Chrome and Edge, and an existing configured ngrok CLI or an equivalent controlled HTTPS route. Ports 18775, 18776, 19232, 19233, and the tunnel agent port must be free. Use fresh temporary browser profiles, never personal profiles. No dependency installation is needed.

Keep previous evidence before repeating. The drivers write the named files under `evidence/`. Choose a fresh runtime directory outside the repository. The recorded run used `C:\Users\Lenovo\AppData\Local\Temp\kha21-provider-transport-20261016`.

## Start the synthetic service

In PowerShell:

```powershell
$runtimeDir = Join-Path $env:TEMP 'kha21-repeat'
if (Test-Path -LiteralPath $runtimeDir) { throw 'Choose a fresh runtime directory.' }
New-Item -ItemType Directory -Path $runtimeDir
$env:KHA21_LOG_FILE = Join-Path $runtimeDir 'server-requests.ndjson'
node experiments/provider-browser-transport/server.mjs
```

Wait for `KHA21_READY 18775`. In another terminal expose only that listener:

```powershell
ngrok http http://127.0.0.1:18775 --inspect=false
```

Do not expose port 18776. That loopback-only port stops the service. The public service serves only its disposable page, client, profile matrix, and synthetic fixture endpoints. It cannot access a real provider or credential store. It has a 45-minute shutdown guard.

## Raw provider OPTIONS probes

Set `$publicTestOrigin` to the actual HTTPS tunnel origin. Record the origin, OS, exact browser builds, Node version, launch arguments, and UTC timestamps in `evidence/environment.json` before running:

```powershell
$publicTestOrigin = 'https://YOUR-DISPOSABLE-HTTPS-HOST'
node experiments/provider-browser-transport/probe-options.mjs $publicTestOrigin
```

`profiles.mjs` is the complete 25-row route/method/header matrix. The probe issues **OPTIONS only**, records raw response header pairs and bodies, and does not follow redirects. Unused response cookie values are omitted. A successful HTTP status is not a successful preflight if required header names are absent. These are HTTP probes, not browser generation requests.

## Browser catalog and tunnel stream checks

Start both browsers with fresh profiles. Change executable paths if needed and record the change:

```powershell
Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList @('--headless=new','--remote-debugging-port=19232',"--user-data-dir=$runtimeDir\chrome-main",'--no-first-run','--no-default-browser-check','about:blank') -WindowStyle Hidden
Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList @('--headless=new','--remote-debugging-port=19233',"--user-data-dir=$runtimeDir\edge-main",'--no-first-run','--no-default-browser-check','about:blank') -WindowStyle Hidden
node experiments/provider-browser-transport/run-browsers.mjs $publicTestOrigin
```

The driver waits for the debugging endpoints, creates fresh browser contexts, and accepts an ngrok interstitial through its ordinary Visit Site control when present. It runs nine catalog GET profiles per browser from the controlled public origin. Keys, project, workspace, and beta values are deliberately synthetic and invalid. Public model catalogs may still return HTTP 200.

Each browser runs 31 controlled-origin fixture cases, then eight public HTTPS cross-origin cases from an ordinary `https://example.com` document. The script is injected into that document through task-owned automation. No server or asset on example.com is modified. Only the synthetic service receives POSTs. The cross-origin tests use ordinary header-authenticated fetch with `credentials: "omit"`; missing-header and wrong-origin controls must prevent the POST.

The driver closes its contexts and browser processes. It records request URLs/methods and CORS diagnostics without importing account credentials. Browser catalog bodies are bounded samples, not complete catalog archives.

## Actual byte fragmentation

The recorded tunnel reserialized CRLF events and delivered LF events as whole events. The separate six-case loopback phase establishes actual partial-line and UTF-8 byte splits without the tunnel. Restart Chrome and Edge with new `chrome-fragments` and `edge-fragments` profile directories and the same debugging ports, then run:

```powershell
node experiments/provider-browser-transport/run-fragments.mjs
```

The fragment driver uses an HTTPS example.com page and the loopback synthetic service. It grants ordinary per-origin local-network permissions through CDP and independently records the queried states. It does not disable browser security, TLS validation, or CORS. This does not test the native permission prompt. It saves `fragments-chrome.json` and `fragments-edge.json`.

The LF harness retains multiline `data:` fields, comments, delayed text events, split writes, typed completion/error events, explicit incomplete output, malformed JSON, EOF, socket disconnect, local abort, and a simple invalidation fence. Responses and Messages envelopes contain only fields needed for these parser checks; they do not claim full provider-schema validation. Unknown Responses guide aliases produce neither text nor success.

## Collect and stop

After the drivers finish:

```powershell
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:18776/shutdown
Copy-Item -LiteralPath "$runtimeDir\server-requests.ndjson" -Destination 'experiments\provider-browser-transport\evidence\server-requests.ndjson'
```

Stop only the tunnel process started for this experiment. Record a fresh `cleanup.json` with `listeners` and `remainingOwnedBrowserProcesses` arrays for the owned ports/profiles. Both arrays must be empty. Keep the temporary profiles inert for inspection; deletion is unnecessary.

```powershell
node experiments/provider-browser-transport/redact-evidence.mjs
node experiments/provider-browser-transport/summarize.mjs
```

The summary verifies expected outcomes, byte splits, timing, abort/close traces, rejected CORS controls, absence of provider generation requests, shutdown, and the unchanged prior KHA-15 evidence manifest. It also produces a SHA-256 manifest for this experiment. Every recorded failure remains under `evidence/initial/`; `transport-diagnostic*.json` retain the independent loopback/tunnel comparison. Unused cookie values in published traces are explicitly omitted.

No authenticated generation, real upstream cancellation, usage, billing, production-origin support, or model playing strength is certified by these checks.
