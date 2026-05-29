export interface SliderProps {
	/** Current numeric value. */
	readonly value: number;
	/** Minimum value. Defaults to `0`. */
	readonly min?: number;
	/** Maximum value. Defaults to `100`. */
	readonly max?: number;
	/** Step increment. Defaults to `1`. */
	readonly step?: number;
	/** Change handler receiving the new numeric value. */
	readonly onChange?: (value: number) => void;
	/** Optional mono suffix shown after the value (e.g. "bps"). */
	readonly suffix?: string;
	/** Track width in px. Defaults to `140`. */
	readonly width?: number;
}

/**
 * Range slider with a trailing monospace value readout. Used by the DeepBook
 * market-maker spread control.
 */
export const Slider = ({
	value,
	min = 0,
	max = 100,
	step = 1,
	onChange,
	suffix,
	width = 140,
}: SliderProps) => (
	<span className="row" style={{ gap: 10 }}>
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={value}
			onChange={(e) => onChange?.(+e.target.value)}
			style={{ width, accentColor: 'var(--accent)' }}
		/>
		<span className="mono tnum" style={{ fontSize: 12.5, minWidth: 44 }}>
			{value}
			{suffix ? ` ${suffix}` : ''}
		</span>
	</span>
);
