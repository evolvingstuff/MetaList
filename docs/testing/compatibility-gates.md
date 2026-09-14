# Refactor compatibility and release gates

These are required project rules, including for security hardening and cleanup. They supplement the shared AGENTS.md. The September 2026 incident came from replacing the HTTPS proxy while the release smoke checked only the HTTPS document and three assets over HTTP. A successful document response did not prove the application could load.

## Changes that must not be incidental to a refactor

Do not change any of these contracts merely to reorganize code, meet a style target, or close a generic review finding:

| Contract | Concrete changes requiring separate justification and compatibility coverage |
| --- | --- |
| Connection lifecycle | Adding `Connection: close`, disabling keep-alive, changing handshake placement, dropping accepted connections, or imposing a new worker/connection limit. |
| Listener and launch behavior | Bind address, HTTP/HTTPS ports, CLI/environment precedence, certificate discovery/trust, namespace restart behavior, or whether LAN access requires different launch settings. |
| Response delivery | Content-Length/chunked framing, compression, MIME types, CSP/module loading, streaming latency, or turning an expected recoverable request failure into process termination. |
| Accepted workloads | New timeouts, byte/count/depth limits, narrowed payload shapes, rejected previously valid values, or changes in concurrency/admission behavior. |
| Persistence and recovery | Schema/data interpretation, backup paths or immutability, encryption, restore/restart sequencing, or retention behavior. |
| Browser workflows | Startup/login, editing/save/undo, namespace switching, attachments, and reconnect/reload behavior on both HTTP and HTTPS. |

If the requested work requires one of these changes, identify it explicitly before implementation. Describe the concrete old/new behavior and affected workflow; supply a regression check for that workflow. If it is outside the user's requested scope, obtain authorization for that specific behavior change. A request to refactor or harden security is not authorization to silently withdraw an existing supported access path or workload.

Do not introduce arbitrary limits without documenting the supported workload and validating at its normal concurrency. Do not replace an existing acceptance test with one that merely endorses the new implementation. Keep changes to separate contracts separable for review and targeted recovery.

## Regression diagnosis and evidence

1. Establish the last known working revision or date and read the relevant diff before changing limits, transport defaults, certificates, or browser settings. An unchanged old default is not evidence of a new regression.
2. Reproduce using the affected transport and browser path. A localhost HTTP result cannot establish that LAN HTTPS works. A synthetic endpoint cannot establish that the shipped module graph initializes.
3. Verify the actual outcome: loaded assets, completed browser initialization and rendered application. A 200 response, an open listener, or passing unit tests alone is insufficient.
4. Keep intermittent failures visible. Do not retry a failed load until green, suppress failed resource requests, or add sleeps/timeouts merely to hide an unexplained regression.
5. If the user directs agents not to run tests, honor that instruction and mark the work unverified. Do not describe it as validated or release it on the strength of older results. This does not require the user to run Edge before every release; the release gate runs Edge automatically.

## Mandatory automated release checks

`Publish to PyPI` already requires build and every Windows/macOS/Linux × Python 3.10–3.14 installed-wheel job. It now includes:

- Every platform/Python combination: three passes through all installed JavaScript, CSS, JSON and icon assets over both HTTP and HTTPS, with six persistent connections per transport. Check status, decoded bytes, JavaScript MIME type, and continued socket reuse. TLS probes trust the temporary application's certificate explicitly and verify its hostname. No source-checkout assets can supply missing wheel files.
- Windows/Python 3.12: the actual Microsoft Edge executable loads both installed namespaces over a non-loopback IPv4 HTTPS address. Three fresh browser contexts each perform three uncached loads per namespace. Require the real module graph, visible application, `data-app-ready`, and no failed requests, startup dependency HTTP errors, or JavaScript exceptions. A delivered 503 from the optional PyPI release check is recorded as an expected outage; missing routes, transport failures and asset failures still fail the gate. The job temporarily trusts only its generated certificate and removes it afterward; it does not disable browser TLS validation.
- Retain Edge results and failure screenshots as `edge-https-startup`. Missing Edge, missing driver, missing diagnostics, a skipped required check, or a failure blocks release. No Chrome substitute, `continue-on-error`, or retry-to-green.
- `tests/unit/test_https_keepalive.py` checks concurrent compressed module transfers on the same TLS sockets and explicit client close; `test_phase_two_http.py` retains streaming, framing, truncation, and disconnect checks.

Do not remove the Windows/Python 3.12 Edge leg, narrow these asset checks, or decouple publication from their success as part of unrelated work. A release tag still requires successful validation of the exact commit before tagging. Manual dispatch does not bypass the matrix. These checks detect this class of regression; they are not a claim that all future defects are impossible.

## Validation status

Added on 2026-09-14 after the user requested prevention of the HTTPS regression. The installed-wheel check passed locally on macOS/Python 3.12 for the 0.6.3 candidate, including 193 assets on both HTTP and verified HTTPS, six persistent connections and three passes in each of two disposable namespaces. The full cross-platform matrix and Windows Edge harness remain pending CI. The user excluded agent testing of the HTTPS issue on the other laptop; ordinary automated testing remains authorized. Their first successful CI run is required before treating them as validated or releasing these changes.


### 0.6.3 connection-establishment correction
The six-client keep-alive regression also failed before its first HTTP request: on local macOS/Python 3.12, only five TLS sockets reached `process_request`, while the sixth client received `BrokenPipeError` during handshake. An isolated run reproduced it; a diagnostic fixture with an accept queue of 32 admitted all six. `BoundedProxyServer.request_queue_size` now matches the existing `MAX_CONNECTIONS` (32), instead of inheriting five pending accepts. The active-worker cap, ports, timeouts and TLS handshake placement are unchanged. This is a separately identified startup-burst fix, not proof that the old queue alone caused the original Friday-to-weekend regression. The concurrent six-socket regression remains unchanged and must pass.
