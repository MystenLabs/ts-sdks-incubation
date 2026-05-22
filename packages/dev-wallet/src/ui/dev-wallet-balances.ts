// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { sectionHeaderStyles, sharedStyles, stateStyles } from './styles.js';
import type { CoinManifestEntry, CoinRecord } from './utils.js';
import {
	formatAddress,
	formatCoinBalance,
	getCoinSymbol,
	indexCoinsByType,
	isSuiCoinType,
	lookupCoinByType,
} from './utils.js';

interface CoinBalance {
	coinType: string;
	symbol: string;
	totalBalance: string;
	decimals: number;
}

@customElement('dev-wallet-balances')
export class DevWalletBalances extends LitElement {
	static override styles = [
		sharedStyles,
		sectionHeaderStyles,
		stateStyles,
		css`
			:host {
				display: block;
			}

			.balance-list {
				display: flex;
				flex-direction: column;
				gap: 2px;
			}

			.balance-item {
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 8px 2px;
				border-radius: var(--dev-wallet-radius);
				background: transparent;
				transition: background 120ms;
			}

			.balance-item:hover {
				background: var(--dev-wallet-bg-hover);
			}

			.balance-main {
				flex: 1;
				min-width: 0;
			}

			.token-icon {
				width: 28px;
				height: 28px;
				border-radius: 50%;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				flex-shrink: 0;
				background: linear-gradient(135deg, var(--dev-wallet-primary), var(--dev-wallet-teal));
				color: #fff;
				font-family: var(--dev-wallet-font-mono);
				font-size: 10px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
			}

			.balance-symbol {
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-medium);
				color: var(--dev-wallet-foreground);
			}

			.balance-name {
				font-size: 11px;
				color: var(--dev-wallet-text-3);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.balance-amount-stack {
				display: flex;
				flex-direction: column;
				align-items: flex-end;
				gap: 1px;
				font-size: 12px;
				color: var(--dev-wallet-foreground);
				font-family: var(--dev-wallet-font-mono);
				font-variant-numeric: tabular-nums;
			}

			.balance-amount-symbol {
				font-size: 10.5px;
				color: var(--dev-wallet-text-3);
			}

			.coins-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
			}

			.coins-header .section-header {
				margin-bottom: 0;
			}

			.manage-btn,
			.action-btn {
				height: 30px;
				padding: 0 10px;
				border-radius: var(--dev-wallet-radius);
				border: 1px solid var(--dev-wallet-border);
				background: transparent;
				color: var(--dev-wallet-text-2);
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-medium);
			}

			.manage-btn:hover,
			.action-btn:hover:not(:disabled) {
				background: var(--dev-wallet-bg-hover);
				border-color: var(--dev-wallet-border-strong);
				color: var(--dev-wallet-foreground);
			}

			.manage-btn:disabled {
				opacity: 0.48;
				cursor: not-allowed;
			}

			.balance-hero {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 18px;
				padding: 16px;
				border: 1px solid var(--dev-wallet-border);
				border-radius: var(--dev-wallet-radius-lg);
				background:
					radial-gradient(
						circle at 20% 0%,
						color-mix(in srgb, var(--dev-wallet-primary) 18%, transparent),
						transparent 42%
					),
					var(--dev-wallet-surface);
			}

			.hero-copy {
				min-width: 0;
			}

			.hero-balance {
				display: flex;
				align-items: baseline;
				gap: 8px;
			}

			.hero-value {
				font-size: 30px;
				line-height: 1;
				font-weight: var(--dev-wallet-font-weight-semibold);
				font-variant-numeric: tabular-nums;
				letter-spacing: 0;
			}

			.hero-unit {
				font-family: var(--dev-wallet-font-mono);
				font-size: 13px;
				color: var(--dev-wallet-text-2);
			}

			.hero-note {
				margin-top: 6px;
				font-size: 12px;
				color: var(--dev-wallet-text-3);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.empty-wallet {
				text-align: left;
				padding: 16px;
			}

			.empty-title {
				font-size: 13px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				color: var(--dev-wallet-foreground);
			}

			.empty-copy {
				margin-top: 6px;
				font-size: 12px;
				line-height: 1.45;
				color: var(--dev-wallet-text-2);
			}
		`,
	];

	@property({ type: String })
	address = '';

	@property({ attribute: false })
	client: ClientWithCoreApi | null = null;

	@property({ type: String })
	network = '';

	/** Optional pre-seeded coin metadata — pass the generated `coins`
	 *  constant from devstack codegen (`src/generated/coins.ts`) to skip
	 *  per-coin `getCoinMetadata` RPC waterfalls on UI load. Unknown coin
	 *  types fall through to an RPC fetch as before. */
	@property({ attribute: false })
	coins: CoinRecord | null = null;

	@state()
	private _balances: CoinBalance[] = [];

	@state()
	private _loading = false;

	@state()
	private _error: string | null = null;

	#lastFetchedAddress = '';
	#lastFetchedClient: ClientWithCoreApi | null = null;
	#fetchGeneration = 0;
	#coinIndex: ReadonlyMap<string, CoinManifestEntry> = new Map();
	#lastCoinsRef: CoinRecord | null = null;

	/** Re-fetch balances for the current address/client. */
	refresh() {
		if (this.address && this.client) {
			this.#fetchBalances();
		}
	}

	override willUpdate(changedProperties: Map<string, unknown>) {
		if (changedProperties.has('coins') && this.coins !== this.#lastCoinsRef) {
			this.#coinIndex = indexCoinsByType(this.coins);
			this.#lastCoinsRef = this.coins;
		}
		if (
			(changedProperties.has('address') || changedProperties.has('client')) &&
			this.address &&
			this.client &&
			(this.address !== this.#lastFetchedAddress || this.client !== this.#lastFetchedClient)
		) {
			this.#fetchBalances();
		}
	}

	override render() {
		if (!this.address || !this.client) {
			return nothing;
		}

		const suiBalance = this._balances.find(
			(balance) => isSuiCoinType(balance.coinType) || balance.symbol === 'SUI',
		);
		const formattedSui = suiBalance
			? formatCoinBalance(suiBalance.totalBalance, suiBalance.decimals)
			: '0.0000';
		const networkLabel = this.network || 'active network';

		return html`
			<div class="balance-hero">
				<div class="hero-copy">
					<div class="hero-balance">
						<span class="hero-value">${formattedSui}</span>
						<span class="hero-unit">SUI</span>
					</div>
					<div class="hero-note">${formatAddress(this.address)} · ${networkLabel}</div>
				</div>
				<button class="action-btn" @click=${this.refresh}>Refresh</button>
			</div>
			<div class="coins-header">
				<h3 class="section-header">Coins · ${this._balances.length}</h3>
				<button class="manage-btn" disabled>Manage</button>
			</div>
			${this._loading
				? html`<div class="loading" part="loading" aria-live="polite">Loading...</div>`
				: this._error
					? html`<div class="error-state" part="error-message" aria-live="polite">
							${this._error}
						</div>`
					: this._balances.length === 0
						? html`<div class="empty-state empty-wallet" part="empty-state">
								<div class="empty-title">No balances on ${networkLabel}</div>
								<div class="empty-copy">
									Fund ${formatAddress(this.address)} from your local faucet or devstack seed, then
									refresh balances here.
								</div>
							</div>`
						: html`
								<div class="balance-list" part="balance-list">
									${this._balances.map((balance) => {
										const seed = lookupCoinByType(this.#coinIndex, balance.coinType);
										const name = seed?.displayName ?? balance.symbol;
										return html`
											<div class="balance-item">
												<span class="token-icon">${balance.symbol.slice(0, 3)}</span>
												<span class="balance-main">
													<div class="balance-symbol">${balance.symbol}</div>
													<div class="balance-name">${name}</div>
												</span>
												<span class="balance-amount-stack">
													<span class="balance-amount">
														${formatCoinBalance(balance.totalBalance, balance.decimals)}
													</span>
													<span class="balance-amount-symbol">${balance.symbol}</span>
												</span>
											</div>
										`;
									})}
								</div>
							`}
		`;
	}

	async #fetchBalances() {
		this.#lastFetchedAddress = this.address;
		this.#lastFetchedClient = this.client;
		const generation = ++this.#fetchGeneration;
		this._loading = true;
		this._error = null;

		try {
			const { balances } = await this.client!.core.listBalances({ owner: this.address });

			if (generation !== this.#fetchGeneration) return;

			// Pre-seed metadata from the generated `coins` record. Each
			// balance with a known coinType skips the per-coin RPC entirely;
			// only the (typically empty) remainder hits the network.
			const preseeded = balances.map((b) => lookupCoinByType(this.#coinIndex, b.coinType));
			const metadataResults = await Promise.all(
				balances.map((b, i) => {
					if (preseeded[i] !== undefined) return null;
					return this.client!.core.getCoinMetadata({ coinType: b.coinType }).catch(() => null);
				}),
			);

			if (generation !== this.#fetchGeneration) return;
			this._balances = balances.map((b, i): CoinBalance => {
				const seed = preseeded[i];
				if (seed !== undefined) {
					return {
						coinType: b.coinType,
						symbol: seed.symbol ?? getCoinSymbol(b.coinType),
						totalBalance: b.balance,
						decimals: seed.decimals,
					};
				}
				return {
					coinType: b.coinType,
					symbol: metadataResults[i]?.coinMetadata?.symbol ?? getCoinSymbol(b.coinType),
					totalBalance: b.balance,
					decimals: metadataResults[i]?.coinMetadata?.decimals ?? 0,
				};
			});
		} catch {
			if (generation !== this.#fetchGeneration) return;
			this._error = 'Failed to load balances';
			this._balances = [];
		} finally {
			if (generation === this.#fetchGeneration) {
				this._loading = false;
			}
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-balances': DevWalletBalances;
	}
}
