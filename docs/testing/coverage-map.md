# Current implementation, tests, and documentation

Updated 2026-09-12. This is a navigation map, not a blanket coverage percentage. The August [CODE_REVIEW](../../CODE_REVIEW.md) remains historical; later measurements are recorded by date in [the harness guide](harness.md).

Paths in the table are repository-relative. Existing tests cover injected and deterministic failures; they do not prove absence of unknown vulnerabilities or replace human testing.

| Review scope | Implementation | Representative validation | Documentation |
|---|---|---|---|
| F01/F04/F05 password, request, and restore integrity | `app/db/live_recovery.py`, `app/services/request_recovery.py`, auth/backup services | `test_live_database_recovery.py`, `test_phase_one_integrity.py`, `test_backup_service.py`; browser restore/restart/hash check | [Security](../security/README.md), [recovery runbook](../security/recovery.md) |
| F02 provider/history privacy | `app/services/agent/cloud_privacy.py`, AI route/chat store | `test_phase_one_integrity.py`, `test_ai_routes.py`, `cloud_privacy_policy.test.mjs` | [Agent contract](../design/agent-harness.md), [security](../security/README.md) |
| F03 sensitive state purge | `app/services/runtime_generation.py`, sensitive caches and frontend teardown | `test_phase_one_integrity.py`, browser logout/session replacement; logging canaries | [Security](../security/README.md) |
| F06 HTTPS streaming | `app/https_proxy.py` | `test_phase_two_http.py`: real HTTP/TLS, binary transfer, truncation/disconnect | [Security](../security/README.md) |
| F07 concurrency/read windows | `app/db/session.py`, sync/undo/resource stores | `test_phase_two_concurrency.py` | [Memory/read guard](../design/in_memory_store.md) |
| F08 input validation | authenticated route models and boundary validation | `test_phase_two_http.py`, route and security tests | [Security](../security/README.md) |
| F09 upload limits | file routes/storage and multipart admission | `test_phase_two_http.py`, file storage tests | [Resource budgets](../security/README.md) |
| F10 shell lifecycle | `app/services/shell_session_service.py` | `test_shell_session_service.py`, `test_run_shell_security.py` | [Security](../security/README.md) |
| F11 retained state limits | `app/services/resource_limits.py`, view cache, undo/sync | `test_next_batch.py`, empty-history browser scenario | [Runtime budgets](../security/README.md) |
| F12/F13 scope sizing, sorting, auth reads | agent scope/context, root sorting, subtree metrics, auth state | `test_next_batch.py`, AI/context/snapshot tests and recorded profiling | [Agent contract](../design/agent-harness.md), [memory design](../design/in_memory_store.md) |
| F14 hierarchy bounds | `app/services/hierarchy.py`, iterative consumers | `test_next_batch.py`, `test_refactor_ordering.py` | [Security](../security/README.md), [refactors](../REFACTORS.md) |
| F15 state ownership and workflow boundaries | note ordering/store, password rewrites, chat stream, snapshot and structured renderers | `test_refactor_ordering.py`, `test_refactor_boundaries.py`, existing rendering/suggestion/AI tests; browser move/delete/undo | [Refactors](../REFACTORS.md) |
| F16 test isolation | `tests/conftest.py`, `scripts/browser-smoke.mjs` | full isolated Python/Node suites, disposable browser namespace | [Harness](harness.md) |
| F17 dependencies and release controls | `uv.lock`, `requirements/`, `scripts/check_supply_chain.py`, release workflow, vendor manifest | `test_supply_chain.py`, metadata audits, actual vendor browser smoke, distribution checks, installed-package matrix | [Supply chain](../security/supply-chain.md) |
| Sound retirement | `app/db/retire_sounds.py`, schema 9 | migration/backup regressions | [Retired sounds](../ui/sounds.md), [reminders](../ui/reminders.md) |

Python test filenames above live under `tests/unit/`; JavaScript tests share that directory. F18 reconciles these current references, setup commands, security text, historical review status, and operational guidance.

Remaining conditional checks: Windows/Linux behavior and every supported Python version must pass for the exact release commit. Live provider calls and physical power-loss simulation are separate from deterministic tests. The optional removal of the client `iterations` parameter remains a product/API decision, not a prerequisite for this remediation batch.
