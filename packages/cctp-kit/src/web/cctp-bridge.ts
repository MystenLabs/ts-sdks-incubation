// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ScopedRegistryHost } from '@lit-labs/scoped-registry-mixin';
import { html, LitElement, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import type { ChainDefinition, ChainKey } from '../chains/types.js';
import type { CctpKit } from '../core/index.js';
import type { TransferRecord, TransferStatus } from '../core/types.js';
import { formatUsdc } from '../utils/amount.js';
import { formatDuration, formatElapsed, waitProgress } from '../utils/duration.js';
import { storeProperty } from '../utils/lit.js';
import { sleep } from '../utils/sleep.js';
import { styles } from './cctp-bridge.styles.js';
import { Button } from './internal/button.js';
import { renderChainIcon } from './internal/chain-icon.js';
import { ChainSelect } from './internal/chain-select.js';

const STEP_LABELS: Record<Exclude<TransferStatus, 'complete' | 'failed'>, string> = {
	pending: 'Preparing',
	approving: 'Approving USDC',
	burning: 'Burning',
	attesting: 'Attesting',
	readyToMint: 'Ready to claim',
	minting: 'Minting',
};

const STEPS: { key: string; label: string; statuses: TransferStatus[] }[] = [
	{ key: 'burn', label: 'Burn', statuses: ['pending', 'approving', 'burning'] },
	{ key: 'attest', label: 'Attest', statuses: ['attesting'] },
	{ key: 'mint', label: 'Mint', statuses: ['readyToMint', 'minting'] },
];

/**
 * The USDC bridge widget. Sui is always on one side of the form and is fixed to the
 * network of the host's dapp-kit instance; the other side is a chain picker.
 *
 * @element mysten-cctp-bridge
 * @prop {CctpKit} instance - The kit created with `createCctpKit`.
 * @cssprop --background
 * @cssprop --foreground
 * @cssprop --primary
 * @cssprop --primary-foreground
 * @cssprop --secondary
 * @cssprop --secondary-foreground
 * @cssprop --border
 * @cssprop --accent
 * @cssprop --accent-foreground
 * @cssprop --muted
 * @cssprop --muted-foreground
 * @cssprop --popover
 * @cssprop --popover-foreground
 * @cssprop --destructive
 * @cssprop --positive
 * @cssprop --ring
 * @cssprop --input
 * @cssprop --radius
 * @cssprop --font-sans
 */
@customElement('mysten-cctp-bridge')
export class CctpBridge extends ScopedRegistryHost(LitElement) {
	static elementDefinitions = {
		'internal-button': Button,
		'internal-chain-select': ChainSelect,
	};

	static override styles = styles;

	@storeProperty()
	instance?: CctpKit;

	@state()
	private _busy = false;

	@state()
	private _formError: string | null = null;

	@state()
	private _customRecipient = false;

	@state()
	private _now = Date.now();

	@state()
	private _view: 'bridge' | 'history' = 'bridge';

	@state()
	private _transferIndex = 0;

	#viewsStartHeight?: number;

	@query('.views')
	private _views?: HTMLElement;

	@query('.back')
	private _backButton?: HTMLButtonElement;

	@query('[part="history-toggle"]')
	private _historyToggle?: HTMLButtonElement;

	@state()
	private _importOpen = false;

	@state()
	private _importHash = '';

	@state()
	private _importChain: ChainKey | '' = '';

	@state()
	private _importError: string | null = null;

	#clock: ReturnType<typeof setInterval> | undefined;

	override connectedCallback() {
		super.connectedCallback();
		this.#clock = setInterval(() => {
			const transfers = this.instance?.stores.$transfers.get() ?? [];
			if (transfers.some((t) => t.status === 'attesting')) this._now = Date.now();
		}, 1000);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.#clock) clearInterval(this.#clock);
	}

	override willUpdate() {
		// Remember the card's height before every render so any content change can be eased.
		if (this.hasUpdated && this._views) {
			this.#viewsStartHeight = this._views.getBoundingClientRect().height;
		}
	}

	override updated(changed: Map<PropertyKey, unknown>) {
		this.#animateViewsHeight();
		if (changed.has('_importOpen') && this._importOpen) {
			this.shadowRoot?.querySelector<HTMLInputElement>('.import input')?.focus();
		}
		if (changed.has('_view') && changed.get('_view') !== undefined) {
			// Move focus with the view so keyboard and screen-reader users land on the new pane.
			(this._view === 'history' ? this._backButton : this._historyToggle)?.focus();
		}
	}

	#heightAnimation = 0;

	/**
	 * Ease the card between its height before and after a render instead of snapping, whether
	 * the change came from switching views, opening the track panel, a quote appearing or a
	 * transfer card arriving.
	 */
	#animateViewsHeight() {
		const views = this._views;
		const start = this.#viewsStartHeight;
		this.#viewsStartHeight = undefined;
		if (!views || start === undefined) return;
		const active = views.querySelector<HTMLElement>('.pane:not(.inactive)');
		if (!active) return;
		const end = active.getBoundingClientRect().height;
		if (Math.abs(end - start) < 1) return;
		if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

		const token = ++this.#heightAnimation;
		views.style.transition = 'none';
		views.style.height = `${start}px`;
		void views.offsetHeight; // commit the start height before transitioning
		views.style.transition = 'height 0.28s cubic-bezier(0.4, 0, 0.2, 1)';
		views.style.height = `${end}px`;

		const done = () => {
			if (token !== this.#heightAnimation) return; // a newer animation took over
			views.style.height = '';
			views.style.transition = '';
			views.removeEventListener('transitionend', onEnd);
		};
		// transitionend bubbles from children (the slide track, the panes); only ours counts.
		const onEnd = (event: TransitionEvent) => {
			if (event.target === views && event.propertyName === 'height') done();
		};
		views.addEventListener('transitionend', onEnd);
		setTimeout(done, 400);
	}

	override render() {
		const kit = this.instance;
		if (!kit) return nothing;
		const history = this._view === 'history';
		return html`
			<div class="card" part="card">
				<div class="views">
					<section
						class=${classMap({ pane: true, 'pane-bridge': true, inactive: history })}
						?inert=${history}
						aria-hidden=${history}
					>
						${this.renderBridgeView(kit)}
					</section>
					<section
						class=${classMap({ pane: true, 'pane-history': true, inactive: !history })}
						?inert=${!history}
						aria-hidden=${!history}
					>
						${this.renderHistoryView(kit)}
					</section>
				</div>
			</div>
		`;
	}

	private renderBridgeView(kit: CctpKit) {
		const canFlip = (kit.config.direction ?? 'both') === 'both';
		const problem = kit.validate();

		return html`
			<div class="header">
				<h2 class="title">${kit.config.ui?.title ?? 'Bridge USDC'}</h2>
				${this.renderSpeed(kit)}
			</div>

			<div class="panels">
				${this.renderPanel(kit, 'from')}
				${canFlip
					? html`<button
							type="button"
							class="flip"
							part="flip"
							title="Swap direction"
							aria-label="Swap direction"
							@click=${() => kit.flipDirection()}
						>
							${flipIcon}
						</button>`
					: html`<span class="flip" aria-hidden="true">${downIcon}</span>`}
				${this.renderPanel(kit, 'to')}
			</div>

			${this.renderSpeedNote(kit)} ${this.renderQuote(kit)}

			<internal-button
				variant="primary"
				?disabled=${this._busy || problem !== null}
				@click=${() => this.submit()}
			>
				${this._busy ? 'Working…' : (problem ?? 'Bridge')}
			</internal-button>
			${this._formError ? html`<p class="error">${this._formError}</p>` : nothing}
			${this.renderTransfers(kit)} ${this._importOpen ? this.renderImport(kit) : nothing}
			<div class="footer-links">
				${this._importOpen ? nothing : this.renderImportToggle()} ${this.renderHistoryToggle(kit)}
			</div>
		`;
	}

	private renderPanel(kit: CctpKit, side: 'from' | 'to') {
		const { stores } = kit;
		const chain = side === 'from' ? stores.$sourceChain.get() : stores.$destinationChain.get();
		const account =
			side === 'from' ? stores.$sourceAccount.get() : stores.$destinationAccount.get();
		const isSui = chain.ecosystem === 'sui';

		return html`
			<div class="panel" part=${side}>
				<div class="row">
					<span class="label">${side === 'from' ? 'From' : 'To'}</span>
					${isSui
						? html`<span class="chain-static" part="sui-chain">
								${renderChainIcon(chain)}
								<span>${chain.name}</span>
							</span>`
						: html`<internal-chain-select
								.options=${stores.$counterpartOptions.get()}
								.value=${chain.key}
								@chain-change=${(e: CustomEvent<{ key: ChainKey }>) =>
									kit.setCounterpartChain(e.detail.key)}
							></internal-chain-select>`}
				</div>

				${side === 'from' ? this.renderAmount(kit) : this.renderReceive(kit)}

				<div class="row">
					${side === 'from' ? this.renderBalance(kit) : this.renderRecipientToggle(kit, chain)}
					${this.renderWallet(kit, chain, account)}
				</div>

				${side === 'to' && this.showRecipientField(chain, account)
					? html`<input
							class="field"
							type="text"
							placeholder="Recipient address on ${chain.name}"
							.value=${stores.$recipient.get()}
							@input=${(e: Event) => kit.setRecipient((e.target as HTMLInputElement).value)}
						/>`
					: nothing}
			</div>
		`;
	}

	private renderAmount(kit: CctpKit) {
		return html`
			<div class="amount-row">
				<input
					class="amount-input"
					type="text"
					inputmode="decimal"
					autocomplete="off"
					placeholder="0.00"
					aria-label="Amount"
					.value=${kit.stores.$amount.get()}
					@input=${(e: Event) => kit.setAmount((e.target as HTMLInputElement).value)}
				/>
				<span class="unit">USDC</span>
			</div>
		`;
	}

	private renderReceive(kit: CctpKit) {
		const quote = kit.stores.$quote.get();
		const value = quote && quote.amount > 0n ? formatUsdc(quote.receiveAmount) : '';
		return html`
			<div class="amount-row">
				<span class=${classMap({ 'amount-static': true, empty: !value })} aria-label="You receive">
					${value || '0.00'}
				</span>
				<span class="unit">USDC</span>
			</div>
		`;
	}

	private renderBalance(kit: CctpKit) {
		const balance = kit.stores.$balance.get().source;
		if (balance === null) return html`<span class="muted"></span>`;
		return html`<span class="muted">
			Balance: ${formatUsdc(balance)} USDC
			${balance > 0n
				? html`<span class="text-button" @click=${() => kit.setAmount(formatUsdc(balance))}
						>Max</span
					>`
				: nothing}
		</span>`;
	}

	private renderRecipientToggle(kit: CctpKit, chain: ChainDefinition) {
		const account = kit.stores.$destinationAccount.get();
		if (!account && chain.ecosystem !== 'sui') {
			return html`<span class="muted">Sending to a custom address</span>`;
		}
		if (this._customRecipient) {
			return html`<button
				type="button"
				class="text-button"
				@click=${() => {
					this._customRecipient = false;
					kit.setRecipient('');
				}}
			>
				Use connected wallet
			</button>`;
		}
		return html`<button
			type="button"
			class="text-button"
			@click=${() => (this._customRecipient = true)}
		>
			Send to a different address
		</button>`;
	}

	private showRecipientField(chain: ChainDefinition, account: { address: string } | null) {
		return this._customRecipient || (!account && chain.ecosystem !== 'sui');
	}

	private renderWallet(kit: CctpKit, chain: ChainDefinition, account: { address: string } | null) {
		if (chain.ecosystem === 'sui') {
			return account
				? html`<span class="pill" title=${account.address}>${shorten(account.address)}</span>`
				: html`<span class="muted">Connect your Sui wallet to continue</span>`;
		}
		const ecosystem = chain.ecosystem;
		return account
			? html`<span class="pill" title=${account.address}>
					${shorten(account.address)}
					<button type="button" class="text-button" @click=${() => kit.disconnect(ecosystem)}>
						Disconnect
					</button>
				</span>`
			: html`<internal-button variant="secondary" small @click=${() => this.connect(kit, chain)}>
					Connect wallet
				</internal-button>`;
	}

	private renderSpeed(kit: CctpKit) {
		if (kit.allowedSpeeds.length < 2) return nothing;
		const speed = kit.stores.$speed.get();
		const fastAvailable = kit.stores.$fastAvailable.get();
		const reason = kit.stores.$fastUnavailableReason.get();
		return html`
			<div class="segmented" role="radiogroup" aria-label="Transfer speed">
				${kit.allowedSpeeds.map((s) => {
					const disabled = s === 'fast' && fastAvailable === false;
					return html`<button
						type="button"
						role="radio"
						aria-checked=${s === speed}
						?disabled=${disabled}
						title=${disabled && reason ? reason : ''}
						class=${s === speed ? 'active' : ''}
						@click=${() => kit.setSpeed(s)}
					>
						${s === 'fast' ? 'Fast' : 'Standard'}
					</button>`;
				})}
			</div>
		`;
	}

	private renderSpeedNote(kit: CctpKit) {
		if (kit.allowedSpeeds.length < 2) return nothing;
		const reason = kit.stores.$fastUnavailableReason.get();
		if (kit.stores.$fastAvailable.get() !== false || !reason) return nothing;
		return html`<p class="muted" part="speed-note">Fast Transfer unavailable: ${reason}.</p>`;
	}

	private renderQuote(kit: CctpKit) {
		const quote = kit.stores.$quote.get();
		const error = kit.stores.$quoteError.get();
		if (error) return html`<p class="error">${error}</p>`;
		if (!quote || quote.amount === 0n) return nothing;
		return html`
			<div class="quote" part="quote">
				<div class="row">
					<span>Circle fee</span>
					<span>${quote.fee === 0n ? 'Free' : `${formatUsdc(quote.fee)} USDC`}</span>
				</div>
				<div class="row">
					<span>Attestation wait</span>
					<span>${formatDuration(quote.estimate.minSeconds, quote.estimate.maxSeconds)}</span>
				</div>
				<div class="row">
					<span>Then</span>
					<span>Mint on ${kit.stores.$destinationChain.get().name}, signed by you</span>
				</div>
			</div>
		`;
	}

	/** In-flight transfers, one card at a time, the active one first. */
	private renderTransfers(kit: CctpKit) {
		const { stores } = kit;
		const activeId = stores.$activeTransferId.get();
		const list = stores.$transfers
			.get()
			.filter((t) => t.status !== 'complete')
			.sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : b.createdAt - a.createdAt));
		if (!list.length) return nothing;
		const index = Math.min(this._transferIndex, list.length - 1);
		const many = list.length > 1;
		return html`
			<div class="transfers" part="transfers">
				<div class="row transfers-head">
					<span class="label">
						${many ? `Transfers · ${index + 1} of ${list.length}` : 'Transfer'}
					</span>
					${many
						? html`<span class="pager">
								<button
									type="button"
									class="pager-btn"
									aria-label="Previous transfer"
									?disabled=${index === 0}
									@click=${() => (this._transferIndex = index - 1)}
								>
									${backIcon}
								</button>
								<button
									type="button"
									class="pager-btn"
									aria-label="Next transfer"
									?disabled=${index === list.length - 1}
									@click=${() => (this._transferIndex = index + 1)}
								>
									${nextIcon}
								</button>
							</span>`
						: nothing}
				</div>
				<div class="carousel">
					<div class="track" style="transform: translateX(-${index * 100}%)">
						${list.map(
							(t, i) =>
								html`<div class="slide" ?inert=${i !== index} aria-hidden=${i !== index}>
									${this.renderTransfer(t, kit)}
								</div>`,
						)}
					</div>
				</div>
			</div>
		`;
	}

	private renderTransfer(transfer: TransferRecord, kit: CctpKit) {
		const from = kit.chains.find((c) => c.key === transfer.from);
		const to = kit.chains.find((c) => c.key === transfer.to);
		const activeIndex = STEPS.findIndex((s) => s.statuses.includes(transfer.status));
		const failed = transfer.status === 'failed';
		const complete = transfer.status === 'complete';
		const running = kit.isRunning(transfer.id);
		const interrupted =
			!running &&
			(transfer.status === 'attesting' ||
				transfer.status === 'minting' ||
				(transfer.status === 'burning' && !!transfer.sourceTxHash));
		// Never got as far as a burn hash: the burn did not go through, so this is a fresh retry.
		const unstarted =
			!running &&
			!transfer.sourceTxHash &&
			(transfer.status === 'pending' ||
				transfer.status === 'approving' ||
				transfer.status === 'burning');
		const canResume = failed || transfer.status === 'readyToMint' || interrupted || unstarted;
		const canRemove = neverBurned(transfer) && !running;
		const statusLabel = complete
			? 'Complete'
			: failed
				? 'Needs attention'
				: (STEP_LABELS[transfer.status as keyof typeof STEP_LABELS] ?? '');

		return html`
			<div class="transfer" part="transfer">
				<div class="row">
					<span class="transfer-title">
						${formatUsdc(transfer.amount)} USDC · ${from?.name} → ${to?.name}
					</span>
					<span class="muted">${statusLabel}</span>
				</div>
				${transfer.status === 'attesting' && from ? this.renderWait(transfer, from) : nothing}
				<ol class="stepper" aria-label="Transfer progress">
					${STEPS.map((step, i) => {
						const done =
							complete ||
							(activeIndex !== -1 && i < activeIndex) ||
							(step.key === 'burn' && !!transfer.sourceTxHash) ||
							(step.key === 'attest' && !!transfer.attestation);
						const isActive = !complete && !failed && i === activeIndex;
						const isFailed = failed && !done && i === failedIndex(transfer);
						const link =
							step.key === 'burn' && transfer.sourceTxHash && from
								? txUrl(from, transfer.sourceTxHash)
								: step.key === 'mint' && transfer.destinationTxHash && to
									? txUrl(to, transfer.destinationTxHash)
									: null;
						return html`<li
								class=${classMap({ step: true, done, active: isActive, failed: isFailed })}
							>
								<span class="dot"></span>
								<span>${step.label}</span>
								${link
									? html`<a class="link muted" target="_blank" rel="noreferrer" href=${link}
											>view</a
										>`
									: nothing}
							</li>
							${i < STEPS.length - 1
								? html`<li class="connector" aria-hidden="true"></li>`
								: nothing}`;
					})}
				</ol>
				${failed && transfer.error ? html`<p class="error">${transfer.error}</p>` : nothing}
				${canResume
					? html`<div class="actions">
							<internal-button
								variant="primary"
								small
								?disabled=${this._busy}
								@click=${() => this.resume(kit, transfer.id)}
							>
								${transfer.status === 'readyToMint' || (failed && transfer.attestation)
									? 'Claim'
									: interrupted || (failed && transfer.sourceTxHash)
										? 'Resume'
										: 'Retry'}
							</internal-button>
							${canRemove ? this.renderRemove(kit, transfer) : nothing}
						</div>`
					: nothing}
			</div>
		`;
	}

	private renderWait(transfer: TransferRecord, from: ChainDefinition) {
		const [min, max] = estimateRange(from, transfer.speed);
		const progress = waitProgress(
			transfer.attestingSince ?? transfer.updatedAt,
			min,
			max,
			this._now,
		);
		return html`
			<div class="wait" part="wait">
				<div class="row">
					<span class="muted">Waiting ${formatElapsed(progress.elapsedSeconds)}</span>
					<span class="muted">
						${progress.overdue
							? `Taking longer than the usual ${formatDuration(min, max)}`
							: `${progress.remaining} remaining`}
					</span>
				</div>
				<div
					class="progress"
					role="progressbar"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow=${Math.round(progress.fraction * 100)}
				>
					<span
						class=${progress.overdue ? 'overdue' : ''}
						style="width: ${progress.fraction * 100}%"
					></span>
				</div>
			</div>
		`;
	}

	private renderImportToggle() {
		return html`<button
			type="button"
			class="text-button"
			part="import-toggle"
			@click=${() => (this._importOpen = true)}
		>
			Track a transfer by transaction hash
		</button>`;
	}

	private renderImport(kit: CctpKit) {
		const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(this._importHash.trim());
		const evmChains = kit.chains.filter((c) => c.ecosystem === 'evm');
		const chainValue =
			this._importChain ||
			(evmChains.find((c) => c.key === kit.stores.$counterpartChain.get().key)?.key ??
				evmChains[0]?.key ??
				'');
		return html`
			<div class="panel import" part="import">
				<div class="row">
					<span class="label">Track a transfer</span>
					<button
						type="button"
						class="pager-btn"
						aria-label="Close"
						@click=${() => this.closeImport()}
					>
						${closeIcon}
					</button>
				</div>
				<p class="muted import-hint">
					Paste the burn transaction hash from Ethereum, another EVM chain, Sui or Solana. The
					transfer is added to your list and claimed from here.
				</p>
				<input
					class="field"
					type="text"
					autocomplete="off"
					spellcheck="false"
					placeholder="Transaction hash"
					aria-label="Source transaction hash"
					.value=${this._importHash}
					@input=${(e: Event) => (this._importHash = (e.target as HTMLInputElement).value)}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter' && this._importHash.trim() && !this._busy) {
							void this.importTransfer(kit, evmChains);
						}
					}}
				/>
				${isEvmHash
					? html`<div class="row">
							<span class="muted">Sent on</span>
							<internal-chain-select
								.options=${evmChains}
								.value=${chainValue}
								@chain-change=${(e: CustomEvent<{ key: ChainKey }>) =>
									(this._importChain = e.detail.key)}
							></internal-chain-select>
						</div>`
					: nothing}
				${this._importError ? html`<p class="error">${this._importError}</p>` : nothing}
				<internal-button
					variant="primary"
					?disabled=${this._busy || !this._importHash.trim()}
					@click=${() => this.importTransfer(kit, evmChains)}
				>
					${this._busy ? 'Looking up…' : 'Track transfer'}
				</internal-button>
			</div>
		`;
	}

	private renderHistoryToggle(kit: CctpKit) {
		const count = kit.stores.$history.get().length;
		return html`<button
			type="button"
			class="text-button"
			part="history-toggle"
			@click=${() => (this._view = 'history')}
		>
			${count ? `History (${count})` : 'History'}
		</button>`;
	}

	private renderHistoryView(kit: CctpKit) {
		const records = [...kit.stores.$history.get()].sort((a, b) => b.createdAt - a.createdAt);
		const wallets = kit.stores.$wallets.get();
		const connected = !!(wallets.sui || wallets.evm || wallets.solana);
		return html`
			<div class="header">
				<button
					type="button"
					class="back"
					part="back"
					aria-label="Back to bridge"
					@click=${() => (this._view = 'bridge')}
				>
					${backIcon}
				</button>
				<h2 class="title">History</h2>
				<span class="header-spacer"></span>
			</div>
			${records.length
				? html`<div class="history" part="history">
						${records.map((t) => this.renderHistoryRow(t, kit))}
					</div>`
				: html`<p class="muted history-empty">
						${connected
							? 'No transfers for the connected wallet yet.'
							: 'Connect a wallet to see its transfers.'}
					</p>`}
		`;
	}

	private renderHistoryRow(transfer: TransferRecord, kit: CctpKit) {
		const from = kit.chains.find((c) => c.key === transfer.from);
		const to = kit.chains.find((c) => c.key === transfer.to);
		const running = kit.isRunning(transfer.id);
		const actionable =
			!running &&
			(transfer.status === 'failed' ||
				transfer.status === 'readyToMint' ||
				(!transfer.sourceTxHash && transfer.status !== 'complete'));
		const label =
			transfer.status === 'complete'
				? 'Complete'
				: transfer.status === 'failed'
					? 'Failed'
					: transfer.status === 'readyToMint'
						? 'Ready to claim'
						: running
							? 'In progress'
							: 'Interrupted';
		return html`
			<div class="history-row">
				<div class="history-main">
					<span
						>${formatUsdc(transfer.amount)} USDC · ${from?.name ?? transfer.from} →
						${to?.name ?? transfer.to}</span
					>
					<span class="muted">
						${new Date(transfer.createdAt).toLocaleString()} · ${label}
						${transfer.sourceTxHash && from
							? html` ·
									<a
										class="link"
										target="_blank"
										rel="noreferrer"
										href=${txUrl(from, transfer.sourceTxHash)}
										>burn</a
									>`
							: nothing}
						${transfer.destinationTxHash && to
							? html` ·
									<a
										class="link"
										target="_blank"
										rel="noreferrer"
										href=${txUrl(to, transfer.destinationTxHash)}
										>mint</a
									>`
							: nothing}
					</span>
				</div>
				<div class="actions">
					${actionable
						? html`<internal-button
								variant="secondary"
								small
								?disabled=${this._busy}
								@click=${() => this.resume(kit, transfer.id)}
							>
								${transfer.status === 'readyToMint' ? 'Claim' : 'Retry'}
							</internal-button>`
						: nothing}
					${neverBurned(transfer) && !running ? this.renderRemove(kit, transfer) : nothing}
				</div>
			</div>
		`;
	}

	private closeImport() {
		this._importOpen = false;
		this._importHash = '';
		this._importChain = '';
		this._importError = null;
	}

	private async importTransfer(kit: CctpKit, evmChains: ChainDefinition[]) {
		const txHash = this._importHash.trim();
		const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(txHash);
		const sourceChain = isEvmHash
			? this._importChain ||
				(evmChains.find((c) => c.key === kit.stores.$counterpartChain.get().key)?.key ??
					evmChains[0]?.key)
			: undefined;
		this._busy = true;
		this._importError = null;
		try {
			await kit.importTransfer({ txHash, sourceChain: sourceChain || undefined });
			this.closeImport();
		} catch (error) {
			this._importError = error instanceof Error ? error.message : String(error);
		} finally {
			this._busy = false;
		}
	}

	private async connect(kit: CctpKit, chain: ChainDefinition) {
		if (chain.ecosystem === 'sui') return;
		this._formError = null;
		try {
			await kit.connect(chain.ecosystem);
		} catch (error) {
			this._formError = error instanceof Error ? error.message : String(error);
		}
	}

	/** Offered only for a transfer that never burned: there is nothing to lose track of. */
	private renderRemove(kit: CctpKit, transfer: TransferRecord) {
		return html`<internal-button
			variant="ghost"
			small
			?disabled=${this._busy}
			@click=${() => kit.removeUnburned(transfer.id)}
		>
			Remove
		</internal-button>`;
	}

	private async submit() {
		const kit = this.instance;
		if (!kit || this._busy) return;
		this._formError = null;
		// Check the amount against what the wallet holds now, not what it held when the form
		// was filled in. Not from Sui: a Sui wallet that signs in a window it opens itself can
		// only open it while the click is still being handled, so nothing may be awaited first.
		if (kit.stores.$sourceChain.get().ecosystem !== 'sui') {
			this._busy = true;
			try {
				await Promise.race([kit.refreshBalance(), sleep(BALANCE_CHECK_LIMIT_MS)]);
			} finally {
				this._busy = false;
			}
			const problem = kit.validate();
			if (problem) {
				this._formError = problem;
				return;
			}
		}
		await this.runWithBusy(kit, () => kit.transfer(), { clearAmountOnBurn: true });
	}

	/**
	 * Hold the form busy only while the user is signing / the burn is confirming; once the burn
	 * has a hash the transfer card takes over and the form is free for another transfer.
	 */
	private async runWithBusy(
		kit: CctpKit,
		start: () => Promise<TransferRecord>,
		options: { clearAmountOnBurn?: boolean; id?: string } = {},
	) {
		this._busy = true;
		let released = false;
		let unsubscribe: (() => void) | undefined;
		const release = (burned: boolean) => {
			if (released) return;
			released = true;
			unsubscribe?.();
			this._busy = false;
			if (burned && options.clearAmountOnBurn) kit.setAmount('');
		};
		// The transfer this run is about: the one named, or the one `start` creates. Not whichever
		// transfer was active before, which is what is left when `start` creates nothing.
		const known = new Set(kit.stores.$transfers.get().map((t) => t.id));
		let id: string | undefined = options.id;
		try {
			const run = start();
			id ??= kit.stores.$transfers.get().find((t) => !known.has(t.id))?.id;
			if (id) {
				unsubscribe = kit.stores.$transfers.subscribe((list) => {
					const t = list.find((r) => r.id === id);
					if (!t) return;
					const pastBurn =
						!!t.sourceTxHash &&
						t.status !== 'pending' &&
						t.status !== 'approving' &&
						t.status !== 'burning';
					if (pastBurn || t.status === 'complete') release(true);
				});
				// The store calls back once straight away, before there was anything to unsubscribe.
				if (released) unsubscribe();
			}
			await run;
			release(false);
		} catch (error) {
			// A failed transfer says why on its own card. The form reports only what never
			// became a transfer.
			if (!id) this._formError = error instanceof Error ? error.message : String(error);
			release(false);
		}
	}

	private async resume(kit: CctpKit, id: string) {
		if (this._busy) return;
		this._formError = null;
		await this.runWithBusy(kit, () => kit.resume(id), { id });
	}
}

/** How long Bridge waits for a fresh balance before going ahead with the one it has. */
const BALANCE_CHECK_LIMIT_MS = 5_000;

/** No burn was sent for this transfer, so no funds depend on its record. */
function neverBurned(transfer: TransferRecord): boolean {
	return (
		!transfer.sourceTxHash &&
		!transfer.droppedSourceTxHash &&
		transfer.status !== 'complete' &&
		!transfer.attestation
	);
}

const backIcon = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<path
		d="M10 3L5 8l5 5"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>`;

const nextIcon = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<path
		d="M6 3l5 5-5 5"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>`;

const closeIcon = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
</svg>`;

const flipIcon = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<path
		d="M5 2.5v11M5 13.5l-2.5-2.5M5 13.5l2.5-2.5M11 13.5v-11M11 2.5L8.5 5M11 2.5L13.5 5"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>`;

const downIcon = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	<path
		d="M8 2.5v11M8 13.5l-3.5-3.5M8 13.5l3.5-3.5"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>`;

function estimateRange(chain: ChainDefinition, speed: 'fast' | 'standard'): [number, number] {
	const range = (speed === 'fast' && chain.finality.fast) || chain.finality.standard;
	return [range[0], range[1]];
}

function shorten(address: string): string {
	return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function txUrl(chain: ChainDefinition, hash: string): string {
	switch (chain.ecosystem) {
		case 'sui':
			return `${chain.explorerUrl}/tx/${hash}`;
		case 'solana':
			return chain.explorerUrl.includes('?')
				? `https://explorer.solana.com/tx/${hash}?cluster=devnet`
				: `${chain.explorerUrl}/tx/${hash}`;
		case 'evm':
			return `${chain.explorerUrl}/tx/${hash}`;
	}
}

/** Best guess of which step a failed transfer was on, from what it persisted. */
function failedIndex(transfer: TransferRecord): number {
	if (transfer.attestation) return 2;
	if (transfer.sourceTxHash) return 1;
	return 0;
}

declare global {
	interface HTMLElementTagNameMap {
		'mysten-cctp-bridge': CctpBridge;
	}
}
