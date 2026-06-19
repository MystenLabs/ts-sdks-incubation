#!/usr/bin/env bash
#
# Capstone live-network validation runner (Scenario B).
#
# Orchestrates the REPEATABLE parts of the "Deploy to a real network" capstone:
# it boots a live localnet `e2e` stack (via the Playwright globalSetup) with the
# committed `deployments/devnet.ts` supplying devnet, then runs the two browser
# specs that prove localnet->devnet switching + a real dev-wallet-signed devnet
# tx. See ./README.md for the full scenario writeup.
#
# This is NOT a CI gate. Live nets are slow/flaky and the devnet faucet
# rate-limits; run it by hand and record the result in ./RUN-LOG.md.
#
# ── MANUAL prerequisites (this script does NOT do these — it only checks) ──────
#   1. (LIVE PUBLISH)  Publish the Move package to devnet and set the package id
#      in ../deployments/devnet.ts. This script will NOT publish — it refuses to
#      run a live deploy. See README.md "Scenario A, step 1-2".
#   2. (FAUCET)        The devnet-tx spec funds alice from the PUBLIC devnet
#      faucet at runtime; no manual funding needed, but the faucet must be up.
#
# ── AUTOMATED (this script) ───────────────────────────────────────────────────
#   - boots the localnet `e2e` stack (Playwright globalSetup) and tears it down,
#   - runs network-switch.spec.ts + devnet-tx.spec.ts with the right env.
#
set -euo pipefail

# --- locate ourselves (run from anywhere) -------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOYMENT_FILE="${EXAMPLE_DIR}/deployments/devnet.ts"

SPECS=(
	"tests/browser/network-switch.spec.ts"
	"tests/browser/devnet-tx.spec.ts"
)

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

note() {
	echo ">> $*"
}

# --- defensive preflight checks -----------------------------------------------

note "Capstone Scenario B preflight (example: ${EXAMPLE_DIR})"

# (1) sui CLI must be on PATH — the live publish (manual) and the spec's
#     on-chain assertions assume a real Sui toolchain is available.
if ! command -v sui >/dev/null 2>&1; then
	fail "the 'sui' CLI is not on PATH. Install it (e.g. 'suiup install sui@mainnet') — \
the capstone needs it to publish to a live network. See README.md 'Prerequisites'."
fi
note "found sui: $(sui --version 2>/dev/null || echo 'unknown version')"

# (2) the committed, typed devnet deployment must exist (Scenario A produced it).
if [[ ! -f "${DEPLOYMENT_FILE}" ]]; then
	fail "missing committed deployment: ${DEPLOYMENT_FILE}
This file must carry a package id actually published to devnet. Produce it via
README.md 'Scenario A' (hand-author, or 'devstack dump-deployment --network devnet')
BEFORE running this harness. This script will NOT run a live deploy for you."
fi

# (2b) sanity: the deployment must carry a concrete devnet package id, not a
#      placeholder/zero. A 0x0 / 0x000… id means the manual publish step was
#      skipped — fail loudly rather than run a tx against a non-package.
if grep -Eq "0x0+['\"]" "${DEPLOYMENT_FILE}"; then
	fail "${DEPLOYMENT_FILE} appears to hold a placeholder package id (0x0…). \
Publish to devnet and set the real package id first (README.md Scenario A, step 1-2)."
fi
note "found committed devnet deployment: ${DEPLOYMENT_FILE}"

# (3) pnpm must be available — it drives playwright + the devstack boot.
if ! command -v pnpm >/dev/null 2>&1; then
	fail "'pnpm' is not on PATH. Install dependencies with 'pnpm install' from the repo root."
fi

# (4) the example must be installed (playwright binary present).
if [[ ! -d "${EXAMPLE_DIR}/node_modules" ]]; then
	fail "${EXAMPLE_DIR}/node_modules is missing — run 'pnpm install' from the repo root first."
fi

note "preflight OK"
echo

# --- run the browser specs (AUTOMATED) ----------------------------------------
#
# globalSetup boots the `e2e` localnet stack from DEVSTACK_STACK; DEVSTACK_APP
# selects this example's config; DEVSTACK_AUTO_APPROVE=1 makes the dev wallet
# auto-approve signing in headless. The localnet stack is torn down after the
# run. The devnet side is the committed deployments/devnet.ts (no boot).
#
# NOTE: this hits the LIVE devnet faucet + fullnode — expect minutes, not
# seconds, and occasional faucet rate-limit retries (handled inside the spec).

note "running capstone browser specs against a live localnet + committed devnet"
note "specs: ${SPECS[*]}"
echo

cd "${EXAMPLE_DIR}"

DEVSTACK_APP=connect-four \
DEVSTACK_STACK=e2e \
DEVSTACK_AUTO_APPROVE=1 \
	pnpm exec playwright test "${SPECS[@]}"

echo
note "capstone Scenario B complete — record the tx digest + network-switch result in capstone/RUN-LOG.md"
