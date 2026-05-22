// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';

import { baseOptions } from '@/app/layout.config';

const packages = [
	{
		title: 'Devstack',
		href: '/devstack',
		description:
			'Compose local Sui networks, accounts, packages, services, generated files, tests, and wallet wiring from one TypeScript config.',
		links: [
			{ label: 'Quickstart', href: '/devstack/quickstart' },
			{ label: 'Services', href: '/devstack/features/services' },
			{ label: 'Testing', href: '/devstack/features/testing-vitest' },
		],
	},
	{
		title: 'Dev Wallet',
		href: '/dev-wallet',
		description:
			'Development-only wallet primitives and UI for local Sui dApp testing, standalone signing, and browser-based accounts.',
		links: [
			{ label: 'Getting started', href: '/dev-wallet/getting-started' },
			{ label: 'Adapters', href: '/dev-wallet/reference/adapters' },
			{ label: 'E2E testing', href: '/dev-wallet/guides/e2e-testing' },
		],
	},
];

export default function Page() {
	return (
		<HomeLayout {...baseOptions}>
			<section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-6 py-16 sm:px-8 lg:px-10 lg:py-24">
				<div className="max-w-3xl">
					<p className="mb-4 text-sm font-medium text-fd-muted-foreground">
						@mysten-incubation TypeScript packages
					</p>
					<h1 className="mb-5 text-4xl font-semibold tracking-normal text-fd-foreground sm:text-5xl">
						Developer tooling for the Sui ecosystem
					</h1>
					<p className="text-lg leading-8 text-fd-muted-foreground">
						This collection hosts prototype packages for local development, testing, wallet
						integration, examples, and docs. Start with the package that matches the workflow you
						are building.
					</p>
				</div>

				<div className="grid gap-5 md:grid-cols-2">
					{packages.map((item) => (
						<section
							key={item.href}
							className="rounded-lg border bg-fd-card p-6 text-fd-card-foreground"
						>
							<div className="flex flex-col gap-5">
								<div>
									<h2 className="text-2xl font-semibold tracking-normal">{item.title}</h2>
									<p className="mt-3 leading-7 text-fd-muted-foreground">{item.description}</p>
								</div>

								<div className="flex flex-wrap gap-2">
									<Link
										href={item.href}
										className="inline-flex min-h-9 items-center rounded-md bg-fd-primary px-3 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/80"
									>
										Overview
									</Link>
									{item.links.map((link) => (
										<Link
											key={link.href}
											href={link.href}
											className="inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
										>
											{link.label}
										</Link>
									))}
								</div>
							</div>
						</section>
					))}
				</div>
			</section>
		</HomeLayout>
	);
}
