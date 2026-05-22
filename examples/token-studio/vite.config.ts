import { defineDevstackViteConfig } from '@mysten-incubation/devstack/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineDevstackViteConfig({ port: 5173, plugins: [react(), tailwindcss()] });
