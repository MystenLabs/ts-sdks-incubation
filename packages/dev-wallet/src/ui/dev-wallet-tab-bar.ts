// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { sharedStyles } from './styles.js';

/** Built-in tab ids. */
export type BuiltinTabId = 'assets' | 'objects' | 'fork' | 'settings';
export type TabId = BuiltinTabId;

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

// Phase 5 Subtopic 6 — fork-controls tab icon. Branching shape signals
// the "fork" semantic without overlapping with the existing wallet
// glyphs; rendered only when the active manifest's `meta.runtime`
// resolves to `'forked'` (see `wallet-controller.renderTabBar`).
const FORK_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
	<circle cx="6" cy="6" r="2" />
	<circle cx="6" cy="18" r="2" />
	<circle cx="18" cy="12" r="2" />
	<path d="M6 8v8" />
	<path d="M6 12h6" />
	<path d="M12 12l4-2" />
	<path d="M12 12l4 2" />
</svg>`;

const BUILTIN_TABS: TabSpec[] = [
	{ id: 'assets', label: 'Assets', icon: ASSETS_ICON },
	{ id: 'objects', label: 'Objects', icon: OBJECTS_ICON },
	{ id: 'settings', label: 'Settings', icon: SETTINGS_ICON },
];

/** Built-in tabs plus the fork-controls tab. Returned when the host
 *  controller signals fork-mode availability via the `showFork` prop. */
const TABS_WITH_FORK: TabSpec[] = [
	{ id: 'assets', label: 'Assets', icon: ASSETS_ICON },
	{ id: 'objects', label: 'Objects', icon: OBJECTS_ICON },
	{ id: 'fork', label: 'Fork', icon: FORK_ICON },
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

	/** Phase 5 Subtopic 6 — when true, the bar surfaces a "Fork" tab
	 *  between Objects and Settings. The host controller toggles this
	 *  on whenever the active stack's manifest reports
	 *  `meta.runtime === 'forked'`. Off by default so bundled-mode
	 *  apps don't accidentally expose admin RPCs. */
	@property({ type: Boolean, attribute: 'show-fork' })
	showFork = false;

	override render() {
		const tabs: TabSpec[] = this.showFork ? TABS_WITH_FORK : BUILTIN_TABS;
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
