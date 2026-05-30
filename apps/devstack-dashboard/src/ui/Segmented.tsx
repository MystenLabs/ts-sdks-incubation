export interface SegmentedOption<T extends string> {
	readonly value: T;
	readonly label: string;
}

export interface SegmentedProps<T extends string> {
	/** Selectable options in display order. */
	readonly options: ReadonlyArray<SegmentedOption<T>>;
	/** Currently selected value. */
	readonly value: T;
	/** Fired with the newly selected value. */
	readonly onChange: (value: T) => void;
}

/**
 * Segmented control (a row of mutually-exclusive `.seg` buttons). The active
 * segment gets `.seg-on`. Generic over the option value union.
 */
export const Segmented = <T extends string>({ options, value, onChange }: SegmentedProps<T>) => (
	<div className="segmented">
		{options.map((option) => (
			<button
				key={option.value}
				type="button"
				className={`seg ${option.value === value ? 'seg-on' : ''}`.trimEnd()}
				onClick={() => onChange(option.value)}
			>
				{option.label}
			</button>
		))}
	</div>
);
