// Browser-safe subpath — re-exports only the pure helpers safe to
// import from app code running in the browser. The main `.` barrel
// pulls in node-only engine modules (the supervisor, docker bindings,
// the manifest grouper, identity validators that import `node:path` +
// `node:fs`); even though Vite externalizes those node modules, every
// property access on the externalized proxy throws at module-init
// time. The result was that `import { localnetWalrusOptions } from
// '@mysten-incubation/devstack'` from `private-content/src/lib/walrus.ts`
// crashed the browser bundle with "Module 'node:path' has been
// externalized for browser compatibility. Cannot access
// 'node:path.basename' in client code." — surface: blank page, no
// React render.
//
// Apps doing browser-side work should import from this subpath:
//
//     import { localnetWalrusOptions } from '@mysten-incubation/devstack/browser';
//
// Add helpers here only when their entire import-graph stays clear of
// node-only modules. If unsure, check `dist/browser/index.mjs` after a
// build: it must NOT contain any `import "node:*"` lines.

export {
	getWalrusCaptured,
	localnetWalrusOptions,
	type LocalnetWalrusOptions,
	type LocalnetWalrusInputs,
} from '../services/walrus/options.js';
