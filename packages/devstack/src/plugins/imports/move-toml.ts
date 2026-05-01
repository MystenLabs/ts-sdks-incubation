// Minimal Move.toml parser. Extracts the `[dependencies]` table only —
// just enough to support the recursive imports walker. Realistic subset:
//
//   Foo = { git = "https://...", rev = "v1", subdir = "..." }
//   Foo = { local = "../foo" }
//   Foo = { local = "../foo", override = true }     # override flag ignored
//
// Other dependency forms (curl, post, etc.) and other Move.toml sections
// (`[package]`, `[addresses]`, `[environments]`) are ignored. Comments
// and blank lines are tolerated. Multi-line dependencies are NOT
// supported — every dep must fit on one line. The realistic upstream
// packages (DeepBook, Pyth, Sui framework) all conform.

export interface GitDep {
	kind: 'git';
	name: string;
	repo: string;
	rev: string;
	subdir: string;
}

export interface LocalDep {
	kind: 'local';
	name: string;
	path: string;
}

export type MoveTomlDep = GitDep | LocalDep;

export interface ParsedMoveToml {
	packageName?: string;
	deps: MoveTomlDep[];
}

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
const PACKAGE_NAME_RE = /^\s*name\s*=\s*"([^"]+)"\s*$/;
const DEP_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{(.+)\}\s*$/;

export function parseMoveToml(source: string): ParsedMoveToml {
	const out: ParsedMoveToml = { deps: [] };
	let section = '';
	for (const rawLine of source.split('\n')) {
		const line = stripComment(rawLine);
		if (line.trim() === '') continue;
		const sectionMatch = line.match(SECTION_RE);
		if (sectionMatch?.[1] !== undefined) {
			section = sectionMatch[1];
			continue;
		}
		if (section === 'package') {
			const m = line.match(PACKAGE_NAME_RE);
			if (m?.[1] !== undefined) out.packageName = m[1];
			continue;
		}
		if (section !== 'dependencies') continue;
		const m = line.match(DEP_LINE_RE);
		if (m === null) continue;
		const [, name, body] = m;
		if (name === undefined || body === undefined) continue;
		const fields = parseInlineTable(body);
		const local = fields.local;
		const git = fields.git;
		if (local !== undefined) {
			out.deps.push({ kind: 'local', name, path: local });
			continue;
		}
		if (git !== undefined) {
			const rev = fields.rev;
			if (rev === undefined) {
				throw new Error(`parseMoveToml: dependency '${name}' has 'git' but no 'rev'. Pin the rev.`);
			}
			out.deps.push({
				kind: 'git',
				name,
				repo: gitUrlToOwnerRepo(git),
				rev,
				subdir: fields.subdir ?? '',
			});
			continue;
		}
		throw new Error(
			`parseMoveToml: dependency '${name}' has neither 'git' nor 'local'. Body: ${body}`,
		);
	}
	return out;
}

function stripComment(line: string): string {
	// Toml comments start with #; strip from first un-quoted #. The
	// realistic subset uses only string keys, so a # outside a "..." pair
	// is always a comment.
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') inString = !inString;
		else if (c === '#' && !inString) return line.slice(0, i);
	}
	return line;
}

function parseInlineTable(body: string): Record<string, string> {
	// `key = "value"` pairs separated by commas (or just whitespace, per
	// the Move.toml convention). String values only — booleans / numbers
	// are tolerated but not surfaced.
	const out: Record<string, string> = {};
	const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("([^"]*)"|true|false|[0-9]+)/g;
	for (const m of body.matchAll(re)) {
		const key = m[1];
		const stringVal = m[3];
		if (key === undefined) continue;
		if (stringVal !== undefined) out[key] = stringVal;
	}
	return out;
}

function gitUrlToOwnerRepo(url: string): string {
	// Accept https://github.com/Owner/Repo(.git) or git@github.com:Owner/Repo(.git).
	// Return "Owner/Repo". Anchor with ^ on the host so impersonation
	// strings like https://github.com.evil.com/... don't slip through.
	const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
	if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
		return `${httpsMatch[1]}/${httpsMatch[2]}`;
	}
	const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
		return `${sshMatch[1]}/${sshMatch[2]}`;
	}
	throw new Error(`parseMoveToml: cannot extract owner/repo from git URL: ${url}`);
}
