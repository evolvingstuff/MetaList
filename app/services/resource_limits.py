"""Server-owned resource budgets and conservative retained-object accounting."""

from app.utils.byte_sizes import MIB
from app.utils.time_units import SECONDS_PER_MINUTE
from dataclasses import fields, is_dataclass
import os
import sys


def configured_limit(name: str, default: int) -> int:
    value = default
    if name in os.environ:
        value = int(os.environ[name])
    if value <= 0:
        raise ValueError(f'{name} must be positive')
    return value


# Defaults for the budgets below; each can be overridden by its environment
# variable (docs/security/README.md, "Runtime memory and shell budgets").
_DEFAULT_UNDO_MIB = 32
_DEFAULT_UNDO_OPERATIONS = 100
_DEFAULT_CLIENT_ENTRIES = 32
_DEFAULT_CLIENT_IDLE_MINUTES = 30
_DEFAULT_SHELL_MAX_MINUTES = 30
_DEFAULT_SHELL_MAX_RUNS = 4
_DEFAULT_SHELL_OUTPUT_MIB = 4

UNDO_BYTES = configured_limit('METALIST_UNDO_BYTES', _DEFAULT_UNDO_MIB * MIB)
UNDO_OPERATIONS = configured_limit('METALIST_UNDO_OPERATIONS', _DEFAULT_UNDO_OPERATIONS)
CLIENT_ENTRIES = configured_limit('METALIST_CLIENT_ENTRIES', _DEFAULT_CLIENT_ENTRIES)
CLIENT_IDLE_SECONDS = configured_limit('METALIST_CLIENT_IDLE_SECONDS', _DEFAULT_CLIENT_IDLE_MINUTES * SECONDS_PER_MINUTE)
SHELL_SECONDS = configured_limit('METALIST_SHELL_MAX_SECONDS', _DEFAULT_SHELL_MAX_MINUTES * SECONDS_PER_MINUTE)
SHELL_RUNS = configured_limit('METALIST_SHELL_MAX_RUNS', _DEFAULT_SHELL_MAX_RUNS)
SHELL_OUTPUT_BYTES = configured_limit('METALIST_SHELL_OUTPUT_BYTES', _DEFAULT_SHELL_OUTPUT_MIB * MIB)
# Each sensitive memoization cache retains at most this much (docs/security/README.md,
# "Runtime memory and shell budgets"); a cache that needs a different budget names its own.
_SENSITIVE_MEMO_MIB = 16
SENSITIVE_MEMO_BYTES = _SENSITIVE_MEMO_MIB * MIB


def retained_bytes(value: object) -> int:
    """Estimate retained Python allocations, counting each shared object once."""
    pending = [value]
    seen = set()
    total = 0
    while pending:
        entry = pending.pop()
        identity = id(entry)
        if identity in seen:
            continue
        seen.add(identity)
        total += sys.getsizeof(entry)
        if isinstance(entry, dict):
            pending.extend(entry.keys())
            pending.extend(entry.values())
        elif isinstance(entry, (list, tuple, set, frozenset)):
            pending.extend(entry)
        elif is_dataclass(entry) and not isinstance(entry, type):
            pending.extend(getattr(entry, field.name) for field in fields(entry))
    return total
