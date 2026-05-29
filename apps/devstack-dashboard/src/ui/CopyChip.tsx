import type { MouseEvent } from 'react';
import { useCopy } from './useCopy.ts';
import { Icon, type IconName } from './icons.tsx';

export interface CopyChipProps {
	/** The value written to the clipboard (and used as the tooltip). */
	readonly text: string;
	/** Optional shorter display label; falls back to `text`. */
	readonly display?: string;
	/** Optional leading icon. */
	readonly icon?: IconName;
	/** Render the label in the monospace face (default true). */
	readonly mono?: boolean;
}

/**
 * Click-to-copy chip. Shows a copy glyph that flips to a green check for a
 * moment after copying. Stops click propagation so it can sit inside clickable
 * rows without triggering row navigation.
 */
export const CopyChip = ({ text, display, icon, mono = true }: CopyChipProps) => {
	const [copied, copy] = useCopy();
	const onClick = (e: MouseEvent<HTMLSpanElement>) => {
		e.stopPropagation();
		copy(text);
	};
	return (
		<span
			className="chip"
			onClick={onClick}
			title={text}
			style={mono ? undefined : { fontFamily: 'var(--font-ui)' }}
		>
			{icon && <Icon name={icon} size={13} />}
			<span className="trunc">{display || text}</span>
			<Icon
				name={copied ? 'check' : 'copy'}
				size={12}
				className="copy-ic"
				style={copied ? { opacity: 1, color: 'var(--c-green)' } : undefined}
			/>
		</span>
	);
};
