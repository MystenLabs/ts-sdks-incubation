#!/usr/bin/env node
import * as readline from "node:readline";
import { styleText } from "node:util";
import { parseArgs } from "../src/cliArgs.js";
import { loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import {
  type CredentialChoice,
  collectCredentials,
  probeKey,
  validateSilent,
} from "../src/credentials.js";
import { registerSecret } from "../src/redaction.js";
import { panelBottom, panelRow, panelTop, panelWidth, selectOne, wrapVisible } from "../src/tui.js";
import { applyResolvedBaseUrl, promptMasked, resolveInstallBaseUrl } from "./install.js";

/**
 * `walrus-console-mcp config` — configure credentials on a machine that is
 * already set up. Same chooser and prompts as the installer's steps 1 and 2,
 * without the agent-registration step: registration stores only the launch
 * command, never the keys, so changing a credential does not change it.
 *
 * Returns the exit code rather than calling process.exit, so it is testable.
 */

const PAD = "     ";

const accent = (s: string) => styleText("cyan", s);
const print = (msg: string) => process.stdout.write(`${msg}\n`);
const line = (msg: string) => print(`${PAD}${msg}`);
/** Vertical gap between steps — matches bin/install.ts. */
const gap = () => {
  print("");
  print("");
};
const ok = (msg: string) => `${styleText("green", "✔")} ${msg}`;
const fail = (msg: string) => `${styleText("red", "✖")} ${msg}`;
const warn = (msg: string) => `${styleText("yellow", "!")} ${msg}`;
const info = (msg: string) => styleText("dim", `· ${msg}`);

const CHOICES: { choice: CredentialChoice; label: string; hint: string }[] = [
  { choice: "api", label: "API key", hint: "everyday key — buckets, upload, download" },
  { choice: "admin", label: "Management key", hint: "mints API keys via generate_api_key" },
  { choice: "both", label: "Both", hint: "" },
];

export async function runConfigure(argv: string[] = []): Promise<number> {
  const args = parseArgs(argv, process.env);
  if (args.errors.length > 0) {
    for (const err of args.errors) print(fail(err));
    return 1;
  }

  // Same allowlist check the installer runs (see resolveInstallBaseUrl): `config`
  // sends the Bearer key to this host too, so it must not accept one `install`
  // would reject. Reported as an exit code here rather than thrown, since
  // runConfigure returns its status instead of exiting.
  let baseUrl: string;
  try {
    baseUrl = resolveInstallBaseUrl();
  } catch (err) {
    print(fail(err instanceof Error ? err.message : String(err)));
    return 1;
  }

  if (args.silent) {
    // Flag/env secrets skip the interactive `ask` wrapper — register before the
    // probe, whose fetch error can embed the Bearer header.
    for (const value of Object.values(args.values)) {
      if (value) registerSecret(value);
    }
    const { updates, clear, errors } = await validateSilent(
      args.values,
      (kind, key) => probeKey(kind, key, baseUrl),
      loadConfigFile(),
    );
    if (errors.length > 0) {
      for (const err of errors) print(fail(err));
      return 1;
    }
    // Persist the resolved base URL, matching the interactive path below.
    mergeConfigFile(updates, [...clear, ...applyResolvedBaseUrl(updates, baseUrl)]);
    print(ok("Credentials saved"));
    return 0;
  }

  const { NO_COLOR, FORCE_COLOR } = process.env;
  if (process.stdout.isTTY && !NO_COLOR && !FORCE_COLOR) {
    Object.assign(process.env, { FORCE_COLOR: "3" });
  }

  print("");
  const index = await selectOne(
    CHOICES.map(({ label, hint }) => ({ label, hint })),
    {
      title: "CHOOSE CREDENTIALS",
      step: "1/2",
      hint: "↑/↓ move   enter select   esc cancel",
    },
  );
  if (index === null) {
    print("");
    print(info("Cancelled — your saved credentials are untouched."));
    return 0;
  }
  const choice = CHOICES[index]?.choice ?? "api";

  gap();
  // A closed panel drawn as content streams — the height is only needed for the
  // bottom border, which prints at the end anyway. Mirrors bin/install.ts's
  // streamPanel; see the note on maskedPanelLine for the live prompt row.
  const width = panelWidth();
  if (width === null) print(`${accent("2/2")}  ${styleText("bold", "AUTHENTICATE")}`);
  else print(panelTop(styleText("bold", "AUTHENTICATE"), width, accent("2/2")));
  const gutter = width === null ? PAD : `${styleText("dim", "│")}  `;
  // Wrapped rather than clamped: this panel is never redrawn, so a wrapped row
  // costs nothing, and truncating a validator message mid-sentence loses it.
  // Continuations indent two further so they read as one message.
  const railed = (msg: string) => {
    if (width === null) {
      print(`${PAD}${msg}`);
      return;
    }
    // -7 not -5: continuations indent four, and panelRow keeps a column of
    // margin before the border (see the matching note in bin/install.ts).
    const [first, ...rest] = wrapVisible(msg, width - 7);
    print(panelRow(`  ${first ?? ""}`, width));
    for (const l of rest) print(panelRow(`    ${l}`, width));
  };
  railed("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Tracks whether the prompts have completed, so a stdin close/SIGINT before
  // that point (Ctrl-D, an empty pipe, a script that forgot a flag) is treated
  // as a cancel rather than the deliberate rl.close() in `finally` below. Mirrors
  // bin/install.ts's `phase`/`cancel` guard, but this function returns an exit
  // code instead of calling process.exit — so cancellation resolves a promise
  // that we race against the prompt sequence instead of exiting the process.
  let phase: "auth" | "done" = "auth";
  let resolveCancelled: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const cancel = () => {
    if (phase !== "auth") return;
    phase = "done";
    print("");
    print(info("Cancelled — your saved credentials are untouched."));
    resolveCancelled?.();
  };
  rl.on("SIGINT", cancel);
  // If stdin ends before the prompts finish, the pending rl.question would never
  // resolve, leaving the top-level await unsettled — Node would exit 13. Exit
  // cleanly instead (see the matching comment in bin/install.ts).
  rl.on("close", cancel);

  try {
    const outcome = await Promise.race([
      collectCredentials(
        choice,
        {
          // Register each secret as it is typed, before it is probed (see the
          // matching comment in bin/install.ts stepAuth).
          ask: async (question) => {
            const value = await promptMasked(
              rl,
              `${gutter}${accent(question)}`,
              width ?? undefined,
            );
            registerSecret(value);
            return value;
          },
          ok: (msg) => railed(ok(msg)),
          fail: (msg) => railed(fail(msg)),
          warn: (msg) => railed(warn(msg)),
          info: (msg) => railed(info(msg)),
          probe: (kind, key) => probeKey(kind, key, baseUrl),
        },
        // Read fresh: this CLI exists to change credentials, so the saved signer it
        // must reason about is whatever is on disk right now.
        loadConfigFile(),
      ).then((write) => ({ cancelled: false as const, write })),
      cancelled.then(() => ({ cancelled: true as const, write: undefined })),
    ]);

    if (outcome.cancelled) return 0;
    phase = "done";

    // Persist the resolved base URL alongside the credentials, so the saved config
    // points at the same API the key was just validated against.
    const { updates, clear } = outcome.write;
    mergeConfigFile(updates, [...clear, ...applyResolvedBaseUrl(updates, baseUrl)]);
    railed("");
    if (width === null) {
      line(ok("Credentials saved"));
    } else {
      railed(styleText("dim", "saved → ~/.config/walrus-console-mcp/config.json"));
      railed("");
      print(panelBottom(width));
    }
  } finally {
    rl.close();
  }

  gap();
  print(info("Not connected to an agent yet? Run walrus-console-mcp install"));
  // Trailing gap so the shell prompt doesn't come back flush against the panel.
  gap();
  return 0;
}
