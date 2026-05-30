import tailwindcss from '@tailwindcss/vite';
import { devstackVitePlugin } from '@mysten-incubation/devstack/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [react(), tailwindcss(), devstackVitePlugin()] });
