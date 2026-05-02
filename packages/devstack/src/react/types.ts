// Type plumbing for the React adapter.

import type { Manifest } from '../runtime/manifest-types.js';

export interface DevstackProviderState {
	manifest: Manifest | null;
}
