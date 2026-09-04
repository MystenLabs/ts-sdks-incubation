---
'@mysten-incubation/devstack': minor
---

Add `suiToolsRef` (and the `DEVSTACK_SUI_TOOLS_REF` env var) to `sui()` local and fork modes to choose the `mysten/sui-tools` build the validator image is based on. Fork mode uses it to run the `sui-fork` binary shipped in sui-tools (commit 892d777c onward, v1.80 release tags) instead of compiling it from source, turning a ten-minute first boot into an image pull. The default fork path is unchanged; `image: { pull }` and `DEVSTACK_SUI_FORK_IMAGE` still work for complete prebuilt images. Move codegen runs `sui move summary` in the same toolchain the stack publishes with; the stack-free `devstack codegen` verb fails when the host `sui` CLI is a different release than an explicitly pinned toolchain.
