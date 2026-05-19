import { type ReactNode, useId } from 'react';

/** Form-row primitive: small uppercase label + caller-rendered control,
 *  wired together by a generated id. */
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
