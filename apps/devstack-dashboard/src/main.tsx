import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import './index.css';

// Restore the persisted theme before first paint.
document.documentElement.dataset.theme = localStorage.getItem('devstack.theme') ?? 'dark';

// One shared react-query client for all browser-direct chain reads (see
// `lib/useChain.ts`). Per-hook `staleTime`/`refetchInterval` tune cadence;
// these defaults just keep retries + focus-refetch sane.
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: 1, refetchOnWindowFocus: false },
	},
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>,
);
