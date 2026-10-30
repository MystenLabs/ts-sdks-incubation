---
'@mysten-incubation/cctp-kit': minor
---

Add a `sponsor` option, `{ baseUrl, fetch? }`, for a service that claims transfers into Sui and pays
the gas. With it, someone bridging USDC to Sui on a route the service serves sees "Claiming on Sui
for you…" instead of a wallet prompt, and needs no SUI. A transfer left at Claim is sent to the
service the next time the page loads. A transfer completes only once the chain shows it claimed.
When the service cannot claim, the wallet is asked as before, and a press on Claim always goes
straight to the wallet. The warnings about needing SUI are dropped only while the service serves the
route. `CctpKitConfig`, `TransferContext` and `CctpKitStores` gain `sponsor`, `sponsor` and
`$sponsor`, and `TransferRecord` gains `sponsorClaim`.

The kit now also re-checks claims on Sui while the page is open, with or without a sponsor: every 15
seconds while the page is visible, and when it becomes visible or gains focus. A transfer someone
else finished completes without a reload and emits `transfer:complete`.
