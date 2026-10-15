# Determine how a public website can reach a player's CLIProxyAPI

Publication: Draft for Linear
Label: wayfinder:research
Mode: AFK
Blocked by: None
Research branch: research/proxy-connectivity
Research asset: research/proxy-connectivity.md

## Question

Which browser-to-proxy connection routes are viable for the agreed public website, and what must a player configure for each route?

Use primary CLIProxyAPI source and documentation plus browser documentation to investigate localhost and LAN HTTP endpoints, remote HTTPS endpoints, mixed-content behavior, CORS and preflight, local-network permissions, authentication headers, and browser differences. Identify the upstream repository and inspected release or commit, and distinguish any known fork behavior from the baseline. Compare direct browser access with relay or companion alternatives where needed, including whether a hosted server can actually reach a player's private endpoint. Record concrete prerequisites, limitations, and what still requires runtime testing. Do not choose a deployment policy for the human or expose a real player's proxy.

Write one cited findings file on the research branch, link it from the resolution comment, and record any newly specifiable follow-up decisions.

