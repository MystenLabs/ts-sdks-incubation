import type { StructuredError } from '../lib/types.ts';
import { errorSummary } from '../lib/derive.ts';
import { Icon } from './icons.tsx';
import { Collapsible } from './Collapsible.tsx';

export interface ErrorPanelProps {
	/** The structured error to surface. */
	readonly error: StructuredError;
}

/**
 * Red-tinted panel for a {@link StructuredError}: an alert glyph with the error
 * `tag` as a code, the `errorSummary` headline, and — when the error carries a
 * multi-step `chain` — a collapsible block listing the underlying causes.
 */
export const ErrorPanel = ({ error }: ErrorPanelProps) => {
	const headline = errorSummary(error);
	const hasChain = error.chain.length > 0;
	return (
		<div
			className="panel panel-pad"
			style={{
				borderColor: 'color-mix(in oklab, var(--c-red) 36%, var(--line))',
				background: 'color-mix(in oklab, var(--c-red) 7%, var(--bg-panel))',
			}}
		>
			<div className="row" style={{ gap: 8, marginBottom: 6 }}>
				<Icon name="alert" size={15} style={{ color: 'var(--c-red)', flex: 'none' }} />
				{error.tag && (
					<span className="mono" style={{ fontSize: 12, color: 'var(--c-red)', fontWeight: 600 }}>
						{error.tag}
					</span>
				)}
			</div>
			<div style={{ fontSize: 13, color: 'var(--tx-hi)', marginBottom: hasChain ? 10 : 0 }}>
				{headline}
			</div>
			{hasChain && (
				<Collapsible title="Cause chain">
					<div className="col" style={{ gap: 4 }}>
						{error.chain.map((step, i) => (
							<div key={i} className="mono" style={{ fontSize: 12, color: 'var(--tx-mid)' }}>
								↳ {step}
							</div>
						))}
					</div>
				</Collapsible>
			)}
		</div>
	);
};
