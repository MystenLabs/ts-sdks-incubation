// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { CopyController } from './copy-controller.js';

/**
 * How to point a dApp at a hosted/standalone dev wallet: a draggable
 * bookmarklet, a console script, and a dApp Kit snippet — all derived from
 * the wallet's `origin`. Rendered beside the standalone wallet on wide
 * screens and at the top of its Settings tab.
 */
const BOOKMARKS_BAR_SHORTCUT = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
	? '⌘ Shift B'
	: 'Ctrl Shift B';

@customElement('dev-wallet-connect-guide')
export class DevWalletConnectGuide extends LitElement {
	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			gap: 24px;
			font-size: 12px;
			line-height: 1.55;
			color: var(--dev-wallet-muted-foreground);
		}

		.guide-section {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.guide-title {
			margin: 0;
			font-family: var(--dev-wallet-font-mono);
			font-size: 10px;
			font-weight: var(--dev-wallet-font-weight-medium);
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--dev-wallet-text-3);
		}

		.guide p {
			margin: 0;
		}

		.guide strong {
			color: var(--dev-wallet-foreground);
			font-weight: var(--dev-wallet-font-weight-medium);
		}

		.steps {
			margin: 0;
			padding-left: 18px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.steps li::marker {
			color: var(--dev-wallet-text-3);
			font-family: var(--dev-wallet-font-mono);
			font-size: 11px;
		}

		.steps .bookmarklet-row {
			margin-top: 6px;
		}

		kbd {
			padding: 1px 5px;
			border-radius: var(--dev-wallet-radius-2xs);
			border: 1px solid var(--dev-wallet-border-strong);
			background: var(--dev-wallet-bg-2);
			font-family: var(--dev-wallet-font-mono);
			font-size: 10.5px;
			color: var(--dev-wallet-foreground);
		}

		.bookmarklet-row {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 10px;
		}

		.bookmarklet {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 6px 12px;
			border-radius: var(--dev-wallet-radius-sm);
			border: 1px solid var(--dev-wallet-border-strong);
			background: var(--dev-wallet-bg-2);
			color: var(--dev-wallet-foreground);
			font-weight: var(--dev-wallet-font-weight-medium);
			text-decoration: none;
			cursor: grab;
			user-select: none;
		}

		.bookmarklet:hover {
			background: var(--dev-wallet-bg-hover);
		}

		.bookmarklet:active {
			cursor: grabbing;
		}

		.bookmarklet svg {
			width: 13px;
			height: 13px;
		}

		.hint {
			font-size: 11px;
			color: var(--dev-wallet-text-3);
		}

		.hint.nudge {
			color: var(--dev-wallet-warning);
		}

		.link-btn {
			align-self: flex-start;
			text-align: left;
			padding: 0;
			border: 0;
			background: none;
			color: var(--dev-wallet-muted-foreground);
			font: inherit;
			text-decoration: underline;
			text-underline-offset: 2px;
			cursor: pointer;
		}

		.link-btn:hover {
			color: var(--dev-wallet-foreground);
		}

		.snippet {
			position: relative;
			border-radius: var(--dev-wallet-radius);
			border: 1px solid var(--dev-wallet-border);
			background: var(--dev-wallet-bg-1);
		}

		.snippet pre,
		.snippet code {
			font-family: var(--dev-wallet-font-mono);
		}

		.snippet pre {
			margin: 0;
			padding: 10px 12px;
			overflow-x: auto;
			font-size: 10.5px;
			line-height: 1.6;
			color: var(--dev-wallet-foreground);
		}

		.snippet .btn-copy {
			position: absolute;
			top: 6px;
			right: 6px;
		}

		.btn-copy {
			height: 22px;
			padding: 0 8px;
			border-radius: var(--dev-wallet-radius-xs);
			border: 1px solid var(--dev-wallet-border);
			background: var(--dev-wallet-bg-2);
			color: var(--dev-wallet-foreground);
			font-family: var(--dev-wallet-font-sans);
			font-size: 10.5px;
			font-weight: var(--dev-wallet-font-weight-medium);
			cursor: pointer;
		}

		.btn-copy:hover {
			background: var(--dev-wallet-bg-hover);
			border-color: var(--dev-wallet-border-strong);
		}
	`;

	/** Origin the wallet is served from (e.g. `https://sui-dev-wallet.vercel.app`). */
	@property({ type: String })
	origin = '';

	@state()
	private _dragNudge = false;

	#copy = new CopyController(this);

	override render() {
		const origin = this.origin;
		const scriptUrl = `${origin}/bookmarklet.js`;
		const bookmarkletHref = `javascript:void(document.head.appendChild(Object.assign(document.createElement('script'),{src:'${scriptUrl}'})))`;
		const consoleScript = `var s=document.createElement('script');s.src='${scriptUrl}';document.head.appendChild(s);`;
		const dappKitSnippet = `import {
  devWalletClientInitializer,
} from '@mysten-incubation/dev-wallet/client';

createDAppKit({
  networks: ['devnet'],
  walletInitializers: [
    devWalletClientInitializer({
      origin: '${origin}',
    }),
  ],
});`;

		return html`
			<section class="guide-section">
				<h2 class="guide-title">Connect an app</h2>
				<p>Use a bookmarklet to add this wallet to any dApp, no code changes needed.</p>
				<ol class="steps">
					<li>Show your browser's bookmarks bar (<kbd>${BOOKMARKS_BAR_SHORTCUT}</kbd>).</li>
					<li>
						Drag this button onto the bookmarks bar:
						<div class="bookmarklet-row">
							<a
								class="bookmarklet"
								href=${bookmarkletHref}
								title="Drag to your bookmarks bar"
								@click=${this.#nudgeDrag}
								>${this.#walletIcon} Dev Wallet</a
							>
							${this._dragNudge
								? html`<span class="hint nudge">Drag it, don't click it</span>`
								: nothing}
						</div>
					</li>
					<li>
						Open your dApp and click the bookmark. Then choose
						<strong>Dev Wallet (Web)</strong> in the dApp's wallet picker.
					</li>
				</ol>
				<p class="hint">
					The bookmark only lasts until the page reloads. After a reload, click it again.
				</p>
				<button class="link-btn" type="button" @click=${() => this.#copy.copy(consoleScript)}>
					${this.#copy.isCopied(consoleScript)
						? 'Copied. Paste it into the dApp’s browser console.'
						: 'Can’t use bookmarks? Copy a script for the dApp’s console instead.'}
				</button>
			</section>

			<section class="guide-section">
				<h2 class="guide-title">Add to your app</h2>
				<p>Register it with dApp Kit so it's always in your wallet picker.</p>
				<div class="snippet">
					<button
						class="btn-copy"
						type="button"
						aria-label="Copy dApp Kit snippet"
						@click=${() => this.#copy.copy(dappKitSnippet)}
					>
						${this.#copy.isCopied(dappKitSnippet) ? 'Copied' : 'Copy'}
					</button>
					<pre><code>${dappKitSnippet}</code></pre>
				</div>
			</section>
		`;
	}

	#nudgeDrag = (e: MouseEvent) => {
		e.preventDefault();
		this._dragNudge = true;
		setTimeout(() => {
			this._dragNudge = false;
		}, 2500);
	};

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
		'dev-wallet-connect-guide': DevWalletConnectGuide;
	}
}
