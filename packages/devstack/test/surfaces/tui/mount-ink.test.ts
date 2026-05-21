import { describe, expect, it } from 'vitest';

import { INK_RENDER_OPTIONS } from '../../../src/surfaces/tui/mount-ink.tsx';

describe('Ink mount options', () => {
	it('keeps Ctrl-C in the command channel and lets Ink place console output above the live region', () => {
		expect(INK_RENDER_OPTIONS).toEqual({
			exitOnCtrlC: false,
			patchConsole: true,
		});
	});
});
