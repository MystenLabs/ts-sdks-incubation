---
'@mysten-incubation/create-devstack-app': patch
---

Scaffolder template now tracks the 0.1.0 `@mysten-incubation/devstack` (`^0.1.0`) and
`@mysten-incubation/dev-wallet` (`^0.3.0`) releases, and the documented create command uses the
`@latest` tag — `pnpm create @mysten-incubation/devstack-app@latest my-app` — so package managers
resolve the newest scaffolder instead of a cached older version.
