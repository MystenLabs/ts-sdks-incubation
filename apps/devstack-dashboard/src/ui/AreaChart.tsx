import { useId } from 'react';
import {
	ResponsiveContainer,
	AreaChart as RArea,
	Area,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
} from 'recharts';
import { CHART_TOOLTIP } from './chartTooltip.tsx';

/** A bare numeric series, or rows carrying a `value` plus arbitrary x fields. */
export type AreaChartData =
	| ReadonlyArray<number>
	| ReadonlyArray<{ value: number; [key: string]: number }>;

export interface AreaChartProps {
	/** Series values, as numbers or objects carrying `value` (+ optional x fields). */
	readonly data: AreaChartData;
	/** Stroke/fill color — typically a `var(--viz-N)` token. Defaults to `--viz-1`. */
	readonly color?: string;
	/** Container height in px. Defaults to 120. */
	readonly height?: number;
	/** Render the horizontal grid. Defaults to true. */
	readonly grid?: boolean;
	/** Render X/Y axes (also tightens left margin). Defaults to false. */
	readonly axis?: boolean;
	/** Render the hover tooltip. Defaults to true. */
	readonly tooltip?: boolean;
	/** Datum key used for the X axis. Defaults to `i` (synthetic index). */
	readonly xKey?: string;
	/** Extra classes appended to the wrapper. */
	readonly className?: string;
}

/** Normalize numbers / `{ value, ... }` rows into Recharts rows keyed by `v`. */
const toData = (arr: AreaChartData): Array<{ i: number; v: number; [key: string]: number }> =>
	arr.map((v, i) => (typeof v === 'number' ? { i, v } : { i, ...v, v: v.value }));

/**
 * Full-width area chart with a gradient fill and optional grid, axes, and
 * hover tooltip. Defaults to a clean, axis-less mini chart; flip `axis` on for
 * a labeled, full-detail view.
 */
export const AreaChart = ({
	data,
	color = 'var(--viz-1)',
	height = 120,
	grid = true,
	axis = false,
	tooltip = true,
	xKey = 'i',
	className = '',
}: AreaChartProps) => {
	const id = useId().replace(/:/g, '');
	const d = toData(data);
	return (
		<div className={className} style={{ width: '100%', height }}>
			<ResponsiveContainer width="100%" height="100%">
				<RArea data={d} margin={{ top: 6, right: 6, bottom: axis ? 2 : 6, left: axis ? -16 : 6 }}>
					<defs>
						<linearGradient id={`ar${id}`} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor={color} stopOpacity={0.3} />
							<stop offset="100%" stopColor={color} stopOpacity={0} />
						</linearGradient>
					</defs>
					{grid && <CartesianGrid stroke="var(--viz-grid)" vertical={false} />}
					{axis && (
						<XAxis
							dataKey={xKey}
							tick={{ fill: 'var(--tx-lo)', fontSize: 10 }}
							axisLine={false}
							tickLine={false}
						/>
					)}
					{axis && (
						<YAxis
							tick={{ fill: 'var(--tx-lo)', fontSize: 10 }}
							axisLine={false}
							tickLine={false}
							width={36}
						/>
					)}
					{tooltip && <Tooltip {...CHART_TOOLTIP} />}
					<Area
						dataKey="v"
						stroke={color}
						strokeWidth={2}
						fill={`url(#ar${id})`}
						type="monotone"
						isAnimationActive={false}
						dot={false}
					/>
				</RArea>
			</ResponsiveContainer>
		</div>
	);
};
