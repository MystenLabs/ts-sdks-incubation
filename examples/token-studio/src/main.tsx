import './index.css';

import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { dAppKit } from './dapp-kit.js';

const queryClient = new QueryClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<DAppKitProvider dAppKit={dAppKit}>
					<App />
			</DAppKitProvider>
		</QueryClientProvider>
	</StrictMode>,
);
