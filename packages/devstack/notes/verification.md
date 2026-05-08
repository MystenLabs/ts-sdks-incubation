# Verification owed

Hands-on tasks that complete prior rounds' "done criteria" but can't be checked
from a typecheck or test pass alone. Tick items off as they're verified.

- [ ] **`pnpm pack` round-trip on a fresh `npm install` cwd.** Confirm the
  produced tarball's file tree, exports map, and bin shebang survive the
  publish round-trip before a real `pnpm publish` (gates the C2 entry in
  `deferred.md`).
