import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../src/substrate/brand.ts';
import { formatStructuredError } from '../../../src/surfaces/tui/error-pane.tsx';

describe('error pane formatting', () => {
	it('keeps startup failure cause chains visible', () => {
		const formatted = formatStructuredError({
			at: Date.parse('2026-05-21T12:00:00.000Z'),
			pluginKey: pluginKey('seal'),
			tag: 'SealBootError',
			summary: 'private-content server failed during startup',
			chain: ['stderr: missing key server config', 'exit code: 1'],
			severity: 'error',
		});

		expect(formatted).toContain('[SealBootError] private-content server failed during startup');
		expect(formatted).toContain('stderr: missing key server config');
		expect(formatted).toContain('exit code: 1');
	});
});
