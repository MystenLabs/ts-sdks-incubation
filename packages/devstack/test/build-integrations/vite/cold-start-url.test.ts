// Unit tests for the cold-start URL projection.

import { describe, expect, it } from '@effect/vitest';

import {
	coldStartHost,
	coldStartUrl,
	DEFAULT_ROUTER_PUBLIC_PORT,
} from '../../../src/build-integrations/vite/cold-start-url.ts';

describe('coldStartUrl', () => {
	it('produces the main-stack canonical URL', () => {
		expect(coldStartUrl({ app: 'wallet', stack: 'main' })).toBe(
			`http://dev.wallet.localhost:${DEFAULT_ROUTER_PUBLIC_PORT}/`,
		);
	});

	it('prefixes the stack name for non-main stacks', () => {
		expect(coldStartUrl({ app: 'wallet', stack: 'test' })).toBe(
			`http://test.dev.wallet.localhost:${DEFAULT_ROUTER_PUBLIC_PORT}/`,
		);
	});

	it('honors a custom router port and scheme', () => {
		expect(coldStartUrl({ app: 'demo', stack: 'main', routerPort: 9999, scheme: 'https' })).toBe(
			'https://dev.demo.localhost:9999/',
		);
	});
});

describe('coldStartHost', () => {
	it('returns just the hostname for allowedHosts', () => {
		expect(coldStartHost({ app: 'wallet', stack: 'main' })).toBe('dev.wallet.localhost');
		expect(coldStartHost({ app: 'wallet', stack: 'test' })).toBe('test.dev.wallet.localhost');
	});
});
