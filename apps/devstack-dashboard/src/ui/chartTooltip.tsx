// Shared Recharts <Tooltip> styling, token-aware (mirrors the shadcn chart
// tooltip). Spread onto <Tooltip {...CHART_TOOLTIP} /> by every chart so the
// tooltip surface stays DRY and theme-consistent.
import type { TooltipProps } from 'recharts';

type TooltipStyleProps = Pick<
	TooltipProps<number, string>,
	'contentStyle' | 'labelStyle' | 'itemStyle' | 'cursor'
>;

/** Token-aware style props spread onto every chart's `<Tooltip>`. */
export const CHART_TOOLTIP: TooltipStyleProps = {
	contentStyle: {
		background: 'var(--bg-elev-2)',
		border: '1px solid var(--line-strong)',
		borderRadius: 8,
		fontSize: 12,
		fontFamily: 'var(--font-mono)',
		boxShadow: 'var(--sh-2)',
		padding: '7px 10px',
	},
	labelStyle: { color: 'var(--tx-lo)', fontSize: 11, marginBottom: 2 },
	itemStyle: { color: 'var(--tx-hi)', padding: 0 },
	cursor: { stroke: 'var(--line-strong)', strokeWidth: 1 },
};
