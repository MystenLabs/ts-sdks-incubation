// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Locate the compiled Swift helper binary.
 *
 * Search order:
 *   1. `APPLE_SIGNER_BINARY` environment variable (absolute path — dev override)
 *   2. In-package universal binary at `../bin/apple-signer` relative to this file
 *      (after `pnpm build`, the binary ships inside the package at `bin/`)
 *   3. Workspace dev build at `../../bin/apple-signer` (when running from `dist/`)
 *
 * Throws on non-darwin platforms, and when no binary is reachable on darwin.
 */
export async function resolveBinaryPath(): Promise<string> {
	const override = process.env.APPLE_SIGNER_BINARY;
	if (override) {
		if (!existsSync(override)) {
			throw new Error(
				`apple-signer: APPLE_SIGNER_BINARY points to a missing file: ${override}`,
			);
		}
		return override;
	}

	if (process.platform !== 'darwin') {
		throw new Error(
			`apple-signer: platform "${process.platform}" is not supported. ` +
				`This package targets macOS only; a sibling package covers other platforms.`,
		);
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, '..', 'bin', 'apple-signer'),
		join(here, '..', '..', 'bin', 'apple-signer'),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		`apple-signer: helper binary not found. Build it from source:\n` +
			`  pnpm --filter @mysten-incubation/apple-signer build:native\n` +
			`Or set APPLE_SIGNER_BINARY to an existing binary path.`,
	);
}
