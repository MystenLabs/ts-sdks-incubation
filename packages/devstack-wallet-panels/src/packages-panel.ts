import { html, LitElement, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import { getActiveManifest } from './manifest-context.js';
import { panelStyles } from './styles.js';

@customElement('devstack-packages-panel')
export class DevstackPackagesPanel extends LitElement {
	static override styles = [panelStyles];

	override render() {
		const manifest = getActiveManifest();
		if (manifest === null) {
			return html`<div class="empty">No manifest loaded — run <code>devstack up</code>.</div>`;
		}
		const packages = manifest.registry.packages ?? [];
		const tokens = manifest.registry.coin?.tokens ?? [];
		if (packages.length === 0 && tokens.length === 0) {
			return html`<div class="empty">No packages registered yet.</div>`;
		}
		return html`
			${packages.length === 0
				? nothing
				: html`
						<div class="section">
							<div class="heading">Packages</div>
							${packages.map(
								(p) => html`
									<div class="row">
										<span class="label">${p.name}</span>
										<button
											class="action"
											type="button"
											title=${p.packageId}
											@click=${() => copyToClipboard(p.packageId)}
										>
											${shortId(p.packageId)}
										</button>
									</div>
									${renderCaptured(p.captured ?? {})}
								`,
							)}
						</div>
					`}
			${tokens.length === 0
				? nothing
				: html`
						<div class="section">
							<div class="heading">Tokens</div>
							${tokens.map(
								(t) => html`
									<div class="row">
										<span class="label">${t.name}</span>
										<span class="value">${t.type}</span>
									</div>
								`,
							)}
						</div>
					`}
		`;
	}
}

function renderCaptured(captured: Record<string, string>) {
	const entries = Object.entries(captured);
	if (entries.length === 0) return nothing;
	return html`<div class="section" style="margin-left:8px;">
		${entries.map(
			([key, value]) => html`
				<div class="row">
					<span class="label">${key}</span>
					<button
						class="action"
						type="button"
						title=${value}
						@click=${() => copyToClipboard(value)}
					>
						${shortId(value)}
					</button>
				</div>
			`,
		)}
	</div>`;
}

function shortId(id: string): string {
	if (id.length <= 14) return id;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

async function copyToClipboard(value: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
	} catch {
		// Best-effort — older browsers / non-secure contexts.
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'devstack-packages-panel': DevstackPackagesPanel;
	}
}
