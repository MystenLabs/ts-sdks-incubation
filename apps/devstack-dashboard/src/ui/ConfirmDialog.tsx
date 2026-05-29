import type { MouseEvent, ReactNode } from 'react';
import { Icon } from './icons.tsx';

export interface ConfirmDialogProps {
	/** Whether the dialog is shown; renders nothing when false. */
	readonly open: boolean;
	/** Dialog heading. */
	readonly title: string;
	/** Body content (prompt text or richer node). */
	readonly body: ReactNode;
	/** When true, uses the danger affordances (alert icon + danger button). */
	readonly danger?: boolean;
	/** Confirm button label. Defaults to "Confirm". */
	readonly confirmLabel?: string;
	/** Fired when the confirm button is pressed. */
	readonly onConfirm: () => void;
	/** Fired on cancel, overlay click, or dismiss. */
	readonly onCancel: () => void;
}

/**
 * Modal confirmation dialog. Clicking the overlay cancels; clicking the panel
 * is contained. Danger mode surfaces an alert icon and a danger-styled confirm.
 */
export const ConfirmDialog = ({
	open,
	title,
	body,
	danger,
	confirmLabel = 'Confirm',
	onConfirm,
	onCancel,
}: ConfirmDialogProps) => {
	if (!open) return null;
	return (
		<div className="overlay" onClick={onCancel}>
			<div
				className="panel"
				onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
				style={{ width: 420, padding: 22, animation: 'popIn .2s ease both' }}
			>
				<div className="row" style={{ gap: 11, marginBottom: 10 }}>
					{danger && (
						<div
							style={{
								width: 32,
								height: 32,
								borderRadius: 8,
								display: 'grid',
								placeItems: 'center',
								background: 'color-mix(in oklab, var(--c-red) 14%, transparent)',
								color: 'var(--c-red)',
								flex: 'none',
							}}
						>
							<Icon name="alert" size={18} />
						</div>
					)}
					<h3 style={{ fontSize: 16 }}>{title}</h3>
				</div>
				<p style={{ color: 'var(--tx-mid)', fontSize: 13, lineHeight: 1.55, margin: '0 0 18px' }}>
					{body}
				</p>
				<div className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
					<button className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};
