# Deferred Security Work

## Status (2026-09-12)

The intended deployment is a personal single-user application on a trusted computer, with explicit configuration for LAN access. This document records residual risks and future work, not a blanket claim that dependencies or releases are safe. Known advisories found during F17 and their patched versions are documented in [the dated supply-chain audit](supply-chain.md).

## Implemented release controls

CI runs Python/Node tests, startup sanity, lock-export/checksum checks, and vulnerability audits before building. Runtime and CI dependencies install from hash-bearing lock exports. Builds use pinned release tools, GitHub Actions reference immutable commits, wheel/sdist resources are checked, and the same wheel passes clean installed startup checks on Windows/macOS/Linux × Python 3.10–3.13 before publication. Pending or failed platform checks block publication. Local testing does not establish that matrix for a future commit.

The remaining process is maintenance: review audit results, update pins and manifests deliberately, and rerun validation for the exact release commit. A successful advisory lookup is not proof against undisclosed vulnerabilities, a compromised publisher, or malicious packages. The Node-only diagram/browser development tool graph is separate from the shipped vendored bundles and is not covered by the Python/vendor audit. See [the update procedure](supply-chain.md#updating-dependencies).

## Periodic Verification

These are maintenance exercises rather than new application features:

- Perform an occasional full security review after substantial authentication,
  encryption, networking, HTML-rendering, backup, restore, or update changes.
- Periodically run the encrypted-namespace storage audit and confirm that newly
  persisted fields have been added to its storage contract.
- Test restoring a real backup into a controlled environment so backup
  recoverability is demonstrated rather than assumed.
- Review persistent server logs and browser storage after new diagnostics or UI
  state features are introduced, ensuring that decrypted note text, searches,
  passwords, tokens, and keys are absent.
- Reassess TLS and certificate handling if MetaList moves beyond a trusted LAN,
  becomes internet-accessible, or is deployed behind a cloud service or reverse
  proxy.

## Deployment Changes That Require a New Threat Model

The present security conclusion should be revisited before any of the following:

- Hosting MetaList on the public internet or in a cloud environment.
- Supporting multiple users or users who do not fully trust one another.
- Allowing third-party plugins, extensions, automation, or agent access.
- Exposing `@shell` outside a loopback-only, explicitly enabled local workflow.
- Accepting databases, backup archives, or imports supplied by untrusted people.
- Running MetaList on an untrusted or shared operating-system account.
- Adding browser-accessible outbound network destinations beyond the current
  same-origin policy.

Such deployments would likely need stronger identity and authorization models,
managed TLS, secrets management, tenant isolation, audit logging, deployment
sandboxing, and a separate design for any shell-like capability.

## Known Residual Risks

The following cannot be fully solved by additional MetaList application code:

- Malware, an administrator, or another sufficiently privileged process on the
  host can inspect process memory, control the browser, or modify executable
  code while a namespace is unlocked.
- A browser extension with permission to read or modify MetaList pages can see
  decrypted data rendered in the page.
- Process-memory inspection may recover the in-memory data-encryption key or
  decrypted content during an authenticated session.
- Explicit logout removes live references and decrypted runtime stores but does
  not guarantee forensic overwriting of allocations previously used by Python
  or the browser. Terminating the process provides a stronger cleanup boundary,
  but cannot undo a dump captured while the namespace was unlocked.
- A user who proceeds through an unexpected TLS certificate warning may connect
  to an impersonating server.
- A compromised build, release account, dependency, or package repository could
  deliver code that reads decrypted data at runtime.

Operational mitigations include using a trusted and patched computer, limiting
browser extensions, treating unexpected certificate changes as suspicious,
locking MetaList when it is not in use, applying appropriate Windows crash-dump
policy where required, and installing releases only from the expected project.

## Low-Priority or Excessive Controls for the Current Deployment

Unless the threat model changes, the following are not currently justified by
their complexity or inconvenience:

- Client TLS certificates for ordinary LAN access.
- Hardware security module integration.
- Routine data-encryption-key rotation without evidence of key compromise.
- More expensive Argon2id settings solely for marginal gains over the current
  memory-hard configuration and password policy.
- Eliminating all in-memory plaintext while the user is actively viewing or
  editing notes.
- Enterprise multi-user authorization, tenant isolation, or centralized audit
  infrastructure.

## Decision

No further security feature is presently required for the personal trusted-LAN
deployment. Future work should begin with supply-chain and release verification,
or with a fresh threat-model review if the deployment assumptions change.
