// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	reactStrictMode: true,
	serverExternalPackages: [
		'ts-morph',
		'typescript',
		'oxc-transform',
		'@shikijs/twoslash',
		'fumadocs-docgen',
	],
	rewrites: () => {
		return [
			{
				source: '/:path*/llms.txt',
				destination: '/llms.txt/:path*',
			},
		];
	},
};

export default withMDX(config);
