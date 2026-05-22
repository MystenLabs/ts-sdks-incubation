---
'@mysten-incubation/keyring-signer': minor
---

Initial release of `@mysten-incubation/keyring-signer`.

Cross-platform Sui signer backed by the OS keyring — macOS Keychain, Linux libsecret,
Windows Credential Manager — via `@napi-rs/keyring`. Keys are persisted as Bech32
`suiprivkey...` strings; signing is performed through a non-extractable Web Crypto
`CryptoKey` handle so the raw private bytes don't linger in the process after import.

The factory returns a standard `@mysten/sui` `Signer`, so `signTransaction`,
`signPersonalMessage`, and `signAndExecuteTransaction` work directly. Supports `ED25519`
and `Secp256r1` schemes (Secp256k1 is unavailable in Node's Web Crypto).

For hardware-isolated keys with biometric gating on macOS, see the sibling package
`@mysten-incubation/apple-signer`.
