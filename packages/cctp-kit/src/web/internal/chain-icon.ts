// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, nothing } from 'lit';
import type { ChainDefinition } from '../../chains/types.js';

/** Styles for `renderChainIcon`; include in any element that renders one. */
export const chainIconStyles = css`
	.chain-icon {
		position: relative;
		width: 22px;
		height: 22px;
		border-radius: 999px;
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--cctp-kit-accent);
		color: var(--cctp-kit-accent-foreground);
		font-size: 0.6875rem;
		font-weight: var(--cctp-kit-font-weight-semibold);
		overflow: hidden;
		user-select: none;
	}

	.chain-icon img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
`;

/** A round chain icon that degrades to a monogram if the image is missing or blocked. */
export function renderChainIcon(chain: ChainDefinition) {
	const monogram = chain.name.charAt(0).toUpperCase();
	return html`<span class="chain-icon" aria-hidden="true">
		${monogram}
		${chain.icon
			? html`<img
					src=${chain.icon}
					alt=""
					loading="lazy"
					@error=${(e: Event) => (e.target as HTMLImageElement).remove()}
				/>`
			: nothing}
	</span>`;
}
