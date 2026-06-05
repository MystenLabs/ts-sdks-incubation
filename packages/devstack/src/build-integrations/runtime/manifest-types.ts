// Manifest-type bridge — L5 read surface.
//
// ARCHITECTURE.md § Layer table: L5 (build-integrations) does not
// import directly from `substrate/`. Manifest types + the runtime
// decode helpers used by the on-disk read path are re-exported through
// this module so the sibling L5 modules (vitest / playwright preset
// surfaces) consume one canonical path. A future relocation of the
// substrate's manifest module ripples through this file only.

export {
	ManifestEnvelopeSchema,
	type ManifestEnvelope,
	type EndpointEntry,
} from '../../substrate/manifest.ts';

export { decodeUnknownSync, parseJsonTextSync } from '../../substrate/runtime/runtime-decode.ts';
