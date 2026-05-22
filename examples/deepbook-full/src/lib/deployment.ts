import { accounts } from '../generated/accounts.js';
import { deepbookBindings } from '../generated/deepbook/deepbook.js';

export const deployment = {
	accounts,
	deepbook: deepbookBindings,
} as const;

const packageId = deployment.deepbook.packageId as string;
const registryId = deployment.deepbook.registryId as string;

export const isDeployed: boolean =
	packageId.startsWith('0x') &&
	packageId.length > 3 &&
	registryId.startsWith('0x') &&
	registryId.length > 3 &&
	deployment.deepbook.pyth !== null;

export type Deployment = typeof deployment;
