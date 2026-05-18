import { describe, expect, it } from 'vitest';
import { defineDevstackVitestConfig } from './define-config.js';

describe('defineDevstackVitestConfig', () => {
	it('emits the canonical test config at minimum invocation', () => {
		const config = defineDevstackVitestConfig();
		expect(config.test?.include).toEqual(['src/**/*.{test,spec}.ts?(x)']);
		expect(config.test?.exclude).toEqual(['e2e/**', 'node_modules', 'dist', '.turbo']);
		expect(config.test?.passWithNoTests).toBe(true);
	});

	it('merges user-supplied test fields over the defaults', () => {
		const config = defineDevstackVitestConfig({ test: { passWithNoTests: false } });
		expect(config.test?.passWithNoTests).toBe(false);
		expect(config.test?.include).toEqual(['src/**/*.{test,spec}.ts?(x)']);
	});
});
