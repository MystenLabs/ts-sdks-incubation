// Toast state + context (logic only). The visual stack is rendered by the
// presentational `ui/ToastViewport`; this provider owns the queue, auto-dismiss
// timers, and the `useToast()` firing API. Dependency-free.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { ToastViewport } from '../ui/ToastViewport.tsx';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
	readonly id: number;
	readonly kind: ToastKind;
	readonly message: string;
}

export interface ToastApi {
	readonly toast: (kind: ToastKind, message: string) => void;
	readonly success: (message: string) => void;
	readonly error: (message: string) => void;
	readonly info: (message: string) => void;
}

const AUTO_DISMISS_MS = 4000;

// Module-level monotonic id — no Date.now collisions.
let nextId = 1;

const ToastContext = createContext<ToastApi | null>(null);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
	const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
	// Track pending timers so we can clear them on unmount.
	const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

	const dismiss = useCallback((id: number) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.current.delete(id);
		}
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	const toast = useCallback(
		(kind: ToastKind, message: string) => {
			const id = nextId++;
			setToasts((prev) => [...prev, { id, kind, message }]);
			const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
			timers.current.set(id, timer);
		},
		[dismiss],
	);

	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
		};
	}, []);

	const api = useMemo<ToastApi>(
		() => ({
			toast,
			success: (message: string) => toast('success', message),
			error: (message: string) => toast('error', message),
			info: (message: string) => toast('info', message),
		}),
		[toast],
	);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<ToastViewport toasts={toasts} onDismiss={dismiss} />
		</ToastContext.Provider>
	);
};

export const useToast = (): ToastApi => {
	const api = useContext(ToastContext);
	if (!api) throw new Error('useToast must be used within a ToastProvider');
	return api;
};
