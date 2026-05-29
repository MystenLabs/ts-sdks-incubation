import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons.tsx';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	/** The icon to render. */
	readonly icon: IconName;
	/** Accessible label, applied to both `aria-label` and `title`. */
	readonly label: string;
}

/**
 * The `.iconbtn` square icon-only button. `label` provides both the accessible
 * name and the hover title. Spreads remaining native button props.
 */
export const IconButton = ({ icon, label, className = '', ...rest }: IconButtonProps) => (
	<button className={`iconbtn ${className}`.trimEnd()} aria-label={label} title={label} {...rest}>
		<Icon name={icon} className="ic" />
	</button>
);
