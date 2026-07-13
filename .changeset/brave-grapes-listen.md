---
'@mysten-incubation/devstack': patch
---

Route native Sui gRPC traffic through the devstack router over h2c while keeping grpc-web and JSON-RPC working on the same public RPC URL.
