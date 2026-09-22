// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { DevWallet } from '../wallet/dev-wallet.js';
import type { ConnectedAppsStore } from '../client/connected-apps.js';
import './dev-wallet-connect-guide.js';
import './dev-wallet-connected-apps.js';
import { connectDialogStyles, sharedStyles } from './styles.js';
import type { CoinRecord } from './utils.js';
import { WalletController } from './wallet-controller.js';

const DOCS_URL = 'https://ts-sdks-incubation.vercel.app/dev-wallet';

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

			/* Wallet centered: connect help on the left, connected apps on the right. */
			.standalone-layout {
				width: 100%;
				margin: 0 auto;
				padding: 24px 0;
				display: grid;
				grid-template-columns: minmax(0, 1fr) 480px minmax(0, 1fr);
				gap: 36px;
				align-items: start;
			}

			.card {
				grid-column: 2;
			}

			.rail-left {
				grid-column: 1;
				justify-self: end;
				width: 100%;
			}

			.rail-right {
				grid-column: 3;
			}

			.rail {
				max-width: 348px;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 24px;
				padding-top: 8px;
				font-size: 12px;
				line-height: 1.55;
				color: var(--dev-wallet-muted-foreground);
			}

			.about {
				padding-top: 16px;
				border-top: 1px solid var(--dev-wallet-border);
				display: flex;
				flex-direction: column;
				gap: 6px;
				font-size: 11px;
				color: var(--dev-wallet-text-3);
			}

			.about code {
				font-family: var(--dev-wallet-font-mono);
				font-size: 10.5px;
				color: var(--dev-wallet-muted-foreground);
			}

			.about a {
				color: var(--dev-wallet-muted-foreground);
			}

			.about a:hover {
				color: var(--dev-wallet-foreground);
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

			/* Too narrow to keep the wallet centered with the aside beside it:
			   hide the aside. The Settings tab carries the same connect guide. */
			@media (max-width: 1240px) {
				.standalone-layout {
					grid-template-columns: minmax(0, 480px);
					justify-content: center;
				}

				.card {
					grid-column: 1;
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

	/** Origin this wallet is served from. Drives the bookmarklet, console
	 *  script, and dApp Kit snippet. Defaults to the page's own origin. */
	@property({ type: String })
	walletOrigin = globalThis.location?.origin ?? '';

	/** Optional pre-seeded coin metadata. Pass the generated `coins`
	 *  constant from devstack codegen to skip per-coin RPC fetches in the
	 *  balances list and signing modal. */
	@property({ attribute: false })
	coins: CoinRecord | null = null;

	/** Connected-dApps store shared with the signing popup. Pass the same
	 *  store to `parseWalletRequest` so Disconnect takes effect. */
	@property({ attribute: false })
	connectedApps: ConnectedAppsStore | null = null;

	#ctrl = new WalletController(this);

	override willUpdate(changedProperties: Map<string, unknown>) {
		if (changedProperties.has('wallet')) {
			this.#ctrl.wallet = this.wallet;
		}
		if (changedProperties.has('walletOrigin')) {
			this.#ctrl.walletOrigin = this.walletOrigin;
		}
		if (changedProperties.has('connectedApps')) {
			this.#ctrl.connectedApps = this.connectedApps;
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
				<aside class="rail rail-left">
					<dev-wallet-connect-guide .origin=${this.walletOrigin}></dev-wallet-connect-guide>
					${this.#renderAbout()}
				</aside>
				<main class="card" part="card">
					<div class="card-header">
						<span class="card-title">${this.wallet?.name ?? 'Dev Wallet'}</span>
						<div class="header-right">${this.#ctrl.renderNetworkBadge()}</div>
					</div>
					${this.#ctrl.renderTabBar()}
					<div class="card-body">${this.#ctrl.renderTabContent()}</div>
				</main>
				<aside class="rail rail-right">
					<dev-wallet-connected-apps .store=${this.connectedApps}></dev-wallet-connected-apps>
				</aside>
			</div>
			${this.#ctrl.renderSigningModal()} ${this.#ctrl.renderConnectPicker()}
		`;
	}

	#renderAbout() {
		const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(this.walletOrigin);
		return html`
			<footer class="about">
				<span>Keys are stored in this browser only. Don't hold real funds here.</span>
				${isLocal
					? nothing
					: html`<span>
							For your <code>sui</code> CLI keys or localnet, run it locally:
							<code>npx @mysten-incubation/dev-wallet serve</code>
						</span>`}
				<a href=${DOCS_URL} target="_blank" rel="noopener noreferrer">Documentation ↗</a>
			</footer>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-standalone': DevWalletStandalone;
	}
}
