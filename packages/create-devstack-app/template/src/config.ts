// Thin app-level projection of the generated runtime config.
//
// Re-exports the generated `config` (networks + packages + objects) so app
// code has a single stable import site for it.

import { config } from '@generated/config.js';

export { config };

/** Shape of the generated runtime config. The codegen emits only the
 *  `config` value (a `const` literal), so the type is derived from it
 *  here rather than imported. */
export type GeneratedConfig = typeof config;
