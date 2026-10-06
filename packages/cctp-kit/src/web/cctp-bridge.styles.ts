// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css } from 'lit';
import { chainIconStyles } from './internal/chain-icon.js';
import { sharedStyles } from './styles/index.js';

export const styles = [
	sharedStyles,
	chainIconStyles,
	css`
		:host {
			display: block;
			color: var(--cctp-kit-foreground);
			font-size: 0.9375rem;
			line-height: 1.4;
		}

		.card {
			background-color: var(--cctp-kit-background);
			border: 1px solid var(--cctp-kit-border);
			border-radius: var(--cctp-kit-radius-xl);
			padding: 20px;
			display: flex;
			flex-direction: column;
			gap: 14px;
			max-width: 480px;
			width: 100%;
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: 32px;
		}

		.title {
			font-size: 1.125rem;
			font-weight: var(--cctp-kit-font-weight-semibold);
		}

		.panels {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.panel {
			background-color: var(--cctp-kit-muted);
			border-radius: var(--cctp-kit-radius-lg);
			padding: 14px 16px;
			display: flex;
			flex-direction: column;
			gap: 12px;
		}

		.row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			min-height: 24px;
		}

		.label {
			color: var(--cctp-kit-muted-foreground);
			font-size: 0.8125rem;
			font-weight: var(--cctp-kit-font-weight-medium);
		}

		.chain-static {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			height: 36px;
			padding: 0 12px 0 8px;
			border-radius: var(--cctp-kit-radius-xl);
			background: var(--cctp-kit-background);
			border: 1px solid var(--cctp-kit-border);
			font-weight: var(--cctp-kit-font-weight-medium);
		}

		.amount-row {
			display: flex;
			align-items: center;
			gap: 12px;
		}

		.amount-input,
		.amount-static {
			flex: 1;
			min-width: 0;
			font-size: 1.75rem;
			line-height: 1.2;
			font-weight: var(--cctp-kit-font-weight-semibold);
			background: transparent;
			border: 0;
			padding: 0;
			margin: 0;
			outline: none;
			box-shadow: none;
			color: var(--cctp-kit-foreground);
		}

		.amount-input::placeholder,
		.amount-static.empty {
			color: var(--cctp-kit-muted-foreground);
		}

		.unit {
			color: var(--cctp-kit-muted-foreground);
			font-weight: var(--cctp-kit-font-weight-medium);
			font-size: 0.9375rem;
		}

		.field {
			width: 100%;
			background-color: var(--cctp-kit-background);
			border: 1px solid var(--cctp-kit-input);
			border-radius: var(--cctp-kit-radius-md);
			padding: 9px 12px;
			outline-style: none;
		}

		.field:focus-visible {
			box-shadow: 0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent);
		}

		.pill {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			font-size: 0.8125rem;
			color: var(--cctp-kit-muted-foreground);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		}

		.flip {
			align-self: center;
			width: 36px;
			height: 36px;
			border-radius: 999px;
			border: 1px solid var(--cctp-kit-border);
			background: var(--cctp-kit-background);
			color: var(--cctp-kit-foreground);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			margin: -21px 0;
			position: relative;
			z-index: 1;
		}

		button.flip {
			cursor: var(--cctp-kit-cursor-button);
		}

		button.flip:hover {
			background: var(--cctp-kit-accent);
		}

		button.flip:focus-visible {
			box-shadow: 0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent);
		}

		.flip svg {
			width: 16px;
			height: 16px;
		}

		.segmented {
			display: inline-flex;
			background: var(--cctp-kit-muted);
			border-radius: var(--cctp-kit-radius-xl);
			padding: 3px;
			gap: 2px;
		}

		.segmented button {
			padding: 4px 12px;
			border-radius: var(--cctp-kit-radius-lg);
			font-family: var(--cctp-kit-font-button);
			text-transform: var(--cctp-kit-button-text-transform);
			letter-spacing: var(--cctp-kit-button-letter-spacing);
			font-size: 0.8125rem;
			font-weight: var(--cctp-kit-font-weight-medium);
			color: var(--cctp-kit-muted-foreground);
			cursor: var(--cctp-kit-cursor-button);
		}

		.segmented button:disabled {
			opacity: 0.45;
			cursor: var(--cctp-kit-cursor-disabled);
		}

		.segmented button.active {
			background: var(--cctp-kit-background);
			color: var(--cctp-kit-foreground);
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
		}

		.quote {
			display: flex;
			flex-direction: column;
			gap: 4px;
			padding: 0 4px;
			font-size: 0.8125rem;
			color: var(--cctp-kit-muted-foreground);
		}

		.quote .row {
			min-height: 0;
		}

		.quote .row span:last-child {
			color: var(--cctp-kit-foreground);
		}

		.link {
			color: inherit;
			text-decoration: underline;
			text-underline-offset: 2px;
		}

		.error {
			color: var(--cctp-kit-destructive);
			font-size: 0.8125rem;
			overflow-wrap: anywhere;
			min-width: 0;
		}

		.muted {
			color: var(--cctp-kit-muted-foreground);
			font-size: 0.8125rem;
		}

		.text-button {
			font-family: inherit;
			font-size: 0.8125rem;
			color: var(--cctp-kit-muted-foreground);
			text-decoration: underline;
			text-underline-offset: 2px;
			cursor: var(--cctp-kit-cursor-button);
		}

		.text-button:hover,
		.text-button:focus-visible {
			color: var(--cctp-kit-foreground);
			outline: none;
			text-decoration-thickness: 2px;
		}

		.transfers {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.transfers-head {
			min-height: 0;
		}

		.pager {
			display: inline-flex;
			gap: 2px;
		}

		.pager-btn {
			width: 26px;
			height: 26px;
			border-radius: 999px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			color: var(--cctp-kit-muted-foreground);
			cursor: var(--cctp-kit-cursor-button);
			outline-style: none;
		}

		.pager-btn:hover:not(:disabled) {
			background: var(--cctp-kit-accent);
			color: var(--cctp-kit-accent-foreground);
		}

		.pager-btn:focus-visible {
			box-shadow: 0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent);
		}

		.pager-btn:disabled {
			opacity: 0.35;
			cursor: var(--cctp-kit-cursor-disabled);
		}

		.pager-btn svg {
			width: 14px;
			height: 14px;
		}

		.carousel {
			overflow: hidden;
		}

		.track {
			display: flex;
			width: 100%;
			transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
		}

		.slide {
			flex: 0 0 100%;
			min-width: 100%;
		}

		@media (prefers-reduced-motion: reduce) {
			.track {
				transition: none;
			}
		}

		.transfer-title {
			font-size: 0.875rem;
			font-weight: var(--cctp-kit-font-weight-medium);
		}

		.stepper {
			list-style: none;
			margin: 0;
			padding: 0;
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 0.8125rem;
		}

		.stepper .step {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			white-space: nowrap;
		}

		.stepper .connector {
			flex: 1;
			height: 1px;
			background: var(--cctp-kit-border);
			min-width: 12px;
		}

		.dot {
			width: 10px;
			height: 10px;
			border-radius: 999px;
			background: var(--cctp-kit-border);
			flex: none;
		}

		.step.active .dot {
			background: var(--cctp-kit-primary);
			animation: pulse 1.2s ease-in-out infinite;
		}

		.step.done .dot {
			background: var(--cctp-kit-positive);
		}

		.step.failed .dot {
			background: var(--cctp-kit-destructive);
		}

		@keyframes pulse {
			0%,
			100% {
				opacity: 1;
			}
			50% {
				opacity: 0.35;
			}
		}

		.transfer {
			border: 1px solid var(--cctp-kit-border);
			border-radius: var(--cctp-kit-radius-lg);
			padding: 10px 12px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.wait {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		.progress {
			height: 4px;
			border-radius: 999px;
			background: var(--cctp-kit-border);
			overflow: hidden;
		}

		.progress span {
			display: block;
			height: 100%;
			background: var(--cctp-kit-primary);
			transition: width 1s linear;
		}

		.progress span.overdue {
			animation: pulse 1.2s ease-in-out infinite;
		}

		.import {
			gap: 10px;
		}

		.import .row {
			min-height: 0;
		}

		.import-hint {
			line-height: 1.45;
		}

		.footer-links {
			display: flex;
			justify-content: center;
			gap: 16px;
			flex-wrap: wrap;
		}

		.views {
			position: relative;
			overflow: hidden;
		}

		.pane {
			display: flex;
			flex-direction: column;
			gap: 14px;
			transition:
				transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
				opacity 0.28s ease;
		}

		/* The inactive pane leaves normal flow so the card sizes to the visible one. */
		.pane.inactive {
			position: absolute;
			inset: 0;
			opacity: 0;
			pointer-events: none;
			visibility: hidden;
			transition:
				transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
				opacity 0.28s ease,
				visibility 0s linear 0.28s;
		}

		.pane-bridge.inactive {
			transform: translateX(-40%);
		}

		.pane-history.inactive {
			transform: translateX(40%);
		}

		@media (prefers-reduced-motion: reduce) {
			.pane,
			.pane.inactive {
				transition: none;
			}
		}

		.back {
			width: 32px;
			height: 32px;
			border-radius: 999px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			color: var(--cctp-kit-foreground);
			cursor: var(--cctp-kit-cursor-button);
			outline-style: none;
		}

		.back:hover {
			background: var(--cctp-kit-accent);
		}

		.back:focus-visible {
			box-shadow: 0 0 0 3px color-mix(in oklab, var(--cctp-kit-ring) 50%, transparent);
		}

		.back svg {
			width: 16px;
			height: 16px;
		}

		.header-spacer {
			width: 32px;
		}

		.pane-history .header {
			justify-content: flex-start;
			gap: 8px;
		}

		.pane-history .title {
			flex: 1;
			text-align: center;
		}

		.history-empty {
			text-align: center;
			padding: 24px 0;
		}

		.history {
			display: flex;
			flex-direction: column;
			gap: 8px;
			min-height: 200px;
			max-height: min(60vh, 520px);
			overflow-y: auto;
		}

		.history-row {
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 10px 12px;
			border: 1px solid var(--cctp-kit-border);
			border-radius: var(--cctp-kit-radius-md);
			font-size: 0.875rem;
		}

		.history-row.hidden {
			opacity: 0.7;
		}

		.history-main {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}

		.actions {
			display: flex;
			gap: 8px;
			justify-content: flex-end;
		}
	`,
];
