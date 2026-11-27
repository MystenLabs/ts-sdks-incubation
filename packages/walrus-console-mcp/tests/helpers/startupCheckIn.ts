/**
 * A server started with an API key makes one `GET /api/v1/spaces`
 * CHECK_IN_DELAY_MS after initialize. Tests that count a tool's own Console traffic wait for that
 * call and drop it first, so "zero requests" still means the tool made none.
 */
export const STARTUP_CHECK_IN = "GET /api/v1/spaces";

export async function dropStartupCheckIn<T>(
  requests: T[],
  isCheckIn: (request: T) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const index = requests.findIndex(isCheckIn);
    if (index !== -1) {
      requests.splice(index, 1);
      return;
    }
    if (Date.now() > end) throw new Error("the startup check-in never reached the stub");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
