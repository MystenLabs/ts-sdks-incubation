import { css } from 'lit';

/**
 * Reusable styles. Tokens follow the dev-wallet host's CSS variable
 * scheme (`--dev-wallet-*`) so panels inherit theming without
 * registering their own variables.
 */
export const panelStyles = css`
	:host {
		display: block;
		font-size: 13px;
		color: var(--dev-wallet-foreground, #1f1f1f);
	}

	.section {
		margin-bottom: 14px;
	}

	.section:last-child {
		margin-bottom: 0;
	}

	.heading {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--dev-wallet-muted-foreground, #6b6b6b);
		margin-bottom: 6px;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border: 1px solid var(--dev-wallet-border, #e5e5e5);
		border-radius: 6px;
		background: var(--dev-wallet-secondary, #f8f8f8);
		margin-bottom: 6px;
	}

	.row:last-child {
		margin-bottom: 0;
	}

	.row .label {
		font-weight: 500;
	}

	.row .value {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace;
		font-size: 11px;
		color: var(--dev-wallet-muted-foreground, #4f4f4f);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}

	button.action {
		font: inherit;
		font-size: 12px;
		padding: 5px 10px;
		border-radius: 5px;
		border: 1px solid var(--dev-wallet-border, #d4d4d4);
		background: var(--dev-wallet-background, #ffffff);
		color: var(--dev-wallet-foreground, #1f1f1f);
		cursor: pointer;
		transition: background-color 0.15s;
	}

	button.action:hover {
		background: var(--dev-wallet-secondary, #f0f0f0);
	}

	button.action:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	button.primary {
		background: var(--dev-wallet-primary, #2563eb);
		color: var(--dev-wallet-primary-foreground, #ffffff);
		border-color: transparent;
	}

	button.primary:hover {
		filter: brightness(1.05);
	}

	.empty {
		color: var(--dev-wallet-muted-foreground, #888);
		font-size: 12px;
		padding: 12px 0;
		text-align: center;
	}

	.error {
		color: #b91c1c;
		font-size: 11px;
		margin-top: 4px;
	}

	.success {
		color: #15803d;
		font-size: 11px;
		margin-top: 4px;
	}
`;
