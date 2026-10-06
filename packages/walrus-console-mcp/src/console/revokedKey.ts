import { CONSOLE_WEB_URLS } from "../baseUrl";
import { resolveSuiNetwork } from "./packageConfig";

/**
 * The 401 codes Console answers for a revoked key. A plain Revoke and the two
 * rotation outcomes each need a different fix, so each gets its own message
 * instead of collapsing into `invalid_api_key`.
 */
export const REVOKED_KEY_CODES = [
  "api_key_revoked",
  "api_key_rotation_incomplete",
  "api_key_replaced",
] as const;

export type RevokedKeyCode = (typeof REVOKED_KEY_CODES)[number];

export const isRevokedKeyCode = (code: string | undefined): code is RevokedKeyCode =>
  (REVOKED_KEY_CODES as readonly string[]).includes(code ?? "");

/**
 * The key's visible prefix, e.g. `hbr_ab12cd34…`, so the caller can tell which
 * credential failed. Console shows the same characters for the key, and the
 * rest of the secret is never printed.
 */
export function displayKeyPrefix(rawKey: string): string {
  const match = /^(hbr(?:adm)?_)(.{1,8})/.exec(rawKey.trim());
  return match ? `${match[1]}${match[2]}…` : "the configured API key";
}

const isManagementKey = (rawKey: string) => rawKey.trim().startsWith("hbradm_");

/** The readable message for a revoked key, naming the key and the remedy. */
export function revokedKeyMessage(code: RevokedKeyCode, rawKey: string, baseUrl: string): string {
  const key = displayKeyPrefix(rawKey);
  const integrations = `${CONSOLE_WEB_URLS[resolveSuiNetwork(baseUrl)]}/integrations`;
  switch (code) {
    case "api_key_revoked":
      return (
        `Console rejected ${key}: the key was revoked and will not work again. ` +
        `Create a new key in Console → Integrations (${integrations}) and re-run the MCP ` +
        `installer with it.`
      );
    // Console may not offer to finish an interrupted rotation (resuming one is
    // behind a feature gate), so the remedy names both ways forward.
    case "api_key_rotation_incomplete":
      return (
        `Console rejected ${key}: it was revoked by a key rotation that has not finished, and ` +
        `it will not work again. In Console → Integrations (${integrations}), finish the ` +
        `rotation if Console offers it, or create a new key, then re-run the MCP installer ` +
        `with the new key's credential bundle.`
      );
    // The rotation reveal shows a credential bundle. For a Management API key it
    // also carries the new Key-Admin address, which this host pins.
    case "api_key_replaced":
      return (
        `Console rejected ${key}: it was replaced by a key rotation. Re-run the MCP installer ` +
        `with the credential bundle Console showed when that rotation finished.` +
        (isManagementKey(rawKey)
          ? ` The rotation gave the Management API key a new Key-Admin address, and the ` +
            `bundle carries it.`
          : "") +
        ` If you no longer have that bundle, create a new key in Console → Integrations ` +
        `(${integrations}).`
      );
  }
}
