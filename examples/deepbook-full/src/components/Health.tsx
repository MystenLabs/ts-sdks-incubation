import { Card } from '../ui/Card.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
import { deployment } from '../lib/deployment.js';

/** Health card — surfaces a quick at-a-glance status of the four
 *  containers + the oracle. Values come straight from the codegen-
 *  emitted handles; no runtime probes (those would race the supervisor's
 *  own readiness gate). */
export function Health() {
	const oracle = deepbookConfig.pyth;
	const serverRest = deployment.deepbookRestUrl;
	return (
		<Card title="Health" subtitle="Stack components">
			<dl className="grid grid-cols-2 gap-3 text-sm">
				<dt className="text-neutral-500">Sui RPC</dt>
				<dd className="font-mono text-xs break-all" data-testid="health-sui-rpc">
					{deployment.rpcUrl || '—'}
				</dd>

				<dt className="text-neutral-500">DeepBook package</dt>
				<dd className="font-mono text-xs break-all" data-testid="health-deepbook-package">
					{deepbookConfig.packageIds.DEEPBOOK_PACKAGE_ID || '—'}
				</dd>

				<dt className="text-neutral-500">Margin package</dt>
				<dd className="font-mono text-xs break-all" data-testid="health-margin-package">
					{deepbookConfig.packageIds.MARGIN_PACKAGE_ID || '—'}
				</dd>

				<dt className="text-neutral-500">Pyth state</dt>
				<dd className="font-mono text-xs break-all" data-testid="health-pyth-state">
					{oracle?.pythStateId || '—'}
				</dd>

				<dt className="text-neutral-500">Server REST</dt>
				<dd className="font-mono text-xs break-all" data-testid="health-server-rest">
					{serverRest || '—'}
				</dd>

				<dt className="text-neutral-500">Pools</dt>
				<dd className="font-mono text-xs" data-testid="health-pools">
					{Object.keys(deepbookConfig.pools).join(', ') || '—'}
				</dd>
			</dl>
		</Card>
	);
}
