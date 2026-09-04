#!/usr/bin/env node
import * as readline from "node:readline";
import { styleText } from "node:util";
import { SECRET_VALUE_FIELDS, parseArgs } from "../src/cliArgs.js";
import { loadConfigFile, mergeConfigFile } from "../src/configFile.js";
import {
  type CredentialChoice,
  collectCredentials,
  isEmptyWrite,
  probeKey,
  validateSilent,
} from "../src/credentials.js";
import { registerSecret } from "../src/redaction.js";
import { panelBottom, panelRow, panelTop, panelWidth, selectOne, wrapVisible } from "../src/tui.js";
import {
  applyResolvedBaseUrl,
  promptEcho,
  promptMasked,
  resolveInstallBaseUrl,
  savedLabel,
  showRow,
  stepAllowedDirs,
  validateSeedDirs,
} from "./install.js";

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
/** Vertical gap between steps — matches bin/install.ts. */
const gap = () => {
  print("");
  print("");
};
const ok = (msg: string) => `${styleText("green", "✔")} ${msg}`;
const fail = (msg: string) => `${styleText("red", "✖")} ${msg}`;
const warn = (msg: string) => `${styleText("yellow", "!")} ${msg}`;
const info = (msg: string) => styleText("dim", `· ${msg}`);

/**
 * POSIX single-quoting for a path printed inside a copy-pasteable command. A
 * single quote cannot appear inside single quotes, so an embedded one closes
 * the string, escapes itself, and reopens it — the shape `'\''`.
 */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Kept in sync by hand with the copy in bin/install.ts — see the note there. */
type ConfigureChoice = CredentialChoice | "paths";

const CHOICES: { choice: ConfigureChoice; label: string; hint: string }[] = [
  {
    choice: "bundle",
    label: "Credential bundle",
    hint: "one paste — key, signer and the address pins",
  },
  { choice: "api", label: "API key", hint: "everyday key — buckets, upload, download" },
  { choice: "admin", label: "Management key", hint: "mints API keys via generate_api_key" },
  { choice: "both", label: "Both", hint: "" },
  {
    choice: "paths",
    label: "File access folders",
    hint: "upload/download directories when the agent has no MCP roots",
  },
];

/**
 * Injectable seam for the credential chooser, so the menu's branches — in
 * particular "File access folders", which is the only interactive consumer of
 * `--allowed-dirs` — are testable without a terminal.
 */
export interface RunConfigureDeps {
  select?: typeof selectOne;
  /** The readline interface the prompts read from — pipes, under test. */
  createReadline?: () => readline.Interface;
}

export async function runConfigure(
  argv: string[] = [],
  deps: RunConfigureDeps = {},
): Promise<number> {
  const select = deps.select ?? selectOne;
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
    // probe, whose fetch error can embed the Bearer header. Only the
    // secret-bearing fields; see SECRET_VALUE_FIELDS for why the address pins
    // must stay out of the redaction set.
    for (const field of SECRET_VALUE_FIELDS) {
      registerSecret(args.values[field]);
    }
    const { updates, clear, errors, warnings } = await validateSilent(
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
    print(ok(savedLabel({ updates, clear })));
    // After the saved line: they describe what the just-written config costs,
    // not a reason it failed. Exit code is unaffected (see bin/install.ts).
    for (const warning of warnings) print(warn(warning));
    return 0;
  }

  // Refuse a bad --allowed-dirs before the menu is shown, rather than per
  // branch. Validating inside the branches gave the SAME typo three different
  // answers: `install` exits 1, the "File access folders" row exits 1, and a
  // credential row exited 0 while printing a remedy command that could not run.
  // One check up front collapses them into one answer, guarantees the notice on
  // the credential branches can only name folders that already validated, and
  // refuses the typo before the operator navigates a menu at all.
  //
  // Interactive path only: `--silent` returned above, where validateSilent
  // collects this error alongside every other one rather than stopping here.
  const seededDirs = args.values.allowedDirs ?? [];
  if (seededDirs.length > 0) {
    const { errors } = validateSeedDirs(seededDirs);
    if (errors.length > 0) {
      // Unindented and unwrapped, like the flag refusals above: a clamped path
      // is not a named path. stepAllowedDirs keeps its own check as a guard, but
      // it can no longer be reached with a bad seed, so nothing prints twice.
      for (const err of errors) print(fail(err));
      print(info("Nothing was saved. Fix the folder (or drop the flag) and re-run."));
      return 1;
    }
  }

  const { NO_COLOR, FORCE_COLOR } = process.env;
  if (process.stdout.isTTY && !NO_COLOR && !FORCE_COLOR) {
    Object.assign(process.env, { FORCE_COLOR: "3" });
  }

  print("");
  const index = await select(
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
  if (choice === "paths") {
    gap();
    // This branch never reaches the credential step, which is the only consumer
    // of the two address seeds. Say so: silently discarding a `--owner-address`
    // the operator typed is how a pin goes missing and every create_bucket
    // refuses later, far from the command that dropped it.
    const seeded: [flag: string, value: string][] = [];
    const { ownerAddress, keyAdminAddress } = args.values;
    if (ownerAddress) seeded.push(["--owner-address", ownerAddress]);
    if (keyAdminAddress) seeded.push(["--key-admin-address", keyAdminAddress]);
    if (seeded.length > 0) {
      const names = seeded.map(([flag]) => flag).join(" and ");
      print(warn(`${names} not applied — "File access folders" changes folders only.`));
      print(
        info(
          `Apply ${seeded.length === 1 ? "it" : "them"} with: walrus-console-mcp config --silent ` +
            seeded.map(([flag, value]) => `${flag} ${value}`).join(" "),
        ),
      );
      print("");
    }
    // `--allowed-dirs` beside an address seed is deliberately NOT silent (see
    // ParsedArgs.silent), so this call is the only thing that can honour it.
    const write = await stepAllowedDirs({ step: "2/2", seed: args.values.allowedDirs });
    gap();
    // A refused folder is a failed run, not a quiet no-op.
    return write.seedRejected ? 1 : 0;
  }

  // The mirror image of the notice above. Every branch from here on is a
  // credential branch, and none of them reaches stepAllowedDirs — so a
  // `--allowed-dirs` typed alongside an address seed (which is what keeps this
  // argv interactive in the first place) would be discarded in silence under a
  // green "Configuration saved". Report it; do not quietly widen what the row
  // the operator picked is supposed to do.
  if (seededDirs.length > 0) {
    print("");
    print(warn("--allowed-dirs not applied — this row changes credentials only."));
    print(
      info(
        "Apply it with: walrus-console-mcp config " +
          // Single-quoted, because a folder with a space in it would otherwise
          // come back from the shell as two argv entries — parseArgs then reads
          // the first word as the folder and rejects the rest, so the remedy
          // this notice promises would truncate the very path it names.
          seededDirs.map((dir) => `--allowed-dirs ${shellQuote(dir)}`).join(" "),
      ),
    );
  }

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
  /**
   * A value printed verbatim — never wrapped, never clamped, so a pinned Sui
   * address is confirmed in full rather than as a `0xab…` prefix. Delegates to
   * bin/install.ts's `showRow` so the rule has exactly one home.
   */
  const shown = (msg: string) => print(showRow(msg, width));
  railed("");

  const rl =
    deps.createReadline?.() ??
    readline.createInterface({ input: process.stdin, output: process.stdout });

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
          ask: async (question, opts) => {
            const masked = opts?.masked !== false;
            const value = masked
              ? await promptMasked(rl, `${gutter}${accent(question)}`, width ?? undefined)
              : await promptEcho(rl, `${gutter}${accent(question)}`, width ?? undefined);
            // Register each secret as it is typed, before it is probed — and only
            // the masked ones (see the matching comment in bin/install.ts
            // stepAuth for why an address pin must never be registered).
            if (masked) registerSecret(value);
            return value;
          },
          ok: (msg) => railed(ok(msg)),
          fail: (msg) => railed(fail(msg)),
          warn: (msg) => railed(warn(msg)),
          info: (msg) => railed(info(msg)),
          show: (msg) => shown(msg),
          probe: (kind, key) => probeKey(kind, key, baseUrl),
        },
        // Read fresh: this CLI exists to change credentials, so the saved signer it
        // must reason about is whatever is on disk right now.
        loadConfigFile(),
        {
          ownerAddress: args.values.ownerAddress,
          keyAdminAddress: args.values.keyAdminAddress,
        },
      ).then((write) => ({ cancelled: false as const, write })),
      cancelled.then(() => ({ cancelled: true as const, write: undefined })),
    ]);

    if (outcome.cancelled) return 0;
    phase = "done";

    railed("");
    if (isEmptyWrite(outcome.write)) {
      // Nothing was confirmed (a declined bundle). Leave the file untouched —
      // including the base-URL bookkeeping a successful auth would imply.
      railed(warn(savedLabel(outcome.write)));
    } else {
      // Persist the resolved base URL alongside the credentials, so the saved
      // config points at the same API the key was just validated against.
      const { updates, clear } = outcome.write;
      mergeConfigFile(updates, [...clear, ...applyResolvedBaseUrl(updates, baseUrl)]);
      railed(
        width === null
          ? ok(savedLabel(outcome.write))
          : styleText("dim", "saved → ~/.config/walrus-console-mcp/config.json"),
      );
    }
    if (width !== null) {
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
