# Browser-to-proxy transport verification

Decision ticket: [Verify browser-to-proxy connectivity with synthetic credentials](https://linear.app/kamkm/issue/KHA-15/verify-browser-to-proxy-connectivity-with-synthetic-credentials).

Run date: 2026-10-16 in Africa/Cairo. Browser evidence is timestamped 2026-10-15T21:10:46Z through 21:13:23Z in UTC.

## Findings

Same-device HTTP loopback worked from an actual public HTTPS origin in the tested Chrome and Edge builds when local-network permission was granted. Both `Authorization` and `X-Api-Key` worked for catalog GET and JSON POST with `credentials: "omit"`. Denying permission blocked all eight tested requests before they reached the server. Granting it again restored access. The `localhost` hostname also worked against the IPv4 loopback listener.

A controlled public HTTPS reference worked cross-origin from `https://example.com` with either authentication header, even while that source origin's local-network permission was denied. This distinguishes public HTTPS access from permission-dependent loopback access.

The earlier source research predicted that the baseline's `Access-Control-Allow-Headers: *` would reject `Authorization`. That prediction was **not observed** in these builds. Twenty-four successful bearer cases have matching OPTIONS records with `authorization` requested, `Access-Control-Allow-Headers: *`, and an authenticated GET/POST afterward. A second round in fresh browser contexts reproduced the observation. Do not describe bearer authentication as necessarily broken in these tested browsers, or generalize this observation to every browser/version.

Restrictive CORS controls confirmed that browser CORS enforcement remained active. Omitting `Authorization` from an explicit allowed-header list blocked eight bearer cases while permitting `X-Api-Key`. Returning a different allowed origin blocked sixteen cases. Four `credentials: "include"` cases also failed against the wildcard-origin baseline. Missing and invalid synthetic keys produced eight readable HTTP 401 responses, so success was not caused by accidentally disabling authentication.

## What actually ran

The baseline is CLIProxyAPI v8.0.30, commit `5be2cdab0869cbaa3d401891f740aebf7e15aa99`. The experiment compiled a test inside that pinned source tree and invoked its **actual CORS middleware, access middleware, and config-key authentication provider**. The synthetic provider count was asserted to be exactly one.

The catalog and chat-completion route handlers were synthetic fixtures. No complete CLIProxyAPI service, provider executor, OAuth directory, upstream client, real proxy configuration, or model subscription was used. Generation could only return the hardcoded fixture. These are real middleware/transport observations with synthetic API endpoints, not evidence that a deployed proxy or any model can play chess.

Baseline CORS responses came unchanged from the pinned middleware. The controlled `/explicit` adapter replaced only the allowed-header list with `Authorization, Content-Type, X-Api-Key, ngrok-skip-browser-warning`. The `/restricted` adapter omitted `Authorization`; `/blocked-origin` replaced the allowed origin with an unrelated `.invalid` origin. These adapters are experiment controls, not changes to CLIProxyAPI.

Both listeners bound only to `127.0.0.1`. The API/harness listener used port 18765; the separate control/log listener used 18766 and was never tunneled. A temporary ngrok HTTPS tunnel exposed only the synthetic API/harness listener. The synthetic key was `kha15-synthetic-only-no-provider`, which is not a credential for a real proxy.

The public HTTPS source for loopback tests was `https://9f46-156-204-70-131.ngrok-free.app/harness`. For the HTTPS reference, the source was `https://example.com` and the controlled destination was that ngrok HTTPS host. Cross-origin reference fetches included ngrok's documented skip-warning header in the ordinary JavaScript request. The tunnel has been stopped; its URL is a historical evidence identifier, not a hosted product.

## Environment and permission control

- OS: Microsoft Windows 11 Pro, version 10.0.26300, build 26300.
- Chrome: 155.0.8059.79. Edge: 155.0.4283.45.
- Node: 24.22.0. Go: 1.26.5, windows/amd64. ngrok: 3.39.9-msix-stable.
- Browsers ran headless with task-specific temporary profiles and fresh browser contexts. Launch flags selected headless mode, a debugging port, a separate user-data directory, and no-first-run/default-browser checks. No web-security disabling flag, certificate bypass, response interception, or CORS bypass was used in browser automation.
- Ordinary permission states were set per source origin through CDP `Browser.setPermission`. The page independently queried `local-network-access`, `local-network`, and `loopback-network`; the recorded states matched granted/denied/regranted phases. This tests enforcement of controlled permission states, not the native permission prompt or a human's interaction with it.

The T3 preview initially reported Electron 44.4.5 / Chromium 152.0.7977.130 and denied local-network permissions. Its snapshot step failed twice with `Preview automation snapshot timed out after 15000ms.` Testing then used the installed browsers under the documented fallback. A later attempt to return the hidden preview tab to example.com also timed out. No experiment script was left running there.

## Evidence and checks

The [reproduction instructions](../experiments/browser-proxy-transport/README.md), harness, driver, and raw evidence are in `experiments/browser-proxy-transport/`.

The [machine-generated summary](../experiments/browser-proxy-transport/evidence/summary.json) classifies 120 browser cases: 76 readable HTTP 200 responses, eight readable HTTP 401 responses, and 36 rejected fetches. The rejections comprise eight permission denials, four incompatible credential-mode cases, eight disallowed bearer-header cases, and sixteen wrong-origin cases. These are deliberate negative controls, not 36 unexplained failures.

The [server trace](../experiments/browser-proxy-transport/evidence/server-requests.ndjson) has 210 records. The evidence checker matched every readable browser response to exactly one actual GET/POST with the same status, verified no server request for denied loopback cases, and correlated all 24 wildcard-bearer successes with preflight records. It also verified that restricted-header and wrong-origin rejections never reached their authenticated API handler.

Four synthetic SSE responses were readable through their terminal `[DONE]` marker. The harness buffers responses with a recorder, so this establishes framing/body readability only. It does not establish real-time chunk delivery, latency, cancellation, proxy keepalives, or upstream completion behavior.

Both server sessions ended through the loopback-only shutdown control, and their selected Go harness test returned PASS. Those test durations include time spent serving the experiment; they are not performance benchmarks. Browser drivers closed their contexts and task browser processes. The task-specific ngrok process was stopped. A final listener check found none of ports 18765, 18766, 19222, 19223, or 4040 listening.

Initial browser setup attempts mistakenly treated a transient empty document as loaded and produced no transport cases. Their JSON records are retained as `initial-navigation-chrome.json` and `initial-navigation-edge.json`. Readiness was corrected to wait for nonempty document content. The later completed runs are separate files; the setup failures were not counted as transport passes or silently relabeled.

## Limits and follow-up checklist

These observations establish narrow transport candidates on the two recorded Windows/browser builds. The supported-proxy decision still chooses launch support, authentication header, configuration requirements, and credential handling.

The following remain untested and must not be called supported solely from this experiment:

1. Run the harness in normal visible Chrome/Edge profiles and exercise the real site permission prompt, dismissal, remembered denial, revocation, and any managed policy. Record browser/OS versions and the permission state with each result.
2. Repeat the proposed launch routes in Firefox, Safari, mobile browsers, and any other claimed platform. No installed Firefox/Safari environment was available here. Do not infer their behavior from Chromium.
3. Verify LAN HTTP, private HTTPS, IPv6 listeners, containers/firewalls, certificate trust/failure variants, and the actual production page's CSP/embedding rules before advertising those combinations.
4. Repeat against the full intended CLIProxyAPI build and gateway with an isolated credential-free setup and intercepted synthetic generation. This harness does not prove real catalog registration, middleware ordering of a full installation, or an arbitrary proxy's configuration.
5. Test actual streaming delivery, cancellation, retries, and compatibility separately. Any later live model validation needs its own authorized player-controlled route. This task made no live generation request and supplies no model-strength evidence.

The wildcard `Authorization` observation is left as an observation, not an explanation of a browser implementation or a change to the Fetch standard. The explicit restrictive controls rule out treating all these successful requests as evidence of disabled CORS, but do not establish behavior in untested deployments.

## Pinned sources

- [CORS and access middleware](https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/internal/api/server_middleware.go).
- [Config-key authentication provider](https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/internal/access/config_access/provider.go).
- [Access manager](https://github.com/router-for-me/CLIProxyAPI/blob/5be2cdab0869cbaa3d401891f740aebf7e15aa99/sdk/access/manager.go).
- Earlier source findings remain in [Determine how a public website can reach a player's CLIProxyAPI](https://linear.app/kamkm/issue/KHA-6/determine-how-a-public-website-can-reach-a-players-cliproxyapi) and [Document CLIProxyAPI model discovery and move requests](https://linear.app/kamkm/issue/KHA-7/document-cliproxyapi-model-discovery-and-move-requests). The runtime results above supersede the unverified bearer-failure prediction for the specific sampled builds.
