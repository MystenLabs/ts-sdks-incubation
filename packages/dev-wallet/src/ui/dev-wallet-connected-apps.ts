// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ConnectedApp, ConnectedAppsStore } from '../client/connected-apps.js';
import { formatAddress } from './utils.js';

/**
 * Lists the dApps connected to a standalone wallet, with a Disconnect action
 * per app. Disconnecting makes the wallet reject that app's signing requests
 * until it connects again.
 */
@customElement('dev-wallet-connected-apps')
export class DevWalletConnectedApps extends LitElement {
	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			gap: 10px;
			font-size: 12px;
			line-height: 1.5;
			color: var(--dev-wallet-muted-foreground);
		}

		.title {
			margin: 0;
			font-family: var(--dev-wallet-font-mono);
			font-size: 10px;
			font-weight: var(--dev-wallet-font-weight-medium);
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--dev-wallet-text-3);
		}

		.empty {
			margin: 0;
			color: var(--dev-wallet-text-3);
		}

		ul {
			margin: 0;
			padding: 0;
			list-style: none;
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		li {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 8px 8px 8px 10px;
			border-radius: var(--dev-wallet-radius-lg);
			border: 1px solid var(--dev-wallet-border);
			background: var(--dev-wallet-bg-1);
		}

		.info {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
		}

		.name {
			color: var(--dev-wallet-foreground);
			font-weight: var(--dev-wallet-font-weight-medium);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.meta {
			font-family: var(--dev-wallet-font-mono);
			font-size: 10.5px;
			color: var(--dev-wallet-text-3);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.disconnect {
			flex-shrink: 0;
			height: 24px;
			padding: 0 8px;
			border-radius: var(--dev-wallet-radius-xs);
			border: 1px solid var(--dev-wallet-border);
			background: transparent;
			color: var(--dev-wallet-text-2);
			font: inherit;
			font-size: 11px;
			cursor: pointer;
		}

		.disconnect:hover {
			border-color: var(--dev-wallet-destructive);
			color: var(--dev-wallet-destructive);
		}
	`;

	@property({ attribute: false })
	store: ConnectedAppsStore | null = null;

	@state()
	private _apps: ConnectedApp[] = [];

	#unsubscribe: (() => void) | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this.#bind();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has('store') && this.isConnected) this.#bind();
	}

	#bind() {
		this.#unsubscribe?.();
		this.#unsubscribe = this.store?.subscribe(() => this.#load()) ?? null;
		this.#load();
	}

	#load() {
		this._apps = this.store?.list() ?? [];
	}

	#disconnect(origin: string) {
		this.store?.remove(origin);
		this.#load();
	}

	override render() {
		return html`
			<h2 class="title">Connected apps</h2>
			${this._apps.length === 0
				? html`<p class="empty">No apps connected yet.</p>`
				: html`<ul>
						${this._apps.map(
							(app) =>
								html`<li>
									<div class="info">
										<span class="name" title=${app.name}>${app.name || safeHost(app.origin)}</span>
										<span class="meta" title=${app.origin}>${this.#describe(app)}</span>
									</div>
									<button
										class="disconnect"
										type="button"
										aria-label=${`Disconnect ${app.origin}`}
										@click=${() => this.#disconnect(app.origin)}
									>
										Disconnect
									</button>
								</li>`,
						)}
					</ul>`}
		`;
	}

	#describe(app: ConnectedApp) {
		const host = safeHost(app.origin);
		const accounts =
			app.accounts.length === 1
				? formatAddress(app.accounts[0])
				: `${app.accounts.length} accounts`;
		return `${host} · ${accounts}`;
	}
}

function safeHost(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-connected-apps': DevWalletConnectedApps;
	}
}
