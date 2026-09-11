# MetaList

A minimalist single-user note-taking app focused on server-side rendering (SSR), fast in-memory tree operations, and efficient sync/diff updates.

## Features
- Rich text editing (ContentEditable) with image support
- Drag-and-drop note reordering
- Real-time content saving
- Keyboard shortcuts / cheatsheet (press `?` in the app)
- Linked-list ordering model for efficient reorders
- Optional password protection + encryption at rest (AES-GCM)
- Multi-tab search contexts with server-persisted scroll/search state (survives browser restarts)
- Manual namespace backups/restores to a user-selected backup folder with retention controls

## Technology Stack

### Backend
- FastAPI
- SQLite (via stdlib `sqlite3`) with a guard-aware wrapper (`SafeSession`)
- Mako templates for SSR

### Frontend
- Vanilla JavaScript (no framework)
- HTML5 Drag and Drop API
- ContentEditable for rich text editing
- CSS custom properties for theming

### Testing
- Python/unit tests plus manual regression passes

## Architecture (High Level)
- Server renders the base page via Mako templates.
- The browser client drives interaction via `/api2` JSON endpoints.
- Notes are loaded/decrypted into an in-memory store at startup; a post-startup DB read guard prevents accidental runtime SELECTs.

## Security Boundary

Password protection encrypts namespace data at rest. While a namespace is
unlocked, the server must hold its data-encryption key and decrypted working
data in process memory, and the browser holds the decrypted content currently
rendered in the page. A sufficiently privileged local process, debugger,
administrator, browser extension, or process-memory dump can therefore expose
an unlocked namespace.

Explicit logout removes the live key and purges decrypted runtime stores, but
it cannot guarantee forensic overwriting of memory previously allocated by the
Python or browser runtimes. Protect the host account and operating system, and
see the detailed [security architecture and threat model](docs/security/README.md).

## Development

### Setup
For a published one-off run with uv:
```bash
uvx metalist
```

For a persistent uv tool install:
```bash
uv tool install metalist
metalist
```

After the first installation, update and restart MetaList with one cross-platform command:
```bash
metalist update
```
The updater checks the installed version against the latest PyPI release first. If MetaList is already current, it reports the installed version and leaves all running namespaces untouched. When an update is available, it checks the installer prerequisites, stops running namespaces, and creates and verifies a new backup of every namespace before installation can begin. Each archive includes the complete notes/settings database, the attachments/sounds database when present, and any legacy search-history database. Locked namespaces are backed up with their encrypted data and key metadata intact, without requiring a password.

Backups are saved to `~/MetaList/namespaces/<namespace>/backups/<namespace>-<timestamp>.metalist-backup.tar.gz`; the updater prints each verified path. Existing backups remain unchanged and are not pruned. If any backup fails, the update aborts with the current installation intact; run `metalist` to restart the stopped servers after resolving the failure.

Only after all backups pass does the updater hand off to an external PowerShell process on Windows or `/bin/sh` on macOS/Linux so the installed environment can unlock. It installs the exact version reported by PyPI with a forced cache refresh, launches MetaList again, and reports the installed version (for example, `MetaList updated to v0.4.1.`). This protection requires an installed version containing the backup safeguard and applies to `metalist update`; direct pip/uv install commands do not run it.

For pip, users can run `pip install metalist`. For a non-editable local install from this checkout, use `uv pip install .` or `pip install .` instead of the editable command below.

```bash
python3 -m venv .venv
source .venv/bin/activate
uv pip install -e .[dev]

npm install
```

### Run
The installed entrypoint starts or restarts every known namespace, prints their URLs, and exits:
```bash
metalist
```
For source-checkout compatibility, `python main.py` performs the same orchestration. Use `metalist work`, `python main.py --namespace work`, or `python main.py work` when you want one foreground namespace process.

Shell execution is disabled by default. To enable `@shell` for every namespace
started by the top-level orchestrator, use either:

```bash
metalist --enable-shell
python main.py --enable-shell
```

This flag is propagated to every namespace child process. The top-level process
prints a conspicuous shell-enabled banner before its namespace launch results.
Use `python main.py work --enable-shell` for one foreground namespace. Shell
routes remain restricted to loopback clients using a loopback request host,
even when the rest of MetaList is intentionally exposed to a LAN.

`metalist` and explicit single-namespace source runs bind to loopback at `127.0.0.1:8000` by default. This keeps a normal laptop launch off LAN and public interfaces unless remote access is explicitly configured.
On first startup, MetaList also auto-generates a self-signed TLS pair at `~/MetaList/certs/metalist-cert.pem` and `~/MetaList/certs/metalist-key.pem`, then enables HTTPS on the same bind host at port `8443`. If you already have real PEM files, point `METALIST_TLS_CERT` and `METALIST_TLS_KEY` at them instead. Set `METALIST_AUTO_GENERATE_TLS=0` only if you explicitly want HTTP-only startup.

Database selection:
- No explicit namespace on a single-namespace launch: `~/MetaList/namespaces/default/default.metalist.db`
- `--namespace work` or `METALIST_NAMESPACE=work`: `~/MetaList/namespaces/work/work.metalist.db`
- The related files DB is derived automatically, so `namespaces/work/work.metalist.db` uses `namespaces/work/work.metalist.files.db`
- Remembered launch ports are stored as plaintext metadata inside each namespace's main `*.metalist.db`
- Launch precedence is: explicit CLI flags > env vars > saved namespace profile; if a namespace has no saved profile, launch it once with explicit ports or configure ports from the UI
- Backups stay beside the namespace data under `~/MetaList/namespaces/work/backups/` and use one archive per snapshot with filenames like `work-<timestamp>.metalist-backup.tar.gz`
- The Backup Settings modal targets one user-selected backup folder and can include multiple namespaces in a single run
- Restoring `work` into `work` is the normal overwrite path; importing a backup under a different namespace name can create a new target namespace with automatically selected conflict-free ports.

Useful env flags:
- `CRASH_SERVER_ON_FAIL=1` (default): fail-fast on validation errors
- `API_PREFIX=/api2`: override API prefix (client assumes `/api2` by default)
- `METALIST_NAMESPACE=work`: select `~/MetaList/namespaces/work/work.metalist.db`
- `METALIST_HOST=127.0.0.1` (default): bind the main app to a specific interface; use a LAN IP or `0.0.0.0` only for intentional remote access
- `METALIST_ALLOWED_HOSTS=notes.example.com,192.168.1.20`: comma-separated public/LAN hostnames accepted in HTTP `Host` headers; loopback aliases and a specific non-wildcard `METALIST_HOST` are accepted automatically
- `METALIST_PORT=8000` (default): bind the main app to a different port
- `METALIST_HTTPS_PORT=8443`: override the HTTPS port when TLS is enabled
- `METALIST_TLS_CERT=/path/to/fullchain.pem` + `METALIST_TLS_KEY=/path/to/privkey.pem`: override TLS paths
- `METALIST_AUTO_GENERATE_TLS=0`: disable automatic creation of the default self-signed TLS pair
- default TLS paths: `~/MetaList/certs/metalist-cert.pem` and `~/MetaList/certs/metalist-key.pem`
- `METALIST_FORWARDED_ALLOW_IPS=127.0.0.1,::1` (default): trust proxy headers only from those reverse-proxy IPs
- `--enable-shell`: opt in to local `@shell` execution for this launch; shell routes require a loopback client and loopback request host, and the capability is never persisted in namespace data

### Remote Access / HTTPS
LAN or VPN access must be enabled explicitly. Prefer binding the machine's specific LAN address, which also adds that address to the accepted-host set:
```bash
METALIST_HOST=192.168.1.20 metalist
```
On a fresh machine, that first launch also creates the default TLS cert pair automatically. Then open either `http://192.168.1.20:8000` or `https://192.168.1.20:8443` from the other machine.

To keep `@shell` available on the host laptop while allowing another laptop to
use normal MetaList features, bind both interfaces and explicitly allow the LAN
address:

```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=10.0.0.31 \
metalist --enable-shell
```

Use `http://127.0.0.1:<namespace-http-port>` on the host laptop when running
`@shell`. Other devices may use `https://10.0.0.31:<namespace-https-port>`, but
their shell start/status requests receive `403`.

Namespaced launch example:
```bash
metalist --namespace work --port 8001
```
This starts a separate process backed by `~/MetaList/namespaces/work/work.metalist.db` on `http://127.0.0.1:8001`.
Its backup snapshots live under `~/MetaList/namespaces/work/backups/` with filenames like `work-<timestamp>.metalist-backup.tar.gz`. New backups are versioned `.tar.gz` workspace archives; legacy `.bak` backups remain restorable.

After you launch a namespace once with explicit ports, MetaList remembers them in that namespace's main DB, so later you can use the shorthand:
```bash
metalist work
```
and MetaList will reuse the saved HTTP / HTTPS ports for `work`. The same applies to the default namespace: `metalist` will reuse the saved default-namespace profile.

Equivalent explicit launch, if you want it:
```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=192.168.1.20 \
METALIST_PORT=8000 \
METALIST_HTTPS_PORT=8443 \
metalist
```
From the other machine, open `https://<laptop-ip>:8443`.

If you already have a real certificate and key, use the same dual-listener flow:
```bash
METALIST_HOST=0.0.0.0 \
METALIST_ALLOWED_HOSTS=192.168.1.20 \
METALIST_PORT=8000 \
METALIST_HTTPS_PORT=8443 \
METALIST_TLS_CERT=/path/to/fullchain.pem \
METALIST_TLS_KEY=/path/to/privkey.pem \
metalist
```

If you want to rotate or regenerate the default self-signed pair manually, the helper script is still available:
```bash
generate-lan-cert.sh
```

When HTTPS is enabled:
- remote HTTP requests to `http://<laptop-ip>:8000` are redirected to HTTPS
- localhost HTTP requests still stay on plain `http://127.0.0.1:8000` so the laptop can keep using the non-TLS port

If TLS is terminated by a reverse proxy on the same machine instead, keep MetaList on loopback and let the proxy forward to it:
```bash
METALIST_HOST=127.0.0.1 \
METALIST_ALLOWED_HOSTS=notes.example.com \
METALIST_PORT=8000 \
METALIST_FORWARDED_ALLOW_IPS=127.0.0.1,::1 \
metalist
```

The reverse proxy must preserve the browser-facing `Host` header and set
`X-Forwarded-Proto`. MetaList never trusts `X-Forwarded-Host`; forwarded
scheme/client metadata is accepted only from `METALIST_FORWARDED_ALLOW_IPS`.
Do not widen that list beyond the actual proxy addresses.

### Legacy Import
`convert-from-legacy.py` replaces the SQLite database referenced by `app.config.DATABASE_URL`, clears its files/sounds sidecar, and imports notes from a legacy JSON export.

This is destructive. It deletes the existing notes DB and related files/sounds DB before rebuilding the namespace.

Example usage:
```bash
convert-from-legacy.py --input /path/to/legacy-export.json
```

Target a namespaced database during import:
```bash
convert-from-legacy.py --namespace work --input /path/to/legacy-export.json
```

If `--namespace`, `--port`, or `--https-port` are omitted, the import script prompts for them and saves the resulting launch profile inside the target namespace DB. That means a one-time import into `work` can immediately seed later shorthand launches like `metalist work`.

### Publishing
For the real user-facing install flow:
```bash
uvx metalist
# or:
uv tool install metalist
metalist
```

This repo now packages itself under the PyPI distribution name `metalist`. Current releases support Python 3.10 through 3.13.

Recommended release path:
1. In the existing PyPI project `metalist`, configure GitHub Trusted Publishing for `evolvingstuff/metalist` and the workflow file `.github/workflows/publish-pypi.yml`.
2. Push the candidate commit to a branch and wait for the `Publish to PyPI` validation workflow to pass for that exact commit. GitHub-hosted Windows, macOS, and Linux runners install the built wheel and test application startup outside the source checkout on Python 3.10 through 3.13. You do not need those operating systems locally. Archive verification also checks runtime files, including agent Markdown resources, against both the wheel and source distribution.
3. Only after every required check passes, create and push the release tag for that same commit. Any intervening change requires a new validation run before tagging. Branch and pull-request runs validate without publishing.
4. The tag workflow repeats validation and publishes the same artifacts tested by its full matrix. Manual publication also requires all checks to pass. Users can then run it with `uvx metalist`, install it persistently with `uv tool install metalist`, or install it with `pip install metalist`.

If `--input` is omitted, a file picker opens (when `tkinter` is available).
Notes tagged with `@implies` are converted into ontology rules and are not imported as notes. Legacy rules that are invalid under the current ontology grammar are reported and skipped while valid rules continue importing.

### Run Tests

Python/unit test examples:
```bash
source .venv/bin/activate
.venv/bin/pytest
node --test tests/unit/*.mjs
.venv/bin/python -c "from pathlib import Path; import main; main._run_startup_sanity_gates(repo_root=Path.cwd())"
```

Source-checkout development launches can enable the mandatory Python and
JavaScript sanity gates with an ignored repository-root `.env` file:

```dotenv
METALIST_ENVIRONMENT=development
```

`main.py` prints the resolved environment at startup. An explicit process
environment value takes precedence over `.env`; only `development` and
`production` are accepted. When the variable and `.env` file are absent,
MetaList runs in production mode and skips the source sanity gates.

`TEST_MODE=1` and `POST /api2/test/reset` still exist for deterministic browser automation if we decide to add a new harness later, but Cypress is not part of the current workflow.

### Diagrams
Render Mermaid diagrams to PNGs:
```bash
npm run render-diagrams
```
