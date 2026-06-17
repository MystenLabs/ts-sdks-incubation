// Inline stack for the snapshot/restore state-survival matrix e2e.
//
// Composes the REAL (non-stub) local services so snapshot/restore can be
// exercised across every stateful subsystem:
//   - sui chain state
//   - walrus blob storage
//   - seal key material (verified via the vault encrypt/decrypt roundtrip)
//   - a local Move package (the private-content `vault`)
//   - deepbook (publish + registry; pools added once the base boots)
//
// Unlike `private-content-boot`, this fixture deliberately uses the REAL
// walrus + seal images (the caller must NOT set *_CARGO_IMAGE_OVERRIDE) so
// blobs actually store and IBE keys actually serve — a snapshot of no-op
// stub containers would prove nothing.
//
// `buildMatrixStack` is parameterized so the boot can be brought up
// incrementally (deepbook off -> on -> pools) while each novel integration
// is de-risked.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	account,
	dashboard,
	defineDevstack,
	deepbook,
	localPackage,
	seal,
	type Stack,
	sui,
	walCoin,
	wallet,
	walrus,
} from '../../../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// snapshot-matrix -> e2e -> test -> devstack -> packages -> repo root
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

const requirePackage = (sourcePath: string, label: string): string => {
	if (!existsSync(resolve(sourcePath, 'Move.toml'))) {
		throw new Error(`snapshot-matrix: missing ${label} Move package at ${sourcePath}`);
	}
	return sourcePath;
};

const VAULT_SOURCE = requirePackage(
	resolve(REPO_ROOT, 'examples/private-content/move/vault'),
	'vault',
);
// DeepBook's Move package is fetched from upstream git — there is no vendored
// copy on disk (the codegen-decoupling work removed it in favor of git
// sourcing). The canonical `examples/deepbook-trader` config tracks `main`, but
// this is a determinism-sensitive snapshot/restore fixture: a moving `main`
// would let an unrelated upstream change break (or silently alter) the boot, so
// we pin a known-good commit instead. Bump deliberately when the example's
// deepbook surface changes.
const DEEPBOOKV3_REPO = 'https://github.com/MystenLabs/deepbookv3.git';
const DEEPBOOK_REV = '5411ef3aa93f7722409b2a85047baa3d4d830c07';

export const STACK_APP = 'snapshot-restore-matrix';
export const STACK_NAME = 'snapshot-restore-matrix';

export interface MatrixStackOptions {
	/** Publish deepbook + create its registry. Default true. */
	readonly deepbook?: boolean;
	/** Override the stack name (and thus container labels) so a second test in
	 *  the same file gets an isolated container set. Default `STACK_NAME`. */
	readonly stackName?: string;
}

/** Build the matrix stack. Members are listed explicitly (not relied on
 *  via the dependency closure) since there is no `hostService` app to
 *  anchor the roots. */
export const buildMatrixStack = (opts: MatrixStackOptions = {}): Stack => {
	const includeDeepbook = opts.deepbook ?? true;
	const stackName = opts.stackName ?? STACK_NAME;

	const localnet = sui();
	const walrusCluster = walrus({ local: { nodeCount: 4 } });
	const wal = walCoin(walrusCluster);

	const sealPublisher = account('seal_publisher', {
		kind: 'ephemeral',
		funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
	});
	// `bank` bankrolls the test's fresh keypair (SUI for gas + WAL for
	// walrus storage payment) via its exposed `signAndExecute`.
	const bank = account('bank', {
		kind: 'ephemeral',
		funding: [
			{ coin: 'sui', amount: 1_000_000_000_000n },
			{ coin: wal, amount: 10_000_000_000n },
		],
	});
	const deepbookPublisher = account('deepbook_publisher', {
		kind: 'ephemeral',
		funding: [{ coin: 'sui', amount: 1_000_000_000_000n }],
	});

	const vault = localPackage('vault', { sourcePath: VAULT_SOURCE, publisher: sealPublisher });
	const sealKeyServer = seal({ mode: 'local-keygen', signer: sealPublisher });
	const devWallet = wallet({ accounts: [bank, sealPublisher, deepbookPublisher] });

	const baseMembers = [
		localnet,
		walrusCluster,
		wal,
		sealKeyServer,
		sealPublisher,
		bank,
		deepbookPublisher,
		vault,
	];

	if (!includeDeepbook) {
		return defineDevstack({
			members: [...baseMembers, devWallet, dashboard()],
			stackName,
		});
	}

	const deepbookPackage = localPackage('deepbook', {
		git: { url: DEEPBOOKV3_REPO, subdir: 'packages/deepbook', rev: DEEPBOOK_REV },
		publisher: deepbookPublisher,
		capture: {
			registryId: '::registry::Registry',
			adminCapId: '::registry::DeepbookAdminCap',
			deepTreasuryId: '::deep::ProtectedTreasury',
		},
	});
	const dex = deepbook({
		mode: 'local',
		publisher: deepbookPublisher,
		package: deepbookPackage,
		deepTreasuryIdKey: 'deepTreasuryId',
		pools: [],
	});

	return defineDevstack({
		members: [...baseMembers, deepbookPackage, dex, devWallet, dashboard()],
		stackName,
	});
};
