import type { ClientWithCoreApi } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Wallet, WalletAccount } from '@mysten/wallet-standard';
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { getActiveManifest } from './manifest-context.js';
import { panelStyles } from './styles.js';
import type { DevstackToken } from './types.js';

interface FaucetStatus {
	target: string;
	state: 'idle' | 'pending' | 'ok' | 'error';
	message?: string;
}

@customElement('devstack-faucet-panel')
export class DevstackFaucetPanel extends LitElement {
	static override styles = [panelStyles];

	@property({ attribute: false })
	wallet: Wallet | null = null;

	@property({ attribute: false })
	activeAddress = '';

	@property({ attribute: false })
	client: ClientWithCoreApi | null = null;

	@state()
	private _status: FaucetStatus = { target: '', state: 'idle' };

	override render() {
		const manifest = getActiveManifest();
		if (manifest === null) {
			return html`<div class="empty">No manifest loaded — run <code>devstack up</code>.</div>`;
		}
		const recipient = this.activeAddress;
		if (recipient === '') {
			return html`<div class="empty">Connect a wallet account to use the faucet.</div>`;
		}
		const faucetUrl = manifest.registry.services?.find((s) => s.name === 'sui-faucet')?.url;
		const packages = manifest.registry.packages ?? [];
		const tokens = (manifest.registry.coin?.tokens ?? []).map((t) => {
			if (t.treasuryCapId !== undefined) return t;
			// Fallback: read the package's captured TreasuryCap object id by
			// matching the token's package id against `manifest.registry.packages`.
			// Lets the panel work with examples whose plugin registers tokens
			// without explicitly forwarding `result.captured.treasuryCapId`.
			const packageId = parseTokenPackage(t.type);
			const pkg = packages.find((p) => p.packageId === packageId);
			const treasuryCapId = pkg?.captured?.treasuryCapId;
			return treasuryCapId !== undefined ? { ...t, treasuryCapId } : t;
		});
		const publisherAddr = manifest.registry.accounts?.find((a) => a.name === 'publisher')?.address;
		return html`
			<div class="section">
				<div class="heading">SUI</div>
				${faucetUrl === undefined
					? html`<div class="empty">Faucet not exposed in manifest.</div>`
					: html`
							<div class="row">
								<span class="label">Top up active account</span>
								<button
									class="action primary"
									type="button"
									?disabled=${this._isPending('sui')}
									@click=${() => this.#topUpSui(faucetUrl, recipient)}
								>
									${this._isPending('sui') ? 'Requesting…' : 'Drip SUI'}
								</button>
							</div>
						`}
			</div>
			${tokens.length === 0
				? nothing
				: html`
						<div class="section">
							<div class="heading">Tokens</div>
							${publisherAddr === undefined
								? html`<div class="empty">
										Publisher account missing from manifest — minting unavailable.
									</div>`
								: tokens.map((t) => this.#renderTokenRow(t, publisherAddr, recipient))}
						</div>
					`}
			${this._status.state === 'ok' && this._status.message
				? html`<div class="success">${this._status.message}</div>`
				: nothing}
			${this._status.state === 'error' && this._status.message
				? html`<div class="error">${this._status.message}</div>`
				: nothing}
		`;
	}

	#renderTokenRow(token: DevstackToken, publisher: string, recipient: string) {
		const target = `token:${token.name}`;
		const pending = this._isPending(target);
		const canMint = token.treasuryCapId !== undefined;
		return html`
			<div class="row">
				<span class="label">${token.name.toUpperCase()}</span>
				<button
					class="action primary"
					type="button"
					?disabled=${pending || !canMint}
					title=${canMint
						? `Mint via publisher ${shortAddr(publisher)}`
						: 'TreasuryCap missing from manifest'}
					@click=${() => this.#mintToken(token, publisher, recipient)}
				>
					${pending ? 'Minting…' : `Mint ${displayAmount(1, token.decimals)} ${token.name}`}
				</button>
			</div>
		`;
	}

	_isPending(target: string): boolean {
		return this._status.target === target && this._status.state === 'pending';
	}

	#setStatus(status: FaucetStatus): void {
		this._status = status;
	}

	async #topUpSui(faucetUrl: string, recipient: string): Promise<void> {
		this.#setStatus({ target: 'sui', state: 'pending' });
		try {
			const res = await fetch(`${faucetUrl}/v1/gas`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					FixedAmountRequest: { recipient },
				}),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(`Faucet returned ${res.status}: ${body || res.statusText}`);
			}
			const body = (await res.json().catch(() => null)) as {
				status?: string;
				coins_sent?: unknown[];
				error?: unknown;
			} | null;
			const coinsSent = Array.isArray(body?.coins_sent) ? body.coins_sent.length : 0;
			if (coinsSent === 0) {
				this.#setStatus({
					target: 'sui',
					state: 'error',
					message:
						(typeof body?.error === 'string' && body.error) ||
						'Faucet returned success but sent no coins (rate limited or recipient already funded).',
				});
				return;
			}
			this.#setStatus({
				target: 'sui',
				state: 'ok',
				message: `Faucet sent ${coinsSent} coin${coinsSent === 1 ? '' : 's'}`,
			});
		} catch (err) {
			this.#setStatus({
				target: 'sui',
				state: 'error',
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #mintToken(
		token: DevstackToken,
		publisherAddress: string,
		recipient: string,
	): Promise<void> {
		const target = `token:${token.name}`;
		this.#setStatus({ target, state: 'pending' });
		try {
			if (this.wallet === null || this.client === null) {
				throw new Error('Wallet/client unavailable');
			}
			if (token.treasuryCapId === undefined) {
				throw new Error('TreasuryCap not registered in manifest');
			}
			const publisher = this.wallet.accounts.find((a) => a.address === publisherAddress) as
				| WalletAccount
				| undefined;
			if (publisher === undefined) {
				throw new Error(
					`Publisher (${shortAddr(publisherAddress)}) not connected in this wallet — open Settings → Accounts and import it.`,
				);
			}
			const moduleName = parseTokenModule(token.type);
			const packageId = parseTokenPackage(token.type);
			const amount = BigInt(10) ** BigInt(token.decimals);
			const tx = new Transaction();
			tx.setSender(publisherAddress);
			tx.moveCall({
				target: `${packageId}::${moduleName}::mint`,
				arguments: [
					tx.object(token.treasuryCapId),
					tx.pure.u64(amount),
					tx.pure.address(recipient),
				],
			});
			const features = this.wallet.features as Record<string, unknown>;
			const feature = features['sui:signAndExecuteTransaction'] as
				| {
						signAndExecuteTransaction: (input: unknown) => Promise<{ digest: string }>;
				  }
				| undefined;
			if (feature === undefined) {
				throw new Error('Wallet does not implement signAndExecuteTransaction');
			}
			const result = await feature.signAndExecuteTransaction({
				account: publisher,
				chain: 'sui:localnet',
				transaction: { toJSON: async () => await tx.toJSON() },
			});
			this.#setStatus({
				target,
				state: 'ok',
				message: `Minted ${displayAmount(1, token.decimals)} ${token.name} (${shortDigest(result.digest)})`,
			});
		} catch (err) {
			this.#setStatus({
				target,
				state: 'error',
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

function shortAddr(address: string): string {
	if (address.length <= 12) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortDigest(digest: string): string {
	if (digest.length <= 12) return digest;
	return `${digest.slice(0, 8)}…`;
}

function displayAmount(units: number, decimals: number): string {
	return units.toFixed(decimals === 0 ? 0 : Math.min(decimals, 6));
}

function parseTokenPackage(type: string): string {
	return type.split('::')[0] ?? '';
}

function parseTokenModule(type: string): string {
	return type.split('::')[1] ?? '';
}

declare global {
	interface HTMLElementTagNameMap {
		'devstack-faucet-panel': DevstackFaucetPanel;
	}
}
