import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

import { PRIVATE_CONTENT_APP_PORT } from './devstack.shared.ts';

export default defineDevstackViteConfig({
	port: PRIVATE_CONTENT_APP_PORT,
	plugins: [react(), tailwindcss()],
});
