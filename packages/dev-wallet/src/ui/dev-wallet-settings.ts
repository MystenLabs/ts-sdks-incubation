// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReadonlyWalletAccount } from '@mysten/wallet-standard';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { DevWallet } from '../wallet/dev-wallet.js';
import type { SignerAdapter } from '../types.js';
import {
	badgeStyles,
	cardItemStyles,
	formInputStyles,
	iconButtonStyles,
	inlineErrorStyles,
	listContainerStyles,
	monoTruncateStyles,
	sectionHeaderStyles,
	sharedStyles,
} from './styles.js';
import { emitEvent, formatAddress, getErrorMessage, NETWORK_COLORS } from './utils.js';
import './dev-wallet-accounts.js';

@customElement('dev-wallet-settings')
export class DevWalletSettings extends LitElement {
	static override styles = [
		sharedStyles,
		sectionHeaderStyles,
		cardItemStyles,
		listContainerStyles,
		formInputStyles,
		iconButtonStyles,
		badgeStyles,
		inlineErrorStyles,
		monoTruncateStyles,
		css`
			:host {
				display: block;
				padding: 14px;
			}

			.section {
				margin-bottom: 10px;
				padding: 12px;
				border: 1px solid var(--dev-wallet-border);
				border-radius: var(--dev-wallet-radius-lg);
				background: var(--dev-wallet-surface);
			}

			.section:last-child {
				margin-bottom: 0;
			}

			.settings-summary {
				display: grid;
				grid-template-columns: repeat(3, minmax(0, 1fr));
				gap: 8px;
			}

			.summary-cell {
				min-width: 0;
				padding: 10px;
				border-radius: var(--dev-wallet-radius);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-0);
			}

			.summary-label {
				font-family: var(--dev-wallet-font-mono);
				font-size: 9.5px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				color: var(--dev-wallet-text-3);
			}

			.summary-value {
				margin-top: 5px;
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				color: var(--dev-wallet-foreground);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.network-item {
				gap: 8px;
				padding: 9px 10px;
			}

			.network-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				flex-shrink: 0;
			}

			.network-name {
				flex: 1;
				font-size: 13px;
				font-weight: var(--dev-wallet-font-weight-medium);
				font-family: var(--dev-wallet-font-mono);
			}

			.network-info {
				flex: 1;
				min-width: 0;
			}

			.network-url {
				font-size: 10px;
			}

			.network-url-input {
				padding: 3px 6px;
				border-radius: var(--dev-wallet-radius-xs);
				border: 1px solid var(--dev-wallet-primary);
				background: var(--dev-wallet-background);
				font-size: 10px;
				font-family: var(--dev-wallet-font-mono);
			}

			.network-actions {
				display: flex;
				gap: 2px;
				flex-shrink: 0;
			}

			.btn-icon {
				width: 22px;
				height: 22px;
				font-size: 11px;
			}

			.btn-icon-danger:hover {
				color: var(--dev-wallet-destructive);
			}

			.network-active-badge {
				height: 16px;
				display: inline-flex;
				align-items: center;
				padding: 0 5px;
				border-radius: 999px;
				border: 1px solid var(--dev-wallet-border-strong);
				background: var(--dev-wallet-accent-fade);
				color: var(--dev-wallet-primary);
				font-weight: var(--dev-wallet-font-weight-semibold);
			}

			.add-network-form {
				display: flex;
				flex-direction: column;
				gap: 8px;
				margin-top: 8px;
				padding: 12px;
				border-radius: var(--dev-wallet-radius-lg);
				border: 1px dashed var(--dev-wallet-border);
				background: var(--dev-wallet-surface);
			}

			.form-input {
				padding: 6px 8px;
				border-radius: var(--dev-wallet-radius);
				border: 1px solid var(--dev-wallet-input);
				background: var(--dev-wallet-bg-2);
				font-size: 12px;
			}

			.form-actions {
				display: flex;
				gap: 6px;
			}

			.btn-sm {
				padding: 5px 10px;
				border-radius: var(--dev-wallet-radius-xs);
				font-size: 11px;
				font-weight: var(--dev-wallet-font-weight-medium);
			}

			.btn-add {
				background: var(--dev-wallet-primary);
				color: var(--dev-wallet-primary-foreground);
			}

			.btn-add:disabled {
				opacity: 0.5;
			}

			.btn-cancel {
				background: var(--dev-wallet-secondary);
				color: var(--dev-wallet-foreground);
				border: 1px solid var(--dev-wallet-border);
			}

			.btn-toggle {
				font-size: 12px;
				color: var(--dev-wallet-primary);
				height: 30px;
				padding: 0 10px;
				margin-top: 8px;
				border: 1px solid var(--dev-wallet-border);
				border-radius: var(--dev-wallet-radius);
			}

			.btn-toggle:hover {
				background: var(--dev-wallet-bg-hover);
				border-color: var(--dev-wallet-border-strong);
			}

			.cli-section-column {
				flex-direction: column;
				align-items: flex-start;
				gap: 6px;
			}

			.cli-header-row {
				display: flex;
				align-items: center;
				gap: 8px;
				width: 100%;
			}

			.cli-accounts-list {
				width: 100%;
				padding-left: 16px;
			}

			.cli-accounts-list .network-url {
				padding: 2px 0;
			}

			.cli-hint {
				padding-left: 16px;
				margin-top: 0;
				font-size: 12px;
			}

			.cli-unpaired-hint {
				margin-top: 8px;
			}

			.about {
				font-size: 12px;
				color: var(--dev-wallet-muted-foreground);
				line-height: 1.5;
			}

			.error {
				font-size: 11px;
				margin-top: 4px;
			}

			.bookmarklet-link-wrapper {
				margin-top: 8px;
			}

			.bookmarklet-link {
				display: inline-flex;
				align-items: center;
				gap: 6px;
				padding: 8px 14px;
				border-radius: var(--dev-wallet-radius-sm);
				background: var(--dev-wallet-primary);
				color: var(--dev-wallet-primary-foreground);
				font-size: 13px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				text-decoration: none;
				cursor: grab;
				user-select: none;
			}

			.bookmarklet-link:hover {
				opacity: 0.9;
			}

			.bookmarklet-link:active {
				cursor: grabbing;
			}

			.bookmarklet-url {
				font-family: var(--dev-wallet-font-mono);
				font-size: 10px;
				color: var(--dev-wallet-muted-foreground);
				word-break: break-all;
				user-select: all;
			}

			.console-snippet {
				margin-top: 8px;
				border-radius: var(--dev-wallet-radius);
				background: var(--dev-wallet-bg-0);
				border: 1px solid var(--dev-wallet-border);
				overflow: hidden;
			}

			.console-snippet-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				padding: 7px 8px 7px 10px;
				border-bottom: 1px solid var(--dev-wallet-border);
				background: color-mix(in srgb, var(--dev-wallet-bg-1) 72%, transparent);
			}

			.console-snippet-label {
				font-family: var(--dev-wallet-font-mono);
				font-size: 9.5px;
				font-weight: var(--dev-wallet-font-weight-medium);
				letter-spacing: 0.12em;
				text-transform: uppercase;
				color: var(--dev-wallet-text-3);
			}

			.console-snippet-code {
				margin: 0;
				max-width: 100%;
				padding: 10px 12px 12px;
				overflow-x: auto;
				font-family: var(--dev-wallet-font-mono);
				font-size: 11px;
				color: var(--dev-wallet-foreground);
				line-height: 1.5;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
				user-select: all;
			}

			.btn-copy {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				min-width: 54px;
				height: 24px;
				padding: 0 8px;
				border-radius: var(--dev-wallet-radius-xs);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-bg-2);
				color: var(--dev-wallet-foreground);
				font-size: 10px;
				font-weight: var(--dev-wallet-font-weight-medium);
				cursor: pointer;
				white-space: nowrap;
			}

			.btn-copy:hover {
				background: var(--dev-wallet-bg-hover);
				border-color: var(--dev-wallet-border-strong);
				color: var(--dev-wallet-foreground);
			}

			@media (max-width: 420px) {
				.settings-summary {
					grid-template-columns: 1fr;
				}
			}
		`,
	];

	@property({ attribute: false })
	wallet: DevWallet | null = null;

	@property({ attribute: false })
	accounts: readonly ReadonlyWalletAccount[] = [];

	@property({ attribute: false })
	adapters: SignerAdapter[] = [];

	@property({ type: String })
	activeAddress = '';

	@property({ type: String })
	bookmarkletOrigin = '';

	@state()
	private _showAddNetwork = false;

	@state()
	private _networkName = '';

	@state()
	private _networkUrl = '';

	@state()
	private _error: string | null = null;

	@state()
	private _editingNetwork: string | null = null;

	@state()
	private _editingUrl = '';

	@state()
	private _copied = false;

	override render() {
		return html`
			<div class="section">${this.#renderSummary()}</div>
			<div class="section">${this.#renderNetworks()}</div>
			${this.#hasCliAdapter()
				? html`<div class="section">${this.#renderCliSigner()}</div>`
				: nothing}
			<div class="section">${this.#renderAccounts()}</div>
			${this.bookmarkletOrigin
				? html`<div class="section">${this.#renderBookmarklet()}</div>`
				: nothing}
		`;
	}

	#renderSummary() {
		const activeNetwork = this.wallet?.activeNetwork ?? 'none';
		return html`
			<h3 class="section-header">Wallet</h3>
			<div class="settings-summary">
				<div class="summary-cell">
					<div class="summary-label">Network</div>
					<div class="summary-value">${activeNetwork}</div>
				</div>
				<div class="summary-cell">
					<div class="summary-label">Accounts</div>
					<div class="summary-value">${this.accounts.length}</div>
				</div>
				<div class="summary-cell">
					<div class="summary-label">Adapters</div>
					<div class="summary-value">${this.adapters.length}</div>
				</div>
			</div>
		`;
	}

	#renderNetworks() {
		if (!this.wallet) return nothing;

		const networks = this.wallet.availableNetworks;
		const activeNetwork = this.wallet.activeNetwork;
		const urls = this.wallet.networkUrls;

		return html`
			<h3 class="section-header">Networks</h3>
			<div class="network-list">
				${networks.map((name) => {
					const color = NETWORK_COLORS[name] ?? '#6b7280';
					const isActive = name === activeNetwork;
					const isEditing = this._editingNetwork === name;
					return html`
						<div class="network-item ${isActive ? 'active' : ''}">
							<span class="network-dot" style="background: ${color}"></span>
							<div class="network-info">
								<span class="network-name">${name}</span>
								${isEditing
									? html`<input
											class="network-url-input"
											type="text"
											.value=${this._editingUrl}
											@input=${(e: InputEvent) => {
												this._editingUrl = (e.target as HTMLInputElement).value;
											}}
											@keydown=${(e: KeyboardEvent) => {
												if (e.key === 'Enter') this.#saveNetworkUrl(name);
												if (e.key === 'Escape') this.#cancelEditNetwork();
											}}
										/>`
									: html`<span class="network-url" title=${urls[name] ?? ''}
											>${urls[name] ?? ''}</span
										>`}
							</div>
							<div class="network-actions">
								${isEditing
									? html`
											<button
												class="btn-icon"
												title="Save"
												aria-label="Save URL"
												@click=${() => this.#saveNetworkUrl(name)}
											>
												&#10003;
											</button>
											<button
												class="btn-icon"
												title="Cancel"
												aria-label="Cancel editing"
												@click=${this.#cancelEditNetwork}
											>
												&#10005;
											</button>
										`
									: html`
											<button
												class="btn-icon"
												title="Edit URL"
												aria-label="Edit network URL"
												@click=${() => this.#startEditNetwork(name, urls[name] ?? '')}
											>
												&#9998;
											</button>
											${!isActive
												? html`<button
														class="btn-icon btn-icon-danger"
														title="Remove"
														aria-label="Remove network"
														@click=${() => this.#removeNetwork(name)}
													>
														&#10005;
													</button>`
												: nothing}
										`}
								${isActive ? html`<span class="network-active-badge">Active</span>` : nothing}
							</div>
						</div>
					`;
				})}
			</div>
			${this._showAddNetwork
				? this.#renderAddNetworkForm()
				: html`
						<button
							class="btn-toggle"
							@click=${() => {
								this._showAddNetwork = true;
							}}
						>
							+ Add Network
						</button>
					`}
		`;
	}

	#renderAddNetworkForm() {
		return html`
			<div class="add-network-form">
				<input
					class="form-input"
					type="text"
					placeholder="Network name (e.g. custom)"
					.value=${this._networkName}
					@input=${(e: InputEvent) => {
						this._networkName = (e.target as HTMLInputElement).value;
						this._error = null;
					}}
				/>
				<input
					class="form-input"
					type="text"
					placeholder="gRPC URL (e.g. http://localhost:9000)"
					.value=${this._networkUrl}
					@input=${(e: InputEvent) => {
						this._networkUrl = (e.target as HTMLInputElement).value;
						this._error = null;
					}}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter') this.#addNetwork();
						if (e.key === 'Escape') this.#cancelAddNetwork();
					}}
				/>
				${this._error ? html`<div class="error">${this._error}</div>` : nothing}
				<div class="form-actions">
					<button
						class="btn-sm btn-add"
						?disabled=${!this._networkName.trim() || !this._networkUrl.trim()}
						@click=${this.#addNetwork}
					>
						Add
					</button>
					<button class="btn-sm btn-cancel" @click=${this.#cancelAddNetwork}>Cancel</button>
				</div>
			</div>
		`;
	}

	#hasCliAdapter(): boolean {
		return this.adapters.some((a) => a.id === 'remote-cli');
	}

	#renderCliSigner() {
		const cliAdapter = this.adapters.find((a) => a.id === 'remote-cli');
		if (!cliAdapter) return nothing;

		const isPaired = 'isPaired' in cliAdapter && (cliAdapter as { isPaired: boolean }).isPaired;
		const cliAccounts = cliAdapter.getAccounts();

		return html`
			<h3 class="section-header">CLI Signer</h3>
			${isPaired
				? html`
						<div class="network-item active cli-section-column">
							<div class="cli-header-row">
								<span
									class="network-dot"
									style="background: var(--dev-wallet-status-connected)"
								></span>
								<span class="network-name">Connected</span>
								${cliAccounts.length > 0
									? html`<span class="network-active-badge">${cliAccounts.length} imported</span>`
									: nothing}
							</div>
							${cliAccounts.length > 0
								? html`<div class="cli-accounts-list">
										${cliAccounts.map(
											(acc) => html`
												<div class="network-url">${acc.label} (${formatAddress(acc.address)})</div>
											`,
										)}
									</div>`
								: html`<div class="about cli-hint">Use + Add above to import CLI accounts.</div>`}
						</div>
					`
				: html`
						<div class="network-item">
							<span
								class="network-dot"
								style="background: var(--dev-wallet-status-disconnected)"
							></span>
							<span class="network-name" style="color: var(--dev-wallet-muted-foreground)"
								>Not connected</span
							>
						</div>
						<div class="about cli-unpaired-hint">
							Open the token URL from your terminal to connect CLI accounts.
						</div>
					`}
		`;
	}

	#renderAccounts() {
		return html`
			<dev-wallet-accounts
				exportparts="account-list: accounts-account-list, add-button: accounts-add-button, empty-state: accounts-empty-state"
				.accounts=${this.accounts}
				.adapters=${this.adapters}
				.activeAddress=${this.activeAddress}
			></dev-wallet-accounts>
		`;
	}

	#renderBookmarklet() {
		if (!this.bookmarkletOrigin) return nothing;
		const origin = this.bookmarkletOrigin;

		const bookmarkletJs = `${origin}/bookmarklet.js`;
		const bookmarkletHref = `javascript:void(document.head.appendChild(Object.assign(document.createElement('script'),{src:'${bookmarkletJs}'})))`;
		const consoleSnippet = `var s=document.createElement('script');s.src='${bookmarkletJs}';document.head.appendChild(s);`;

		return html`
			<h3 class="section-header">Bookmarklet</h3>
			<div class="about">
				Drag this link to your bookmarks bar, then click it on any dApp to inject the wallet:
			</div>
			<div class="bookmarklet-link-wrapper">
				<a
					class="bookmarklet-link"
					href=${bookmarkletHref}
					title="Drag to bookmarks bar"
					@click=${(e: MouseEvent) => e.preventDefault()}
				>
					Dev Wallet
				</a>
			</div>
			<div class="about" style="margin-top: 12px">Or paste this in the browser console:</div>
			<div class="console-snippet">
				<div class="console-snippet-header">
					<span class="console-snippet-label">Console</span>
					<button
						class="btn-copy"
						type="button"
						aria-label="Copy console snippet"
						@click=${() => this.#copySnippet(consoleSnippet)}
					>
						${this._copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				<pre class="console-snippet-code"><code>${consoleSnippet}</code></pre>
			</div>
			<div class="about" style="margin-top: 8px">
				Or add this script to your page:<br />
				<code class="bookmarklet-url">${bookmarkletJs}</code>
			</div>
		`;
	}

	#copySnippet(text: string) {
		navigator.clipboard.writeText(text).then(() => {
			this._copied = true;
			setTimeout(() => {
				this._copied = false;
			}, 2000);
		});
	}

	#addNetwork() {
		if (!this.wallet) return;

		const name = this._networkName.trim();
		const url = this._networkUrl.trim();

		if (!name || !url) return;

		if (this.wallet.availableNetworks.includes(name)) {
			this._error = `Network "${name}" already exists`;
			return;
		}

		try {
			this.wallet.addNetwork(name, url);
			this._networkName = '';
			this._networkUrl = '';
			this._showAddNetwork = false;
			this._error = null;
			emitEvent(this, 'network-added', { name, url });
		} catch (err) {
			this._error = getErrorMessage(err, 'Failed to add network');
		}
	}

	#cancelAddNetwork() {
		this._showAddNetwork = false;
		this._networkName = '';
		this._networkUrl = '';
		this._error = null;
	}

	#startEditNetwork(name: string, url: string) {
		this._editingNetwork = name;
		this._editingUrl = url;
	}

	#saveNetworkUrl(name: string) {
		if (!this.wallet) return;
		const url = this._editingUrl.trim();
		if (!url) return;

		try {
			this.wallet.addNetwork(name, url);
			this._editingNetwork = null;
			this._editingUrl = '';
		} catch (error) {
			this._error = error instanceof Error ? error.message : 'Invalid URL';
		}
	}

	#cancelEditNetwork() {
		this._editingNetwork = null;
		this._editingUrl = '';
	}

	#removeNetwork(name: string) {
		if (!this.wallet) return;
		this.wallet.removeNetwork(name);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-settings': DevWalletSettings;
	}
}
