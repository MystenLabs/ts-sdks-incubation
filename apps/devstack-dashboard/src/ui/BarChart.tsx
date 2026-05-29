import {
	ResponsiveContainer,
	BarChart as RBar,
	Bar,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
} from 'recharts';
import { CHART_TOOLTIP } from './chartTooltip.tsx';

/** A bare numeric series, or rows of `{ label, value }`. */
export type BarChartData = ReadonlyArray<number> | ReadonlyArray<{ label: string; value: number }>;

export interface BarChartProps {
	/** Series values, as numbers or `{ label, value }` objects. */
	readonly data: BarChartData;
	/** Bar fill color — typically a `var(--viz-N)` token. Defaults to `--viz-2`. */
	readonly color?: string;
	/** Container height in px. Defaults to 120. */
	readonly height?: number;
	/** Render the horizontal grid. Defaults to true. */
	readonly grid?: boolean;
	/** Render X/Y axes (also tightens left margin). Defaults to false. */
	readonly axis?: boolean;
	/** Render the hover tooltip. Defaults to true. */
	readonly tooltip?: boolean;
	/** Datum key used for the X axis. Defaults to `label`. */
	readonly xKey?: string;
	/** Extra classes appended to the wrapper. */
	readonly className?: string;
}

/** Normalize numbers / `{ label, value }` rows into Recharts rows keyed by `v`. */
const toData = (arr: BarChartData): Array<{ i: number; label: string | number; v: number }> =>
	arr.map((x, i) =>
		typeof x === 'number' ? { i, label: i, v: x } : { i, label: x.label, v: x.value },
	);

/**
 * Full-width bar chart with rounded top corners and optional grid, axes, and
 * hover tooltip (whose cursor highlights the hovered band). Defaults to a
 * clean, axis-less mini chart.
 */
export const BarChart = ({
	data,
	color = 'var(--viz-2)',
	height = 120,
	grid = true,
	axis = false,
	tooltip = true,
	xKey = 'label',
	className = '',
}: BarChartProps) => {
	const d = toData(data);
	return (
		<div className={className} style={{ width: '100%', height }}>
			<ResponsiveContainer width="100%" height="100%">
				<RBar data={d} margin={{ top: 6, right: 6, bottom: axis ? 2 : 6, left: axis ? -16 : 6 }}>
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
					{tooltip && <Tooltip {...CHART_TOOLTIP} cursor={{ fill: 'var(--bg-hover)' }} />}
					<Bar dataKey="v" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
				</RBar>
			</ResponsiveContainer>
		</div>
	);
};
