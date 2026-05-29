import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons.tsx';

const VARIANT_CLASS = {
	default: '',
	primary: 'btn-primary',
	danger: 'btn-danger',
	ghost: 'btn-ghost',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** Visual variant. Defaults to "default". */
	readonly variant?: 'default' | 'primary' | 'danger' | 'ghost';
	/** Small size (`.btn-sm`). */
	readonly sm?: boolean;
	/** Optional leading icon, rendered via `Icon` with the `ic` class. */
	readonly icon?: IconName;
}

/**
 * The `.btn` button primitive with variant + size modifiers and an optional
 * leading icon. Spreads remaining native button props (onClick, disabled, …).
 */
export const Button = ({
	variant = 'default',
	sm,
	icon,
	className = '',
	children,
	...rest
}: ButtonProps) => {
	const classes = ['btn', VARIANT_CLASS[variant], sm ? 'btn-sm' : '', className]
		.filter(Boolean)
		.join(' ');
	return (
		<button className={classes} {...rest}>
			{icon && <Icon name={icon} className="ic" />}
			{children}
		</button>
	);
};
