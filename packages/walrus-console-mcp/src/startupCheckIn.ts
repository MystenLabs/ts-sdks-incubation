/**
 * One authenticated Console call when a harness starts this server, so
 * Console records the key as used (COMG-1121) without the user typing a prompt.
 * Connect MCP's last step lights its tick from that record.
 *
 * Called from the server's initialize hook, after the handshake, so the harness's
 * `clientInfo.name` already travels with the call. The installer never starts the
 * server, so it never checks in.
 *
 * Health checks such as `claude mcp list` and `claude mcp get` also start the
 * server and run the same handshake (initialize, initialized, tools/list), so the
 * handshake cannot tell them from a real session. What differs is how long they
 * stay: a health check closes stdin about 100 ms after spawn. So the call waits
 * CHECK_IN_DELAY_MS first, is skipped when stdin has already ended, and is
 * aborted when stdin ends while it is in flight.
 *
 * Fire-and-forget: the caller never awaits it, nothing it does reaches stdout (the
 * JSON-RPC channel), and every failure ends as one line on stderr. A machine that
 * is offline at launch starts normally; `ping_console` still works afterwards.
 */

/** Same bound as `ping_console`'s check, so a silent Console cannot hold a fiber. */
export const CHECK_IN_TIMEOUT_MS = 10_000;

/** Long enough to outlast a health check, which closes stdin within ~100 ms. */
export const CHECK_IN_DELAY_MS = 3_000;

export interface CheckInDeps {
  /**
   * The authenticated call. Resolves without a request when no API key is set,
   * since there is nothing to record. Rejects on any failure.
   */
  readonly call: (signal: AbortSignal) => Promise<unknown>;
  /** One line to stderr. Redaction is installed before the server starts. */
  readonly log: (line: string) => void;
  /** Fires when the harness closes stdin. The check-in is then skipped or aborted. */
  readonly closed: AbortSignal;
}

let started = false;

/** Starts the check-in at most once per process. Returns without waiting for it. */
export function checkInWithConsole(deps: CheckInDeps): void {
  if (started) return;
  started = true;
  const delay = setTimeout(() => void runCheckIn(deps), CHECK_IN_DELAY_MS);
  // Never keeps the process alive on its own.
  delay.unref?.();
  deps.closed.addEventListener("abort", () => clearTimeout(delay), { once: true });
}

async function runCheckIn(deps: CheckInDeps): Promise<void> {
  if (deps.closed.aborted) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS);
  timer.unref?.();
  // An open socket would keep the event loop alive after stdin ends; drop it.
  const onClosed = () => controller.abort();
  deps.closed.addEventListener("abort", onClosed, { once: true });
  try {
    await deps.call(controller.signal);
  } catch (error) {
    // The harness has gone, so there is no one to tell.
    if (deps.closed.aborted) return;
    const reason = controller.signal.aborted
      ? `no answer within ${CHECK_IN_TIMEOUT_MS / 1000} seconds`
      : error instanceof Error
        ? error.message
        : String(error);
    try {
      deps.log(
        `console-mcp: startup check-in with Console failed (${reason}). Run ping_console to retry.`,
      );
    } catch {
      // A logger that throws must not surface as an unhandled rejection.
    }
  } finally {
    clearTimeout(timer);
    deps.closed.removeEventListener("abort", onClosed);
  }
}

/** Test hook: lets one process exercise the once-only guard more than once. */
export function resetCheckInForTests(): void {
  started = false;
}
