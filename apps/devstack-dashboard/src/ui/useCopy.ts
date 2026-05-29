import { useCallback, useState } from 'react';

/**
 * Clipboard-copy hook with a brief "copied" acknowledgement window.
 *
 * Returns a tuple of `[copied, copy]`: `copied` flips to `true` for ~1.1s
 * after a successful `copy(text)`, letting callers swap a copy glyph for a
 * checkmark. Clipboard failures are swallowed (e.g. insecure context) but the
 * acknowledgement still fires so the UI stays responsive.
 */
export const useCopy = (): readonly [copied: boolean, copy: (text: string) => void] => {
	const [copied, setCopied] = useState(false);
	const copy = useCallback((text: string) => {
		try {
			void navigator.clipboard.writeText(text);
		} catch {
			// best-effort: ignore clipboard write failures
		}
		setCopied(true);
		setTimeout(() => setCopied(false), 1100);
	}, []);
	return [copied, copy] as const;
};
