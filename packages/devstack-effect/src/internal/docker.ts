// Compatibility re-export of the docker slice's public surface so
// existing `import * as Docker from '../internal/docker.js'` consumers
// keep working after the split into `./docker/`. The directory's
// `index.ts` is the canonical home; this shim mirrors its exports.

export * from './docker/index.js';
