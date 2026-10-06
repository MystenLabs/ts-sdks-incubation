// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement } from 'lit';
import { property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { sharedStyles } from '../styles/index.js';

export class Button extends LitElement {
	static override shadowRootOptions = {
		...LitElement.shadowRootOptions,
		delegatesFocus: true,
	};

	static override styles = [
		sharedStyles,
		css`
			.button {
				transition-property: background-color;
				transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
				transition-duration: 0.15s;
				border-radius: var(--cctp-kit-radius-md);
				font-weight: var(--cctp-kit-font-weight-semibold);
				font-family: var(--cctp-kit-font-button);
				text-transform: var(--cctp-kit-button-text-transform);
				letter-spacing: var(--cctp-kit-button-letter-spacing);
				text-decoration: none;
				outline-style: none;
				display: inline-flex;
				justify-content: center;
				align-items: center;
				gap: 8px;
				padding: 8px 16px;
				height: 40px;
				width: 100%;
				cursor: var(--cctp-kit-cursor-button);
			}

			.button.small {
				height: 32px;
				padding: 4px 12px;
				width: auto;
				font-size: 0.875rem;
			}

			.button:disabled {
				cursor: var(--cctp-kit-cursor-disabled);
				opacity: 0.6;
			}

			.button:focus-visible {
				box-shadow:
					0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent),
					rgba(0, 0, 0, 0.05) 0px 1px 2px 0px;
			}

			.button.primary {
				background-color: var(--cctp-kit-primary);
				color: var(--cctp-kit-primary-foreground);
			}

			.button.primary:hover:not(:disabled) {
				background-color: color-mix(in oklab, var(--cctp-kit-primary) 90%, transparent);
			}

			.button.secondary {
				background-color: var(--cctp-kit-secondary);
				color: var(--cctp-kit-secondary-foreground);
			}

			.button.secondary:hover:not(:disabled) {
				background-color: color-mix(in oklab, var(--cctp-kit-secondary) 80%, transparent);
			}

			.button.ghost {
				background-color: transparent;
				color: var(--cctp-kit-muted-foreground);
			}

			.button.ghost:hover:not(:disabled) {
				background-color: var(--cctp-kit-accent);
				color: var(--cctp-kit-accent-foreground);
			}
		`,
	];

	@property({ type: String })
	variant: 'primary' | 'secondary' | 'ghost' = 'primary';

	@property({ type: Boolean })
	small = false;

	@property({ type: Boolean, reflect: true })
	disabled = false;

	override render() {
		return html`
			<button
				part="trigger"
				type="button"
				?disabled=${this.disabled}
				class=${classMap({ button: true, [this.variant]: true, small: this.small })}
			>
				<slot></slot>
			</button>
		`;
	}
}
