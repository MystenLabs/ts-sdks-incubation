import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
import { defineConfig } from 'vitest/config';
import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';

export default defineConfig({
	plugins: [devstackVitePlugin()],
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
