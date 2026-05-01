# Prior art: EVM developer tooling

Context for the `@mysten-incubation/devstack` design. The EVM ecosystem has been iterating on
"config-driven local dev + plugin-extensible tasks + generated typed bindings" for nearly a decade;
the patterns below are the load-bearing ideas worth borrowing or explicitly rejecting. Companion to
[`docs/devstack-design.md`](../../docs/devstack-design.md).

---

## Hardhat (Nomic Foundation)

**Pattern: a runtime environment + plugin queue.** v2's extensibility is built on two functions
imported from `hardhat/config`: `extendConfig` (run during config resolution, lets a plugin add
fields like `networks`, `namedAccounts`, `paths.deploy`) and `extendEnvironment` (a queue of
synchronous functions that mutate the `HardhatRuntimeEnvironment` before any task runs — plugins
attach things like `hre.deployments`, `hre.ethers`, custom utilities). Tasks themselves are
pluggable: a plugin calls `task("my-task", ...)` or, in v2.18+, `scope("my-scope").task(...)` to
namespace commands like `npx hardhat my-scope my-other-task`. See
[Building plugins](https://v2.hardhat.org/hardhat-runner/docs/advanced/building-plugins),
[HRE](https://v2.hardhat.org/hardhat-runner/docs/advanced/hardhat-runtime-environment), and
[Creating a task](https://v2.hardhat.org/hardhat-runner/docs/advanced/create-task).

```ts
extendConfig((config, userConfig) => {
	/* fill defaults */
});
extendEnvironment((hre) => {
	hre.myTool = lazyObject(() => makeTool(hre));
});
task('compile').setAction(async (args, hre, runSuper) => {
	/* wrap */
});
```

What's good: the `runSuper` chain lets plugins decorate built-in tasks without forking. `lazyObject`
defers expensive instantiation. The HRE is a single typed surface that consumers can rely on.

What's painful: monkey-patching the global runtime makes type augmentation fragile (everyone
declares the same module twice); plugin order matters but isn't enforced; `extendEnvironment` is
sync-only so async setup leaks into the first task that touches the field. **Hardhat v3 is rewriting
this as a hook system**
([discussion #7465](https://github.com/NomicFoundation/hardhat/discussions/7465)) — specific hook
points (`build`, `network`, `test`, etc.) replace runtime mutation. Documentation is incomplete as
of late 2025; the direction validates our choice to make plugin contributions declarative (compose
render, manifest, doctor) rather than mutate-the-world.

**hardhat-deploy** ([wighawag/hardhat-deploy](https://github.com/wighawag/hardhat-deploy)) is the
de-facto deployment plugin. Three ideas worth stealing:

1. **Named accounts.** Configure `namedAccounts: { deployer: 0, alice: 1 }` in `hardhat.config`;
   tests read `await getNamedAccounts()` with no `accounts[0]` magic numbers. We already have a
   `pool.claim()` story — the missing piece is letting `devstack.config.ts` give roles names.
2. **Deploy scripts as ordered files in `deploy/`.** Each file exports a default async function;
   ordering controlled by filename prefix (`001_token.ts`). Re-running is idempotent because results
   are written to `deployments/<network>/<Contract>.json` (address + ABI + receipt) and skipped if
   unchanged. This is essentially what our manifest emission does for Move packages, but
   per-deployment rather than per- plugin.
3. **Fixtures via `evm_snapshot`.** `deployments.fixture(["Token"])` runs the deploy scripts once,
   snapshots, and reverts to that snapshot for every subsequent test. Sui doesn't have free
   EVM-style snapshots, but our testcontainers warm-pool serves the same role.

---

## Foundry / Anvil (foundry-rs)

**Pattern: a fast native node + Solidity-as-script + cheat codes.** Anvil is a Rust-native local
node started with one flag: `anvil --fork-url https://eth.merkle.io --fork-block-number 18000000`
gives a forked chain with state pinned to a block. `forge test` spins Anvil internally; tests opt
into forks via cheat codes like `vm.createFork`, `vm.selectFork`, `vm.rollFork`
([Fork Testing](https://getfoundry.sh/forge/fork-testing/)), and each `setUp()` runs in a fresh EVM
state by default.

```solidity
contract MyTest is Test {
    uint256 mainnetFork;
    function setUp() public {
        mainnetFork = vm.createFork(vm.envString("MAINNET_RPC"));
        vm.selectFork(mainnetFork);
    }
}
```

Deployment uses the same DSL:
[`forge script Deploy.s.sol --broadcast --rpc-url $RPC`](https://getfoundry.sh/forge/deploying/)
runs a `run()` function whose `vm.startBroadcast()` block is materialized as real on-chain
transactions. The artifacts (`broadcast/<script>/<chain>/run-latest.json`) are checked-in-friendly
receipts.

What's good: **one binary per concern** (`forge`, `anvil`, `cast`, `chisel`), no Node runtime
dependency, sub-second cold start, native arch on Apple Silicon. The cheat-code surface is a _typed_
protocol (Solidity enum + precompile address) — in our world the equivalent would be having every
plugin contribution be a typed call rather than a string-templated YAML fragment.

What to be careful with: cheat codes leak across forks (`makePersistent` exists for a reason); fork
tests against real RPCs make CI hostage to upstream rate limits — same trap we'd hit if we let
plugins reach out to mainnet without a clear "offline by default" policy.

---

## scaffold-eth-2

**Pattern: opinionated full-stack template + content-merge extensions.** The bar we're aspiring to.
From `git clone` (or `npx create-eth`) to "I see my mint land" in three commands: `yarn chainsleep`
(Anvil), `yarn deploy` (hardhat-deploy or foundry script), `yarn start` (Next.js). The frontend gets
typed contract bindings with **zero manual ABI export** because `yarn deploy` writes
`packages/nextjs/contracts/deployedContracts.ts` keyed by `chainId`, and the in-house hooks
`useScaffoldReadContract` / `useScaffoldWriteContract` are wagmi wrappers that infer types straight
from that file ([docs](https://docs.scaffoldeth.io/hooks/useScaffoldWriteContract)). Burner wallet +
local faucet are wired by default, so a dev who has never installed MetaMask can still sign.

**Extensions** ([create-eth-extensions](https://github.com/scaffold-eth/create-eth-extensions)) are
the part of scaffold-eth-2 most relevant to us. An extension is a git repo containing an
`extension/` folder whose tree mirrors the base template; `npx create-eth -e <name>` deep-merges
files (additive for new files, override for collisions) at scaffold time. The contract is
content-level, not API-level: the extension doesn't register a plugin, it just _ships the files it
wants merged in_.

That's a different axis from our `DevstackPlugin`. Ours is a runtime contract (compose, deploy,
manifest, doctor); theirs is a scaffold-time content contract. Both have a place — extensions are
how we'd ship "DeepBook v3 + a trading UI" as a one-command starter, with the devstack plugin
handling the runtime services.

---

## wagmi CLI / viem

**Pattern: declarative codegen with pluggable sources + sinks.**
[`wagmi.config.ts`](https://wagmi.sh/cli/getting-started) is a single file that lists `contracts`
and `plugins`; `wagmi generate` resolves ABIs through the plugin chain and writes typed bindings to
`out`. The [plugin API](https://wagmi.sh/cli/api/plugins) splits responsibilities cleanly: source
plugins (`etherscan`, `blockExplorer`, `sourcify`, `fetch`, `foundry`, `hardhat`) inject contracts;
sink plugins (`react`, `actions`) emit code via a `run` hook; `foundry`/`hardhat` also implement
`watch` so codegen tracks compile output.

```ts
export default defineConfig({
	out: 'src/generated.ts',
	plugins: [foundry({ project: '../contracts' }), react()],
});
```

What's worth stealing: the **two-axis plugin model** (contract-source vs. codegen-sink) maps almost
1:1 onto our "deploy-time-contributor" vs. "manifest-consumer" split. Source plugins inject typed
objects into a shared registry; sink plugins consume the merged registry. We already have manifest
contribution; the missing piece is making manifest _readers_ also be plugins (e.g. a
`dapp-kit-codegen` plugin that runs after all publish plugins finish).

---

## Tenderly Virtual TestNets

**Pattern: hosted forks as multiplayer dev environments.**
[Virtual TestNets](https://docs.tenderly.co/virtual-testnets) fork any of 105 EVM chains in
milliseconds, expose a JSON-RPC URL, and stay in sync with mainnet state. The
[GitHub Action](https://github.com/marketplace/actions/tenderly-virtual-testnet-setup) provisions
parallel forks per CI job. Useful as a reference for "what if the dev environment isn't local?" — we
don't need this in Phase 1, but the manifest model should not assume `localhost`.

---

## What we should consider stealing

1. **scaffold-eth's "deploy writes typed bindings" loop.** Our `publishMovePackage` already emits
   manifest entries; one more plugin (`dapp-kit-codegen`) that watches the manifest and writes a
   typed `useScaffoldMoveCall` equivalent against `@mysten/sui` would close the loop from Move
   source change to typed React hook with zero manual step. This is the highest-leverage UX win.
2. **wagmi's two-axis plugin model.** Make `DevstackPlugin` explicit about the source/sink
   distinction: source plugins contribute to the manifest (publish, fund, allocate ports); sink
   plugins read the merged manifest after the topological sort completes (codegen, doctor renderers,
   endpoints page). It's already roughly this — naming and typing it would prevent plugins from
   accidentally racing each other.
3. **hardhat-deploy's named accounts + idempotent `deployments/`.** Devnet config should let
   consumers name roles (`admin`, `treasury`, `alice`) and have those names propagate into the
   manifest, the test account pool, and the frontend. The on-disk shape
   (`deployments/<net>/<obj>.json` per published Move package, with bytecode digest as the
   idempotency key) is exactly what M8's source-digest gate already does — formalize it as an
   emitted artifact, not just an internal cache.

---

## What to avoid

- **Hardhat v2's mutate-the-runtime model.** Type augmentation across plugins becomes a
  `declare module` arms race. Our plugin contributions should be _returned values composed by the
  host_, not mutations of a shared object. (We already do this; codify it.)
- **Solidity-as-script for our case.** Foundry's `vm.startBroadcast` is brilliant _because_ the test
  language and the deploy language are the same. Move + TypeScript don't have that property; trying
  to build a cross-language DSL would be worse than two clean languages.
- **Faucet-on-the-hot-path.** Scaffold-eth's burner wallet is fine for demo; their tests don't
  faucet-per-test. Same rule already in CLAUDE.md.
- **Always-on hosted forks as a default.** Tenderly is a great escape hatch but a bad default —
  local-first means local-first, native-arch, no network dependency to start.
- **String-templated config mutation.** deepbook-sandbox's `git checkout` to recover from
  `client.yaml` mutation is the canonical anti-pattern; the EVM equivalent (Hardhat configs that
  mutate `process.env` mid-run) is just as bad. Generate, don't mutate.

---

## Uncertainty notes

- Hardhat v3's hook system is real but undocumented; specific hook names here are inferred from the
  discussion thread rather than canonical docs. Worth re-checking once v3 GAs.
- create-eth-extensions' merge semantics described from the repo structure, not a formal spec —
  verify before shipping our own extensions story.
- Foundry's per-test fork isolation behavior under parallel `forge test` invocations isn't called
  out in the docs I read; would need a small experiment to confirm the contract.
