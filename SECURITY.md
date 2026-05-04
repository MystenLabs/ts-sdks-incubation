# Security

## Reporting a vulnerability

Do **not** open a public GitHub issue for a security vulnerability.

Email security reports to `security@mystenlabs.com` with:

- A description of the issue and the affected package(s).
- Reproduction steps or a proof-of-concept.
- Impact assessment as you understand it.
- Any suggested mitigation.

We will acknowledge receipt within two business days and aim to provide an initial
assessment within seven. Coordinated disclosure is expected — please give us a reasonable
window to ship a fix before any public discussion.

## Scope

This repo includes **prototype packages** (devstack and friends) that are not yet
published to npm and have no consumers outside this monorepo. Vulnerability reports for
those packages are still welcome — we'd rather find issues now than after a release —
but the urgency tier is lower than for the published packages.

The published packages (`@mysten-incubation/dev-wallet`) are in scope at the standard
urgency tier.

## Out of scope

- Issues in dependencies — please report upstream first; reach out to us if the
  dependency is unresponsive and the issue impacts our packages.
- Findings from automated scanners without a working proof of impact.
- Theoretical issues with no practical exploit path.

## Disclosure

We publish security advisories via GitHub's security advisory system on this repo.
Reporters are credited unless they request otherwise.
