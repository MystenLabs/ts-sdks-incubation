---
'@mysten-incubation/devstack': minor
---

Start real local Walrus publisher and aggregator HTTP endpoints by default. Local Walrus bindings now point `publisherUrl` and `aggregatorUrl` at simple app-facing `/v1/blobs` services instead of aliasing both URLs to the first storage node.
