// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ForkRelay } from '../adapters/fork-relay.js';
import type { DevWallet } from '../wallet/dev-wallet.js';
import { connectDialogStyles, sharedStyles } from './styles.js';
import type { CoinRecord } from './utils.js';
import { WalletController } from './wallet-controller.js';

export type DevWalletDockStyle = 'corner-pill' | 'side-tab';

@customElement('dev-wallet-panel')
export class DevWalletPanel extends LitElement {
	static override styles = [
		sharedStyles,
		connectDialogStyles,
		css`
			:host {
				display: block;
				position: fixed;
				inset: 0;
				z-index: 999999;
				font-size: 13px;
				pointer-events: none;
			}

			.trigger {
				position: fixed;
				right: 20px;
				bottom: 20px;
				width: 40px;
				height: 40px;
				border-radius: 999px;
				background: var(--dev-wallet-surface);
				color: var(--dev-wallet-primary);
				border: 1px solid var(--dev-wallet-border-2);
				display: flex;
				align-items: center;
				justify-content: center;
				box-shadow: var(--dev-wallet-shadow-md);
				transition:
					transform 120ms,
					box-shadow 120ms,
					border-color 120ms;
				pointer-events: auto;
				z-index: 2;
			}

			.trigger:hover {
				transform: translateY(-1px);
				border-color: var(--dev-wallet-border-strong);
				box-shadow:
					var(--dev-wallet-shadow-md),
					0 0 0 4px var(--dev-wallet-accent-fade);
			}

			.trigger.side-tab {
				top: 50%;
				right: 0;
				bottom: auto;
				width: 34px;
				height: 88px;
				border-radius: 12px 0 0 12px;
				transform: translateY(-50%);
			}

			.trigger.side-tab:hover {
				transform: translateY(calc(-50% - 1px));
			}

			.trigger svg {
				width: 20px;
				height: 20px;
			}

			.status-dot {
				position: absolute;
				right: 3px;
				bottom: 3px;
				width: 10px;
				height: 10px;
				border-radius: 999px;
				border: 2px solid var(--dev-wallet-surface);
				background: var(--dev-wallet-status-connected);
			}

			.status-dot.notice {
				background: var(--dev-wallet-primary);
				animation: pulse-ring 1.6s ease-out infinite;
			}

			.scrim {
				position: fixed;
				inset: 0;
				background: rgba(2, 6, 14, 0.4);
				pointer-events: auto;
				animation: fadein 160ms ease-out;
			}

			.sidebar {
				position: fixed;
				top: 12px;
				right: 12px;
				bottom: 76px;
				width: 400px;
				max-width: calc(100vw - 24px);
				border-radius: var(--dev-wallet-radius-xl);
				background: var(--dev-wallet-surface);
				border: 1px solid var(--dev-wallet-border-2);
				box-shadow: var(--dev-wallet-shadow-drawer);
				display: flex;
				flex-direction: column;
				overflow: hidden;
				pointer-events: auto;
				animation: slidein-right 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
			}

			.status-strip {
				display: flex;
				align-items: center;
				gap: 8px;
				min-height: 30px;
				padding: 6px 10px 6px 12px;
				border-bottom: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-2);
			}

			.status-strip .host-origin {
				flex: 1;
				min-width: 0;
				font-family: var(--dev-wallet-font-mono);
				font-size: 10.5px;
				color: var(--dev-wallet-text-3);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.sidebar-header {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 10px 14px;
				border-bottom: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-1);
				position: relative;
				z-index: 1;
			}

			.brand {
				display: flex;
				align-items: center;
				gap: 8px;
				min-width: 0;
			}

			.logo-mark {
				width: 20px;
				height: 20px;
				border-radius: 7px;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				color: var(--dev-wallet-primary-foreground);
				background:
					radial-gradient(circle at 35% 25%, rgba(255, 255, 255, 0.5), transparent 22px),
					linear-gradient(135deg, var(--dev-wallet-primary), var(--dev-wallet-teal));
				box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
				flex-shrink: 0;
			}

			.logo-mark svg {
				width: 14px;
				height: 14px;
			}

			.title-stack {
				display: flex;
				flex-direction: column;
				line-height: 1.1;
				min-width: 0;
			}

			.sidebar-title {
				font-size: 12.5px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				color: var(--dev-wallet-foreground);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.version {
				font-family: var(--dev-wallet-font-mono);
				font-size: 9px;
				letter-spacing: 0.12em;
				text-transform: uppercase;
				color: var(--dev-wallet-text-3);
			}

			.header-spacer {
				flex: 1;
				min-width: 8px;
			}

			.close-btn {
				color: var(--dev-wallet-text-3);
				width: 24px;
				height: 24px;
				display: flex;
				align-items: center;
				justify-content: center;
				border-radius: var(--dev-wallet-radius);
				flex-shrink: 0;
			}

			.close-btn:hover {
				background: var(--dev-wallet-bg-hover);
				color: var(--dev-wallet-foreground);
			}

			.close-btn svg {
				width: 14px;
				height: 14px;
			}

			.sidebar-body {
				overflow-y: auto;
				overflow-x: hidden;
				flex: 1;
				min-height: 0;
				background: var(--dev-wallet-bg-0);
			}

			.section {
				padding: 14px;
				border-bottom: 1px solid var(--dev-wallet-border);
			}

			.section:last-child {
				border-bottom: 0;
			}

			@media (max-width: 520px) {
				.sidebar {
					left: 12px;
					width: auto;
				}
			}
		`,
	];

	@property({ attribute: false })
	wallet: DevWallet | null = null;

	/** Optional pre-seeded coin metadata. Pass the generated `coins`
	 *  constant from devstack codegen (`src/generated/coins.ts`) to skip
	 *  per-coin RPC fetches in the balances list and signing modal. */
	@property({ attribute: false })
	coins: CoinRecord | null = null;

	/** Phase 5 Subtopic 6 — fork admin relay. When set, the panel
	 *  surfaces a "Fork" tab that drives advance-clock,
	 *  advance-checkpoint, and impersonation slot management against
	 *  the devstack wallet-app server. Construct from the manifest
	 *  with `createForkRelayFromManifest(manifest)`. */
	@property({ attribute: false })
	forkRelay: ForkRelay | null = null;

	/** Optional upstream label (`'mainnet'`, `'testnet'`, …) sourced
	 *  from `meta.upstream` on the manifest. Falls back to inferring
	 *  from the active network literal when not provided. */
	@property({ type: String })
	forkUpstream = '';

	@property({ type: String, attribute: 'dock-style' })
	dockStyle: DevWalletDockStyle = 'corner-pill';

	@state()
	private _isOpen = false;

	#ctrl = new WalletController(this);
	#hadPendingRequest = false;

	override willUpdate(changedProperties: Map<string, unknown>) {
		if (changedProperties.has('wallet')) {
			this.#ctrl.wallet = this.wallet;
		}
		if (changedProperties.has('coins')) {
			this.#ctrl.coins = this.coins;
		}
		if (changedProperties.has('forkRelay')) {
			this.#ctrl.forkRelay = this.forkRelay;
		}
		if (changedProperties.has('forkUpstream')) {
			this.#ctrl.forkUpstream = this.forkUpstream;
		}
	}

	override updated() {
		// Refresh balances only when transitioning from having a pending request to not
		const hasPending = this.#ctrl.pendingRequest !== null;
		if (this.#hadPendingRequest && !hasPending) {
			this.updateComplete.then(() => {
				this.shadowRoot
					?.querySelector<
						import('./dev-wallet-balances.js').DevWalletBalances
					>('dev-wallet-balances')
					?.refresh();
			});
		}
		this.#hadPendingRequest = hasPending;

		const dialog = this.shadowRoot?.querySelector<HTMLDialogElement>('.connect-dialog');
		if (this.#ctrl.pendingConnect && dialog && !dialog.open) {
			dialog.showModal();
		} else if (!this.#ctrl.pendingConnect && dialog?.open) {
			dialog.close();
		}
	}

	override render() {
		return html`
			${this._isOpen ? this.#renderSidebar() : nothing}
			<button
				class="trigger ${this.dockStyle === 'side-tab' ? 'side-tab' : 'corner-pill'}"
				part="trigger"
				aria-label=${this._isOpen ? 'Close Dev Wallet' : 'Open Dev Wallet'}
				aria-expanded=${this._isOpen}
				@click=${this.#togglePanel}
			>
				${this.#walletIcon}
				<span
					class="status-dot ${this.#ctrl.pendingRequest ? 'notice' : ''}"
					aria-hidden="true"
				></span>
			</button>
			${this.#ctrl.renderSigningModal()} ${this.#ctrl.renderConnectPicker()}
		`;
	}

	#renderSidebar() {
		return html`
			<button class="scrim" aria-label="Close Dev Wallet" @click=${this.#closePanel}></button>
			<div class="sidebar" part="sidebar">
				<div class="status-strip">
					<span class="chip chip-success">connected</span>
					<span class="host-origin">${globalThis.location?.origin ?? 'embedded host'}</span>
					<button
						class="close-btn"
						part="close-button"
						aria-label="Close"
						@click=${this.#closePanel}
					>
						${this.#closeIcon}
					</button>
				</div>
				<div class="sidebar-header">
					<div class="brand">
						<span class="logo-mark">${this.#walletIcon}</span>
						<span class="title-stack">
							<span class="sidebar-title">${this.wallet?.name ?? 'Dev Wallet'}</span>
							<span class="version">v0.1.0</span>
						</span>
					</div>
					<span class="header-spacer"></span>
					${this.#ctrl.renderNetworkBadge()}
				</div>
				${this.#ctrl.renderTabBar()}
				<div class="sidebar-body">${this.#ctrl.renderTabContent()}</div>
			</div>
		`;
	}

	get #walletIcon() {
		return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
			<rect x="2" y="6" width="20" height="14" rx="2.5" />
			<path d="M2 10h20" />
			<rect x="15" y="12" width="5" height="4" rx="1" />
			<circle cx="17.5" cy="14" r="0.5" fill="currentColor" stroke="none" />
		</svg>`;
	}

	get #closeIcon() {
		return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M18 6L6 18" />
			<path d="M6 6l12 12" />
		</svg>`;
	}

	#togglePanel() {
		this._isOpen = !this._isOpen;
		if (this._isOpen) {
			this.#ctrl.syncState();
		}
	}

	#closePanel() {
		this._isOpen = false;
	}

	#handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && this._isOpen) {
			this.#closePanel();
		}
	};

	override connectedCallback() {
		super.connectedCallback();
		window.addEventListener('keydown', this.#handleKeydown);
	}

	override disconnectedCallback() {
		window.removeEventListener('keydown', this.#handleKeydown);
		super.disconnectedCallback();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-panel': DevWalletPanel;
	}
}
