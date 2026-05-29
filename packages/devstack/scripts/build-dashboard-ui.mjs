// Bundle the dashboard React app into the devstack package.
//
// Production/CLI path: the dashboard plugin serves a *built* SPA that ships
// inside this package (see src/plugins/dashboard/server.ts). This script wires
// that bundle:
//
//   1. Export the live GraphQL SDL to apps/devstack-dashboard/schema.graphql
//      (gql.tada typegen reads it). Resolves the schema-before-app-build
//      chicken-and-egg: the SDL only walks the Pothos type system, so it needs
//      no built app and no resolver invocation.
//   2. Build the app (`vite build`) → apps/devstack-dashboard/dist/.
//   3. Copy that dist/ into packages/devstack/dashboard-ui/ (shipped via the
//      package `files` array, served at runtime by the plugin).
//
// Invoked by the package `build` script before `tsdown`, and standalone via
// `pnpm --filter @mysten-incubation/devstack build:dashboard-ui`.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const appRoot = join(repoRoot, 'apps', 'devstack-dashboard');
const appDist = join(appRoot, 'dist');
const bundleDir = join(packageRoot, 'dashboard-ui');

const log = (msg) => {
	// eslint-disable-next-line no-console
	console.log(`[build:dashboard-ui] ${msg}`);
};

const run = (command, args, cwd) =>
	execFileSync(command, args, { cwd, stdio: 'inherit', encoding: 'utf8' });

// 1. Export the GraphQL SDL the frontend's gql.tada typegen depends on.
log('exporting GraphQL schema → apps/devstack-dashboard/schema.graphql');
run(
	process.execPath,
	['--experimental-strip-types', join(packageRoot, 'src', 'plugins', 'dashboard', 'print-schema.ts')],
	packageRoot,
);

// 2. Build the React app.
log('building dashboard app (vite build)');
run('pnpm', ['--filter', 'devstack-dashboard-app', 'build'], repoRoot);

if (!existsSync(join(appDist, 'index.html'))) {
	throw new Error(
		`expected built app at ${appDist}/index.html after vite build, but it is missing`,
	);
}

// 3. Copy the built dist/ into the package's shipped bundle dir.
log(`copying ${appDist} → ${bundleDir}`);
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(appDist, bundleDir, { recursive: true });

log('done');
