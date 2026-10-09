// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { createComponent } from '@lit/react';
import type { ComponentProps } from 'react';
import type { CctpKit } from '../core/index.js';
import { CctpBridge as CctpBridgeElement } from '../web/index.js';
import { useCctpKit } from './hooks.js';

const CctpBridgeComponent = createComponent({
	react: React,
	tagName: 'mysten-cctp-bridge',
	elementClass: CctpBridgeElement,
});

export type CctpBridgeProps = Omit<ComponentProps<typeof CctpBridgeComponent>, 'instance'> & {
	/** Optional explicit kit; otherwise the one from `<CctpKitProvider>` is used. */
	instance?: CctpKit;
};

export function CctpBridge({ instance, ...props }: CctpBridgeProps) {
	const kit = useCctpKit(instance);
	return <CctpBridgeComponent {...props} instance={kit} />;
}
