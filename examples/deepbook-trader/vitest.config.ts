import { defineConfig } from 'vitest/config';
import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';

export default defineConfig({
	plugins: [devstackVitePlugin()],
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
