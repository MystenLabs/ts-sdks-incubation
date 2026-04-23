---
'@mysten-incubation/apple-signer': minor
---

Initial release of `@mysten-incubation/apple-signer`.

A macOS-only Sui signer that wraps two Apple platform APIs behind a single signed Swift
helper binary:

- **Secure Enclave mode** (`createEnclaveSigner`) — Secp256r1 keys generated via
  CryptoKit's `SecureEnclave.P256.Signing.PrivateKey`. Private scalar never exists outside
  the chip. Keys persisted as opaque `dataRepresentation` blobs on disk; device- and
  binary-bound; not recoverable.
- **Keychain mode** (`createKeychainSigner`) — Secp256r1 `SecKey` items stored in the
  macOS Keychain via `SecItemAdd` with a custom per-operation ACL. Signing is silent from
  the helper; export requires user auth via Keychain Access.app. Four seed sources:
  `random`, `bech32` (BYO `suiprivkey...`), `mnemonic` (BIP39 + SLIP10), and
  `generate-mnemonic` (helper generates entropy and returns the mnemonic once). Keychain
  mode requires a Developer ID–signed helper at production time; ad-hoc builds fail fast
  with `errSecMissingEntitlement`.

A Swift helper subprocess holds a single `LAContext` for its lifetime — the first sign in
a fresh Node process triggers a Touch ID prompt, subsequent signs are silent until exit.
The helper is auto-managed by a module-level singleton, so `create*Signer` / `load*Signer`
calls without an explicit `helper` option share one subprocess (and one biometric prompt)
for the process lifetime.

Ships a **universal Swift binary** (arm64 + x86_64) inside the package at
`bin/apple-signer` — no separate platform-binary packages, no postinstall build step.
`package.json` declares `"os": ["darwin"]`, so npm refuses to install on Linux/Windows;
sibling packages (`windows-hello-signer`, `tpm-signer`) will cover other platforms when
they land.

All signers extend `@mysten/sui`'s `Signer`, so `signTransaction`, `signPersonalMessage`,
and `signAndExecuteTransaction` work directly.

Also exposes `keypairFromP12(bytes, password)` under the `/recover` subpath — a pure-JS
decoder for PKCS#12 files exported via Keychain Access.app (or `openssl pkcs12 -export`).
Returns a `Secp256r1Keypair` suitable for re-import into a new Keychain entry.
