// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css } from 'lit';

const resetStyles = css`
	* {
		box-sizing: border-box;
		-webkit-font-smoothing: antialiased;
		text-rendering: optimizeLegibility;
		font-family: var(--dev-wallet-font-sans);
	}

	button {
		appearance: none;
		background-color: transparent;
		font-size: inherit;
		font-family: inherit;
		color: inherit;
		border: 0;
		padding: 0;
		margin: 0;
		cursor: pointer;
		outline-color: color-mix(in oklab, var(--dev-wallet-ring) 50%, transparent);
	}

	p,
	h1,
	h2,
	h3 {
		margin: 0;
		color: var(--dev-wallet-foreground);
	}

	:focus-visible {
		outline: 2px solid var(--dev-wallet-ring);
		outline-offset: 2px;
	}
`;

const themeStyles = css`
	:host {
		/* Handoff tokens — dark devtools surface, Sui blue accent. */
		--dev-wallet-bg-0: #05080f;
		--dev-wallet-bg-1: #0a1322;
		--dev-wallet-bg-2: #0f1b30;
		--dev-wallet-bg-3: #15243e;
		--dev-wallet-bg-4: #1c2f4d;
		--dev-wallet-bg-hover: rgba(255, 255, 255, 0.04);
		--dev-wallet-border: rgba(255, 255, 255, 0.07);
		--dev-wallet-border-2: rgba(255, 255, 255, 0.12);
		--dev-wallet-border-strong: rgba(77, 162, 255, 0.35);
		--dev-wallet-foreground: #e6eefb;
		--dev-wallet-text-2: #94a6c2;
		--dev-wallet-text-3: #5c708e;
		--dev-wallet-text-mute: #3d526f;
		--dev-wallet-scrim: rgba(2, 6, 14, 0.7);
		--dev-wallet-primary: #4da2ff;
		--dev-wallet-primary-hover: #6fbcff;
		--dev-wallet-primary-foreground: #03101f;
		--dev-wallet-accent-fade: rgba(77, 162, 255, 0.12);
		--dev-wallet-secondary: var(--dev-wallet-bg-2);
		--dev-wallet-secondary-foreground: var(--dev-wallet-foreground);
		--dev-wallet-background: var(--dev-wallet-bg-0);
		--dev-wallet-surface: var(--dev-wallet-bg-1);
		--dev-wallet-muted: var(--dev-wallet-bg-3);
		--dev-wallet-muted-foreground: var(--dev-wallet-text-2);
		--dev-wallet-input: var(--dev-wallet-bg-2);
		--dev-wallet-ring: var(--dev-wallet-primary);
		--dev-wallet-destructive: #ff6b6b;
		--dev-wallet-positive: #4ecca3;
		--dev-wallet-warning: #ffb454;
		--dev-wallet-magenta: #c792ea;
		--dev-wallet-teal: #66e1d0;
		--dev-wallet-status-connected: var(--dev-wallet-positive);
		--dev-wallet-status-disconnected: var(--dev-wallet-text-3);

		/* Radius scale */
		--dev-wallet-radius-2xs: 3px;
		--dev-wallet-radius-xs: 4px;
		--dev-wallet-radius-sm: 4px;
		--dev-wallet-radius: 6px;
		--dev-wallet-radius-md: 6px;
		--dev-wallet-radius-lg: 10px;
		--dev-wallet-radius-xl: 14px;

		/* Shadows */
		--dev-wallet-shadow-sm: 0 1px 3px rgba(2, 8, 20, 0.25);
		--dev-wallet-shadow-md:
			0 8px 24px rgba(0, 8, 24, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
		--dev-wallet-shadow-card:
			0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 10px 30px rgba(2, 8, 20, 0.4);
		--dev-wallet-shadow-lg:
			0 24px 60px rgba(0, 8, 24, 0.55), 0 2px 0 rgba(255, 255, 255, 0.04) inset;
		--dev-wallet-shadow-drawer:
			0 30px 80px rgba(0, 8, 24, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;

		/* Typography */
		--dev-wallet-font-sans:
			'Geist', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		--dev-wallet-font-weight-medium: 500;
		--dev-wallet-font-weight-semibold: 600;
		--dev-wallet-font-weight-bold: 700;
		--dev-wallet-font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;

		/* Font-size scale */
		--dev-wallet-text-2xs: 10px;
		--dev-wallet-text-xs: 11px;
		--dev-wallet-text-sm: 12px;
		--dev-wallet-text-base: 13px;
		--dev-wallet-text-md: 14px;
		--dev-wallet-text-lg: 15px;
		--dev-wallet-text-xl: 16px;
	}

	.mono {
		font-family: var(--dev-wallet-font-mono);
		font-feature-settings: 'ss01', 'cv01';
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 22px;
		padding: 0 8px;
		border-radius: 999px;
		font-family: var(--dev-wallet-font-mono);
		font-size: 10.5px;
		font-weight: var(--dev-wallet-font-weight-medium);
		letter-spacing: 0.02em;
		background: var(--dev-wallet-bg-3);
		color: var(--dev-wallet-text-2);
		border: 1px solid var(--dev-wallet-border);
		white-space: nowrap;
	}

	.chip-accent {
		color: var(--dev-wallet-primary);
		border-color: var(--dev-wallet-border-strong);
		background: var(--dev-wallet-accent-fade);
	}

	.chip-success {
		color: var(--dev-wallet-positive);
		border-color: rgba(78, 204, 163, 0.3);
		background: rgba(78, 204, 163, 0.08);
	}

	.chip-warn {
		color: var(--dev-wallet-warning);
		border-color: rgba(255, 180, 84, 0.3);
		background: rgba(255, 180, 84, 0.08);
	}

	.chip-mute {
		color: var(--dev-wallet-text-3);
	}

	@keyframes slidein-right {
		from {
			opacity: 0;
			transform: translateX(20px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@keyframes fadein {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes popin {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(8px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	@keyframes pulse-ring {
		0% {
			box-shadow: 0 0 0 0 rgba(77, 162, 255, 0.45);
		}
		100% {
			box-shadow: 0 0 0 14px rgba(77, 162, 255, 0);
		}
	}
`;

export const dropdownItemStyles = css`
	.dropdown-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 8px;
		border-radius: var(--dev-wallet-radius);
		font-size: 12px;
		color: var(--dev-wallet-foreground);
		text-align: left;
	}

	.dropdown-item:hover {
		background: var(--dev-wallet-bg-hover);
	}

	.dropdown-item[aria-selected='true'] {
		font-weight: var(--dev-wallet-font-weight-semibold);
	}
`;

export const connectDialogStyles = css`
	.connect-dialog {
		width: 460px;
		max-height: min(600px, 80vh);
		border-radius: var(--dev-wallet-radius-xl);
		background: var(--dev-wallet-surface);
		border: 1px solid var(--dev-wallet-border-2);
		box-shadow: var(--dev-wallet-shadow-lg);
		overflow: hidden;
		display: flex;
		flex-direction: column;
		padding: 0;
		color: inherit;
		pointer-events: auto;
		animation: popin 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}

	.connect-dialog::backdrop {
		background: rgba(2, 6, 14, 0.55);
	}

	.connect-dialog-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 14px 16px 12px;
		border-bottom: 1px solid var(--dev-wallet-border);
		background: var(--dev-wallet-bg-1);
	}

	.connect-dialog-title {
		font-size: 13px;
		font-weight: var(--dev-wallet-font-weight-semibold);
		color: var(--dev-wallet-foreground);
	}
`;

export const actionButtonStyles = css`
	.actions {
		display: flex;
		gap: 8px;
	}

	.btn {
		height: 30px;
		padding: 0 12px;
		border-radius: var(--dev-wallet-radius);
		border: 1px solid var(--dev-wallet-border-2);
		background: var(--dev-wallet-bg-3);
		color: var(--dev-wallet-foreground);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		font-size: 12px;
		font-weight: var(--dev-wallet-font-weight-medium);
		white-space: nowrap;
		transition:
			background 120ms,
			border-color 120ms,
			color 120ms,
			transform 80ms;
	}

	.actions .btn {
		flex: 1;
	}

	.btn:hover {
		background: var(--dev-wallet-bg-4);
		border-color: var(--dev-wallet-border-strong);
	}

	.btn:active {
		transform: translateY(0.5px);
	}

	.btn-approve {
		background: var(--dev-wallet-primary);
		border-color: var(--dev-wallet-primary);
		color: var(--dev-wallet-primary-foreground);
		font-weight: var(--dev-wallet-font-weight-semibold);
	}

	.btn-approve:hover {
		background: var(--dev-wallet-primary-hover);
		border-color: var(--dev-wallet-primary-hover);
	}

	.btn-reject {
		background: transparent;
		color: var(--dev-wallet-destructive);
	}

	.btn-reject:hover {
		background: rgba(255, 107, 107, 0.07);
		border-color: var(--dev-wallet-destructive);
	}

	.btn-cancel {
		background: transparent;
		color: var(--dev-wallet-text-2);
		border-color: transparent;
	}

	.btn-cancel:hover {
		background: var(--dev-wallet-bg-hover);
		color: var(--dev-wallet-foreground);
	}

	.btn-create {
		background: var(--dev-wallet-primary);
		color: var(--dev-wallet-primary-foreground);
	}

	.btn-create:hover {
		background: oklab(from var(--dev-wallet-primary) calc(l - 0.03) a b);
	}

	.btn-create:disabled,
	.btn-approve:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
`;

export const stateStyles = css`
	.loading,
	.empty-state,
	.error-state {
		text-align: center;
		padding: 18px 16px;
		font-size: 13px;
		border-radius: var(--dev-wallet-radius-lg);
		border: 1px solid var(--dev-wallet-border);
		background: var(--dev-wallet-bg-1);
	}

	.loading {
		color: var(--dev-wallet-muted-foreground);
	}

	.empty-state {
		color: var(--dev-wallet-muted-foreground);
	}

	.error-state {
		color: var(--dev-wallet-destructive);
	}
`;

export const sectionHeaderStyles = css`
	.section-header {
		font-family: var(--dev-wallet-font-mono);
		font-size: 10px;
		font-weight: var(--dev-wallet-font-weight-medium);
		color: var(--dev-wallet-text-3);
		text-transform: uppercase;
		letter-spacing: 0.14em;
		margin-bottom: 10px;
	}
`;

/** `<dialog>` chrome shared by new-account / accounts confirm-remove / signing-modal. */
export const dialogStyles = css`
	dialog:not([open]),
	.confirm-dialog:not([open]) {
		display: none;
	}

	dialog,
	.confirm-dialog {
		max-width: calc(100vw - 32px);
		border-radius: var(--dev-wallet-radius-xl);
		background: var(--dev-wallet-surface);
		border: 1px solid var(--dev-wallet-border-2);
		box-shadow: var(--dev-wallet-shadow-lg);
		display: flex;
		flex-direction: column;
		color: inherit;
		animation: popin 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}

	dialog::backdrop,
	.confirm-dialog::backdrop {
		background: color-mix(in oklab, oklch(0 0 0) 50%, transparent);
	}

	.dialog-title {
		font-size: 16px;
		font-weight: var(--dev-wallet-font-weight-semibold);
		color: var(--dev-wallet-foreground);
		margin-bottom: 16px;
	}
`;

/** Flex-row card with secondary bg + border + active highlight. */
export const cardItemStyles = css`
	.network-item,
	.account-item,
	.slot-item,
	.import-item {
		display: flex;
		align-items: center;
		border-radius: var(--dev-wallet-radius-lg);
		border: 1px solid var(--dev-wallet-border);
		background: var(--dev-wallet-surface);
	}

	.network-item.active,
	.account-item.active,
	.slot-item.active,
	.import-item.selected {
		border-color: var(--dev-wallet-border-strong);
		background: var(--dev-wallet-accent-fade);
	}
`;

/** Vertical flex container with a 4px gap (override gap per-list). */
export const listContainerStyles = css`
	.network-list,
	.account-list,
	.slot-list,
	.import-list,
	.commands-list,
	.coin-flows {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
`;

/** Text-input with focus-highlight and reset chrome. */
export const formInputStyles = css`
	.form-input,
	.field-input,
	.action-input,
	.network-url-input,
	.edit-label-input {
		outline: none;
		box-sizing: border-box;
		font-family: inherit;
		color: var(--dev-wallet-foreground);
		width: 100%;
	}

	.form-input:focus,
	.field-input:focus,
	.action-input:focus {
		border-color: var(--dev-wallet-primary);
	}

	.form-input::placeholder,
	.field-input::placeholder,
	.action-input::placeholder {
		color: var(--dev-wallet-muted-foreground);
	}
`;

/** Click-to-copy cursor / hover-tint / `.copied` positive-color states. */
export const copyableTextStyles = css`
	.account-address,
	.detail-value.copyable-addr {
		cursor: pointer;
		border-radius: var(--dev-wallet-radius-2xs);
		transition: background 0.15s;
	}

	.account-address:hover,
	.detail-value.copyable-addr:hover {
		background: color-mix(in oklab, var(--dev-wallet-primary) 15%, transparent);
	}

	.account-address.copied,
	.detail-value.copied {
		color: var(--dev-wallet-positive);
	}
`;

/** Truncated monospace text — every muted address span in the wallet UI. */
export const monoTruncateStyles = css`
	.account-address,
	.import-item-address,
	.slot-address,
	.network-url,
	.command-detail,
	.command-arg {
		font-family: var(--dev-wallet-font-mono);
		color: var(--dev-wallet-text-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-feature-settings: 'ss01', 'cv01';
	}

	.confirm-account-address {
		font-family: var(--dev-wallet-font-mono);
		color: var(--dev-wallet-muted-foreground);
	}
`;

/** Small square icon button used for inline edit / delete actions. */
export const iconButtonStyles = css`
	.btn-icon,
	.edit-label-btn,
	.delete-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--dev-wallet-radius-xs);
		color: var(--dev-wallet-muted-foreground);
	}

	.btn-icon:hover,
	.edit-label-btn:hover {
		background: var(--dev-wallet-border);
		color: var(--dev-wallet-foreground);
	}
`;

/** Tiny uppercase pill — every status / scheme / network badge. */
export const badgeStyles = css`
	.network-active-badge,
	.account-badge,
	.import-item-badge,
	.slot-toggle {
		font-family: var(--dev-wallet-font-mono);
		font-size: 10.5px;
		font-weight: var(--dev-wallet-font-weight-medium);
		text-transform: uppercase;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
`;

/** Uppercase muted label headings (`.section-label`, `.status-label`, `.field-label`). */
export const subLabelStyles = css`
	.section-label,
	.status-label {
		font-family: var(--dev-wallet-font-mono);
		font-size: 10px;
		font-weight: var(--dev-wallet-font-weight-medium);
		color: var(--dev-wallet-text-3);
		text-transform: uppercase;
		letter-spacing: 0.14em;
	}

	.field-label {
		display: block;
		font-size: 12px;
		font-weight: var(--dev-wallet-font-weight-medium);
		color: var(--dev-wallet-muted-foreground);
		margin-bottom: 4px;
	}

	.section-label-error {
		color: var(--dev-wallet-destructive);
	}
`;

/** Inline single-line destructive error message. */
export const inlineErrorStyles = css`
	.error,
	.inline-error,
	.confirm-error {
		color: var(--dev-wallet-destructive);
		font-size: 12px;
		word-break: break-word;
	}
`;

/** Circular initial-avatar shared by accounts list + account-selector. */
export const avatarStyles = css`
	.account-avatar,
	.avatar {
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: var(--dev-wallet-font-weight-semibold);
		color: var(--dev-wallet-primary-foreground);
		background: linear-gradient(135deg, var(--dev-wallet-primary), var(--dev-wallet-teal));
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
		flex-shrink: 0;
	}
`;

const reducedMotionStyles = css`
	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			animation-duration: 0.01ms !important;
			animation-iteration-count: 1 !important;
			transition-duration: 0.01ms !important;
		}
	}
`;

const hostBlockStyles = css`
	:host {
		display: block;
	}
`;

export const sharedStyles = [resetStyles, themeStyles, reducedMotionStyles, hostBlockStyles];
