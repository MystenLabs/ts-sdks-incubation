import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export interface FieldProps {
	/** Optional eyebrow label rendered above the control. */
	readonly label?: ReactNode;
	/** Optional hint text rendered below the control. */
	readonly hint?: ReactNode;
	/** The wrapped control (e.g. an {@link Input} or {@link Select}). */
	readonly children: ReactNode;
}

/**
 * Labeled control wrapper: an optional eyebrow label, the control, and an
 * optional dim hint, stacked in a column. Pair with {@link Input}/{@link Select}
 * or any control node.
 */
export const Field = ({ label, hint, children }: FieldProps) => (
	<div className="col" style={{ gap: 6 }}>
		{label && <span className="eyebrow">{label}</span>}
		{children}
		{hint && <span style={{ fontSize: 11.5, color: 'var(--tx-lo)' }}>{hint}</span>}
	</div>
);

/**
 * Text input styled with the `.field` class. Merges any incoming `className`
 * and spreads remaining native input props.
 */
export const Input = ({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
	<input className={`field ${className}`.trimEnd()} {...rest} />
);

/**
 * Select control styled with the `.field` class. Merges any incoming
 * `className` and spreads remaining native select props.
 */
export const Select = ({
	className = '',
	children,
	...rest
}: SelectHTMLAttributes<HTMLSelectElement>) => (
	<select className={`field ${className}`.trimEnd()} {...rest}>
		{children}
	</select>
);

export interface TextInputProps
	extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
	/** Current string value. */
	readonly value: string;
	/** Change handler receiving the new string value. */
	readonly onChange?: (value: string) => void;
	/** Render the value in the monospace face. */
	readonly mono?: boolean;
}

/**
 * Single-line text input over the `.field` style with a value/onChange(string)
 * API. Pass `mono` to render the monospace face. Used by search inputs and the
 * Faucet/Mint forms.
 */
export const TextInput = ({ value, onChange, mono, className = '', ...rest }: TextInputProps) => (
	<input
		className={`field${mono ? ' mono' : ''} ${className}`.trimEnd()}
		value={value}
		onChange={(e) => onChange?.(e.target.value)}
		{...rest}
	/>
);

export interface NumberInputProps
	extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
	/** Current numeric value. */
	readonly value: number;
	/** Change handler receiving the coerced numeric value. */
	readonly onChange?: (value: number) => void;
}

/**
 * Numeric input over the monospace `.field` style with a value/onChange(number)
 * API. Coerces the native string event to a number. Used by the Faucet/Mint
 * amount fields.
 */
export const NumberInput = ({ value, onChange, className = '', ...rest }: NumberInputProps) => (
	<input
		type="number"
		className={`field mono ${className}`.trimEnd()}
		value={value}
		onChange={(e) => onChange?.(+e.target.value)}
		{...rest}
	/>
);
