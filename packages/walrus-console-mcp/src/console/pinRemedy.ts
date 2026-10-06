/**
 * The two address pins — `create_bucket`'s owner and manager — as a user sets
 * them, for the refusals that tell the user to set or correct one. The owner
 * pin also verifies the bucket `upload_file` writes to.
 *
 * The extension's form field comes first (COMG-851 review on PR #54). A Claude
 * Desktop user configures the server only through the Walrus Console
 * extension's settings form, which sets the env var itself — and env beats the
 * config file — so the env var and `walrus-console-mcp config` change nothing
 * for them. Both stay listed for every other host. `config` also covers the
 * credential bundle, so the bundle is not offered as a remedy of its own.
 *
 * `field` is the form field's title in manifest.json; tests/pinRemedy.test.ts
 * fails if the two drift apart.
 */
interface PinSetting {
  readonly field: string;
  readonly envVar: string;
}

export const WEB_ACCOUNT_PIN: PinSetting = {
  field: "Web Account Address",
  envVar: "CONSOLE_WEB_ACCOUNT_ADDRESS",
};

export const KEY_ADMIN_PIN: PinSetting = {
  field: "Key Admin Address",
  envVar: "CONSOLE_KEY_ADMIN_ADDRESS",
};

/** No leading verb: each refusal supplies its own ("set …", "correct …"). */
const pinRemedy = ({ field, envVar }: PinSetting): string =>
  `${field} in the Walrus Console extension's settings (Claude Desktop), ${envVar} in the ` +
  "server's environment, or run `walrus-console-mcp config`";

export const WEB_ACCOUNT_PIN_REMEDY = pinRemedy(WEB_ACCOUNT_PIN);
export const KEY_ADMIN_PIN_REMEDY = pinRemedy(KEY_ADMIN_PIN);
