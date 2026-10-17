import os
import sys

from app.server_runtime import resolve_api_prefix
from app.server_runtime import resolve_database_runtime_config
from app.server_runtime import resolve_default_database_path
from app.server_runtime import resolve_v1_api_prefix
from app.utils.time_units import SECONDS_PER_MINUTE
from app.version import __version__

VERSION = __version__


def _env_flag(name: str, *, default: bool) -> bool:
    if name not in os.environ:
        return default

    value = os.environ[name].strip().lower()
    assert value != "", f"Empty env flag: {name}"

    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False

    raise ValueError(f"Invalid boolean env flag {name}={value!r}")


def _env_int(name: str, default: int) -> int:
    if name not in os.environ:
        return default

    value = os.environ[name].strip()
    assert value != "", f"Empty env int: {name}"
    if value[0] in {"+", "-"}:
        assert len(value) > 1, f"Invalid integer env {name}={value!r}"
        digits = value[1:]
    else:
        digits = value
    if not digits.isdigit():
        raise ValueError(f"Invalid integer env {name}={value!r}")
    return int(value)


# Development settings - CRASH SERVER ON ANY ERROR
CRASH_SERVER_ON_FAIL = _env_flag("CRASH_SERVER_ON_FAIL", default=True)
DEV_ENFORCE_INTEGRITY_CHECKS = _env_flag("DEV_ENFORCE_INTEGRITY_CHECKS", default=False)
DISABLE_UNDO_SNAPSHOT = _env_flag("DISABLE_UNDO_SNAPSHOT", default=True)

# Tag suggestions
TAG_SUGGESTION_CONNECTORS = "-_/."
DEFAULT_MAX_SEARCH_SUGGESTIONS = 20
MAX_SEARCH_SUGGESTIONS = _env_int("MAX_SEARCH_SUGGESTIONS", DEFAULT_MAX_SEARCH_SUGGESTIONS)
DEFAULT_MAX_TAG_SUGGESTIONS = 20
MAX_TAG_SUGGESTIONS = _env_int("MAX_TAG_SUGGESTIONS", DEFAULT_MAX_TAG_SUGGESTIONS)
TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS = _env_flag(
    "TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS",
    default=True,
)

# Authentication configuration
DEFAULT_TOKEN_EXPIRY_MINUTES = 0  # Disabled unless a namespace explicitly enables idle expiry
DEFAULT_KDF_TIME_COST = 3
KDF_TIME_COST = _env_int("KDF_TIME_COST", DEFAULT_KDF_TIME_COST)
KDF_MIN_TIME_COST = 1
KDF_MAX_TIME_COST = 10
DEFAULT_KDF_MEMORY_COST_KIB = 65_536
KDF_MEMORY_COST_KIB = _env_int("KDF_MEMORY_COST_KIB", DEFAULT_KDF_MEMORY_COST_KIB)
KDF_MIN_MEMORY_COST_KIB = 8_192
KDF_MAX_MEMORY_COST_KIB = 1_048_576
DEFAULT_KDF_PARALLELISM = 4
KDF_PARALLELISM = _env_int("KDF_PARALLELISM", DEFAULT_KDF_PARALLELISM)
KDF_MIN_PARALLELISM = 1
KDF_MAX_PARALLELISM = 16
KDF_ALGORITHM = "ARGON2ID"
VAULT_VERSION = 3
PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 72
PASSWORD_MIN_ZXCVBN_SCORE = 3
# zxcvbn rates a password from 0 (very weak) through 4 (very strong).
ZXCVBN_MAX_SCORE = 4

# Login brute-force mitigation
DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5
_DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MINUTES = 5
_DEFAULT_LOGIN_RATE_LIMIT_BLOCK_MINUTES = 5
DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS = _DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MINUTES * SECONDS_PER_MINUTE
DEFAULT_LOGIN_RATE_LIMIT_BLOCK_SECONDS = _DEFAULT_LOGIN_RATE_LIMIT_BLOCK_MINUTES * SECONDS_PER_MINUTE
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = _env_int("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS)
LOGIN_RATE_LIMIT_WINDOW_SECONDS = _env_int("LOGIN_RATE_LIMIT_WINDOW_SECONDS", DEFAULT_LOGIN_RATE_LIMIT_WINDOW_SECONDS)
LOGIN_RATE_LIMIT_BLOCK_SECONDS = _env_int("LOGIN_RATE_LIMIT_BLOCK_SECONDS", DEFAULT_LOGIN_RATE_LIMIT_BLOCK_SECONDS)

# Runtime memory-hardening checks
SECURITY_HARDENING_ENABLED = _env_flag("SECURITY_HARDENING_ENABLED", default=True)
SECURITY_REQUIRE_ENCRYPTED_SWAP = _env_flag("SECURITY_REQUIRE_ENCRYPTED_SWAP", default=False)
SECURITY_REQUIRE_MACOS_NO_HIBERNATION = _env_flag("SECURITY_REQUIRE_MACOS_NO_HIBERNATION", default=False)

assert KDF_MIN_TIME_COST <= KDF_TIME_COST <= KDF_MAX_TIME_COST
assert KDF_MIN_MEMORY_COST_KIB <= KDF_MEMORY_COST_KIB <= KDF_MAX_MEMORY_COST_KIB
assert KDF_MIN_PARALLELISM <= KDF_PARALLELISM <= KDF_MAX_PARALLELISM
assert 0 < PASSWORD_MIN_LENGTH <= PASSWORD_MAX_LENGTH
assert 0 <= PASSWORD_MIN_ZXCVBN_SCORE <= ZXCVBN_MAX_SCORE
assert MAX_SEARCH_SUGGESTIONS > 0
assert MAX_TAG_SUGGESTIONS > 0
assert LOGIN_RATE_LIMIT_MAX_ATTEMPTS > 0
assert LOGIN_RATE_LIMIT_WINDOW_SECONDS > 0
assert LOGIN_RATE_LIMIT_BLOCK_SECONDS > 0

# API prefixes (single source of truth)
# Client uses '/api2' via JS CONFIG; server uses the same here.
API_PREFIX = resolve_api_prefix(environ=os.environ)
V1_API_PREFIX = resolve_v1_api_prefix(environ=os.environ)

_database_runtime_config = resolve_database_runtime_config(
    environ=os.environ,
    argv=sys.argv[1:],
)
TEST_MODE = _database_runtime_config.test_mode
ACTIVE_NAMESPACE = _database_runtime_config.namespace

if TEST_MODE:
    # Use test database
    DATABASE_URL = _database_runtime_config.database_url
    test_database_path = _database_runtime_config.database_path

    # Delete existing test.db if it exists
    if test_database_path.exists():
        test_database_path.unlink()
        print("Deleted existing test.db")

    print("Running in TEST MODE - using test.db")
else:
    # Use production database
    DEFAULT_DB_PATH = str(resolve_default_database_path())
    DATABASE_URL = _database_runtime_config.database_url

# Enable verbose SQLite trace logging only when explicitly requested.
if "SQL_TRACE" in os.environ:
    SQL_TRACE_ENABLED = os.environ["SQL_TRACE"] == "1"
else:
    SQL_TRACE_ENABLED = False
