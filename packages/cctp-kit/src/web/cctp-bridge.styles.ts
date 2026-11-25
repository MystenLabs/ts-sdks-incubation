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
			margin-left: auto;
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

		.notice {
			margin: 0;
			padding: 0.5rem 0.75rem;
			font-size: 0.8125rem;
			border-radius: var(--cctp-kit-radius-md);
			border: 1px solid var(--cctp-kit-border);
			background-color: var(--cctp-kit-muted);
		}

		.segmented.mode {
			display: flex;
			margin-left: 0;
		}

		.segmented.mode button {
			flex: 1;
		}

		.recovery-saved {
			display: inline-flex;
			align-items: center;
			gap: 8px;
		}

		.recovery-input {
			display: flex;
			gap: 8px;
			align-items: center;
		}

		.recovery-input .field {
			flex: 1;
			min-width: 0;
		}

		.recovery-actions {
			display: flex;
			gap: 12px;
		}

		.warning {
			color: var(--cctp-kit-warning);
			font-size: 0.8125rem;
			font-weight: var(--cctp-kit-font-weight-medium);
		}

		.hint {
			font-size: 0.75rem;
		}

		.deposit {
			display: flex;
			gap: 14px;
			align-items: center;
			padding: 14px;
			border: 1px solid var(--cctp-kit-border);
			border-radius: var(--cctp-kit-radius-lg);
		}

		.qr {
			flex: none;
			width: 128px;
			height: 128px;
			border-radius: var(--cctp-kit-radius-md);
			overflow: hidden;
		}

		.qr svg {
			display: block;
			width: 100%;
			height: 100%;
		}

		.deposit-body {
			display: flex;
			flex-direction: column;
			gap: 8px;
			min-width: 0;
		}

		.deposit-address {
			font-family: var(--cctp-kit-font-mono, ui-monospace, monospace);
			font-size: 0.8125rem;
			overflow-wrap: anywhere;
			user-select: all;
		}

		.deposit-status {
			margin: 0;
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		.deposit-progress {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 14px;
			border: 1px solid var(--cctp-kit-border);
			border-radius: var(--cctp-kit-radius-lg);
			font-size: 0.8125rem;
		}

		.deposit-progress ol {
			list-style: none;
			margin: 0;
			padding: 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.deposit-progress li {
			display: flex;
			align-items: center;
			gap: 10px;
			color: var(--cctp-kit-muted-foreground);
		}

		.deposit-progress li.done,
		.deposit-progress li.active {
			color: var(--cctp-kit-foreground);
		}

		.step-mark {
			flex: none;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			border: 2px solid var(--cctp-kit-border);
			box-sizing: border-box;
			transition:
				background-color 0.25s ease,
				border-color 0.25s ease;
		}

		li.done .step-mark {
			background: var(--cctp-kit-positive);
			border-color: var(--cctp-kit-positive);
		}

		li.active .step-mark {
			border-color: var(--cctp-kit-positive);
			border-top-color: transparent;
			animation: cctp-kit-spin 0.9s linear infinite;
		}

		.elapsed {
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
		}

		.deposit-success {
			display: flex;
			gap: 12px;
			align-items: center;
			padding: 14px;
			border-radius: var(--cctp-kit-radius-lg);
			border: 1px solid color-mix(in oklab, var(--cctp-kit-positive) 55%, transparent);
			background: color-mix(in oklab, var(--cctp-kit-positive) 14%, var(--cctp-kit-background));
			animation: cctp-kit-rise 0.3s ease-out;
		}

		.deposit-success-body {
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 0;
			font-size: 0.8125rem;
		}

		.deposit-success-body strong {
			font-size: 0.9375rem;
			font-weight: var(--cctp-kit-font-weight-semibold);
		}

		.check {
			flex: none;
			width: 36px;
			height: 36px;
		}

		.check-ring {
			fill: var(--cctp-kit-positive);
		}

		.check-tick {
			stroke: var(--cctp-kit-background);
			stroke-width: 2.4;
			stroke-linecap: round;
			stroke-linejoin: round;
			stroke-dasharray: 16;
			stroke-dashoffset: 16;
			animation: cctp-kit-draw 0.4s 0.15s ease-out forwards;
		}

		.deposit-last {
			margin: 0;
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			font-size: 0.8125rem;
		}

		.small-check {
			flex: none;
			width: 16px;
			height: 16px;
			stroke: var(--cctp-kit-positive);
			stroke-width: 2.2;
			stroke-linecap: round;
			stroke-linejoin: round;
		}

		@keyframes cctp-kit-spin {
			to {
				transform: rotate(360deg);
			}
		}

		@keyframes cctp-kit-draw {
			to {
				stroke-dashoffset: 0;
			}
		}

		@keyframes cctp-kit-rise {
			from {
				opacity: 0;
				transform: translateY(4px);
			}
		}

		@media (prefers-reduced-motion: reduce) {
			li.active .step-mark,
			.deposit-success {
				animation: none;
			}

			.check-tick {
				animation: none;
				stroke-dashoffset: 0;
			}
		}

		.pulse {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: var(--cctp-kit-positive);
			animation: cctp-kit-pulse 1.6s ease-in-out infinite;
		}

		@keyframes cctp-kit-pulse {
			50% {
				opacity: 0.3;
			}
		}

		@media (prefers-reduced-motion: reduce) {
			.pulse {
				animation: none;
			}
		}

		@media (max-width: 420px) {
			.deposit {
				flex-direction: column;
				align-items: stretch;
			}

			.qr {
				align-self: center;
				width: 168px;
				height: 168px;
			}
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

		.import-found {
			margin: 0;
			font-size: 0.8125rem;
			color: var(--cctp-kit-positive);
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
