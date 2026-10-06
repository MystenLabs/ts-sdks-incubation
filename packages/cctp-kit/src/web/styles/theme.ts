// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css } from 'lit';

/**
 * Two-level theming, identical in shape to @mysten/dapp-kit-core: internal `--cctp-kit-*`
 * tokens read the same shadcn/ui-named public custom properties dapp-kit reads
 * (`--background`, `--primary`, `--radius`, ...), so a host that has themed dapp-kit gets
 * this widget themed for free. Defaults are the light palette; set the public variables
 * under `prefers-color-scheme: dark` or a theme class for dark mode.
 */
export const themeStyles = css`
	:host {
		--cctp-kit-background: var(--background, oklch(1 0 0));
		--cctp-kit-foreground: var(--foreground, oklch(0.145 0 0));
		--cctp-kit-primary: var(--primary, oklch(0.216 0.006 56.043));
		--cctp-kit-primary-foreground: var(--primary-foreground, oklch(0.985 0.001 106.423));
		--cctp-kit-secondary: var(--secondary, oklch(0.97 0.001 106.424));
		--cctp-kit-secondary-foreground: var(--secondary-foreground, oklch(0.216 0.006 56.043));
		--cctp-kit-border: var(--border, oklch(0.922 0 0));
		--cctp-kit-accent: var(--accent, oklch(0.97 0.001 106.424));
		--cctp-kit-accent-foreground: var(--accent-foreground, oklch(0.205 0 0));
		--cctp-kit-muted: var(--muted, oklch(0.97 0.001 106.424));
		--cctp-kit-muted-foreground: var(--muted-foreground, oklch(0.553 0.013 58.071));
		--cctp-kit-popover: var(--popover, oklch(1 0 0));
		--cctp-kit-popover-foreground: var(--popover-foreground, oklch(0.145 0 0));
		--cctp-kit-destructive: var(--destructive, oklch(0.577 0.245 27.325));
		--cctp-kit-positive: var(--positive, oklch(0.862 0.127 146.2));
		--cctp-kit-ring: var(--ring, oklch(0.708 0 0));
		--cctp-kit-input: var(--input, oklch(0.922 0 0));
		--cctp-kit-radius: var(--radius, 12px);
		--cctp-kit-radius-sm: calc(var(--cctp-kit-radius) - 4px);
		--cctp-kit-radius-md: calc(var(--cctp-kit-radius) - 2px);
		--cctp-kit-radius-lg: var(--cctp-kit-radius);
		--cctp-kit-radius-xl: calc(var(--cctp-kit-radius) + 4px);
		--cctp-kit-font-sans: var(
			--font-sans,
			ui-sans-serif,
			system-ui,
			sans-serif,
			'Apple Color Emoji',
			'Segoe UI Emoji',
			'Segoe UI Symbol',
			'Noto Color Emoji'
		);
		/* Optional extras beyond the shadcn set: button typography. */
		--cctp-kit-font-button: var(--font-button, var(--cctp-kit-font-sans));
		--cctp-kit-button-text-transform: var(--button-text-transform, none);
		--cctp-kit-button-letter-spacing: var(--button-letter-spacing, normal);
		--cctp-kit-font-weight-medium: var(--font-weight-medium, 500);
		--cctp-kit-font-weight-semibold: var(--font-weight-semibold, 600);
		--cctp-kit-cursor-button: var(--cursor-button, pointer);
		--cctp-kit-cursor-disabled: var(--cursor-disabled, not-allowed);
	}
`;
