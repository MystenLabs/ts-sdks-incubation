// Permission policy for codegen-emitted files.
//
// Distilled-doc § "Sensitive emitted files have restrictive
// filesystem permissions, re-applied on every emit (not just on
// create) to recover from manual chmods". The orchestrator hands the
// emit/swap layer the mode it should apply.
//
// Two-axis policy:
//   - `sensitive: true` → 0o600 (rw user only).
//   - `sensitive: false` → 0o644 (rw user, r world).
// The parent directory the emit lives in inherits the strictest
// sensitivity of any file inside it — 0o700 when any file is
// sensitive, 0o755 otherwise. The orchestrator applies parent mode
// at swap time, separate from per-file modes.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

export const SENSITIVE_FILE_MODE = 0o600;
export const NON_SENSITIVE_FILE_MODE = 0o644;
export const SENSITIVE_DIR_MODE = 0o700;
export const NON_SENSITIVE_DIR_MODE = 0o755;

/** File mode for one codegen contribution. */
export const modeFor = (decl: Pick<CodegenableDecl, 'sensitive'>): number =>
	decl.sensitive === true ? SENSITIVE_FILE_MODE : NON_SENSITIVE_FILE_MODE;

/** Parent-directory mode given a set of contributions inside it. */
export const dirModeFor = (decls: ReadonlyArray<Pick<CodegenableDecl, 'sensitive'>>): number =>
	decls.some((d) => d.sensitive === true) ? SENSITIVE_DIR_MODE : NON_SENSITIVE_DIR_MODE;

/** True if ANY contribution in the set is sensitive — gates the
 *  `.gitignore` "cover by default" rule and the parent-mode policy. */
export const anySensitive = (decls: ReadonlyArray<Pick<CodegenableDecl, 'sensitive'>>): boolean =>
	decls.some((d) => d.sensitive === true);
