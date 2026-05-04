import { type ReactNode, useId } from 'react';

/** Form-row primitive: small uppercase label + caller-rendered control,
 *  wired together by a generated id. Lifted from 6 form components in
 *  the example apps where the same JSX was duplicated byte-for-byte. */
export function Field({ label, render }: { label: string; render: (id: string) => ReactNode }) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
				{label}
			</label>
			{render(id)}
		</div>
	);
}
