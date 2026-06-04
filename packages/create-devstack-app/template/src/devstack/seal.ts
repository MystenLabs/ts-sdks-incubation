// Seal plugin wiring (optional). Synthesizes a dedicated publisher, publishes
// the local `vault` Move package, starts a local-keygen Seal key server, and
// registers the publisher in the dev wallet so the seal panel can run
// `seal_approve` policy checks.

import { account, localPackage, seal } from '@mysten-incubation/devstack';
import { resolve } from 'node:path';

import type { PluginContext, PluginContribution, PluginModule } from './contribution.js';

export const sealModule: PluginModule = {
	setup(ctx: PluginContext): PluginContribution {
		const sealPublisher = account('seal_publisher', {
			kind: 'ephemeral',
			funding: [{ coin: 'sui', amount: 1_000_000_000n }],
		});
		const vault = localPackage('vault', {
			sourcePath: resolve(ctx.here, 'move/vault'),
			publisher: sealPublisher,
		});
		const sealKeyServer = seal({ mode: 'local-keygen', signer: sealPublisher });
		return {
			walletAccounts: [sealPublisher],
			after: [vault, sealKeyServer],
		};
	},
};
