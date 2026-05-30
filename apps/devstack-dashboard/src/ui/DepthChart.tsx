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

/** A single order-book level: a price and the size resting at it. */
export interface DepthLevel {
	readonly price: number;
	readonly size: number;
}

export interface DepthChartProps {
	/** Bid levels (descending price order, as an order book lists them). */
	readonly bids: ReadonlyArray<DepthLevel>;
	/** Ask levels (ascending price order). */
	readonly asks: ReadonlyArray<DepthLevel>;
	/** Container height in px. Defaults to 160. */
	readonly height?: number;
	/** Extra classes appended to the wrapper. */
	readonly className?: string;
}

/** A plotted depth point: a price with a cumulative bid or ask size. */
interface DepthPoint {
	readonly price: number;
	readonly bid?: number;
	readonly ask?: number;
}

/**
 * Order-book depth chart: cumulative bid/ask sizes rendered as two stepped,
 * gradient-filled areas (green bids, red asks) sharing a price X axis. Bids are
 * cumulated then reversed so depth builds outward from the spread on both sides.
 */
export const DepthChart = ({ bids, asks, height = 160, className = '' }: DepthChartProps) => {
	let bc = 0;
	let ac = 0;
	const bidPts: DepthPoint[] = bids.map((o) => ({ price: o.price, bid: (bc += o.size) }));
	const askPts: DepthPoint[] = asks.map((o) => ({ price: o.price, ask: (ac += o.size) }));
	const data: DepthPoint[] = [...bidPts].reverse().concat(askPts);
	return (
		<div className={className} style={{ width: '100%', height }}>
			<ResponsiveContainer width="100%" height="100%">
				<RArea data={data} margin={{ top: 6, right: 6, bottom: 2, left: -16 }}>
					<defs>
						<linearGradient id="depthBid" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="var(--c-green)" stopOpacity={0.32} />
							<stop offset="100%" stopColor="var(--c-green)" stopOpacity={0.02} />
						</linearGradient>
						<linearGradient id="depthAsk" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="var(--c-red)" stopOpacity={0.32} />
							<stop offset="100%" stopColor="var(--c-red)" stopOpacity={0.02} />
						</linearGradient>
					</defs>
					<CartesianGrid stroke="var(--viz-grid)" vertical={false} />
					<XAxis
						dataKey="price"
						tick={{ fill: 'var(--tx-lo)', fontSize: 10 }}
						axisLine={false}
						tickLine={false}
					/>
					<YAxis
						tick={{ fill: 'var(--tx-lo)', fontSize: 10 }}
						axisLine={false}
						tickLine={false}
						width={36}
					/>
					<Tooltip {...CHART_TOOLTIP} />
					<Area
						dataKey="bid"
						stroke="var(--c-green)"
						strokeWidth={1.5}
						fill="url(#depthBid)"
						type="stepAfter"
						isAnimationActive={false}
						dot={false}
						connectNulls
					/>
					<Area
						dataKey="ask"
						stroke="var(--c-red)"
						strokeWidth={1.5}
						fill="url(#depthAsk)"
						type="stepAfter"
						isAnimationActive={false}
						dot={false}
						connectNulls
					/>
				</RArea>
			</ResponsiveContainer>
		</div>
	);
};
