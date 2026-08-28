/**
 * Pure logic for the shrinkwrap staleness guard (scripts/check-shrinkwrap.mts).
 * Split out so it is unit-testable without shelling out to npm or touching
 * the filesystem.
 */

export interface OutOfRangeDependency {
  readonly name: string;
  readonly range: string;
  readonly pinned: string;
}

export interface StalenessResult {
  readonly missing: readonly string[];
  readonly outOfRange: readonly OutOfRangeDependency[];
}

/**
 * Whether `pinned` (an exact "X.Y.Z", as npm-shrinkwrap.json always records)
 * satisfies `range`. Handles exactly the two range forms this package's own
 * `dependencies` use: a caret range (`^X.Y.Z`) and an exact pin (`X.Y.Z`).
 * Anything else fails closed — an unrecognised range reads as stale.
 */
export function satisfiesRange(range: string, pinned: string): boolean {
  const trimmedRange = range.trim();
  // The trailing `([-+].*)?$` group, plus the `$` anchor itself, both matter:
  // without the anchor this only matched the LEADING numeric prefix of
  // `pinned`, silently ignoring a prerelease/build suffix — so
  // "3.22.1-alpha.0" read as plain "3.22.1". Per semver a prerelease has
  // LOWER precedence than its base version and never satisfies a range this
  // function's model recognises, so a matched suffix fails closed below
  // rather than being ignored.
  const pinnedMatch = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(pinned.trim());
  if (!pinnedMatch) return false;
  if (pinnedMatch[4] !== undefined) return false;
  const [pMajor, pMinor, pPatch] = [1, 2, 3].map((i) => Number(pinnedMatch[i])) as [
    number,
    number,
    number,
  ];

  const exactMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmedRange);
  if (exactMatch) {
    const [eMajor, eMinor, ePatch] = [1, 2, 3].map((i) => Number(exactMatch[i])) as [
      number,
      number,
      number,
    ];
    return pMajor === eMajor && pMinor === eMinor && pPatch === ePatch;
  }

  // Anchored with a trailing `$` so a compound/OR range (e.g.
  // "^3.22.1 || ^4.0.0") does not match on its leading alternative alone and
  // get evaluated as if the rest were not there — it must fall through to
  // the fail-closed `return false` below instead.
  const caretMatch = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(trimmedRange);
  if (!caretMatch) return false;
  const [rMajor, rMinor, rPatch] = [1, 2, 3].map((i) => Number(caretMatch[i])) as [
    number,
    number,
    number,
  ];

  if (rMajor > 0) {
    return pMajor === rMajor && (pMinor > rMinor || (pMinor === rMinor && pPatch >= rPatch));
  }
  if (rMinor > 0) {
    return pMajor === 0 && pMinor === rMinor && pPatch >= rPatch;
  }
  return pMajor === 0 && pMinor === 0 && pPatch === rPatch;
}

/** Compare package.json's direct `dependencies` against what npm-shrinkwrap.json pins. */
export function findStaleDependencies(
  packageDeps: Readonly<Record<string, string>>,
  shrinkwrapVersions: Readonly<Record<string, string>>,
): StalenessResult {
  const missing: string[] = [];
  const outOfRange: OutOfRangeDependency[] = [];
  for (const [name, range] of Object.entries(packageDeps)) {
    const pinned = shrinkwrapVersions[name];
    if (pinned === undefined) {
      missing.push(name);
      continue;
    }
    if (!satisfiesRange(range, pinned)) {
      outOfRange.push({ name, range, pinned });
    }
  }
  return { missing, outOfRange };
}
