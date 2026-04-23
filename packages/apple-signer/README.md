# @mysten-incubation/apple-signer

Sui signer backed by native macOS key stores — Apple Secure Enclave and macOS Keychain —
with a single signed Swift helper and one biometric prompt per Node process.

> [!CAUTION] **Do not use these keys for anything you can't afford to lose.**
>
> - **Enclave-mode keys are non-recoverable.** They are device- and binary-bound. If the
>   Mac dies, the helper binary's signature changes, or macOS invalidates the stored blob
>   across an OS upgrade, the key is gone. There is no mnemonic, no `.p12`, no cloud
>   backup — by design.
> - **Both modes can break on helper upgrade.** Today the helper is **ad-hoc signed**. The
>   first time it's re-signed with a Developer ID certificate, existing keys may become
>   unreadable (Enclave: binary binding; Keychain: ACL bound to the ad-hoc code signature).
>   Expect to regenerate keys once, when this package's CI signing pipeline lands.
> - **Intended for dev keys, local tooling, and testnet accounts** — contexts where losing
>   the key is a non-event. Anything more serious belongs somewhere else.

> [!CAUTION] **Pre-1.0:** This package is under active development. Minor versions may contain
> breaking changes until the API stabilizes at 1.0.

> [!NOTE] **macOS only.** `package.json` declares `"os": ["darwin"]`, so npm refuses to
> install on Linux/Windows. Separate sibling packages will cover Windows (Windows Hello /
> CNG) and Linux (TPM 2.0) when they land. Keys are P-256 (Sui's `Secp256r1` scheme) —
> Apple's hardware-backed APIs don't offer Ed25519 or Secp256k1.

## Two modes, one helper

| Mode     | How keys are created                                 | Key bytes in Node? | Recovery              |
| -------- | ---------------------------------------------------- | ------------------ | --------------------- |
| Enclave  | Secure Enclave chip generates the key                | Never              | No (device-bound)     |
| Keychain | Helper generates or imports; stored with custom ACL  | Only on import     | Yes — `.p12` via UI   |

- **Enclave mode** (`createEnclaveSigner`) — strongest isolation. Private scalar never
  leaves the chip. Keys are device- and binary-bound.
- **Keychain mode** (`createKeychainSigner`) — user-recoverable via macOS Keychain
  Access.app's export flow. Supports four seed sources: `random`, `bech32`, `mnemonic`,
  and `generate-mnemonic`. Signing is silent from the helper; exporting requires user
  authentication. Requires a Developer ID–signed helper in production (ad-hoc builds fail
  with `errSecMissingEntitlement`).

Both modes share one signed Swift helper subprocess, auto-managed by a module-level
singleton — so one biometric prompt unlocks every signer in the process.

## Installation

```sh npm2yarn
npm i @mysten-incubation/apple-signer
```

The package ships a universal Swift binary (arm64 + x86_64) inside at `bin/apple-signer`
— no separate platform packages, no postinstall build step. On non-darwin, npm's
platform filter prevents install.

## Quick start — Enclave

```typescript
import { createEnclaveSigner } from '@mysten-incubation/apple-signer';

const signer = await createEnclaveSigner({ tag: 'publisher' });

// First sign triggers Touch ID; every subsequent sign in this process is silent.
const { bytes, signature } = await signer.signTransaction(txBytes);
```

## Quick start — Keychain

```typescript
import { createKeychainSigner } from '@mysten-incubation/apple-signer';

// Helper generates entropy + mnemonic; mnemonic returned once for the caller to store.
const { signer, mnemonic } = await createKeychainSigner({
    tag: 'publisher',
    seed: { source: 'generate-mnemonic', wordCount: 24 },
});

console.log('save this somewhere safe:', mnemonic);

const { signature } = await signer.signPersonalMessage(new TextEncoder().encode('hi'));
```

Or import from an existing Bech32 / mnemonic:

```typescript
await createKeychainSigner({ tag: 'restored', seed: { source: 'bech32', bech32 } });
await createKeychainSigner({ tag: 'restored', seed: { source: 'mnemonic', mnemonic } });
```

## API

| Function                                                                 | Purpose                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `createEnclaveSigner({ tag, requireBiometric?, helper? })`               | Load or generate an SE-backed signer                  |
| `loadEnclaveSigner({ tag, helper? })`                                    | Load existing SE signer or `null`                     |
| `listEnclaveSigners({ helper? })`                                        | Tags of all enclave keys on this device               |
| `deleteEnclaveSigner({ tag, helper? })`                                  | Remove entry; returns whether it existed              |
| `createKeychainSigner({ tag, seed?, requireBiometric?, helper? })`       | Generate or import a Keychain-stored signer           |
| `loadKeychainSigner({ tag, helper? })`                                   | Load existing Keychain signer or `null`               |
| `listKeychainSigners({ helper? })`                                       | Tags of all keychain entries under this app's prefix  |
| `deleteKeychainSigner({ tag, helper? })`                                 | Remove entry; returns whether it existed              |

### Keychain seed sources

```typescript
type KeychainSeed =
    | { source: 'random' }                                    // default
    | { source: 'bech32'; bech32: string }                    // import suiprivkey1...
    | { source: 'mnemonic'; mnemonic: string; path?: string } // BIP39 + SLIP10
    | { source: 'generate-mnemonic'; wordCount?: 12 | 24 };   // returns mnemonic once
```

## How keys are stored

- **Enclave mode**: opaque `dataRepresentation` blobs in
  `~/Library/Application Support/mysten-incubation-apple-signer/enclave-keys.json`
  (`0600`). The blob is useless without the matching binary and device.
- **Keychain mode**: `SecKey` items in the user's login keychain with a custom
  `SecAccess` ACL — signing is trusted to the helper binary; export requires user
  authentication via Keychain Access.app.

## Security properties

- **Key isolation**: strongest in the Sui TS ecosystem. Enclave mode keys never exist
  in process memory. Keychain mode briefly exposes bytes only at import time (seed
  modes other than `random`), then zeroes the buffer.
- **Binary binding (Enclave)**: rebuilding the helper invalidates previously-stored
  handles. Under Developer ID signing, handles survive updates signed with the same
  identity.
- **User presence**: optional per key. When enabled, requires Touch ID on first sign
  of each helper lifetime.

For the detailed threat model, see the [docs page](../docs/content/apple-signer/index.mdx).

## When to pick something else

- **Cross-platform** — use [`@mysten-incubation/keyring-signer`](../keyring-signer)
  (pure JS, works everywhere).
- **ED25519 / Secp256k1** — neither is supported by these APIs. Use `keyring-signer`.
- **Headless / CI** — no biometric possible; use env-var or KMS-backed signing.
