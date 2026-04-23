# @mysten-incubation/keyring-signer

Cross-platform Sui signer backed by the OS keyring (macOS Keychain, Linux libsecret,
Windows Credential Manager). Persists keys as Bech32 `suiprivkey...` strings and signs via
non-extractable WebCrypto `CryptoKey` handles so the raw private bytes don't linger in the
process after import.

> [!CAUTION] **Dev and testnet keys only.** The OS keyring is not a strong security boundary —
> any other process your OS user runs can read stored keys silently, with no prompt. Do not
> put anything into this package that you can't afford to lose.

> [!CAUTION] **Pre-1.0:** This package is under active development. Minor versions may contain
> breaking changes until the API stabilizes at 1.0.

> [!NOTE] **Want biometric + hardware isolation on macOS?** Use
> [`@mysten-incubation/apple-signer`](../apple-signer) — Apple Secure Enclave or macOS
> Keychain keys, binary scoped, one Touch ID prompt per Node process run.

## Install

```sh npm2yarn
npm i @mysten-incubation/keyring-signer
```

## Quick start

```typescript
import { createKeyringSigner } from '@mysten-incubation/keyring-signer';

const signer = await createKeyringSigner({
	scheme: 'ED25519', // or 'Secp256r1'
	tag: 'publisher',  // stable identifier — reuse to reload the same key on future calls
});

const { bytes, signature } = await signer.signTransaction(txBytes);
```

First call generates a fresh key and stores it in the OS keyring. Subsequent calls with
the same `tag` reload it. The returned value is a standard `@mysten/sui` `Signer`.

## Supported schemes

- `ED25519` — signed via `crypto.subtle.sign('Ed25519', ...)`.
- `Secp256r1` — signed via `@mysten/signers`'s `WebCryptoSigner` (handles low-S
  normalization).

`Secp256k1` is not supported — Node's WebCrypto doesn't expose the curve.

## API

| Function                                                       | Purpose                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `createKeyringSigner({ scheme, tag, service? })`               | Load or generate a key                               |
| `loadKeyringSigner({ tag, service? })`                         | Load existing key or `null`                          |
| `listKeyringSigners({ service? })`                             | Return tags under a service                          |
| `importKeyringSigner({ secretKey, tag, service?, overwrite? })`| Store a Bech32 key                                   |
| `deleteKeyringSigner({ tag, service? })`                       | Remove entry                                         |
| `exportKeyringSignerSecret({ tag, service? })`                 | Read raw Bech32 from the keyring (bypasses Signer)   |

Default `service` is `"sui-keyring-signer"`. Override to namespace per-app.

## Security model

- **Private key bytes in memory briefly.** During `createKeyringSigner` / `loadKeyringSigner`,
  the Bech32 string is decoded to raw bytes, those bytes are imported as a non-extractable
  `CryptoKey`, and the raw buffers are zero-filled. Intermediate strings may linger in V8's
  string table until GC.
- **`CryptoKey` handles are opaque.** A malicious dep can call `signer.sign()` but cannot
  extract the private key. That's a V8-level boundary, not an OS-level one: a debugger or
  process-level attacker can still inspect the backing memory.
- **The OS keyring protects against plaintext-on-disk, not against other processes.** Any
  Node process your user runs can `getPassword()` the stored Bech32 silently.
- **For hardware-isolated keys with biometric gating on macOS**, use
  [`@mysten-incubation/apple-signer`](../apple-signer).

## Managing keys from the command line

### macOS Keychain

```sh
security find-generic-password -s sui-keyring-signer
security find-generic-password -s sui-keyring-signer -a publisher -g
security delete-generic-password -s sui-keyring-signer -a publisher
```

### Linux (secret-service)

```sh
secret-tool search service sui-keyring-signer
secret-tool clear service sui-keyring-signer account publisher
```

### Windows

Open **Credential Manager** → Generic Credentials, filter by `sui-keyring-signer`.

## Sourcing a key from elsewhere

If the key lives in an env var, file, or test fixture, skip this package entirely — use
`@mysten/sui`'s standard keypair API:

```typescript
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const keypair = Ed25519Keypair.fromSecretKey(process.env.MY_PRIVATE_KEY!);
```

For `.p12` recovery, see [`@mysten-incubation/apple-signer/recover`](../apple-signer).

## Caveats

- **Linux headless / CI**: the OS keyring requires a running `secret-service` daemon. In
  that environment use a keypair from `@mysten/sui` directly (see above).
