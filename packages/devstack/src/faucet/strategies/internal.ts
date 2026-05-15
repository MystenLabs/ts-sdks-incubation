// Strategy authoring helper. Returns its argument unchanged — exists
// so plug-in authors get inferred parameter types and TS infers the
// right shape without an explicit annotation at the call site.

import type { FaucetStrategy } from '../service.js';

export const defineStrategy = (s: FaucetStrategy): FaucetStrategy => s;
