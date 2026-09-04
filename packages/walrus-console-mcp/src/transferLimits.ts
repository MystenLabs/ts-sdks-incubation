/**
 * Ceiling on how many bytes one transfer may buffer in memory.
 *
 * This is a liveness limit, not a policy one. The MCP server is a long-lived
 * process, and both directions hold two full copies of the payload at once — an
 * upload has the plaintext and the Seal ciphertext, a download has the ciphertext
 * and the decrypted plaintext. Without a cap, one oversized file (or a handful of
 * concurrent ordinary ones) exhausts the heap and takes down the session,
 * including every unrelated tool call in flight.
 *
 * Console enforces its own server-side cap and answers 413 — see
 * `PayloadTooLargeError`. That check happens too late to help here: by the time
 * the server can reject an upload, the client has already read, encrypted, and
 * buffered the whole thing.
 */

export const MAX_TRANSFER_BYTES_ENV = "CONSOLE_MCP_MAX_TRANSFER_BYTES";

/**
 * 256 MiB. Comfortably above any realistic document or archive a user hands an
 * agent, and low enough that the two-copies-in-flight worst case stays inside a
 * default Node heap.
 */
export const DEFAULT_MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

/**
 * Resolve the cap from the environment, falling back to the default.
 *
 * A non-numeric, zero, or negative override falls back rather than throwing: this
 * is read on the transfer path, and a typo in an env var should not be the reason
 * an upload fails with a message about parsing.
 */
export function maxTransferBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_TRANSFER_BYTES_ENV];
  if (!raw) return DEFAULT_MAX_TRANSFER_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TRANSFER_BYTES;
  return Math.floor(parsed);
}
