import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

/** Per-tone token + leading glyph. Ported verbatim from the design handoff. */
const BANNER_TONE = {
	info: { tok: 'cyan', icon: 'dot' },
	warn: { tok: 'yellow', icon: 'alert' },
	success: { tok: 'green', icon: 'check' },
	danger: { tok: 'red', icon: 'alert' },
	neutral: { tok: 'white', icon: 'dot' },
} as const satisfies Record<string, { tok: string; icon: IconName | 'dot' }>;

export type BannerTone = keyof typeof BANNER_TONE;

export interface BannerProps {
	/** Visual tone driving the leading glyph + tinted surface. Defaults to `info`. */
	readonly tone?: BannerTone;
	/** Emphasised title line. */
	readonly title?: ReactNode;
	/** Supporting body copy. */
	readonly children?: ReactNode;
	/** Trailing action node (e.g. a button), rendered before the close affordance. */
	readonly action?: ReactNode;
	/** When provided, renders an `x` close button calling this handler. */
	readonly onClose?: () => void;
	/** Extra classes appended after the base layout classes. */
	readonly className?: string;
}

/**
 * Inline callout / banner. The surface is a tinted, bordered panel keyed off the
 * tone's semantic color token; `info`/`neutral` lead with a `.dot`, the rest
 * with a stroke `Icon`.
 */
export const Banner = ({
	tone = 'info',
	title,
	children,
	action,
	onClose,
	className = '',
}: BannerProps) => {
	const t = BANNER_TONE[tone] ?? BANNER_TONE.info;
	return (
		<div
			className={`flex items-start gap-[11px] rounded-[9px] px-[14px] py-[11px] ${className}`.trimEnd()}
			style={{
				background: `color-mix(in oklab, var(--c-${t.tok}) 7%, var(--bg-panel))`,
				border: `1px solid color-mix(in oklab, var(--c-${t.tok}) 34%, var(--line))`,
			}}
		>
			{t.icon === 'dot' ? (
				<span className={`dot dot-${t.tok} mt-[5px] shrink-0`} />
			) : (
				<Icon
					name={t.icon}
					size={16}
					style={{ color: `var(--c-${t.tok})`, marginTop: 1, flex: 'none' }}
				/>
			)}
			<div className="flex-1 min-w-0">
				{title && <div className="text-[13px] font-medium text-hi">{title}</div>}
				{children && (
					<div className="text-[12.5px] text-mid mt-[2px] leading-[1.5]">{children}</div>
				)}
			</div>
			{action}
			{onClose && (
				<button className="iconbtn shrink-0" style={{ width: 24, height: 24 }} onClick={onClose}>
					<Icon name="x" size={14} />
				</button>
			)}
		</div>
	);
};
