import { describe, expect, it } from 'vitest';
import { buildRunContainerArgs } from './docker.js';

describe('buildRunContainerArgs', () => {
	it('binds published ports to 127.0.0.1 by default', () => {
		const args = buildRunContainerArgs({
			name: 'sui-localnet',
			image: 'devstack/sui:1',
			ports: [
				{ host: 9000, container: 9000 },
				{ host: 9123, container: 9123 },
			],
		});
		expect(args).toContain('--publish');
		const publishes = args.filter((_, i) => args[i - 1] === '--publish');
		expect(publishes).toEqual(['127.0.0.1:9000:9000', '127.0.0.1:9123:9123']);
	});

	it('omits the 127.0.0.1 prefix when expose: "lan"', () => {
		const args = buildRunContainerArgs({
			name: 'sui-localnet',
			image: 'devstack/sui:1',
			expose: 'lan',
			ports: [{ host: 9000, container: 9000 }],
		});
		const publishes = args.filter((_, i) => args[i - 1] === '--publish');
		expect(publishes).toEqual(['9000:9000']);
	});

	it('explicit expose: "localhost" matches the default', () => {
		const a = buildRunContainerArgs({
			name: 'x',
			image: 'i',
			ports: [{ host: 1, container: 2 }],
		});
		const b = buildRunContainerArgs({
			name: 'x',
			image: 'i',
			expose: 'localhost',
			ports: [{ host: 1, container: 2 }],
		});
		expect(a).toEqual(b);
	});
});
