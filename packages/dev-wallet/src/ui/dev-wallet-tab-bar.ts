// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { WalletPanelDescriptor } from '../types.js';
import { sharedStyles } from './styles.js';

/** Built-in tab ids. Custom panels expose their own `id` strings via {@link WalletPanelDescriptor}. */
export type BuiltinTabId = 'assets' | 'objects' | 'settings';
export type TabId = BuiltinTabId | (string & {});

interface TabSpec {
	id: TabId;
	label: string;
	icon: TemplateResult;
}

const ASSETS_ICON = html`<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
>
	<rect x="2" y="4" width="20" height="16" rx="2" />
	<path d="M16 12h.01" />
</svg>`;

const OBJECTS_ICON = html`<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
>
	<rect x="3" y="3" width="7" height="7" rx="1" />
	<rect x="14" y="3" width="7" height="7" rx="1" />
	<rect x="3" y="14" width="7" height="7" rx="1" />
	<rect x="14" y="14" width="7" height="7" rx="1" />
</svg>`;

const SETTINGS_ICON = html`<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
>
	<circle cx="12" cy="12" r="3" />
	<path
		d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
	/>
</svg>`;

const FALLBACK_ICON = html`<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
>
	<circle cx="12" cy="12" r="9" />
</svg>`;

const BUILTIN_TABS: TabSpec[] = [
	{ id: 'assets', label: 'Assets', icon: ASSETS_ICON },
	{ id: 'objects', label: 'Objects', icon: OBJECTS_ICON },
	{ id: 'settings', label: 'Settings', icon: SETTINGS_ICON },
];

@customElement('dev-wallet-tab-bar')
export class DevWalletTabBar extends LitElement {
	static override styles = [
		sharedStyles,
		css`
			:host {
				display: block;
				border-top: 1px solid var(--dev-wallet-border);
			}

			.tab-bar {
				display: flex;
				height: 40px;
				overflow-x: auto;
			}

			.tab {
				flex: 1;
				min-width: 64px;
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 4px;
				font-size: 11px;
				font-weight: var(--dev-wallet-font-weight-medium);
				color: var(--dev-wallet-muted-foreground);
				transition: color 0.15s;
				border-top: 2px solid transparent;
				white-space: nowrap;
				padding: 0 6px;
			}

			.tab:hover {
				color: var(--dev-wallet-foreground);
			}

			.tab[aria-selected='true'] {
				color: var(--dev-wallet-primary);
				border-top-color: var(--dev-wallet-primary);
			}

			.tab svg {
				width: 16px;
				height: 16px;
			}
		`,
	];

	@property({ type: String })
	active: TabId = 'assets';

	@property({ attribute: false })
	panels: readonly WalletPanelDescriptor[] = [];

	override render() {
		const tabs: TabSpec[] = [
			...BUILTIN_TABS,
			...this.panels.map(
				(p): TabSpec => ({
					id: p.id,
					label: p.label,
					icon: p.icon !== undefined ? html`${unsafeHTML(p.icon)}` : FALLBACK_ICON,
				}),
			),
		];
		return html`
			<nav class="tab-bar" part="tab-bar" role="tablist" aria-label="Wallet navigation">
				${tabs.map(
					(tab) => html`
						<button
							class="tab"
							part="tab"
							role="tab"
							aria-selected=${this.active === tab.id}
							tabindex=${this.active === tab.id ? 0 : -1}
							@click=${() => this.#select(tab.id)}
							@keydown=${(e: KeyboardEvent) => this.#handleKeydown(e, tabs)}
						>
							${tab.icon} ${tab.label}
						</button>
					`,
				)}
			</nav>
		`;
	}

	#handleKeydown(e: KeyboardEvent, tabs: TabSpec[]): void {
		const currentIndex = tabs.findIndex((t) => t.id === this.active);
		let newIndex = -1;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			newIndex = (currentIndex + 1) % tabs.length;
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
		}
		if (newIndex !== -1) {
			const next = tabs[newIndex];
			if (next === undefined) return;
			this.#select(next.id);
			const buttons = this.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tab');
			buttons?.[newIndex]?.focus();
		}
	}

	#select(tab: TabId): void {
		if (tab !== this.active) {
			this.dispatchEvent(
				new CustomEvent('tab-changed', {
					bubbles: true,
					composed: true,
					detail: { tab },
				}),
			);
		}
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-tab-bar': DevWalletTabBar;
	}
}
