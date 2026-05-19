// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { dropdownItemStyles, sharedStyles } from './styles.js';
import { isForkNetwork, NETWORK_COLORS } from './utils.js';
import './dev-wallet-dropdown.js';

@customElement('dev-wallet-network-badge')
export class DevWalletNetworkBadge extends LitElement {
	static override styles = [
		sharedStyles,
		dropdownItemStyles,
		css`
			:host {
				display: inline-block;
			}

			.badge {
				display: flex;
				align-items: center;
				gap: 4px;
				padding: 3px 8px;
				border-radius: 999px;
				font-size: 11px;
				font-weight: var(--dev-wallet-font-weight-medium);
				color: var(--dev-wallet-foreground);
				background: var(--dev-wallet-secondary);
				cursor: pointer;
				transition: background 0.15s;
			}

			/* Phase 4 P4.17 — amber stripe + fork label when the
			   active network is a *-fork variant. The stripe is
			   diagonal-hatched so it survives dark + light themes
			   without depending on a separate badge background. */
			.badge.fork {
				background-image: repeating-linear-gradient(
					45deg,
					rgba(234, 179, 8, 0.18),
					rgba(234, 179, 8, 0.18) 4px,
					transparent 4px,
					transparent 8px
				);
			}

			.fork-tag {
				color: #92400e;
				font-weight: var(--dev-wallet-font-weight-bold);
				font-size: 10px;
				margin-left: 4px;
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}

			.badge:hover {
				background: var(--dev-wallet-border);
			}

			.dot {
				width: 6px;
				height: 6px;
				border-radius: 50%;
			}

			.chevron {
				width: 10px;
				height: 10px;
				color: var(--dev-wallet-muted-foreground);
			}

			.dropdown-item {
				padding: 8px 12px;
			}
		`,
	];

	@property({ type: String })
	active = '';

	@property({ attribute: false })
	networks: string[] = [];

	@state()
	private _open = false;

	override render() {
		const color = NETWORK_COLORS[this.active] ?? NETWORK_COLORS['localnet'];
		const fork = isForkNetwork(this.active);
		// Phase 4 P4.17 — when `meta.runtime: 'forked'` flows through
		// (codegen emits the network literal as e.g. `'mainnet-fork'`),
		// the badge surfaces an amber-hatched stripe + a `(fork)`
		// label so the user can't mistake the wallet panel for one
		// pointed at real upstream funds.
		const baseLabel = fork ? this.active.replace(/-fork$/, '') : this.active;

		return html`
			<dev-wallet-dropdown .open=${this._open} @close=${() => (this._open = false)}>
				<button
					slot="trigger"
					class=${fork ? 'badge fork' : 'badge'}
					part="trigger"
					aria-expanded=${this._open}
					aria-haspopup="listbox"
					title=${fork ? `sui-fork stack — no real ${baseLabel} funds at risk` : ''}
					@click=${() => (this._open = !this._open)}
				>
					<span class="dot" style="background: ${color}"></span>
					${baseLabel} ${fork ? html`<span class="fork-tag">fork</span>` : ''}
					<svg
						class="chevron"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
					>
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
				<div slot="popover">
					${this.networks.map((network) => {
						const dotColor = NETWORK_COLORS[network] ?? NETWORK_COLORS['localnet'];
						return html`
							<button
								class="dropdown-item"
								aria-selected=${network === this.active}
								@click=${() => this.#select(network)}
							>
								<span class="dot" style="background: ${dotColor}"></span>
								${network}
							</button>
						`;
					})}
				</div>
			</dev-wallet-dropdown>
		`;
	}

	#select(network: string) {
		this._open = false;
		if (network !== this.active) {
			this.dispatchEvent(
				new CustomEvent('network-changed', {
					bubbles: true,
					composed: true,
					detail: { network },
				}),
			);
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-network-badge': DevWalletNetworkBadge;
	}
}
