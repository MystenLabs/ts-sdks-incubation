/** djb2 string hash, ported verbatim from the handoff (unsigned 32-bit). */
function hashStr(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h;
}

export interface IdenticonProps {
	/** Seed string (typically an address) driving the deterministic pattern. */
	readonly address: string;
	/** Square pixel size (width === height). Defaults to 28. */
	readonly size?: number;
	/** Extra classes appended after the base wrapper classes. */
	readonly className?: string;
}

/**
 * Deterministic 5×5 symmetric avatar derived from a string hash: hue + pattern
 * are a pure function of `address`, so the same input always yields the same
 * glyph. Cells are mirrored across the vertical axis.
 */
export const Identicon = ({ address = '', size = 28, className = '' }: IdenticonProps) => {
	const h = hashStr(address);
	const hue = h % 360;
	const hue2 = (hue + 40) % 360;
	const cells: Array<[number, number]> = [];
	// 5x5 symmetric pattern
	for (let y = 0; y < 5; y++)
		for (let x = 0; x < 3; x++) {
			const on = ((h >> (y * 3 + x)) & 1) === 1;
			if (on) {
				cells.push([x, y]);
				if (x < 2) cells.push([4 - x, y]);
			}
		}
	const fg = `hsl(${hue} 70% 65%)`;
	return (
		<span
			className={`inline-block rounded-[6px] overflow-hidden shrink-0 ${className}`.trimEnd()}
			style={{ width: size, height: size }}
		>
			<svg viewBox="0 0 5 5" width={size} height={size}>
				<rect width="5" height="5" fill={`hsl(${hue2} 30% 18%)`} />
				{cells.map(([x, y], i) => (
					<rect key={i} x={x} y={y} width="1.02" height="1.02" fill={fg} />
				))}
			</svg>
		</span>
	);
};
