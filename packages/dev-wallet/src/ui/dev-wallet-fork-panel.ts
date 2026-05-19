// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Dev-wallet fork-controls panel. Renders when the active stack is in
// `runtime === 'forked'` mode and surfaces a curated slice of the
// sui-fork admin API to the operator: status read, advance-clock,
// advance-checkpoint, and impersonation slot toggles.
//
// Phase 5 Subtopic 6 (`packages/devstack/notes/sui-fork-phase-5.md`
// §8 — tasks P5.8.1–5 and P5.9.1–3).

import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ForkImpersonationSlot, ForkRelay, ForkStatus } from '../adapters/fork-relay.js';
import { actionButtonStyles, sectionHeaderStyles, sharedStyles, stateStyles } from './styles.js';
import { formatAddress, getErrorMessage } from './utils.js';

/** Default polling cadence for `GetStatus`. Slow on purpose — the panel
 *  also refreshes after every action verb lands. Phase 5 Subtopic 7
 *  (subscriptions) replaces polling with a stream eventually. */
const STATUS_POLL_MS = 4000;

@customElement('dev-wallet-fork-panel')
export class DevWalletForkPanel extends LitElement {
	static override styles = [
		sharedStyles,
		sectionHeaderStyles,
		actionButtonStyles,
		stateStyles,
		css`
			:host {
				display: block;
			}

			.section {
				margin-bottom: 18px;
			}

			.section:last-child {
				margin-bottom: 0;
			}

			.status-grid {
				display: grid;
				grid-template-columns: max-content 1fr;
				column-gap: 12px;
				row-gap: 6px;
				font-size: 12px;
				padding: 10px 12px;
				border-radius: var(--dev-wallet-radius-md);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-secondary);
			}

			.status-label {
				color: var(--dev-wallet-muted-foreground);
				font-weight: var(--dev-wallet-font-weight-medium);
				text-transform: uppercase;
				letter-spacing: 0.5px;
				font-size: 10px;
				align-self: center;
			}

			.status-value {
				font-family: var(--dev-wallet-font-mono);
				color: var(--dev-wallet-foreground);
				word-break: break-all;
			}

			.status-value.dim {
				color: var(--dev-wallet-muted-foreground);
			}

			.action-row {
				display: flex;
				gap: 6px;
				align-items: stretch;
			}

			.action-input {
				flex: 1;
				min-width: 0;
				padding: 8px 10px;
				font-size: 12px;
				font-family: var(--dev-wallet-font-mono);
				border-radius: var(--dev-wallet-radius-sm);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-background);
				color: var(--dev-wallet-foreground);
				outline: none;
			}

			.action-input:focus {
				border-color: var(--dev-wallet-primary);
			}

			.btn-action {
				min-width: 96px;
				padding: 0 14px;
				border-radius: var(--dev-wallet-radius-sm);
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-semibold);
				background: var(--dev-wallet-primary);
				color: var(--dev-wallet-primary-foreground);
				transition: background-color 0.15s;
			}

			.btn-action:hover:not(:disabled) {
				background: oklab(from var(--dev-wallet-primary) calc(l - 0.03) a b);
			}

			.btn-action:disabled {
				opacity: 0.55;
				cursor: not-allowed;
			}

			.slot-list {
				display: flex;
				flex-direction: column;
				gap: 6px;
			}

			.slot-item {
				display: flex;
				align-items: center;
				gap: 8px;
				padding: 8px 10px;
				border-radius: var(--dev-wallet-radius-sm);
				border: 1px solid var(--dev-wallet-border);
				background: var(--dev-wallet-secondary);
			}

			.slot-item.active {
				border-color: var(--dev-wallet-primary);
			}

			.slot-meta {
				flex: 1;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 2px;
			}

			.slot-label {
				font-size: 12px;
				font-weight: var(--dev-wallet-font-weight-medium);
				color: var(--dev-wallet-foreground);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.slot-address {
				font-size: 10px;
				font-family: var(--dev-wallet-font-mono);
				color: var(--dev-wallet-muted-foreground);
			}

			.slot-toggle {
				font-size: 10px;
				padding: 4px 10px;
				border-radius: var(--dev-wallet-radius-xs);
				background: var(--dev-wallet-background);
				border: 1px solid var(--dev-wallet-border);
				color: var(--dev-wallet-muted-foreground);
				font-weight: var(--dev-wallet-font-weight-semibold);
				text-transform: uppercase;
				letter-spacing: 0.5px;
			}

			.slot-toggle.on {
				background: var(--dev-wallet-primary);
				color: var(--dev-wallet-primary-foreground);
				border-color: var(--dev-wallet-primary);
			}

			.slot-toggle:hover:not(:disabled) {
				filter: brightness(1.05);
			}

			.slot-toggle:disabled {
				opacity: 0.55;
				cursor: not-allowed;
			}

			.helper-text {
				font-size: 11px;
				color: var(--dev-wallet-muted-foreground);
				margin-top: 6px;
				line-height: 1.4;
			}

			.fork-banner {
				padding: 8px 12px;
				background: rgba(234, 179, 8, 0.12);
				border: 1px solid rgba(234, 179, 8, 0.35);
				border-radius: var(--dev-wallet-radius-sm);
				font-size: 11px;
				color: var(--dev-wallet-muted-foreground);
				line-height: 1.4;
				margin-bottom: 14px;
			}

			.fork-banner strong {
				color: #92400e;
				font-weight: var(--dev-wallet-font-weight-semibold);
			}

			.inline-error {
				color: var(--dev-wallet-destructive);
				font-size: 11px;
				margin-top: 6px;
				word-break: break-word;
			}
		`,
	];

	/** Fork relay client. Provided by the parent (`wallet-controller`)
	 *  when the active manifest exposes a forked stack. When `null`,
	 *  the panel renders an empty state — the tab gating in the
	 *  controller normally prevents this. */
	@property({ attribute: false })
	relay: ForkRelay | null = null;

	/** Upstream label (`'mainnet'`, `'testnet'`, …). Surfaced in the
	 *  banner so the operator can't misread which chain the fork forked. */
	@property({ type: String })
	upstream = '';

	@state()
	private _status: ForkStatus | null = null;

	@state()
	private _statusError: string | null = null;

	@state()
	private _statusLoading = false;

	@state()
	private _actionInFlight: 'advance-clock' | 'advance-checkpoint' | null = null;

	@state()
	private _actionError: string | null = null;

	@state()
	private _slots: ForkImpersonationSlot[] = [];

	@state()
	private _slotsError: string | null = null;

	@state()
	private _slotToggleInFlight: string | null = null;

	@state()
	private _clockInputMs = '1000';

	@state()
	private _checkpointInputCount = '1';

	#pollTimer: ReturnType<typeof setInterval> | null = null;

	override connectedCallback() {
		super.connectedCallback();
		this.#startPolling();
		void this.#refreshAll();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.#stopPolling();
	}

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has('relay')) {
			this._status = null;
			this._statusError = null;
			this._slots = [];
			this._slotsError = null;
			if (this.relay !== null) {
				void this.#refreshAll();
			}
		}
	}

	override render() {
		if (!this.relay) {
			return html`<div class="empty-state" part="empty-state">
				Fork controls require a devstack wallet-app connection.
			</div>`;
		}

		const upstream = this._status?.upstream ?? this.upstream;
		return html`
			<div class="fork-banner" part="fork-banner">
				<strong>Fork mode:</strong> changes here only affect the local
				${upstream ? html`<em>${upstream}</em>` : 'forked'} sui-fork stack — no real funds at risk.
			</div>

			<div class="section">
				<div class="section-header">Status</div>
				${this.#renderStatus()}
			</div>

			<div class="section">
				<div class="section-header">Advance clock</div>
				<div class="action-row">
					<input
						class="action-input"
						part="advance-clock-input"
						type="number"
						min="1"
						step="1"
						aria-label="Advance clock duration in ms"
						.value=${this._clockInputMs}
						@input=${this.#onClockInput}
						?disabled=${this._actionInFlight !== null}
					/>
					<button
						class="btn-action"
						part="advance-clock-button"
						?disabled=${this._actionInFlight !== null || !this.#parseClock()}
						@click=${this.#onAdvanceClock}
					>
						${this._actionInFlight === 'advance-clock' ? 'Advancing…' : '+ ms'}
					</button>
				</div>
				<div class="helper-text">
					Advances <code>clock::timestamp_ms()</code> by the given milliseconds.
				</div>
			</div>

			<div class="section">
				<div class="section-header">Advance checkpoints</div>
				<div class="action-row">
					<input
						class="action-input"
						part="advance-checkpoint-input"
						type="number"
						min="1"
						step="1"
						aria-label="Advance checkpoint count"
						.value=${this._checkpointInputCount}
						@input=${this.#onCheckpointInput}
						?disabled=${this._actionInFlight !== null}
					/>
					<button
						class="btn-action"
						part="advance-checkpoint-button"
						?disabled=${this._actionInFlight !== null || !this.#parseCheckpointCount()}
						@click=${this.#onAdvanceCheckpoint}
					>
						${this._actionInFlight === 'advance-checkpoint' ? 'Sealing…' : '+ ckpt'}
					</button>
				</div>
				<div class="helper-text">
					Seals pending transactions into <code>n</code> new checkpoints.
				</div>
				${this._actionError
					? html`<div class="inline-error" part="action-error">${this._actionError}</div>`
					: nothing}
			</div>

			<div class="section">
				<div class="section-header">Impersonation slots</div>
				${this.#renderSlots()}
			</div>
		`;
	}

	#renderStatus() {
		if (this._statusLoading && this._status === null) {
			return html`<div class="loading" part="status-loading">Loading fork status…</div>`;
		}
		if (this._statusError) {
			return html` <div class="error-state" part="status-error">${this._statusError}</div> `;
		}
		if (!this._status) {
			return html`<div class="empty-state" part="status-empty">Fork status unavailable.</div>`;
		}
		const { checkpoint, clockMs, autoTickMs } = this._status;
		const clockIso = (() => {
			try {
				return new Date(Number(clockMs)).toISOString();
			} catch {
				return '—';
			}
		})();
		return html`
			<div class="status-grid" part="status-grid">
				<span class="status-label">Checkpoint</span>
				<span class="status-value" part="status-checkpoint">${checkpoint.toString()}</span>
				<span class="status-label">Clock</span>
				<span class="status-value" part="status-clock">${clockMs.toString()}</span>
				<span class="status-label">UTC</span>
				<span class="status-value dim" part="status-clock-iso">${clockIso}</span>
				<span class="status-label">Auto-tick</span>
				<span class="status-value dim" part="status-auto-tick">
					${autoTickMs ? `${autoTickMs}ms` : 'off'}
				</span>
			</div>
		`;
	}

	#renderSlots() {
		if (this._slotsError) {
			return html`<div class="error-state" part="slots-error">${this._slotsError}</div>`;
		}
		if (this._slots.length === 0) {
			return html`<div class="empty-state" part="slots-empty">
				No impersonation slots configured. Add addresses via
				<code>Sui({fork:{impersonate:[…]}})</code>.
			</div>`;
		}
		return html`
			<div class="slot-list" part="slot-list">
				${this._slots.map((slot) => {
					const inFlight = this._slotToggleInFlight === slot.address;
					return html`
						<div
							class=${slot.active ? 'slot-item active' : 'slot-item'}
							part=${slot.active ? 'slot-item slot-item-active' : 'slot-item'}
						>
							<div class="slot-meta">
								<span class="slot-label">${slot.label ?? formatAddress(slot.address)}</span>
								<span class="slot-address">${formatAddress(slot.address)}</span>
							</div>
							<button
								class=${slot.active ? 'slot-toggle on' : 'slot-toggle'}
								part="slot-toggle"
								aria-pressed=${slot.active}
								?disabled=${inFlight}
								@click=${() => this.#onToggleSlot(slot)}
							>
								${inFlight ? '…' : slot.active ? 'On' : 'Off'}
							</button>
						</div>
					`;
				})}
			</div>
			<div class="helper-text">
				When <strong>On</strong>, user-driven tx signing for the matching account routes through
				<code>executeImpersonated</code> instead of a real signature.
			</div>
		`;
	}

	// ── Input bindings ────────────────────────────────────────────────────

	#onClockInput = (e: Event) => {
		this._clockInputMs = (e.target as HTMLInputElement).value;
	};

	#onCheckpointInput = (e: Event) => {
		this._checkpointInputCount = (e.target as HTMLInputElement).value;
	};

	#parseClock(): number | null {
		const n = Number(this._clockInputMs);
		if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
		return n;
	}

	#parseCheckpointCount(): number | null {
		const n = Number(this._checkpointInputCount);
		if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
		return n;
	}

	// ── Action handlers ───────────────────────────────────────────────────

	#onAdvanceClock = async () => {
		const ms = this.#parseClock();
		if (ms === null || !this.relay) return;
		this._actionInFlight = 'advance-clock';
		this._actionError = null;
		try {
			const result = await this.relay.advanceClock(ms);
			if (result.ok) {
				this._status = result.value;
			} else {
				this._actionError = result.error;
			}
		} catch (error) {
			this._actionError = getErrorMessage(error, 'advance-clock failed');
		} finally {
			this._actionInFlight = null;
		}
	};

	#onAdvanceCheckpoint = async () => {
		const count = this.#parseCheckpointCount();
		if (count === null || !this.relay) return;
		this._actionInFlight = 'advance-checkpoint';
		this._actionError = null;
		try {
			const result = await this.relay.advanceCheckpoint(count);
			if (result.ok) {
				this._status = result.value;
			} else {
				this._actionError = result.error;
			}
		} catch (error) {
			this._actionError = getErrorMessage(error, 'advance-checkpoint failed');
		} finally {
			this._actionInFlight = null;
		}
	};

	#onToggleSlot = async (slot: ForkImpersonationSlot) => {
		if (!this.relay || this._slotToggleInFlight !== null) return;
		this._slotToggleInFlight = slot.address;
		this._slotsError = null;
		try {
			const result = await this.relay.setImpersonation(slot.address, !slot.active);
			if (result.ok) {
				this._slots = result.value;
				// Notify dapp-level integrations (`wallet-controller`) so the
				// signing modal flips its impersonation footnote in lock-step
				// with the toggle. Composed/bubbling so the host element sees
				// it regardless of where the panel was mounted.
				this.dispatchEvent(
					new CustomEvent('fork-impersonation-changed', {
						bubbles: true,
						composed: true,
						detail: {
							address: slot.address,
							active: !slot.active,
							slots: result.value,
						},
					}),
				);
			} else {
				this._slotsError = result.error;
			}
		} catch (error) {
			this._slotsError = getErrorMessage(error, 'toggle failed');
		} finally {
			this._slotToggleInFlight = null;
		}
	};

	// ── Polling ───────────────────────────────────────────────────────────

	#startPolling() {
		this.#stopPolling();
		this.#pollTimer = setInterval(() => {
			void this.#refreshStatus();
		}, STATUS_POLL_MS);
	}

	#stopPolling() {
		if (this.#pollTimer !== null) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
	}

	async #refreshAll(): Promise<void> {
		await Promise.all([this.#refreshStatus(), this.#refreshSlots()]);
	}

	async #refreshStatus(): Promise<void> {
		if (!this.relay) return;
		this._statusLoading = true;
		try {
			const result = await this.relay.getStatus();
			if (result.ok) {
				this._status = result.value;
				this._statusError = null;
			} else {
				this._statusError = result.error;
			}
		} catch (error) {
			this._statusError = getErrorMessage(error, 'status refresh failed');
		} finally {
			this._statusLoading = false;
		}
	}

	async #refreshSlots(): Promise<void> {
		if (!this.relay) return;
		try {
			const result = await this.relay.listImpersonations();
			if (result.ok) {
				this._slots = result.value;
				this._slotsError = null;
			} else {
				this._slotsError = result.error;
			}
		} catch (error) {
			this._slotsError = getErrorMessage(error, 'slot refresh failed');
		}
	}

	/** Public hook for tests + external consumers (e.g. signing-modal
	 *  wants to re-read slots after a transaction lands). Resolves once
	 *  both status + slots have refreshed. */
	async refresh(): Promise<void> {
		await this.#refreshAll();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'dev-wallet-fork-panel': DevWalletForkPanel;
	}
}
