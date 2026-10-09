// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css, html, LitElement, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import type { ChainDefinition, ChainKey } from '../../chains/types.js';
import { sharedStyles } from '../styles/index.js';
import { chainIconStyles, renderChainIcon } from './chain-icon.js';

/**
 * A dropdown of chains with icons. Dispatches a composed `chain-change` event with
 * `detail.key` when the user picks an option.
 *
 * @fires chain-change
 */
export class ChainSelect extends LitElement {
	static override styles = [
		sharedStyles,
		chainIconStyles,
		css`
			:host {
				position: relative;
				display: inline-block;
			}

			.trigger {
				display: inline-flex;
				align-items: center;
				gap: 8px;
				height: 36px;
				padding: 0 10px 0 8px;
				border-radius: var(--cctp-kit-radius-xl);
				background: var(--cctp-kit-background);
				border: 1px solid var(--cctp-kit-border);
				font-weight: var(--cctp-kit-font-weight-medium);
				cursor: var(--cctp-kit-cursor-button);
				outline-style: none;
				max-width: 240px;
			}

			.trigger:hover:not(:disabled) {
				background: var(--cctp-kit-accent);
			}

			.trigger:focus-visible {
				box-shadow: 0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent);
			}

			.trigger:disabled {
				cursor: var(--cctp-kit-cursor-disabled);
				opacity: 0.7;
			}

			.name {
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.chevron {
				width: 14px;
				height: 14px;
				flex: none;
				color: var(--cctp-kit-muted-foreground);
				transition: transform 0.15s ease;
			}

			.chevron.open {
				transform: rotate(180deg);
			}

			.menu {
				position: absolute;
				right: 0;
				top: calc(100% + 6px);
				min-width: 230px;
				max-height: 300px;
				overflow-y: auto;
				padding: 6px;
				background: var(--cctp-kit-popover);
				color: var(--cctp-kit-popover-foreground);
				border: 1px solid var(--cctp-kit-border);
				border-radius: var(--cctp-kit-radius-lg);
				box-shadow:
					0 10px 30px rgba(0, 0, 0, 0.12),
					0 2px 6px rgba(0, 0, 0, 0.06);
				z-index: 20;
			}

			.option {
				display: flex;
				align-items: center;
				gap: 10px;
				width: 100%;
				padding: 8px 10px;
				border-radius: var(--cctp-kit-radius-sm);
				text-align: left;
				cursor: var(--cctp-kit-cursor-button);
				outline-style: none;
			}

			.option:hover,
			.option:focus-visible {
				background: var(--cctp-kit-accent);
				color: var(--cctp-kit-accent-foreground);
			}

			.option.selected {
				font-weight: var(--cctp-kit-font-weight-semibold);
			}

			.check {
				margin-left: auto;
				width: 14px;
				height: 14px;
				color: var(--cctp-kit-primary);
			}
		`,
	];

	@property({ attribute: false })
	options: ChainDefinition[] = [];

	@property({ type: String })
	value: ChainKey | '' = '';

	@property({ type: Boolean, reflect: true })
	disabled = false;

	@state()
	private _open = false;

	#onDocumentPointerDown = (event: Event) => {
		if (!event.composedPath().includes(this)) this.#close();
	};

	#onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') this.#close();
	};

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.#close();
	}

	#toggle() {
		if (this._open) this.#close();
		else this.#openMenu();
	}

	#openMenu() {
		this._open = true;
		document.addEventListener('pointerdown', this.#onDocumentPointerDown, true);
		document.addEventListener('keydown', this.#onKeyDown);
	}

	#close() {
		if (!this._open) return;
		this._open = false;
		document.removeEventListener('pointerdown', this.#onDocumentPointerDown, true);
		document.removeEventListener('keydown', this.#onKeyDown);
	}

	#select(key: ChainKey) {
		this.#close();
		if (key !== this.value) {
			this.dispatchEvent(
				new CustomEvent('chain-change', { detail: { key }, bubbles: true, composed: true }),
			);
		}
	}

	override render() {
		const selected = this.options.find((c) => c.key === this.value);
		return html`
			<button
				type="button"
				class="trigger"
				part="trigger"
				aria-haspopup="listbox"
				aria-expanded=${this._open}
				?disabled=${this.disabled}
				@click=${this.#toggle}
			>
				${selected ? renderChainIcon(selected) : nothing}
				<span class="name">${selected?.name ?? 'Select chain'}</span>
				<svg class=${classMap({ chevron: true, open: this._open })} viewBox="0 0 16 16" fill="none">
					<path
						d="M4 6l4 4 4-4"
						stroke="currentColor"
						stroke-width="1.75"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
			${
				this._open
					? html`<div class="menu" role="listbox" part="menu">
							${this.options.map(
								(chain) =>
									html`<button
										type="button"
										role="option"
										aria-selected=${chain.key === this.value}
										class=${classMap({ option: true, selected: chain.key === this.value })}
										@click=${() => this.#select(chain.key)}
									>
										${renderChainIcon(chain)}
										<span class="name">${chain.name}</span>
										${
											chain.key === this.value
												? html`<svg class="check" viewBox="0 0 16 16" fill="none">
														<path
															d="M3 8.5l3 3 7-7"
															stroke="currentColor"
															stroke-width="1.75"
															stroke-linecap="round"
															stroke-linejoin="round"
														/>
													</svg>`
												: nothing
										}
									</button>`,
							)}
						</div>`
					: nothing
			}
		`;
	}
}
