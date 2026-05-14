// We deliberately do not spread the full `process.env` into spawned children:
// devstack may be invoked with secrets in env (e.g. `MASTER_KEY=...` for
// debugging, AWS creds from a CI runner) that have no business reaching
// third-party plugin scripts. Instead we forward only well-known operational
// vars needed to locate binaries, write temp files, and respect tooling
// conventions.
const ALLOWED_ENV_KEYS: ReadonlyArray<string> = [
	'PATH',
	'HOME',
	'USER',
	'SHELL',
	'LANG',
	'LC_ALL',
	'TERM',
	'TMPDIR',
	'NODE_ENV',
	'NODE_PATH',
	'NODE_OPTIONS',
	'PWD',
	'OLDPWD',
	'SystemRoot',
	'APPDATA',
	'LOCALAPPDATA',
	'USERPROFILE',
	'Path',
];

export const inheritedHostEnv = (): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const key of ALLOWED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
};
