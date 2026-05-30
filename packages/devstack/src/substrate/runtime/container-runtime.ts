// Substrate-level re-export of the container-runtime service.
//
// Why this exists: the root barrel must not name the L1 Docker
// implementation directly. ARCHITECTURE.md treats L1 (the
// `runtime/docker/*` modules) as replaceable per backend, so a
// future backend swap (e.g. podman, firecracker) re-points this one
// file rather than threading through every consumer of the root
// barrel.
//
// Internal callers (plugins, orchestrators) continue to import from
// `runtime/docker/service.ts` directly — that is fine because those
// callers already live inside L1's scope.

export { ContainerRuntimeService } from '../../runtime/docker/service.ts';
