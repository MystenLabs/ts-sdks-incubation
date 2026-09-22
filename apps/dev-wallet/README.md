# dev-wallet app

The hosted Sui Dev Wallet, deployed at <https://sui-dev-wallet.vercel.app>. It's the standalone
wallet from `@mysten-incubation/dev-wallet` without CLI integration: WebCrypto (persistent) and
InMemory adapters only. It serves the wallet UI, the popup signing flow for `DevWalletClient`, and
`/bookmarklet.js`.

User docs: [Hosted wallet guide](../../packages/docs/content/dev-wallet/guides/hosted-wallet.mdx).

## Local development

```bash
pnpm turbo build --filter=@mysten-incubation/dev-wallet   # builds bookmarklet.js too
pnpm --filter dev-wallet-app dev
```

## Deployment

Vercel project `sui-dev-wallet` in the Mysten Labs team, with Root Directory `apps/dev-wallet`. Build
settings live in `vercel.json`: the install step runs from the repo root and builds the dev-wallet
package, and `vite build` copies its `bookmarklet.js` into `dist/`. The build fails if the file is
missing.

Deployment Protection is **off** on purpose. Other origins load the popup and `bookmarklet.js`, so
an auth wall breaks every dApp using the wallet.

Deploy manually from the repo root:

```bash
pnpm dlx vercel@latest deploy --prod --scope mysten-labs
```
