import { defineConfig } from 'vitest/config';
import {
	devstackVitestServerConfig,
	devstackVitestTestConfig,
} from '@mysten-incubation/devstack/vitest';

export default defineConfig({
	server: devstackVitestServerConfig(),
	test: devstackVitestTestConfig(),
});
