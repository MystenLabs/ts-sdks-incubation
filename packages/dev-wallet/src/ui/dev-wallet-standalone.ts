// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { DevWallet } from '../wallet/dev-wallet.js';
import { connectDialogStyles, sharedStyles } from './styles.js';
import type { CoinRecord } from './utils.js';
import { WalletController } from './wallet-controller.js';

@customElement('dev-wallet-standalone')
export class DevWalletStandalone extends LitElement {
	static override styles = [
		sharedStyles,
		connectDialogStyles,
		css`
			:host {
				display: block;
				min-height: 100vh;
				box-sizing: border-box;
				padding: 24px;
				color: var(--dev-wallet-foreground);
				background-color: var(--dev-wallet-bg-0);
				background-image:
					linear-gradient(var(--dev-wallet-border) 1px, transparent 1px),
					linear-gradient(90deg, var(--dev-wallet-border) 1px, transparent 1px);
				background-size: 32px 32px;
				background-position: -1px -1px;
			}

			.standalone-layout {
				width: 100%;
				max-width: 1220px;
				min-height: calc(100vh - 48px);
				margin: 0 auto;
				padding: 24px 0;
				display: grid;
				grid-template-columns: minmax(240px, 1fr) 480px minmax(260px, 1fr);
				gap: 20px;
				align-items: start;
			}

			.rail {
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 16px;
				padding-top: 6px;
			}

			.wordmark {
				display: flex;
				align-items: center;
				gap: 10px;
			}

			.logo-mark {
				width: 28px;
				height: 28px;
				border-radius: 9px;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				color: var(--dev-wallet-primary-foreground);
				background:
					radial-gradient(circle at 35% 25%, rgba(255, 255, 255, 0.5), transparent 24px),
					linear-gradient(135deg, var(--dev-wallet-primary), var(--dev-wallet-teal));
				box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
			}

			.logo-mark svg {
				width: 18px;
				height: 18px;
			}

			.wordmark-title {
				display: flex;
				flex-direction: column;
				line-height: 1.1;
			}

			.wordmark-title strong {
				font-size: 16px;
				font-weight: var(--dev-wallet-font-weight-semibold);
			}

			.version {
				font-family: var(--dev-wallet-font-mono);
				font-size: 9px;
				letter-spacing: 0.12em;
				text-transform: uppercase;
				color: var(--dev-wallet-text-3);
			}

			.rail-section {
				display: flex;
				flex-direction: column;
				gap: 8px;
			}

			.rail-title {
				font-family: var(--dev-wallet-font-mono);
				font-size: 10px;
				font-weight: var(--dev-wallet-font-weight-medium);
				letter-spacing: 0.14em;
				text-transform: uppercase;
				color: var(--dev-wallet-text-3);
			}

			.code {
				margin: 0;
				overflow: auto;
				white-space: pre;
				padding: 10px 12px;
				border-radius: var(--dev-wallet-radius);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-0);
				color: var(--dev-wallet-foreground);
				font-family: var(--dev-wallet-font-mono);
				font-size: 11.5px;
				line-height: 1.55;
			}

			.status-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
			}

			.status-row {
				display: flex;
				align-items: center;
				gap: 8px;
				min-width: 0;
				padding: 8px 10px;
				border-radius: var(--dev-wallet-radius-lg);
				border: 1px solid var(--dev-wallet-border);
				background: color-mix(in srgb, var(--dev-wallet-bg-1) 88%, transparent);
			}

			.status-dot {
				width: 7px;
				height: 7px;
				border-radius: 999px;
				background: var(--dev-wallet-status-connected);
				flex-shrink: 0;
			}

			.status-dot.mute {
				background: var(--dev-wallet-text-3);
			}

			.status-copy {
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 1px;
			}

			.status-copy strong {
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-medium);
			}

			.status-copy span {
				font-family: var(--dev-wallet-font-mono);
				font-size: 10.5px;
				color: var(--dev-wallet-text-3);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.card {
				width: 100%;
				max-width: 480px;
				border-radius: var(--dev-wallet-radius-xl);
				background: var(--dev-wallet-surface);
				border: 1px solid var(--dev-wallet-border-2);
				box-shadow: var(--dev-wallet-shadow-drawer);
				overflow: hidden;
				display: flex;
				flex-direction: column;
				height: min(640px, calc(100vh - 48px));
				min-height: 540px;
			}

			.card-header {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 10px 14px;
				border-bottom: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-1);
			}

			.card-title {
				font-size: 12.5px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				color: var(--dev-wallet-foreground);
			}

			.header-right {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-left: auto;
			}

			.status-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: var(--dev-wallet-status-connected);
			}

			.status-text {
				font-family: var(--dev-wallet-font-mono);
				font-size: 10.5px;
				color: var(--dev-wallet-muted-foreground);
			}

			.card-body {
				overflow-y: auto;
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

			@media (max-width: 1020px) {
				.standalone-layout {
					grid-template-columns: minmax(0, 480px);
					justify-content: center;
				}

				.rail {
					display: none;
				}
			}

			@media (max-width: 560px) {
				:host {
					padding: 12px;
				}

				.standalone-layout {
					min-height: calc(100vh - 24px);
					padding: 0;
				}

				.card {
					height: calc(100vh - 24px);
					min-height: 0;
				}
			}
		`,
	];

	@property({ attribute: false })
	wallet: DevWallet | null = null;

	/** When set, the settings tab shows a bookmarklet section pointing to this origin. */
	@property({ type: String })
	bookmarkletOrigin = '';

	/** Optional pre-seeded coin metadata. Pass the generated `coins`
	 *  constant from devstack codegen to skip per-coin RPC fetches in the
	 *  balances list and signing modal. */
	@property({ attribute: false })
	coins: CoinRecord | null = null;

	#ctrl = new WalletController(this);

	override willUpdate(changedProperties: Map<string, unknown>) {
		if (changedProperties.has('wallet')) {
			this.#ctrl.wallet = this.wallet;
		}
		if (changedProperties.has('bookmarkletOrigin')) {
			this.#ctrl.bookmarkletOrigin = this.bookmarkletOrigin;
		}
		if (changedProperties.has('coins')) {
			this.#ctrl.coins = this.coins;
		}
	}

	override updated() {
		const dialog = this.shadowRoot?.querySelector<HTMLDialogElement>('.connect-dialog');
		if (this.#ctrl.pendingConnect && dialog && !dialog.open) {
			dialog.showModal();
		} else if (!this.#ctrl.pendingConnect && dialog?.open) {
			dialog.close();
		}
	}

	override render() {
		return html`
			<div class="standalone-layout">
				<aside class="rail">${this.#renderLeftRail()}</aside>
				<div class="card" part="card">
					<div class="card-header">
						<span class="logo-mark">${this.#walletIcon}</span>
						<span class="wordmark-title">
							<span class="card-title">${this.wallet?.name ?? 'Dev Wallet'}</span>
							<span class="version">v0.1.0</span>
						</span>
						<div class="header-right">
							${this.#ctrl.renderNetworkBadge()}
							<span class="status-dot"></span>
							<span class="status-text">Running</span>
						</div>
					</div>
					${this.#ctrl.renderTabBar()}
					<div class="card-body">${this.#ctrl.renderTabContent()}</div>
				</div>
				<aside class="rail">${this.#renderRightRail()}</aside>
			</div>
			${this.#ctrl.renderSigningModal()} ${this.#ctrl.renderConnectPicker()}
		`;
	}

	#renderLeftRail() {
		const origin = this.bookmarkletOrigin || globalThis.location?.origin || 'http://localhost:5174';
		const quickStart = `npx @mysten-incubation/dev-wallet serve\n${origin}`;
		const clientSnippet = `createDAppKit({
  walletInitializers: [
    devWalletClientInitializer({
      origin: '${origin}'
    })
  ]
})`;
		const embeddingSnippet = `createDAppKit({
  networks: ['devnet'],
  walletInitializers: [
    devWalletInitializer({
      adapters: [
        new WebCryptoSignerAdapter()
      ],
      autoConnect: true,
      mountUI: true
    })
  ]
})`;
		return html`
			<div class="wordmark">
				<span class="logo-mark">${this.#walletIcon}</span>
				<span class="wordmark-title">
					<strong>Dev Wallet</strong>
					<span class="version">v0.1.0</span>
				</span>
			</div>
			<div class="rail-section">
				<div class="rail-title">Quick Start</div>
				<pre class="code">${quickStart}</pre>
			</div>
			<div class="rail-section">
				<div class="rail-title">Embed Wallet</div>
				<pre class="code">${embeddingSnippet}</pre>
			</div>
			<div class="rail-section">
				<div class="rail-title">Standalone Client</div>
				<pre class="code">${clientSnippet}</pre>
			</div>
			<div class="rail-section">
				<div class="rail-title">Bookmarklet Endpoint</div>
				<pre class="code">${origin}/bookmarklet.js</pre>
			</div>
		`;
	}

	#renderRightRail() {
		const activeNetwork = this.wallet?.activeNetwork ?? 'devnet';
		const networkUrl = this.wallet?.networkUrls[activeNetwork] ?? 'client configured by dApp Kit';
		const accountCount = this.wallet?.accounts.length ?? 0;
		const adapterCount = this.wallet?.adapters.length ?? 0;
		const adapterNames =
			this.wallet?.adapters.map((adapter) => adapter.name).join(', ') ?? 'No adapters';
		return html`
			<div class="rail-section">
				<div class="rail-title">Wallet Status</div>
				<div class="status-list">
					<div class="status-row">
						<span class="status-dot"></span>
						<span class="status-copy">
							<strong>Network: ${activeNetwork}</strong>
							<span>${networkUrl}</span>
						</span>
					</div>
					<div class="status-row">
						<span class="status-dot mute"></span>
						<span class="status-copy">
							<strong>${accountCount} account(s)</strong>
							<span>${adapterCount} adapter(s): ${adapterNames}</span>
						</span>
					</div>
				</div>
			</div>
		`;
	}

	get #walletIcon() {
		return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
			<rect x="2" y="6" width="20" height="14" rx="2.5" />
			<path d="M2 10h20" />
			<rect x="15" y="12" width="5" height="4" rx="1" />
			<circle cx="17.5" cy="14" r="0.5" fill="currentColor" stroke="none" />
		</svg>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-standalone': DevWalletStandalone;
	}
}
