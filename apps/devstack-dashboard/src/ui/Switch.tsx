export interface SwitchProps {
	/** Whether the switch is on. */
	readonly checked: boolean;
	/** Change handler receiving the next checked state. */
	readonly onChange?: (checked: boolean) => void;
}

/**
 * Pill toggle switch. The track fills with the accent when on and the knob
 * slides across. Used by the DeepBook market-maker running toggle.
 */
export const Switch = ({ checked, onChange }: SwitchProps) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		onClick={() => onChange?.(!checked)}
		style={{
			width: 40,
			height: 23,
			borderRadius: 999,
			border: '1px solid var(--line-strong)',
			background: checked ? 'var(--accent)' : 'var(--bg-elev-2)',
			position: 'relative',
			transition: '.16s',
			cursor: 'pointer',
			padding: 0,
			flex: 'none',
		}}
	>
		<span
			style={{
				position: 'absolute',
				top: 2,
				left: checked ? 19 : 2,
				width: 17,
				height: 17,
				borderRadius: '50%',
				background: checked ? 'var(--accent-ink)' : 'var(--tx-mid)',
				transition: '.16s',
			}}
		/>
	</button>
);
