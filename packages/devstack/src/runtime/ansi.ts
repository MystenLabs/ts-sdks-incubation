// Minimal ANSI styling. Honors `NO_COLOR` (https://no-color.org) to
// disable, `FORCE_COLOR` to force-on regardless of TTY, and otherwise
// gates on stream `isTTY`.
//
// Used by PlainRenderer (when stdout is a TTY) and as a fallback for
// the InkRenderer's `appendLog` path which writes raw lines outside
// the ink reconciler.

interface ColorOptions {
	stream?: NodeJS.WriteStream;
	force?: boolean;
}

export function supportsColor(opts: ColorOptions = {}): boolean {
	if (opts.force) return true;
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
	if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
	const stream = opts.stream ?? process.stdout;
	return Boolean(stream.isTTY);
}

const CODES = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	gray: '\x1b[90m',
	brightBlue: '\x1b[94m',
	brightMagenta: '\x1b[95m',
	brightCyan: '\x1b[96m',
} as const;

export type Color = keyof typeof CODES;

export function makeStyler(enabled: boolean): Record<Color, (s: string) => string> {
	const out = {} as Record<Color, (s: string) => string>;
	for (const k of Object.keys(CODES) as Color[]) {
		out[k] = enabled ? (s: string) => `${CODES[k]}${s}${CODES.reset}` : (s: string) => s;
	}
	return out;
}
