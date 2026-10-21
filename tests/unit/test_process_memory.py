"""The Memory Usage dialog reads this server process's memory from the OS on every
platform (the same tests run on Windows, macOS and Linux in CI, so each OS's call and
unit is exercised)."""

import json
import subprocess
import sys
from pathlib import Path

from app.process_memory import BYTES_PER_MEGABYTE, PROCESS_MEMORY_MEASURE, current_resident_bytes
from app.process_memory import peak_process_memory_bytes, peak_resident_bytes, process_memory_bytes, release_freed_memory

# A Python process with pytest and MetaList imported, and less than a machine could hold.
_SMALLEST_PLAUSIBLE_MEGABYTES = 10
_LARGEST_PLAUSIBLE_MEGABYTES = 64 * 1024
_HELD_MEGABYTES = 256
_PAGE_BYTES = 4096
_REPOSITORY = Path(__file__).resolve().parents[2]


def test_current_and_peak_are_in_bytes_and_plausible():
    # Resident memory, and process memory (on macOS the footprint), of this test process.
    for current_bytes, peak_bytes in ((current_resident_bytes(), peak_resident_bytes()),
                                      (process_memory_bytes(), peak_process_memory_bytes())):
        current = current_bytes / BYTES_PER_MEGABYTE
        peak = peak_bytes / BYTES_PER_MEGABYTE
        assert _SMALLEST_PLAUSIBLE_MEGABYTES < current < _LARGEST_PLAUSIBLE_MEGABYTES, current
        assert current <= peak + 1, (current, peak)


# In a process of its own: one that has freed memory before may reuse it for what it
# holds next, so its measured memory need not grow (macOS on Python 3.14 in CI,
# 2026-10-21). A new process has nothing to reuse.
_GROWTH_SCRIPT = """
import json, sys
from app.process_memory import BYTES_PER_MEGABYTE, current_resident_bytes, peak_resident_bytes
from app.process_memory import peak_process_memory_bytes, process_memory_bytes
held_megabytes, page_bytes = int(sys.argv[1]), int(sys.argv[2])
before = {"resident": current_resident_bytes(), "process": process_memory_bytes()}
held = bytearray(held_megabytes * BYTES_PER_MEGABYTE)
held[::page_bytes] = b"x" * len(held[::page_bytes])
after = {"resident": current_resident_bytes(), "process": process_memory_bytes()}
peaks = {"resident": peak_resident_bytes(), "process": peak_process_memory_bytes()}
print(json.dumps({"before": before, "after": after, "peaks": peaks}))
"""
_GROWTH_TIMEOUT_SECONDS = 60
# At least this share of what the process holds shows as growth (pages may be compressed
# or rounded by the system).
_SHOWN_SHARE = 0.5


def _measured_growth() -> dict[str, dict[str, int]]:
    result = subprocess.run(
        [sys.executable, "-c", _GROWTH_SCRIPT, str(_HELD_MEGABYTES), str(_PAGE_BYTES)],
        cwd=_REPOSITORY, capture_output=True, encoding="utf-8", timeout=_GROWTH_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_memory_grows_with_what_a_process_holds_and_the_peak_follows():
    # Resident memory, and process memory (on macOS the footprint): the same checks on every OS.
    measured = _measured_growth()
    for measure in ("resident", "process"):
        before, after, peak = measured["before"][measure], measured["after"][measure], measured["peaks"][measure]
        assert after - before >= _SHOWN_SHARE * _HELD_MEGABYTES * BYTES_PER_MEGABYTE, measured
        assert peak >= after - BYTES_PER_MEGABYTE, measured


def test_the_measure_names_what_process_memory_reports():
    expected = "resident"
    if sys.platform == "darwin":
        expected = "footprint"
    assert PROCESS_MEMORY_MEASURE == expected


def test_freed_memory_goes_back_without_error_on_every_os():
    # Linux glibc: malloc_trim; macOS: pressure relief; Windows: _heapmin.
    held = bytearray(_HELD_MEGABYTES * BYTES_PER_MEGABYTE)
    held[::_PAGE_BYTES] = b"x" * len(held[::_PAGE_BYTES])
    del held
    release_freed_memory()
    assert process_memory_bytes() > 0
