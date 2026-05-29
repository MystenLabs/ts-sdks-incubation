/** Glyph + semantic color token per known coin symbol. Ported from the handoff. */
const COIN_GLYPH: Record<string, { g: string; tok: string }> = {
	SUI: { g: '◎', tok: 'cyan' },
	USDC: { g: '$', tok: 'green' },
	DEEP: { g: '◆', tok: 'blue' },
	WAL: { g: '▲', tok: 'magenta' },
	NS: { g: '✦', tok: 'yellow' },
};

export interface CoinIconProps {
	/** Coin symbol; unknown symbols fall back to their first character. */
	readonly symbol: string;
	/** Square pixel size (width === height). Defaults to 22. */
	readonly size?: number;
}

/**
 * Rounded, token-colored coin glyph. Known symbols map to a hand-picked glyph +
 * color; anything else falls back to a neutral first-letter badge.
 */
export const CoinIcon = ({ symbol, size = 22 }: CoinIconProps) => {
	const m = COIN_GLYPH[symbol] ?? { g: (symbol || '?')[0], tok: 'white' };
	return (
		<span
			className="inline-grid place-items-center rounded-full font-mono shrink-0"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.5,
				background: `color-mix(in oklab, var(--c-${m.tok}) 16%, transparent)`,
				color: `var(--c-${m.tok})`,
				border: `1px solid color-mix(in oklab, var(--c-${m.tok}) 30%, transparent)`,
			}}
		>
			{m.g}
		</span>
	);
};
