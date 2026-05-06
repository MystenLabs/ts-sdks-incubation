import { describe, expect, it } from 'vitest';

import { parseConfigArg, parseNetworkArg, parseStackArg, parseTargetArg } from './args.js';

describe('parseConfigArg', () => {
	it('defaults to ./devstack.config.ts', () => {
		expect(parseConfigArg([])).toBe('./devstack.config.ts');
	});

	it('reads --config <path>', () => {
		expect(parseConfigArg(['--config', './foo.ts'])).toBe('./foo.ts');
	});

	it('reads trailing positional path', () => {
		expect(parseConfigArg(['./foo.ts'])).toBe('./foo.ts');
	});

	it('does not misread other flag values as positional', () => {
		expect(parseConfigArg(['--network', 'testnet', './foo.ts'])).toBe('./foo.ts');
		expect(parseConfigArg(['--target', 'scratch', './foo.ts'])).toBe('./foo.ts');
		expect(parseConfigArg(['--stack', 'feature', './foo.ts'])).toBe('./foo.ts');
	});

	it('--config takes precedence over positional when both set', () => {
		expect(parseConfigArg(['./pos.ts', '--config', './flag.ts'])).toBe('./flag.ts');
	});

	it('ignores bare-token positionals that do not look like a path', () => {
		// `devstack up scratch` (where `scratch` is a stack name) should NOT
		// resolve `scratch` as the config — fall through to the default.
		expect(parseConfigArg(['scratch'])).toBe('./devstack.config.ts');
		expect(parseConfigArg(['main'])).toBe('./devstack.config.ts');
	});

	it('accepts paths that contain `/`', () => {
		expect(parseConfigArg(['./custom/cfg.ts'])).toBe('./custom/cfg.ts');
		expect(parseConfigArg(['/abs/path/cfg.ts'])).toBe('/abs/path/cfg.ts');
		expect(parseConfigArg(['nested/dir/cfg'])).toBe('nested/dir/cfg');
	});

	it('accepts paths ending in known extensions', () => {
		expect(parseConfigArg(['cfg.ts'])).toBe('cfg.ts');
		expect(parseConfigArg(['cfg.js'])).toBe('cfg.js');
		expect(parseConfigArg(['cfg.mts'])).toBe('cfg.mts');
		expect(parseConfigArg(['cfg.mjs'])).toBe('cfg.mjs');
	});
});

describe('parseNetworkArg', () => {
	it('returns undefined when no flag', () => {
		expect(parseNetworkArg([])).toBeUndefined();
	});

	it('reads valid network values', () => {
		expect(parseNetworkArg(['--network', 'localnet'])).toBe('localnet');
		expect(parseNetworkArg(['--network', 'testnet'])).toBe('testnet');
		expect(parseNetworkArg(['--network', 'mainnet'])).toBe('mainnet');
	});

	it('throws on unknown network', () => {
		expect(() => parseNetworkArg(['--network', 'tetnet'])).toThrow(/--network/);
	});

	it('skips other flag values', () => {
		expect(parseNetworkArg(['--config', './foo.ts', '--network', 'testnet'])).toBe('testnet');
	});
});

describe('parseStackArg', () => {
	it('returns undefined when no flag', () => {
		expect(parseStackArg([])).toBeUndefined();
	});

	it('reads --stack <name>', () => {
		expect(parseStackArg(['--stack', 'feature'])).toBe('feature');
	});

	it('returns undefined for empty value', () => {
		expect(parseStackArg(['--stack', ''])).toBeUndefined();
	});
});

describe('parseTargetArg', () => {
	it('returns undefined when no flag', () => {
		expect(parseTargetArg([])).toBeUndefined();
	});

	it('reads --target <value>', () => {
		expect(parseTargetArg(['--target', 'testnet'])).toBe('testnet');
		expect(parseTargetArg(['--target', 'localnet:scratch'])).toBe('localnet:scratch');
	});

	it('returns undefined for empty value', () => {
		expect(parseTargetArg(['--target', ''])).toBeUndefined();
	});

	it('reads --target=value', () => {
		expect(parseTargetArg(['--target=testnet'])).toBe('testnet');
		expect(parseTargetArg(['--target=localnet:scratch'])).toBe('localnet:scratch');
	});
});

describe('--flag=value across all parsers', () => {
	it('parseConfigArg accepts --config=path', () => {
		expect(parseConfigArg(['--config=./foo.ts'])).toBe('./foo.ts');
	});

	it('parseStackArg accepts --stack=name', () => {
		expect(parseStackArg(['--stack=feature'])).toBe('feature');
	});

	it('parseNetworkArg accepts --network=value', () => {
		expect(parseNetworkArg(['--network=testnet'])).toBe('testnet');
	});
});
