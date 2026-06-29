---
'@mysten-incubation/devstack': minor
---

Start the release-provided Walrus publisher and aggregator services by default in local mode. Local Walrus bindings now point `publisherUrl` and `aggregatorUrl` at app-facing `/v1/blobs` service containers instead of aliasing both URLs to the first storage node.
