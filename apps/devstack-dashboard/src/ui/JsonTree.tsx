import { useState } from 'react';
import { Icon } from './icons.tsx';

/** Hard recursion cap, guarding against cyclic or pathologically deep data. */
const MAX_DEPTH = 12;

const ADDRESS_RE = /^0x[0-9a-f]{6,}/i;

/** Color token for a primitive (leaf) value. */
const leafToken = (value: unknown): string => {
	if (typeof value === 'string') return ADDRESS_RE.test(value) ? 'magenta' : 'green';
	if (typeof value === 'number') return 'blue';
	if (typeof value === 'boolean') return 'yellow';
	return 'dim'; // null / undefined
};

/** Render a primitive value as its displayed string. */
const leafText = (value: unknown): string => {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `"${value}"`;
	return String(value);
};

interface NodeProps {
	readonly data: unknown;
	readonly name?: string;
	readonly depth: number;
	readonly autoExpandDepth: number;
}

/** One recursive node: a primitive leaf or a collapsible object/array branch. */
const Node = ({ data, name, depth, autoExpandDepth }: NodeProps) => {
	const [open, setOpen] = useState(depth < autoExpandDepth);
	const isBranch = depth < MAX_DEPTH && typeof data === 'object' && data !== null;

	if (!isBranch) {
		const token = leafToken(data);
		return (
			<div className="row" style={{ gap: 7, padding: '1.5px 0', paddingLeft: depth * 15 }}>
				{name != null && (
					<span className="mono" style={{ fontSize: 12, color: 'var(--c-cyan)' }}>
						{name}:
					</span>
				)}
				<span
					className="mono trunc"
					style={{ fontSize: 12, color: `var(--c-${token})`, maxWidth: 360 }}
				>
					{leafText(data)}
				</span>
			</div>
		);
	}

	const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(data)
		? data.map((value, i) => [String(i), value] as const)
		: Object.entries(data as Record<string, unknown>);
	const summary = Array.isArray(data) ? `[${entries.length}]` : `{${entries.length}}`;

	return (
		<div>
			<div
				className="row"
				style={{ gap: 6, padding: '1.5px 0', paddingLeft: depth * 15, cursor: 'pointer' }}
				onClick={() => setOpen((o) => !o)}
			>
				<Icon
					name={open ? 'chevD' : 'chevR'}
					size={13}
					style={{ color: 'var(--tx-dim)', flex: 'none' }}
				/>
				{name != null && (
					<span className="mono" style={{ fontSize: 12, color: 'var(--c-cyan)' }}>
						{name}:
					</span>
				)}
				<span className="mono" style={{ fontSize: 12, color: 'var(--tx-lo)' }}>
					{summary}
				</span>
			</div>
			{open &&
				entries.map(([key, value]) => (
					<Node
						key={key}
						name={key}
						data={value}
						depth={depth + 1}
						autoExpandDepth={autoExpandDepth}
					/>
				))}
		</div>
	);
};

export interface JsonTreeProps {
	/** Arbitrary JSON-like value to render. */
	readonly data: unknown;
	/** Depth (exclusive) below which branches auto-collapse. Defaults to 2. */
	readonly defaultExpanded?: number;
}

/**
 * Recursive, collapsible JSON viewer. Branches auto-expand above
 * `defaultExpanded` depth and collapse below it; recursion is hard-capped at
 * depth 12 (deeper objects render as opaque leaves). Leaf values are colored by
 * type, with `0x…`-prefixed strings highlighted as addresses.
 */
export const JsonTree = ({ data, defaultExpanded = 2 }: JsonTreeProps) => (
	<Node data={data} depth={0} autoExpandDepth={defaultExpanded} />
);
