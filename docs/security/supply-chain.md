# Supply-chain controls and audit

## Update dated 2026-10-06 (America/Los_Angeles)

The 0.12.0 main-branch release audit failed on one newly published advisory:

- `multidict` 6.7.1 (CVE-2026-104874, GHSA-54p9-h82j-f925), a transitive dependency through `instructor` → `aiohttp`/`yarl`, fixed by locking `multidict` **6.9.1** (`uv lock --upgrade-package multidict`; no other package moved; exports regenerated). The local audit then reported no known advisories across 95 Python versions and 87 vendor versions.

## Update dated 2026-10-23, Dependabot alerts (America/Los_Angeles)

GitHub's Dependabot reported open alerts on 2026-10-23. Each was checked against the locked versions; the ones locked below their first fixed version were upgraded, each to that version or the newest fix, and nothing else moved (`uv lock --upgrade-package filelock --upgrade-package pypdf --upgrade-package mako --upgrade-package setuptools` after raising the exact pins in `pyproject.toml`; both exports regenerated with the commands below and installed with `--require-hashes`):

- `pypdf` 6.21.1 → **6.21.2** (runtime): GHSA-6c7f-9265-g8fw / CVE-2026-115572, GHSA-jr96-gvgh-j3r4 / CVE-2026-115585, GHSA-gmh7-3g9r-mjh5 / CVE-2026-115580, all high: crafted cross-reference tables or repeated references to a missing object make parsing run for a long time. **Applies**: the AI's web tool (`app/services/agent/web_fetch.py`, `_read_pdf`) parses PDFs of up to 4 MiB that it opens on the web, in a worker thread with no time limit, so a crafted PDF could keep that vault's process busy. It is reached only with web access turned on (off by default). Attached PDFs are never parsed.
- `Mako` 1.3.12 → **1.4.2** (runtime): GHSA-5639-2j2p-m4mx / CVE-2026-102991 (medium): on Windows a `TemplateLookup` URI starting with a drive letter escapes the template directory. **Does not apply**: MetaList looks up only its own fixed template names (`app/presentation/templates.py`), never a name from a request.
- `filelock` 3.32.6 → **4.2.4** (CI only, through `pip-audit` → `cachecontrol[filecache]`): GHSA-v4x8-3wr5-3wq8 / CVE-2026-112940 (high), GHSA-567q-5qvw-pf92 and GHSA-9vhv-jxww-xfm5 (low): `ReadWriteLock` and `SoftFileLock` on shared or Windows machines. **Does not apply** to MetaList, which never imports filelock.
- `setuptools` 83.0.0 → **84.1.0** (build only; `build-system.requires` raised to match): GHSA-xmj3-9gf7-h52w (low): path escape installing legacy wheels on Windows. **Does not apply**: setuptools only builds MetaList's own wheel.
- `zod` 3.25.76 → **4.6.7** in `scripts/browser-validation` (release browser checks), by raising `puppeteer-core` 25.11.0 → **25.13.0**, whose `chromium-bidi` moved to zod 4: GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404 (high): memory exhaustion validating oversized collections. **Does not apply**: zod runs only in chromium-bidi's Chrome-BiDi mapper, and the checks drive Chrome over CDP and Firefox over its own BiDi. `npm ci` from the new lockfile; puppeteer-core 25.13.0 launched Chrome 156 and Firefox 158 headless and loaded MetaList. The browser test suites' own `package-lock.json` is not tracked (`.gitignore`); `puppeteer` 23.11.1 there pins chromium-bidi 0.11.0 with zod 3.23.8, reached the same way only in Chrome-BiDi mode, so it stays until a puppeteer upgrade is worth its own change.
- `pytest` 8.4.2 → **9.1.1** in `experiments/tag_suggestions/requirements.txt` (an offline experiment, never installed into `.venv` or shipped): GHSA-6w46-j5rx-g56g / CVE-2025-71176 (medium): shared `/tmp/pytest-of-{user}` directories on UNIX. **Does not apply** to MetaList.

Alerts that were already fixed: `pillow` (13.0.0, the first fixed version for every open pillow alert, including the critical GHSA-5x8w-8jj5-q52h, GHSA-332p-7hrc-92wf, GHSA-8g5g-8vmr-9782, GHSA-v9pv-5gc8-w2m6 and GHSA-w889-685w-c8fh), `aiohttp` (3.14.4), `certifi` (2026.10.19) and `uv` (0.13.4) were already locked at their fixed versions on `main`; those alerts were stale. Older pypdf alerts (fixed in 6.20.0–6.21.1) were also already met. The local audit then reported no known advisories across 99 Python versions and 86 vendor versions.

## Update dated 2026-10-23 (America/Los_Angeles)

The main-branch release audit for 0.23.0 failed on three DOMPurify advisories published on 2026-10-22, all fixed in **3.4.17**: GHSA-cg2g-xh64-v4q7 (critical: `SAFE_FOR_TEMPLATES` with a DOM-returning mode leaves template expressions in shadow roots), GHSA-mrv2-3pqr-j5jr (high: an `IN_PLACE` hook that removes a parent or sibling leaves its event handlers armed) and GHSA-c6gr-qvv4-5v3f (low: the SMIL `attributeName=href` guard skipped with `PARSER_MEDIA_TYPE: 'application/xhtml+xml'`). DOMPurify **3.4.17** is vendored: the npm archive's sha512 matched the registry integrity before `package/dist/purify.min.js` and `package/LICENSE` (unchanged) were copied. MetaList sanitizes to a string with the default HTML parser, never sets `SAFE_FOR_TEMPLATES`, `RETURN_DOM`, `IN_PLACE` or `PARSER_MEDIA_TYPE`, and registers only an `uponSanitizeAttribute` hook that removes no node, so none of the three applied; the upgrade keeps the version-based audit clean. The Excalidraw build lockfile also resolves DOMPurify 3.4.16, but it is not among the packages compiled into that bundle (`bundle-packages.json`).

## Update dated 2026-10-04 (America/Los_Angeles)

The main-branch release audit failed on two newly published advisories:

- `urllib3` 2.7.0 (PYSEC-2026-4175, -4176, -4177: streaming decompression limits and HTTPS-proxy TLS settings), fixed by locking `urllib3` **2.8.0** (`uv lock --upgrade-package urllib3`; exports regenerated).
- DOMPurify 3.4.13 (GHSA-p98j-92pf-mc4p: `IN_PLACE` sanitizing with a node-removing `afterSanitize` hook), fixed by vendoring DOMPurify **3.4.16**. The npm archive's sha512 matched the registry integrity before `package/dist/purify.min.js` and `package/LICENSE` were copied. MetaList registers only an `uponSanitizeAttribute` hook and never uses `IN_PLACE`, so the advisory did not apply; the upgrade keeps the version-based audit clean.

## Audit dated 2026-09-12 (America/Los_Angeles)

The review began at checkpoint `8150c089`. The final audit includes 94 locked Python package/version pairs: the existing 71-package runtime/development graph plus pinned release/audit tools. All platform-marker branches are included, even when they would not install on this macOS host. `pip-audit 2.10.1` reported **no known vulnerabilities**. This is advisory metadata coverage, not proof against undisclosed defects or malicious dependencies. [PyPA's audit contract](https://github.com/pypa/pip-audit) explains the distinction.

The vendored JavaScript audit initially matched 14 advisories across three libraries. Each result was checked against the maintainer's published GitHub advisory. Mermaid 11.9.0 matched 11 findings, DOMPurify 3.4.12 matched one, and the previously unversioned markdown-it bundle matched two. An integrity-verified npm archive comparison identified that unversioned bundle as markdown-it 10.0.0 with its leading license banner removed.

This batch replaces those bundles with Mermaid **11.16.1**, DOMPurify **3.4.13**, and markdown-it **14.3.2**, retaining the current Mermaid/DOMPurify major versions and using markdown-it's patched v14 maintenance line. zxcvbn **4.4.2** is unchanged. Original code files and retired license paths are removed; patched licenses are shipped beside the bundles. Follow-up OSV queries returned **no known advisories** for the four selected package/version pairs. The raw reports retain their UTC query timestamp (September 13 UTC corresponds to September 12 locally).

Applicability is narrower than version matching: MetaList does not use the DOMPurify `IN_PLACE` plus element-removal-hook pattern required by its advisory. The old browser markdown-it entrypoint is not loaded by the current server-rendered note path, but its vulnerable file was shipped. Mermaid does execute for fenced diagrams with strict security configuration; several upstream issues involve sanitization or resource consumption. These are package-level findings, not a claim that every upstream exploit was reproduced against MetaList.

- [Python report](audits/2026-09-12-python.json)
- [Final vendor report](audits/2026-09-12-vendor.json)
- [Maintainer advisory evidence](audits/2026-09-12-browser-advisories.json)
- [Machine-readable vendor provenance](vendor-manifest.json)

## Vendored bundle inventory

Each bundle was compared with an npm archive whose registry integrity digest was verified before extracting its code/license in temporary storage. The manifest records exact archive URLs, integrity values, members, and local SHA-256 values. Checksums identify reviewed bytes; they do not establish that the original publisher is trustworthy.

| npm package | Shipped version | Bundle SHA-256 |
|---|---|---|
| dompurify | 3.4.17 | `cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31` |
| mermaid | 11.16.1 | `18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954` |
| zxcvbn | 4.4.2 | `f42c651f40506acb6b662490f338dd47a5951d3312039c4ab8fe5090484f351a` |
| @excalidraw/excalidraw (built bundle) | 0.18.1 | `98d0fb0b56f3a2b061d643d8040918e09e0ba72ad4208c5d25ff2e43e15b3946` |

markdown-it was removed on 2026-10-17: no page loaded it, and the browser renderer that used it had no caller (`docs/security/html-sinks.md`).

Excalidraw ships only as ES modules for bundlers, so unlike the other rows it is not a file copied from the npm archive. `scripts/vendor/excalidraw/` builds it deterministically with esbuild from an exact `package-lock.json` (React and React DOM included), patches out its CDN font fallback and WebAssembly font subsetting so the unchanged Content Security Policy holds, and records every compiled npm package in `bundle-packages.json`. `check_supply_chain.py check` verifies that list against the lockfile and the manifest's `bundle` entry, and `audit` queries OSV for each bundled package version. See `scripts/vendor/excalidraw/README.md` for rebuilding and for the fonts and features left out.

The inventory covers shipped top-level bundles. It is not a separately resolved audit of every implementation embedded within Mermaid's bundle, nor an audit of the Node-only Mermaid CLI/Puppeteer development dependency graph. npm development tooling is not installed by the release's Node unit-test step. Future changes to that build boundary require revisiting this scope.

## Release validation

`requirements/runtime.txt` and `requirements/ci.txt` are deterministic, hash-bearing exports of `uv.lock`. The CI file includes the `dev` extra and `release` dependency group. Build/test tools are pinned in `pyproject.toml`; runtime dependency versions were retained. CI installs with pip's `--require-hashes`, checks both exports against the lock, validates vendor inventory/checksums/licenses and full Action commit pins, then audits every locked version and vendor version. Network/audit errors fail the build; reports are retained for diagnosis. No advisory ignore list or `continue-on-error` bypass is added.

The build uses `python -m build --no-isolation`, so the pinned setuptools/wheel/build tools are actually used. Distribution verification checks runtime resources and rejects obsolete vendor JavaScript as well as missing/stale files. One verified wheel/source-distribution pair is reused by every downstream job. Each clean platform environment installs hash-verified runtime dependencies and then that wheel with `--no-deps`, outside the checkout. Dependency consistency and actual installed CLI/HTTP/HTTPS startup run on Windows, macOS, and Linux at the supported Python endpoints, 3.11 and 3.14. GitHub caches downloaded packages and locked browser tooling, while pip hash verification and the npm lockfile remain mandatory on every clean installation.

Publication requires build, all platform/Python unit jobs, per-OS JavaScript/sanity, every installed-package/update job, browser smoke, and browser soak, using the same tested distributions. Manual dispatch cannot publish. **Before creating any release tag**, the exact commit must already have a successful complete main workflow run. The tag job independently verifies that run's jobs and artifact, then publishes the same files without repeating the matrix. Local checks, a previous commit, or a pending/skipped/canceled/failed job do not meet that gate. The full cross-platform matrix runs once on the main push, not on feature branches. Local macOS validation does not establish Windows/Linux success.

Every third-party Action now uses the full commit obtained from its official repository's current v4/v5 or release/v1 reference. Human-readable comments retain those reference names. Pinning an Action does not freeze the hosted runner image, Python/Node patch selection, or every external service/container used by the Action.

## Updating dependencies

### Managed update installer

`app/services/update_installer.py` pins official [uv 0.12.17](https://github.com/astral-sh/uv/releases/tag/0.12.17)
archives for supported Windows, macOS, and Linux target triples by SHA-256. The
hashes match the official release's `sha256.sum`. Only the target archive's exact
`uv`/`uv.exe` member is read. The verified archive remains in MetaList's private
user cache; the extracted executable must equal those trusted bytes before every
use and must report exactly 0.12.17. The user's global uv is neither executed nor
replaced. Windows uv 0.12.13 contained the
[upstream change](https://github.com/astral-sh/uv/pull/18713) that replaced temporary
PE-resource editing with in-memory editing; the pinned 0.12.17 includes that fix.
This avoids the reported operation but does not establish which software denied it
on the affected computer.

This required updater download is separate from the Python dependency lock and
must be reviewed when changing the pinned version, official URLs, target coverage,
or archive hashes. Release smoke tests isolate the managed cache and require its
executable on every operating system; the older hash-locked fixture uv only creates
the disposable starting installation and is removed from `PATH` before an ordinary
update begins. The recovery test also pins the published
MetaList 0.7.1 wheel URL and SHA-256 in `scripts/smoke_self_update.py`; it uses the
actual old updater code rather than substituting the candidate's updater.

### Locked Python and browser dependencies

1. Review maintainer release notes/advisories and change the relevant exact requirement in `pyproject.toml`. Resolve with `uv lock`; review the resulting graph changes. Runtime dependencies, developer extras, and release tools have distinct roles.
2. Regenerate both exports (uv version is pinned in the release group):

```bash
uv export --locked --no-default-groups --no-emit-project --no-header --no-annotate -o requirements/runtime.txt
uv export --locked --all-extras --group release --no-emit-project --no-header --no-annotate -o requirements/ci.txt
python -m pip install --require-hashes -r requirements/ci.txt
python scripts/check_supply_chain.py check
python scripts/check_supply_chain.py audit --output /tmp/metalist-dependency-audit
```

Run these commands after activating `.venv`; on Windows use a writable absolute output directory instead of `/tmp`. The metadata audit removes installation markers to include all platform branches and does not install or execute the audited distributions. Hash verification applies during installation; `--disable-pip --no-deps` is deliberate for metadata-only auditing.

3. For a browser library, obtain the official npm archive, verify its integrity, copy the selected distribution and license, update the manifest and runtime URL, and remove the retired bundle. Recheck advisories and run the actual browser smoke. Review advisory conditions instead of equating every version match with application exploitability.
4. For an Action update, resolve the official reference to its full commit, review the upstream change/release, and update both SHA and reference comment. Do not replace the SHA with a movable tag.
5. Run the suites, startup gates, distribution checks, and relevant browser/installed-package validation. Record changed versions, advisory results and limitations in a new dated audit. Obtain human testing confirmation before a code checkpoint. A separately authorized release requires the complete exact-commit matrix again.

Review dependencies when advisories arrive, during dependency updates, and before releases. No background monitoring or scheduled job was created by this review.

## Initial maintainer advisories

These affected the reviewed old versions; the final versions above no longer match them in the completed query. Preserve these links as evidence rather than an active finding list.

- [GHSA-2v8p-3f2j-5mp7](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-2v8p-3f2j-5mp7): Mermaid XY Charts are vulnerable to an infinite loop DoS (upstream severity: medium).
- [GHSA-3rrr-jr9j-h3q3](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-3rrr-jr9j-h3q3): Mermaid Architecture diagrams are vulnerable to prototype pollution (upstream severity: medium).
- [GHSA-55q2-fjhq-7xh7](https://github.com/cure53/DOMPurify/security/advisories/GHSA-55q2-fjhq-7xh7): IN_PLACE hook removal leaves a detached subtree executable, causing XSS (upstream severity: low).
- [GHSA-6m6c-36f7-fhxh](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-6m6c-36f7-fhxh): Mermaid Gantt Charts are vulnerable to an Infinite Loop DoS (upstream severity: medium).
- [GHSA-6v5v-wf23-fmfq](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-6v5v-wf23-fmfq): Quadratic complexity DoS in smartquotes rule via replaceAt string operations (upstream severity: medium).
- [GHSA-6vfc-qv3f-vr6c](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-6vfc-qv3f-vr6c): Possible ReDOS in newline rule (upstream severity: medium).
- [GHSA-6x64-9x62-f2gx](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-6x64-9x62-f2gx): Mermaid allows CSS injection applying to sibling elements of the diagram (upstream severity: medium).
- [GHSA-7rqq-prvp-x9jh](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-7rqq-prvp-x9jh): Improper sanitization of sequence diagram labels leads to XSS (upstream severity: critical).
- [GHSA-87f9-hvmw-gh4p](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-87f9-hvmw-gh4p): Improper sanitization of configuration leads to CSS injection (upstream severity: medium).
- [GHSA-8gwm-58g9-j8pw](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-8gwm-58g9-j8pw): Improper sanitization of architecture diagram iconText leads to XSS (upstream severity: critical).
- [GHSA-c4c3-pg64-4m4v](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-c4c3-pg64-4m4v): Mermaid configuration APIs allow prototype pollution (upstream severity: low).
- [GHSA-ghcm-xqfw-q4vr](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-ghcm-xqfw-q4vr): Improper sanitization of `classDef` in state diagrams leads to HTML injection (upstream severity: medium).
- [GHSA-rhh3-jpg6-66xh](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-rhh3-jpg6-66xh): Mermaid radar diagrams are vulnerable to DoS (upstream severity: medium).
- [GHSA-xcj9-5m2h-648r](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-xcj9-5m2h-648r): Improper sanitization of `classDefs` in diagrams leads to CSS injection (upstream severity: medium).

## Local validation for this batch

1,421 Python tests, 628 Node tests, both startup gates, actual patched-vendor browser checks, and the full disposable browser smoke passed. Wheel/sdist verification checked 425 runtime resources and rejected obsolete vendor bundles. A clean hash-verified wheel installation passed dependency consistency and installed CLI/HTTP/HTTPS startup outside the checkout on macOS/Python 3.12.3. Lock exports/pins/vendor checks also passed with an empty uv cache. The full hosted platform matrix has not run for this batch; it remains required before release.
