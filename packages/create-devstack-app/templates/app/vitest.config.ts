import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';
import { defineConfig } from 'vitest/config';

// The vite plugin resolves `@generated/*` to the active stack's codegen
// output; the server/test presets keep the watcher off `.devstack/`.
export default defineConfig({
	plugins: [devstackVitePlugin()],
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
