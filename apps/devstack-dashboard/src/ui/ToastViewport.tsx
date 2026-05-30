import type { Toast } from '../lib/toast.tsx';
import { Dot } from './Dot.tsx';

const KIND_TOKEN = { success: 'green', error: 'red', info: 'cyan' } as const;

export interface ToastViewportProps {
	readonly toasts: ReadonlyArray<Toast>;
	readonly onDismiss: (id: number) => void;
}

/** Fixed top-right toast stack (presentational). State lives in `lib/toast`. */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
	return (
		<div className="toast-wrap" role="status" aria-live="polite">
			{toasts.map((t) => (
				<button key={t.id} type="button" className="toast" onClick={() => onDismiss(t.id)}>
					<Dot token={KIND_TOKEN[t.kind]} />
					<span className="grow" style={{ textAlign: 'left', color: 'var(--tx-hi)' }}>
						{t.message}
					</span>
				</button>
			))}
		</div>
	);
}
