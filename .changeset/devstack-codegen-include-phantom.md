---
'@mysten-incubation/devstack': minor
---

New `codegen.includePhantomTypeParameters` stack option, passed through to `@mysten/codegen`: phantom type parameters become required arguments on generated struct factories, so the generated BCS classes compose into fully-qualified type tags (`Pool(DBTC, DUSDC).name`). Default remains off.
