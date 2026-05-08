// `deepbook.publish` — runs `importMovePackage` against
// `MystenLabs/deepbookv3@<version>` inside the sui localnet container.
// Uses `sui client test-publish --with-unpublished-dependencies` so
// DeepBook's `token` sub-package gets inlined under the parent
// address — that's how the `DEEP` coin type ends up at
// `${deepbookPackageId}::deep::DEEP`.
//
// Captures the system Registry + DeepbookAdminCap into the manifest as
// `packages.deepbook.captured.{registryId, adminCapId}` so the pools
// action (and any user code) can reach them.

import type { ActionRunContext, PublishAction } from '../../core/types.js';
import { importMovePackage } from '../../helpers/imported-package.js';
import { openSuiRpcClient } from '../../helpers/sui-client.js';
import { requireLocalnetCtx } from '../../runtime/runtime-helpers.js';
import { suiContainerName } from '../sui/index.js';
import { DEEPBOOK_REPO, DEEPBOOK_SUBDIR } from './source.js';

const CAPTURE = {
	registryId: '::registry::Registry',
	adminCapId: '::registry::DeepbookAdminCap',
} as const;

interface DeepbookPublishOptions {
	version: string;
	admin: string;
}

export function deepbookPublishAction(opts: DeepbookPublishOptions): PublishAction {
	return {
		name: 'publish',
		type: 'Publish',
		needs: ['source', 'accounts.fund'],
		path: '<imported>',
		runsAs: opts.admin,
		inputs: { repo: DEEPBOOK_REPO, version: opts.version, admin: opts.admin },
		getStatus: async (ctx) => {
			const prior = ctx.registry.packages.find('deepbook');
			if (prior === undefined) return { ok: false, detail: 'no prior publish' };
			const client = openSuiRpcClient(ctx);
			const chainId = await client.getChainIdentifier();
			if (prior.chainId !== chainId) {
				return { ok: false, detail: 'chainId differs from prior publish' };
			}
			const live = await client.getObject({ id: prior.packageId });
			if (live.data === null || live.data === undefined) {
				return { ok: false, detail: `${prior.packageId} not on chain` };
			}
			for (const [depName, depId] of Object.entries(prior.deps ?? {})) {
				const depLive = await client.getObject({ id: depId });
				if (depLive.data === null || depLive.data === undefined) {
					return { ok: false, detail: `dep ${depName} (${depId}) not on chain` };
				}
			}
			return { ok: true, detail: prior.packageId };
		},
		run: async (ctx) => {
			requireLocalnetCtx(ctx, 'deepbook.publish');
			const containerName = suiContainerName(ctx.appName, ctx.stack);
			const client = openSuiRpcClient(ctx);
			const chainId = await client.getChainIdentifier();
			const publisher = ctx.accounts.get(opts.admin);
			const result = await importMovePackage({
				containerName,
				repo: DEEPBOOK_REPO,
				rev: opts.version,
				subdir: DEEPBOOK_SUBDIR,
				alias: 'deepbook',
				chainId,
				publisher,
				capture: CAPTURE,
				prior: buildPriorEntry(ctx.registry.packages.find('deepbook')),
				appendLog: ctx.appendLog,
			});
			ctx.registry.packages.register({
				name: 'deepbook',
				packageId: result.packageId,
				captured: result.captured,
				deps: result.deps,
				sourceDigest: result.sourceDigest,
				chainId,
				network: ctx.network,
			});
		},
	};
}

function buildPriorEntry(entry: ReturnType<ActionRunContext['registry']['packages']['find']>) {
	if (entry === undefined) return undefined;
	if (entry.sourceDigest === undefined || entry.chainId === undefined) return undefined;
	return {
		packageId: entry.packageId,
		captured: entry.captured,
		deps: entry.deps ?? {},
		sourceDigest: entry.sourceDigest,
		chainId: entry.chainId,
	};
}
