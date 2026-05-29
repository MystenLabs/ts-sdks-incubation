import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';
import type { StatusToken } from '../lib/derive.ts';

/** A selectable option: a bare string, or an object with an optional dot token. */
export type MultiSelectOption = string | { value: string; label: string; token?: StatusToken };

export interface MultiSelectProps {
	/** Button label shown alongside the count badge. */
	readonly label: string;
	/** Optional leading icon on the trigger button. */
	readonly icon?: IconName;
	/** The available options (string shorthand or `{ value, label, token? }`). */
	readonly options: ReadonlyArray<MultiSelectOption>;
	/** Currently-selected option values. */
	readonly selected: ReadonlyArray<string>;
	/** Toggle handler for a single option value. */
	readonly onToggle: (value: string) => void;
	/** Which edge the dropdown aligns to. Defaults to `left`. */
	readonly align?: 'left' | 'right';
}

/**
 * Faceted multi-select filter: a button revealing an outside-click-dismissable
 * dropdown of checkable options, each optionally prefixed by a semantic dot. A
 * count badge surfaces the active selection size.
 */
export const MultiSelect = ({
	label,
	icon,
	options,
	selected,
	onToggle,
	align = 'left',
}: MultiSelectProps) => {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const h = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('mousedown', h);
		return () => document.removeEventListener('mousedown', h);
	}, []);
	const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
	const count = selected.length;
	return (
		<div ref={ref} className="relative">
			<button
				className="btn btn-sm"
				onClick={() => setOpen((o) => !o)}
				style={count ? { borderColor: 'var(--accent-line)', color: 'var(--tx-hi)' } : undefined}
			>
				{icon && <Icon name={icon} size={13} />}
				{label}
				{count > 0 && (
					<span
						className="badge"
						style={{ height: 16, fontSize: 10, padding: '0 6px', color: 'var(--accent)' }}
					>
						{count}
					</span>
				)}
				<Icon name="chevD" size={12} />
			</button>
			{open && (
				<div
					className="panel absolute z-30 min-w-[180px] p-[6px] max-h-[320px] overflow-y-auto"
					style={{ top: 'calc(100% + 6px)', [align]: 0, boxShadow: 'var(--sh-pop)' }}
				>
					{opts.map((o) => {
						const on = selected.includes(o.value);
						return (
							<button
								key={o.value}
								className="flex items-center justify-between w-full px-[8px] py-[6px] rounded-[6px] bg-transparent border-none text-[12.5px] cursor-pointer gap-[8px] hover:bg-hover"
								onClick={() => onToggle(o.value)}
							>
								<span className="flex items-center gap-[7px]">
									{'token' in o && o.token && <span className={`dot dot-${o.token}`} />}
									<span style={{ color: on ? 'var(--tx-hi)' : 'var(--tx-mid)' }}>{o.label}</span>
								</span>
								{on && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
};
