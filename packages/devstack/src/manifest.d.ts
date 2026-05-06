// Ambient declaration for `virtual:devstack-manifest`. Apps reference
// this once via:
//
//   /// <reference types="@mysten-incubation/devstack/manifest" />
//
// in `src/vite-env.d.ts` (or any `.d.ts` picked up by tsconfig). The
// devstack vite plugin (`@mysten-incubation/devstack/vite`) supplies the
// runtime values; this file gives TypeScript the corresponding types.

declare module 'virtual:devstack-manifest' {
	import type { Manifest } from '@mysten-incubation/devstack';

	export const manifest: Manifest;
}
