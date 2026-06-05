// Built-in plugin router entrypoints.
//
// The router orchestrator owns registry validation and collision checks.
// Built-in plugins own their public listener names and ports.

import type { EntrypointDecl } from '../contracts/routable.ts';
import { DASHBOARD_ENTRYPOINTS } from './dashboard/routable.ts';
import { HOST_SERVICE_ENTRYPOINTS } from './host-service/routable.ts';
import { SEAL_ENTRYPOINTS } from './seal/routable.ts';
import { SUI_ENTRYPOINTS } from './sui/routable.ts';
import { WALLET_ENTRYPOINTS } from './wallet/routable.ts';
import { WALRUS_ENTRYPOINTS } from './walrus/routable.ts';

export const BUILT_IN_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	...DASHBOARD_ENTRYPOINTS,
	...SUI_ENTRYPOINTS,
	...HOST_SERVICE_ENTRYPOINTS,
	...WALLET_ENTRYPOINTS,
	...WALRUS_ENTRYPOINTS,
	...SEAL_ENTRYPOINTS,
];
