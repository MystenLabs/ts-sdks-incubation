---
'@mysten-incubation/devstack': minor
---

Add `graphqlHeaders` to the sui plugin's `live` and `local-rpc` modes for authenticated GraphQL
endpoints. Headers stay runtime-only (never written to codegen output); the dashboard relays its Sui
GraphQL reads through a same-origin `/sui-graphql` proxy that attaches them server-side.
