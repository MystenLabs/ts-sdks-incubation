// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { PendingSigningRequest } from '../wallet/dev-wallet.js';
import { sharedStyles } from './styles.js';
import { emitEvent } from './utils.js';
import './dev-wallet-signing.js';

/**
 * A centered modal overlay for signing requests.
 *
 * Renders a backdrop and centered dialog containing the
 * `<dev-wallet-signing>` component. Dispatches `approve` and
 * `reject` events to the parent.
 */
@customElement('dev-wallet-signing-modal')
export class DevWalletSigningModal extends LitElement {
	static override styles = [
		sharedStyles,
		css`
			:host {
				display: block;
			}

			dialog {
				width: 360px;
				max-width: calc(100vw - 32px);
				max-height: min(600px, 80vh);
				border-radius: var(--dev-wallet-radius-xl);
				background: var(--dev-wallet-background);
				border: 1px solid var(--dev-wallet-border);
				box-shadow: var(--dev-wallet-shadow-lg);
				overflow: hidden;
				display: flex;
				flex-direction: column;
				padding: 0;
				color: inherit;
			}

			dialog::backdrop {
				background: color-mix(in oklab, oklch(0 0 0) 50%, transparent);
			}

			.modal-header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 14px 16px;
				border-bottom: 1px solid var(--dev-wallet-border);
			}

			.modal-title {
				font-size: 15px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				color: var(--dev-wallet-foreground);
			}

			.modal-body {
				flex: 1;
				overflow: hidden;
				display: flex;
				flex-direction: column;
			}

			/* Phase 4 P4.19 — footnote rendered when the active account
			   is in fork-mode impersonation. Visually distinct so users
			   don't conflate this with a real signature flow. */
			.fork-footnote {
				padding: 8px 16px;
				background: rgba(234, 179, 8, 0.12);
				border-top: 1px solid rgba(234, 179, 8, 0.35);
				font-size: 11px;
				color: var(--dev-wallet-muted-foreground);
				line-height: 1.4;
			}

			.fork-footnote strong {
				color: #92400e;
				font-weight: var(--dev-wallet-font-weight-semibold);
			}
		`,
	];

	@property({ attribute: false })
	request: PendingSigningRequest | null = null;

	@property({ attribute: false })
	client: ClientWithCoreApi | null = null;

	@property({ type: String })
	walletName = 'Dev Wallet';

	/** Phase 4 P4.19 — when the active account's `source === 'impersonate'`,
	 *  the parent flips this on and the modal renders a footnote
	 *  explaining no real signature will be produced. */
	@property({ type: Boolean })
	impersonation = false;

	#handleDialogCancel = (e: Event) => {
		e.preventDefault();
		emitEvent(this, 'reject');
	};

	override firstUpdated() {
		const dialog = this.shadowRoot?.querySelector('dialog');
		if (dialog && !dialog.open) {
			dialog.showModal();
		}
		dialog?.addEventListener('cancel', this.#handleDialogCancel);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		const dialog = this.shadowRoot?.querySelector('dialog');
		dialog?.removeEventListener('cancel', this.#handleDialogCancel);
		if (dialog?.open) dialog.close();
	}

	override render() {
		if (!this.request) return nothing;

		return html`
			<dialog part="dialog">
				<div class="modal-header">
					<span class="modal-title">${this.walletName}</span>
				</div>
				<div class="modal-body">
					<dev-wallet-signing
						exportparts="approve-button: signing-approve-button, reject-button: signing-reject-button, request-type: signing-request-type, empty-state: signing-empty-state, error-message: signing-error-message, footer: signing-footer"
						.request=${this.request}
						.client=${this.client}
						@approve=${this.#handleApprove}
						@reject=${this.#handleReject}
					></dev-wallet-signing>
				</div>
				${this.impersonation
					? html`<div class="fork-footnote" part="fork-footnote">
							<strong>Fork-only:</strong> this account is in <em>impersonation</em> mode. The fork
							accepts the transaction with an empty signature (no real private key signs it), so it
							would be rejected by mainnet / testnet / devnet validators.
						</div>`
					: nothing}
			</dialog>
		`;
	}

	#handleApprove(e: Event) {
		// Stop the composed signing event from also reaching the parent
		e.stopPropagation();
		emitEvent(this, 'approve');
	}

	#handleReject(e: Event) {
		e.stopPropagation();
		emitEvent(this, 'reject');
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-signing-modal': DevWalletSigningModal;
	}
}
