// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext } from 'react';
import type { ReactNode } from 'react';
import type { CctpKit } from '../core/index.js';

export const CctpKitContext = createContext<CctpKit | null>(null);

export interface CctpKitProviderProps {
	/**
	 * The kit to expose to descendants. Create it once outside React (or memoise it per set of
	 * options) and keep the same instance for the life of the app, exactly like a dapp-kit
	 * instance. Do not destroy it in an effect cleanup: React StrictMode runs cleanups once on
	 * mount, which would permanently disconnect a live kit.
	 */
	kit: CctpKit;
	children?: ReactNode;
}

export function CctpKitProvider({ kit, children }: CctpKitProviderProps) {
	return <CctpKitContext.Provider value={kit}>{children}</CctpKitContext.Provider>;
}
