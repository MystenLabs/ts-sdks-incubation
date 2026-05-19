// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { sectionHeaderStyles, sharedStyles, stateStyles } from './styles.js';
import type { CoinManifestEntry, CoinRecord } from './utils.js';
import { formatCoinBalance, getCoinSymbol, indexCoinsByType, lookupCoinByType } from './utils.js';

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
				gap: 4px;
			}

			.balance-item {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 10px 12px;
				border-radius: var(--dev-wallet-radius-sm);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-secondary);
			}

			.balance-symbol {
				font-size: 14px;
				font-weight: var(--dev-wallet-font-weight-medium);
				color: var(--dev-wallet-foreground);
			}

			.balance-amount {
				font-size: 14px;
				color: var(--dev-wallet-foreground);
				font-family: var(--dev-wallet-font-mono);
			}
		`,
	];

	@property({ type: String })
	address = '';

	@property({ attribute: false })
	client: ClientWithCoreApi | null = null;

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

		return html`
			<h3 class="section-header">Balances</h3>
			${this._loading
				? html`<div class="loading" part="loading" aria-live="polite">Loading...</div>`
				: this._error
					? html`<div class="error-state" part="error-message" aria-live="polite">
							${this._error}
						</div>`
					: this._balances.length === 0
						? html`<div class="empty-state" part="empty-state">No balances</div>`
						: html`
								<div class="balance-list" part="balance-list">
									${this._balances.map(
										(balance) => html`
											<div class="balance-item">
												<span class="balance-symbol">${balance.symbol}</span>
												<span class="balance-amount"
													>${formatCoinBalance(balance.totalBalance, balance.decimals)}</span
												>
											</div>
										`,
									)}
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
