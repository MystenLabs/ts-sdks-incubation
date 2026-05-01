import type { ReactNode } from 'react';

// FRICTION: byte-for-byte duplicate of examples/token-studio/src/components/Card.tsx.
// Two copies = extract trigger. Phase 2: shared @mysten-incubation/ui (or similar).
export function Card({
	title,
	subtitle,
	children,
	right,
}: {
	title: string;
	subtitle?: string;
	children: ReactNode;
	right?: ReactNode;
}) {
	return (
		<section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/50 overflow-hidden">
			<header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-neutral-200 dark:border-neutral-800">
				<div>
					<h2 className="text-sm font-semibold leading-tight">{title}</h2>
					{subtitle && <p className="text-xs text-neutral-500 mt-0.5 leading-tight">{subtitle}</p>}
				</div>
				{right}
			</header>
			<div className="px-5 py-4">{children}</div>
		</section>
	);
}
