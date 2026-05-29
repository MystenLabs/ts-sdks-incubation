import type { CSSProperties } from 'react';

/**
 * Stroke-icon path map (24×24 viewbox, `currentColor` stroke). Each value is
 * one or more `M…`-prefixed subpaths; `Icon` splits on `M` to render multiple
 * `<path>` segments. Ported verbatim from the design handoff.
 */
const ICONS = {
	grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
	layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
	terminal: 'M4 17l6-6-6-6M12 19h8',
	activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
	wallet:
		'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7M16 13h.01',
	drop: 'M12 2.7s6 5.5 6 10.3a6 6 0 0 1-12 0C6 8.2 12 2.7 12 2.7z',
	compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16.2 7.8 14 14l-6.2 2.2L10 10z',
	puzzle: 'M4 7h3a2 2 0 1 0 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 1 0-4z',
	sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
	cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
	copy: 'M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
	check: 'M20 6 9 17l-5-5',
	ext: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
	search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
	refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
	camera:
		'M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
	power: 'M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10',
	trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
	chevR: 'M9 18l6-6-6-6',
	chevD: 'M6 9l6 6 6-6',
	chevL: 'M15 18l-6-6 6-6',
	x: 'M18 6 6 18M6 6l12 12',
	play: 'M5 3l14 9-14 9z',
	pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
	alert:
		'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
	filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
	download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
	cmd: 'M15 6a3 3 0 1 1 3 3h-3zm0 0v12m0-12H9m6 12a3 3 0 1 0 3-3h-3zm-6-6a3 3 0 1 1-3-3v3zm0 0v6m0 0a3 3 0 1 0-3 3v-3zm0 0h6',
	plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
	database:
		'M12 8c5 0 8-1.3 8-3s-3-3-8-3-8 1.3-8 3 3 3 8 3zM4 5v6c0 1.7 3 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3 3 8 3s8-1.3 8-3v-6',
	box: 'M21 8 12 3 3 8m18 0v8l-9 5-9-5V8m18 0-9 5m0 0L3 8m9 5v8',
	coins: 'M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM15 10a6 6 0 1 1-6 9.7',
	arrowR: 'M5 12h14M13 5l7 7-7 7',
	dot: 'M12 12h.01',
	clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
	hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
	zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
} as const;

/** Every available icon name. */
export type IconName = keyof typeof ICONS;

export interface IconProps {
	/** Which glyph to render; unknown names fall back to a small dot. */
	readonly name: IconName;
	/** Square pixel size (width === height). Defaults to 16. */
	readonly size?: number;
	/** Extra classes appended after the base `ic` class. */
	readonly className?: string;
	/** Inline style passthrough (e.g. `{ color: 'var(--c-cyan)' }`). */
	readonly style?: CSSProperties;
}

/**
 * Inline SVG stroke icon. Splits its path data into discrete `<path>` segments
 * so multi-stroke glyphs render correctly, and inherits color via
 * `currentColor`.
 */
export const Icon = ({ name, size = 16, className = '', style }: IconProps) => {
	const d = ICONS[name] ?? ICONS.dot;
	return (
		<svg
			className={'ic ' + className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
		>
			{d
				.split('M')
				.filter(Boolean)
				.map((seg, i) => (
					<path key={i} d={'M' + seg} />
				))}
		</svg>
	);
};
