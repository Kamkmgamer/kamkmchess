# Choose supported proxy setups and credential handling

Publication: Draft for Linear
Label: wayfinder:grilling
Mode: HITL
Blocked by: [Determine how a public website can reach a player's CLIProxyAPI](01-proxy-connectivity.md), [Document CLIProxyAPI model discovery and move requests](02-proxy-api.md)

## Question

Which proxy deployments and browsers will the MVP support, and what will the player provide to establish a connection?

Using the connectivity and API research, decide the supported path for localhost, LAN, and remote instances; how endpoint and proxy authentication are entered; whether any credential or request passes through the website's server; what is retained and for how long; and what connection errors the player can act on. Identify the CLIProxyAPI variant or version baseline and the actual configuration that represents the first supported setup. If meeting the public-website destination requires extra components or changes to scope, take that choice to the human explicitly.

