"""Server-owned resource budgets and conservative retained-object accounting."""

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


VIEW_BYTES = configured_limit('METALIST_VIEW_CACHE_BYTES', 64 * 1024 * 1024)
UNDO_BYTES = configured_limit('METALIST_UNDO_BYTES', 32 * 1024 * 1024)
UNDO_OPERATIONS = configured_limit('METALIST_UNDO_OPERATIONS', 100)
CLIENT_ENTRIES = configured_limit('METALIST_CLIENT_ENTRIES', 32)
CLIENT_IDLE_SECONDS = configured_limit('METALIST_CLIENT_IDLE_SECONDS', 1800)
SHELL_SECONDS = configured_limit('METALIST_SHELL_MAX_SECONDS', 1800)
SHELL_RUNS = configured_limit('METALIST_SHELL_MAX_RUNS', 4)
SHELL_OUTPUT_BYTES = configured_limit('METALIST_SHELL_OUTPUT_BYTES', 4 * 1024 * 1024)


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
