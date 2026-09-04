/**
 * Prove the Sui transport this client actually uses.
 *
 * Two assertions, run live against the configured fullnode:
 *  1. gRPC (`SuiGrpcClient`, what every read in `src/` goes through) WORKS.
 *  2. JSON-RPC on the same host is RETIRED — so there is no silent fallback to
 *     it, and no temptation to "fix" a failure by reaching for it.
 *
 * The second half matters as much as the first: a transport that merely happens
 * to work is not the same as one that is the only thing available.
 *
 * Usage: pnpm tsx scripts/probe-sui-transport.mts
 * Reads only. Creates nothing. Prints no secrets.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Effect } from "effect";
import { ConsoleConfigTag } from "../src/config.js";
import { resolveFullnodeUrl, resolveSuiNetwork } from "../src/console/packageConfig.js";
import { AppRuntime, unwrapFiberFailure } from "../src/runtime.js";

const program = Effect.gen(function* () {
  const cfg = yield* ConsoleConfigTag;
  const network = resolveSuiNetwork(cfg.baseUrl);
  const fullnode = resolveFullnodeUrl(network);

  return yield* Effect.tryPromise(async () => {
    const client = new SuiGrpcClient({ baseUrl: fullnode, network });

    // 1. gRPC read: the Sui framework package, which exists on every network.
    let grpc: { ok: boolean; detail: string };
    try {
      const { object } = await client.getObject({
        objectId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        include: { content: false },
      });
      grpc = { ok: true, detail: `getObject returned type ${object.type ?? "(package)"}` };
    } catch (err) {
      grpc = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    // 2. JSON-RPC on the same host — expected to be gone.
    let jsonRpc: { reachable: boolean; detail: string };
    try {
      const res = await fetch(fullnode, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sui_getObject",
          params: ["0x0000000000000000000000000000000000000000000000000000000000000002"],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = (await res.text()).slice(0, 200);
      // A retired method answers with an error body, not a transport failure.
      jsonRpc = {
        reachable: res.ok && !text.includes("-32601") && !/deprecat|retire/i.test(text),
        detail: `HTTP ${res.status}: ${text}`,
      };
    } catch (err) {
      jsonRpc = { reachable: false, detail: err instanceof Error ? err.message : String(err) };
    }

    return { network, fullnode, grpc, jsonRpc };
  });
});

try {
  const report = await AppRuntime.runPromise(program);
  console.log(JSON.stringify(report, null, 2));
  // The healthy state is gRPC up AND JSON-RPC gone.
  process.exit(report.grpc.ok && !report.jsonRpc.reachable ? 0 : 2);
} catch (err) {
  const unwrapped = unwrapFiberFailure(err);
  console.error(unwrapped instanceof Error ? unwrapped.message : String(unwrapped));
  process.exit(1);
}
