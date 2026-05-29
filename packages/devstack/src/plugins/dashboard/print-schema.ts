// SDL printer for the dashboard schema.
//
// The schema is a module-level value (`dashboardSchema`), so printing only
// walks the type system — no deps and no resolver invocation. Writes the SDL
// to `apps/devstack-dashboard/schema.graphql` for the frontend's gql.tada
// typegen. Dependency-free beyond `graphql` + the builder.
//
//   node --experimental-strip-types \
//     packages/devstack/src/plugins/dashboard/print-schema.ts
//
// (or `tsx packages/devstack/src/plugins/dashboard/print-schema.ts`)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printSchema } from 'graphql';
import { dashboardSchema } from './schema.ts';

/** Return the dashboard schema's SDL. */
export const printDashboardSchema = (): string => printSchema(dashboardSchema);

/** Resolve the SDL output path relative to this file. */
const outputPath = (): string =>
	fileURLToPath(new URL('../../../../../apps/devstack-dashboard/schema.graphql', import.meta.url));

/** Write the SDL to the frontend app. */
export const writeDashboardSchema = (): string => {
	const sdl = printDashboardSchema();
	const target = outputPath();
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${sdl}\n`, 'utf8');
	return target;
};

const isMain = (): boolean => {
	const entry = process.argv[1];
	return entry != null && import.meta.url === new URL(`file://${entry}`).href;
};

if (isMain()) {
	const target = writeDashboardSchema();
	// eslint-disable-next-line no-console
	console.log(`wrote dashboard SDL → ${target}`);
}
