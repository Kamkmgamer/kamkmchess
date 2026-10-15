# Reproduce the synthetic transport experiment

This is disposable evidence for [Verify browser-to-proxy connectivity with synthetic credentials](https://linear.app/kamkm/issue/KHA-15/verify-browser-to-proxy-connectivity-with-synthetic-credentials). Read the [findings and limits](../../research/browser-proxy-transport.md) before interpreting the results.

The harness runs actual pinned upstream CORS/key-auth middleware with synthetic catalog and completion handlers. It does not start CLIProxyAPI's service or configure a provider. Never point this driver at a real proxy: the experiment is designed for its fixed synthetic key and handlers.

## Prepare a separate upstream checkout

Requirements are Go 1.26+, Node 24+, installed Chrome and Edge, and an existing configured ngrok CLI or equivalent controlled public HTTPS route. No dependency package is needed for the Node driver. Ports 18765, 18766, 19222, 19223, and the ngrok agent port must be free.

From this repository in PowerShell, choose a fresh temporary runtime directory. Keep it outside the repository and outside any real proxy's auth/config directories.

```powershell
$experimentAssets = (Resolve-Path 'experiments\browser-proxy-transport').Path
$experimentRuntime = Join-Path $env:TEMP 'kha15-transport-repeat'
if (Test-Path -LiteralPath $experimentRuntime) { throw 'Choose a fresh experimentRuntime directory.' }
git clone --depth 1 --branch v8.0.30 https://github.com/router-for-me/CLIProxyAPI.git "$experimentRuntime\upstream"
git -C "$experimentRuntime\upstream" rev-parse HEAD
# Required commit: 5be2cdab0869cbaa3d401891f740aebf7e15aa99
Copy-Item -LiteralPath "$experimentAssets\upstream_harness_test.go" -Destination "$experimentRuntime\upstream\internal\api\kha15_transport_harness_test.go"
$env:KHA15_ASSET_DIR = $experimentAssets
$env:KHA15_LOG_FILE = "$experimentRuntime\requests.ndjson"
$env:KHA15_READY_FILE = "$experimentRuntime\ready.json"
Push-Location "$experimentRuntime\upstream"
go test ./internal/api -run '^TestKHA15TransportHarness$' -count=1 -v -timeout=30m
Pop-Location
```

Wait for `KHA15_READY`. This terminal remains serving until the control endpoint stops it or its 25-minute guard expires. The selected Go test's eventual PASS indicates orderly harness completion, not that every browser case succeeded.

## Expose only the synthetic listener

In another terminal, expose `http://127.0.0.1:18765` through a disposable HTTPS tunnel. For ngrok:

```powershell
ngrok http http://127.0.0.1:18765 --inspect=false
```

Use its HTTPS public origin in the commands below. Do not expose port 18766, a real CLIProxyAPI instance, a source directory, or real credentials. The experiment page is `/harness`. The public endpoint also provides the synthetic reference API.

The driver normally accepts an ngrok browser interstitial through its Visit Site control. Its public-reference fetches set `ngrok-skip-browser-warning` as an ordinary request header. That header is included in the controlled CORS allowlists; it does not bypass browser CORS.

## Run both browser rounds

Use fresh task-specific user-data directories. The paths below are the installed Windows browser locations used in this run; adapt them to the browsers actually being measured. Do not reuse a personal browser profile. These launches do not disable CORS, TLS checks, or local-network security.

```powershell
$experimentRuntime = Join-Path $env:TEMP 'kha15-transport-repeat'
$publicTestOrigin = 'https://YOUR-DISPOSABLE-HTTPS-HOST'
function Start-TransportBrowsers {
  Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList @('--headless=new','--remote-debugging-port=19222',"--user-data-dir=$experimentRuntime\chrome-profile",'--no-first-run','--no-default-browser-check','about:blank') -WindowStyle Hidden
  Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList @('--headless=new','--remote-debugging-port=19223',"--user-data-dir=$experimentRuntime\edge-profile",'--no-first-run','--no-default-browser-check','about:blank') -WindowStyle Hidden
}
Start-TransportBrowsers
# Wait until http://127.0.0.1:19222/json/version and :19223/json/version answer.
node experiments/browser-proxy-transport/run-browsers.mjs $publicTestOrigin
Start-TransportBrowsers
# Wait for both debugging endpoints again. Each round closes its browsers.
node experiments/browser-proxy-transport/run-browsers.mjs $publicTestOrigin --cors-controls
```

The first round tests loopback granted/denied/regranted states, localhost, explicit allowed headers, wrong/missing keys, incompatible credential mode, synthetic SSE framing, and a public HTTPS reference from example.com. The focused second round repeats wildcard cases and tests an explicit header list without Authorization plus a wrong allowed origin.

CDP sets ordinary per-origin permission states and the page queries those states independently. A normal visible-browser check remains necessary to verify a human's native permission prompt. The page's Test HTTP loopback button can be used for that follow-up. Do not treat prompt behavior as covered by the automated permission overrides.

Files under `evidence/` are written by the driver. Preserve earlier runs before repeating if they are needed as evidence. A driver infrastructure error sets a nonzero exit code; expected CORS and permission rejections are recorded as outcomes rather than infrastructure errors.

## Collect, check, and stop

Once both drivers finish, copy the runtime `requests.ndjson` to `experiments/browser-proxy-transport/evidence/server-requests.ndjson`, then run:

```powershell
node experiments/browser-proxy-transport/summarize-evidence.mjs
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:18766/shutdown
```

Stop the specific tunnel process you started. Confirm that the owned listeners and browser processes have exited. Keep raw evidence, source, versions, and the public-origin identifier together. Temporary checkouts/profiles may remain inert for inspection; no recursive deletion is needed to stop the experiment.

The summary checks trace consistency, denied-loopback isolation, observed wildcard-bearer behavior, and restrictive controls. It does not certify chess correctness, model compatibility, or an arbitrary installed proxy.
