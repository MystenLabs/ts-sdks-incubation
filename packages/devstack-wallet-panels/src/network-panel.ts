import { html, LitElement, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import { getActiveManifest } from './manifest-context.js';
import { panelStyles } from './styles.js';

@customElement('devstack-network-panel')
export class DevstackNetworkPanel extends LitElement {
	static override styles = [panelStyles];

	override render() {
		const manifest = getActiveManifest();
		if (manifest === null) {
			return html`<div class="empty">No manifest loaded — run <code>devstack up</code>.</div>`;
		}
		const services = manifest.registry.services ?? [];
		const accounts = manifest.registry.accounts ?? [];
		return html`
			<div class="section">
				<div class="heading">Stack</div>
				<div class="row">
					<span class="label">App</span>
					<span class="value">${manifest.app || '—'}</span>
				</div>
				<div class="row">
					<span class="label">Network</span>
					<span class="value">${manifest.network}</span>
				</div>
				<div class="row">
					<span class="label">Emitted</span>
					<span class="value">${formatTime(manifest.emittedAt)}</span>
				</div>
			</div>
			${services.length === 0
				? nothing
				: html`
						<div class="section">
							<div class="heading">Services</div>
							${services.map(
								(s) => html`
									<div class="row">
										<span class="label">${s.name}</span>
										<span class="value">${s.url}</span>
									</div>
								`,
							)}
						</div>
					`}
			${accounts.length === 0
				? nothing
				: html`
						<div class="section">
							<div class="heading">Seeded accounts</div>
							${accounts.map(
								(a) => html`
									<div class="row">
										<span class="label">${a.name}</span>
										<span class="value">${shortAddress(a.address)}</span>
									</div>
								`,
							)}
						</div>
					`}
		`;
	}
}

function shortAddress(address: string): string {
	if (address.length <= 14) return address;
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTime(iso: string): string {
	if (!iso) return '—';
	try {
		const d = new Date(iso);
		return d.toLocaleTimeString();
	} catch {
		return iso;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'devstack-network-panel': DevstackNetworkPanel;
	}
}
