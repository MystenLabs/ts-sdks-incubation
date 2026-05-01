// Shared module-level manifest reference. The panel custom elements pull
// from here so the dev-wallet's `panels: [{ tagName }]` registration
// stays terse — no prop drilling, no per-panel manifest property.

import type { DevstackManifest } from './types.js';

let active: DevstackManifest | null = null;

export function setActiveManifest(manifest: DevstackManifest | null): void {
	active = manifest;
}

export function getActiveManifest(): DevstackManifest | null {
	return active;
}
