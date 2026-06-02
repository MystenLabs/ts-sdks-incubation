# Template rebuild — per-plugin demo panels + interactive picker (design spec)

Authoritative spec for the WS3/WS4 template rebuild. Build agents follow this EXACTLY (marker syntax + paths must match so the scaffolder's strip logic works). Producer/devstack core codegen is DONE; consume the NEW generated shape (`design-codegen.md`).

## New generated shape (consume this)
- `@generated/config.js` → `config = { network, networks.<net>.{chain,mode,rpc,faucet,graphql,forkUpstream}, packages.<name>.{mvr,packageId,byNetwork,objects?}, objects.<pkg>.<key> }`
- `@generated/seal.js` → `seal` name-keyed `{ <name>: SealBindings }`
- `@generated/walrus.js` → `walrus` (single WalrusBindings, NOT name-keyed)
- `@generated/deepbook.js` → `deepbook` name-keyed `{ <name>: DeepbookBindings }`
- `@generated/bindings/<pkg>/<module>.js` → Move codegen (e.g. `Counter.get({client,objectId})`, builder fns)
- `@devstack-dev/accounts.js` → `accounts`; `@devstack-dev/dev-wallet.js` → `devWallet` (DEV-ONLY, gitignored)

## Marker syntax (strip mechanism)
Comment-fence on whole-statement boundaries. Plugin id in the fence. Stripper removes unselected blocks (incl. fence lines); for selected plugins removes only the 2 fence lines, keeps body.
```ts
// devstack:begin walrus
import { WalrusPanel } from './panels/WalrusPanel.js';
// devstack:end walrus
```
Every `begin` MUST have a matching `end` (scaffold asserts). Fences only on statement boundaries (import lines, array elements, config member lines) so removal never breaks syntax. `package.json` deps stripped structurally via the manifest (no comments in JSON). Move dirs removed by directory.

## Target `examples/_template/` tree (superset)
core = always; others fenced.
```
package.json            superset deps; optional deps removed structurally by picker
devstack.config.ts      superset stack; per-plugin member blocks fenced
playwright.config.ts    REWORKED: test-stack (DEVSTACK_STACK=test)
tsconfig.app.json       + @devstack-dev/* path → ./.devstack/stacks/_template/generated-extras/*
src/
  main.tsx              provider wiring (unchanged)
  dapp-kit.ts           REWRITTEN dev/prod wallet split
  dapp-kit.dev.ts       NEW dev-only: accounts + __devstackDAppKit__.selectAccount slot for playwright connectAs
  App.tsx               panel registry; per-panel import+array-element fenced
  config.ts             NEW thin helper: re-export @generated/config + activeNet
  ui/Panel.tsx          NEW shared panel chrome
  ui/Card.tsx           keep
  lib/sign.ts           NEW shared useSignAndExecute (lift robust version from old App.tsx)
  lib/counter.ts        core tx builders + read over generated bindings
  lib/counter.test.ts   NEW vitest unit (non-empty suite): asserts tx targets counter::create_and_share / increment_entry
  lib/walrus.ts         <<walrus>> harvest from private-content, retarget @generated/walrus.js
  lib/seal.ts           <<seal>>  harvest from private-content, retarget @generated/seal.js + @generated/config.js
  panels/CounterPanel.tsx   core
  panels/WalrusPanel.tsx    <<walrus>>
  panels/SealPanel.tsx      <<seal>>
move/counter/{Move.toml,sources/counter.move}   core local package
move/vault/**            <<seal>> copy from examples/private-content/move/vault
e2e/counter.spec.ts      core
e2e/walrus.spec.ts       <<walrus>>
e2e/seal.spec.ts         <<seal>>
```
DELETE: `move/hello`, `e2e/mint.spec.ts`, old greeting App body.
(Deepbook panel/lib/spec/config added by the deepbook track after plugin investigation.)

## dapp-kit.ts (dev/prod split) — deployable, no runtime accounts
- RPC from `config.networks[config.network].rpc` (was `suiNetwork.rpcUrl`). Network = `config.network`.
- Dev-wallet wiring gated by `import.meta.env.DEV`; the gitignored `@devstack-dev/*` modules imported DYNAMICALLY (never in prod bundle). `@mysten-incubation/dev-wallet` may be a static dep (safe in prod even if unused), but `@devstack-dev/dev-wallet.js` + `@devstack-dev/accounts.js` MUST be dynamic + DEV-gated.
- NO `accountAddressByName`, NO `accounts` import in `dapp-kit.ts`. Move the `selectAccount`/`findDevWalletAccount` slot wiring + accounts import into `dapp-kit.dev.ts`, dynamically imported only when `import.meta.env.DEV`. Preserves playwright `connectAs` (tests run dev-mode) while keeping accounts out of prod.
- prod: omit dev initializer → standard wallet-standard wallets register; `autoConnect: import.meta.env.DEV`.
- Settle exact construction so `tsc -b` AND `vite build` pass with `@devstack-dev/*` absent (they don't exist in a non-applied/prod tree). Use guarded dynamic import; avoid top-level await leaking to prod.

## App.tsx registry
Import panels (fenced), push into a `panels` array (fenced elements), render `panels.map(P => <P connected={...}/>)`. Core CounterPanel never references optional plugins.

## devstack.config.ts wiring (core + seal + walrus; deepbook TBD)
- `sui()`, `account('alice')` (dev-only), `localPackage('counter', { sourcePath: move/counter, publisher: alice, /* networks: { testnet:{packageId}, mainnet:{packageId} } for deploy */ })`.
- `// devstack:begin walrus` walrus cluster (`walrus({ local: { nodeCount: 1 } })`) + walCoin. `// devstack:end walrus`
- `// devstack:begin seal` ephemeral seal_publisher account, `localPackage('vault', move/vault)`, `seal({ mode:'local-keygen', signer: sealPublisher })`. `// devstack:end seal`
- `wallet({ accounts: [alice, /*seal*/ sealPublisher] })`, `hostService({ name:'app', script: vite, after:[counter, devWallet, /*walrus*/ walrusCluster, /*seal*/ vault, sealKeyServer] })`, `dashboard()`.
- `defineDevstack({ members:[localnet, app, dashboard()], stackName:'_template' })`.
- No `capture:` needed (counter id held in React state; seal reads vault::File id; walrus uses blob ids).

## counter Move (core)
`module counter::counter;` struct `Counter has key,store { id, owner, value:u64 }`; `create_and_share` (entry, shares), `increment_entry(&mut Counter)`, `value(&Counter):u64`. `Move.toml` name counter, edition 2024, `[addresses] counter="0x0"`.
counter.ts: `createCounterTx()` (moveCall create_and_share), `incrementTx(id)`, `readCounter(client,id)` via generated `Counter.get`. Verify exact emitted binding fn names against a real apply (likely `createAndShare`/`incrementEntry`, `Counter.get` like connect-four `Game.get`).

## seal + walrus panels (harvest from private-content)
- walrus lib: copy `storeBlob`/`readBlob`, import `walrus` from `@generated/walrus.js` (single). Panel: text→bytes→store→show blobId→readBlob→render. Mirror private-content's signer mechanism for `writeBlob` (connected dev-wallet account). testids `walrus-blob-id`,`walrus-readback`.
- seal lib: copy `encryptForSealId`/`decryptForFile`, retarget to `seal.<name>.serverConfigs`/`objectId` from `@generated/seal.js` and `config.packages.vault.packageId`. Drop private-content's `deployment.ts` indirection. Panel: secret→encrypt→(hold ciphertext in React state, no walrus dependency)→decrypt→show. testids `seal-encrypted`,`seal-decrypted`.

## Test-stack DX (WS4)
- `playwright.config.ts`: `webServer` via `devstackPlaywrightWebServer({ baseURL, stack: 'test', command: 'DEVSTACK_APP=_template DEVSTACK_STACK=test pnpm dev', env:{VITE_TEMPLATE_AUTO_APPROVE:'1'} })`. baseURL `http://dev.test.<app>.localhost:5175` (test stack, distinct from dev's default `primary`). The webServer's `pnpm dev` brings its own stack up — no manual apply. `reuseExistingServer:!CI`.
- scripts: `dev: DEVSTACK_APP=_template devstack up`; `test:e2e: DEVSTACK_APP=_template DEVSTACK_STACK=test playwright test`; `test: pnpm run typecheck && vitest run` (counter.test.ts makes suite non-empty).
- gitignore: ensure `test-results/`, `playwright-report/`, `.devstack/`, `src/generated/`, `move/**/build/`. Harden against the scaffold-time `test-results` leak; add a create-devstack-app regression test asserting a fresh scaffold's initial commit has no `test-results/`.

## Scaffolder (create-devstack-app) — picker + strip
- Add `@clack/prompts` dep (bundled by tsdown; confirm not externalized). `bin.ts`: flags `--plugins core,seal,walrus,deepbook` / `--all` / `--minimal` / `--yes`; interactive multiselect (default all; core non-togglable, pre-checked).
- `src/plugin-manifest.ts` (NEW): `PluginId='core'|'walrus'|'seal'|'deepbook'`; per-plugin `{files,dirs,deps,devDeps}` (panel/lib/spec/move-dir/deps). Shared fenced files (devstack.config.ts, App.tsx) NOT in `files` — always kept + fence-stripped.
- `scaffold()` stays prompt-free (pure, testable): add `plugins?` option (default all). `stripPlugins(appDir, selected)`: rm unselected `files`/`dirs` (tolerate missing — rm -f semantics), fence-strip shared text files (line-based stack parser; assert no leftover fences), structurally delete unselected deps from package.json. Guard: grep no remaining `devstack:begin/end`, no import of removed module.
- `rewriteName`: also rewrite `@devstack-dev` tsconfig path segment `stacks/_template`→`stacks/<name>` + playwright app/stack tokens.

## sync-template.ts changes
- `rewriteTemplateScripts`: new scripts (counter dev/test, `DEVSTACK_STACK=test`).
- DELETE `applyTemplateCutoverFixups` (brittle old-App regexes won't match; superset _template is the literal final source).
- Extract the duplicated `SKIP` set to a shared module (used by index.ts + sync-template.ts).
- Add validation (sync + --check): every manifest file/dir exists in template; every `devstack:begin <p>` has matching end in shared files.
- Ensure new optional deps (`@mysten/seal`,`@mysten/walrus`,`@mysten/walrus-wasm`,`@mysten/deepbook-v3`) cataloged.

## Phased build
- A (solo): core+seal+walrus template end-to-end (shared files + counter + seal + walrus + move + specs + dapp-kit + playwright + package.json + gitignore; delete hello/mint). No deepbook.
- D (parallel, disjoint package): scaffolder picker+strip+manifest+sync-template (+ its own typecheck + a scaffold regression test).
- Deepbook track (after investigation): possibly enhance the deepbook plugin to be a true one-liner local DeX; then add deepbook panel/lib/spec + fenced config/App/package.json blocks + manifest already covers it.
- E (gate, solo): `devstack apply` superset (Docker), confirm generated shapes match imports, `pnpm test` + `pnpm test:e2e` on DEVSTACK_STACK=test while dev runs, scaffold each subset (minimal/+walrus/+seal/+deepbook/all) and `tsc -b` each to prove no dangling refs, run check-template.

## NO git operations in any build agent (a concurrent git op already clobbered work once). Plain file edits only.
