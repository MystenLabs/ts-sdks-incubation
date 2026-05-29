import { useId } from 'react';
import { ResponsiveContainer, AreaChart as RArea, Area, LineChart as RLine, Line } from 'recharts';

/** A bare numeric series, or one wrapped in `{ value }` objects. */
export type SparklineData = ReadonlyArray<number> | ReadonlyArray<{ value: number }>;

export interface SparklineProps {
	/** Series values, as numbers or `{ value }` objects. */
	readonly data: SparklineData;
	/** Stroke/fill color — typically a `var(--viz-N)` token. Defaults to `--viz-1`. */
	readonly color?: string;
	/** Container width in px. Defaults to 96. */
	readonly width?: number;
	/** Container height in px. Defaults to 28. */
	readonly height?: number;
	/** `area` (gradient fill) or `line` (stroke only). Defaults to `area`. */
	readonly type?: 'area' | 'line';
	/** Extra classes appended to the wrapper. */
	readonly className?: string;
}

/** Normalize the loose `number | { value }` input into Recharts row objects. */
const toData = (arr: SparklineData): Array<{ i: number; v: number }> =>
	arr.map((v, i) => (typeof v === 'number' ? { i, v } : { i, v: v.value }));

/**
 * Tiny, axis-less trend chart. Renders either a gradient-filled area or a bare
 * line at a fixed footprint — meant for inline cells and KPI sparklines.
 */
export const Sparkline = ({
	data,
	color = 'var(--viz-1)',
	width = 96,
	height = 28,
	type = 'area',
	className = '',
}: SparklineProps) => {
	const id = useId().replace(/:/g, '');
	const d = toData(data);
	return (
		<div className={className} style={{ width, height }}>
			<ResponsiveContainer width="100%" height="100%">
				{type === 'area' ? (
					<RArea data={d} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
						<defs>
							<linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={color} stopOpacity={0.3} />
								<stop offset="100%" stopColor={color} stopOpacity={0} />
							</linearGradient>
						</defs>
						<Area
							dataKey="v"
							stroke={color}
							strokeWidth={1.5}
							fill={`url(#sp${id})`}
							type="monotone"
							isAnimationActive={false}
							dot={false}
						/>
					</RArea>
				) : (
					<RLine data={d} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
						<Line
							dataKey="v"
							stroke={color}
							strokeWidth={1.5}
							type="monotone"
							isAnimationActive={false}
							dot={false}
						/>
					</RLine>
				)}
			</ResponsiveContainer>
		</div>
	);
};
