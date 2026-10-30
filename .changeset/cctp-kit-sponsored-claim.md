---
'@mysten-incubation/cctp-kit': minor
---

Add a `sponsor` option, `{ baseUrl, fetch? }`, for a service that claims transfers into Sui and pays
the gas. With it, someone bridging USDC to Sui on a route the service serves sees "Claiming on Sui
for you…" instead of a wallet prompt, and needs no SUI. A transfer left at Claim is sent to the
service the next time the page loads. A transfer completes only once the chain shows it claimed.
When the service cannot claim, the wallet, or `sui.executeTransaction`, is asked as before, and a
press on Claim always goes straight to it. With `claim: 'manual'` the kit never asks the service.

Transfers of less than 0.1 USDC after fees (`MIN_SPONSORED_AMOUNT`) never reach the service. The
warnings about needing SUI are dropped, and the quote says "Claimed on Sui for you", only while the
service serves the form's route and amount. The quote says "Mint on Sui" with an executor.

`TransferRecord.sponsorClaim` is `pending`, `unavailable` or `refused`. When the service could not
claim a transfer waiting at Claim, the card says so. One marked `unavailable` is sent to the service
again at most every 5 minutes while the page is visible, once each time. One marked `refused` is not
sent again, on a reload either; only the service's own refusal counts (a 422 `ineligible`, a 400 for
a body it rejected, or a recipient on USDC's deny list). A request worth retrying is retried after 3,
20 and 60 seconds, each lengthened by up to a quarter, with no attempt started after 120 seconds.

`CctpKitConfig`, `TransferContext` and `CctpKitStores` gain `sponsor`, `sponsor` and `$sponsor`.
`CctpKit` gains `claimer()` and `sponsorState(transfer)`.

The kit now also re-checks claims on Sui while the page is open, with or without a sponsor: every 15
seconds while the page is visible, and when it becomes visible or gains focus. A transfer someone
else finished completes without a reload and emits `transfer:complete`.
