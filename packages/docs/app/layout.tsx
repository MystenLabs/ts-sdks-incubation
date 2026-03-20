// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
import './global.css';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

export const metadata: Metadata = {
	title: {
		template: '%s | Mysten Incubation Docs',
		default: 'Mysten Incubation Docs',
	},
	description:
		'Documentation for @mysten-incubation TypeScript packages for the Sui blockchain ecosystem.',
};

const inter = Inter({
	subsets: ['latin'],
});

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={inter.className} suppressHydrationWarning>
			<body className="flex flex-col min-h-screen">
				<RootProvider>{children}</RootProvider>
			</body>
		</html>
	);
}
