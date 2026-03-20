# dev-wallet CLAUDE.md

## Package-Specific Commands

```bash
# Build (must build deps first)
pnpm turbo build --filter=@mysten-incubation/dev-wallet

# Tests
pnpm --filter @mysten-incubation/dev-wallet test:node     # 280 node tests
pnpm --filter @mysten-incubation/dev-wallet test:browser   # 47+12 browser tests via Playwright

# Lint
pnpm --filter @mysten-incubation/dev-wallet lint

# Demo app (interactive review)
cd packages/dev-wallet/examples/demo && pnpm dev
```

## Architecture Quick Reference

- **Wallet core**: `src/wallet/dev-wallet.ts` — wallet-standard Wallet, request queue, auto-approval
- **Adapters**: `src/adapters/browser.ts` — InMemorySignerAdapter, WebCryptoSignerAdapter,
  PasskeySignerAdapter, RemoteCliAdapter, BaseSignerAdapter
- **UI**: `src/ui/` — Lit Web Components (panel, signing-modal, signing, accounts, balances,
  new-account, account-selector, tab-bar, settings, objects, dropdown, standalone, mount)
- **React**: `src/react/` — useDevWallet hook, DevWalletProvider, React-wrapped Lit components
- **Client**: `src/client/` — DevWalletClient for PostMessage popup wallet
- **Server**: `src/server/` — request handler for standalone web wallet
- **CLI**: `src/bin/cli.ts` — `npx @mysten-incubation/dev-wallet serve`
- **Demo**: `examples/demo/` — dapp-kit-react based demo with Tailwind v4

### Export Map

| Import path                              | Contents                                        |
| ---------------------------------------- | ----------------------------------------------- |
| `@mysten-incubation/dev-wallet`          | DevWallet, types, config                        |
| `@mysten-incubation/dev-wallet/adapters` | InMemory, WebCrypto, Passkey, RemoteCLI, Base   |
| `@mysten-incubation/dev-wallet/ui`       | Lit components, mountDevWallet                  |
| `@mysten-incubation/dev-wallet/react`    | useDevWallet, DevWalletProvider, React wrappers |
| `@mysten-incubation/dev-wallet/client`   | DevWalletClient                                 |
| `@mysten-incubation/dev-wallet/server`   | parseWalletRequest                              |

### Key Patterns

- Lit components use `experimentalDecorators` (tsconfig)
- Tests: vitest.config.ts excludes `examples/**` and browser tests

### Demo

```bash
cd packages/dev-wallet/examples/demo && pnpm dev
```

Demo runs on port 5173, standalone wallet on 5174. If Vite HMR breaks after a code change, clear the
cache: `rm -rf node_modules/.vite && pnpm dev`.
