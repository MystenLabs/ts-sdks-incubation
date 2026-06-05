// Barrel for the dashboard's shared component atoms. Components consume the
// canonical `lib/` data/logic layer (format, derive, types) — they hold no
// domain logic of their own.

export { useCopy } from './useCopy.ts';
export { Icon, type IconName, type IconProps } from './icons.tsx';
export { Dot, type DotProps } from './Dot.tsx';
export { StatusBadge, type StatusBadgeProps, tokenColor } from './StatusBadge.tsx';
export { CopyChip, type CopyChipProps } from './CopyChip.tsx';
export { AddressChip, type AddressChipProps } from './AddressChip.tsx';
export { EndpointLink, type EndpointLinkProps } from './EndpointLink.tsx';
export { CoinAmount, type CoinAmountProps } from './CoinAmount.tsx';
export { Kpi, type KpiProps } from './Kpi.tsx';
export { SectionHead, type SectionHeadProps } from './SectionHead.tsx';
export { EmptyState, type EmptyStateProps } from './EmptyState.tsx';
export { LevelPill, type LevelPillProps } from './LevelPill.tsx';
export { Badge, type BadgeProps } from './Badge.tsx';
export { Button, type ButtonProps } from './Button.tsx';
export { IconButton, type IconButtonProps } from './IconButton.tsx';
export {
	Field,
	type FieldProps,
	Input,
	Select,
	TextInput,
	type TextInputProps,
	NumberInput,
	type NumberInputProps,
} from './Field.tsx';
export { Segmented, type SegmentedOption, type SegmentedProps } from './Segmented.tsx';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.tsx';
export { ToastViewport, type ToastViewportProps } from './ToastViewport.tsx';

// Presentational primitives formalized from the design handoff (surfaces,
// tables, key/value rows, meters, disclosure, JSON, error + funding cells).
export { Panel, type PanelProps } from './Panel.tsx';
export { PanelHeader, type PanelHeaderProps } from './PanelHeader.tsx';
export { DataTable, type DataTableProps, type Column } from './DataTable.tsx';
export { DefList, type DefListProps } from './DefList.tsx';
export { DefRow, type DefRowProps } from './DefRow.tsx';
export { Meter, type MeterProps } from './Meter.tsx';
export { Collapsible, type CollapsibleProps } from './Collapsible.tsx';
export { JsonTree, type JsonTreeProps } from './JsonTree.tsx';
export { ErrorPanel, type ErrorPanelProps } from './ErrorPanel.tsx';
export { FundingStatus, type FundingStatusProps } from './FundingStatus.tsx';

// Callout, faceted filter, and identity glyphs from the design handoff.
export { Banner, type BannerProps, type BannerTone } from './Banner.tsx';
export { MultiSelect, type MultiSelectProps, type MultiSelectOption } from './MultiSelect.tsx';
export { CoinIcon, type CoinIconProps } from './CoinIcon.tsx';
export { Identicon, type IdenticonProps } from './Identicon.tsx';

// Recharts-backed charts from the design handoff, sharing a token-aware tooltip.
export { CHART_TOOLTIP } from './chartTooltip.tsx';
export { Sparkline, type SparklineProps, type SparklineData } from './Sparkline.tsx';
export { AreaChart, type AreaChartProps, type AreaChartData } from './AreaChart.tsx';
export { BarChart, type BarChartProps, type BarChartData } from './BarChart.tsx';
export { DepthChart, type DepthChartProps, type DepthLevel } from './DepthChart.tsx';

// Extra utility components from the design handoff (pagination, load-more, code).
export { Pagination, type PaginationProps } from './Pagination.tsx';
export { LoadMore, type LoadMoreProps } from './LoadMore.tsx';
export { CodeBlock, type CodeBlockProps } from './CodeBlock.tsx';

// Explorer/detail + form atoms from the design handoff (tx effects, breadcrumbs,
// tooltip, skeletons, slider, switch).
export {
	TxEffectsView,
	type TxEffectsViewProps,
	type TxEffects,
	type TxGas,
	type TxBalanceChange,
	type TxObjectChange,
} from './TxEffectsView.tsx';
export { Breadcrumbs, type BreadcrumbsProps, type BreadcrumbItem } from './Breadcrumbs.tsx';
export { Tooltip, type TooltipProps } from './Tooltip.tsx';
export { Skeleton, type SkeletonProps, SkeletonRows, type SkeletonRowsProps } from './Skeleton.tsx';
export { Slider, type SliderProps } from './Slider.tsx';
export { Switch, type SwitchProps } from './Switch.tsx';

// Re-export the semantic token type for convenience at the component boundary.
export type { StatusToken } from '../lib/derive.ts';
