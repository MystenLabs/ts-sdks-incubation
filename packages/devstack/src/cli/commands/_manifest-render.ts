// Shared manifest projection + human-readable renderer — feeds both
// `devstack manifest` and `devstack status` so they can't drift on what
// "endpoints / packages / accounts" mean. The JSON envelope shape is
// produced inline by each command; this module owns the human-readable
// summary lines only.

import type { Manifest } from '../../runtime/manifest-schema.js';

/** Walk the typed manifest into a flat endpoint table — `name` matches
 *  `EndpointName` in `runtime/endpoint-names`. Order is load-bearing for
 *  the human render. */
export const projectEndpoints = (
	m: Manifest,
): ReadonlyArray<{ readonly name: string; readonly url: string }> => {
	const out: Array<{ name: string; url: string }> = [];
	if (m.services.sui !== undefined) {
		out.push({ name: 'sui-rpc', url: m.services.sui.rpc.url });
		if (m.services.sui.faucet !== undefined)
			out.push({ name: 'sui-faucet', url: m.services.sui.faucet.url });
		if (m.services.sui.graphql !== undefined)
			out.push({ name: 'sui-graphql', url: m.services.sui.graphql.url });
	}
	if (m.services.seal !== undefined)
		out.push({ name: 'seal-key-server', url: m.services.seal.keyServer.url });
	if (m.services.walrus !== undefined) {
		out.push({ name: 'walrus-aggregator', url: m.services.walrus.aggregator.url });
		out.push({ name: 'walrus-publisher', url: m.services.walrus.publisher.url });
	}
	if (m.app.dev !== undefined) out.push({ name: 'frontend.dev-server', url: m.app.dev.url });
	if (m.app.wallet !== undefined) out.push({ name: 'wallet-app', url: m.app.wallet.url });
	return out;
};

/** Render the body of a manifest summary into console lines. `full`
 *  toggles the manifest-only `coins` + `extras` blocks that `devstack
 *  status` historically omits. */
export const renderManifestBody = (m: Manifest, full = false): ReadonlyArray<string> => {
	const lines: Array<string> = [];

	const eps = projectEndpoints(m);
	if (eps.length > 0) {
		lines.push(`  endpoints:`);
		for (const ep of eps) lines.push(`    ${ep.name}: ${ep.url}`);
	}
	const pkgs = Object.entries(m.packages);
	if (pkgs.length > 0) {
		lines.push(`  packages:`);
		for (const [name, pkg] of pkgs) lines.push(`    ${name}: ${pkg.id}`);
	}
	const accts = Object.entries(m.accounts);
	if (accts.length > 0) {
		lines.push(`  accounts:`);
		for (const [name, acct] of accts) lines.push(`    ${name}: ${acct.address}`);
	}

	if (full) {
		const coins = Object.entries(m.coins);
		if (coins.length > 0) {
			lines.push(`  coins:`);
			for (const [name, coin] of coins)
				lines.push(`    ${name}: ${coin.type} (${coin.decimals} decimals)`);
		}
		const extraKeys = Object.keys(m.app.extras);
		if (extraKeys.length > 0) {
			lines.push(`  extras: ${extraKeys.length} key${extraKeys.length === 1 ? '' : 's'}`);
			for (const key of extraKeys) lines.push(`    ${key}`);
		}
	}

	return lines;
};
