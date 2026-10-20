"""The Memory Usage dialog reads this server process's memory from the OS on every
platform (the same tests run on Windows, macOS and Linux in CI, so each OS's call and
unit is exercised)."""

import sys

from app.process_memory import BYTES_PER_MEGABYTE, PROCESS_MEMORY_MEASURE, current_resident_bytes
from app.process_memory import peak_process_memory_bytes, peak_resident_bytes, process_memory_bytes, release_freed_memory

# A Python process with pytest and MetaList imported, and less than a machine could hold.
_SMALLEST_PLAUSIBLE_MEGABYTES = 10
_LARGEST_PLAUSIBLE_MEGABYTES = 64 * 1024
_HELD_MEGABYTES = 256
_PAGE_BYTES = 4096


def test_current_and_peak_are_in_bytes_and_plausible():
    current = current_resident_bytes() / BYTES_PER_MEGABYTE
    peak = peak_resident_bytes() / BYTES_PER_MEGABYTE
    assert _SMALLEST_PLAUSIBLE_MEGABYTES < current < _LARGEST_PLAUSIBLE_MEGABYTES, current
    assert current <= peak + 1, (current, peak)


def test_both_grow_with_what_the_process_holds():
    current_before = current_resident_bytes()
    held = bytearray(_HELD_MEGABYTES * BYTES_PER_MEGABYTE)
    held[::_PAGE_BYTES] = b"x" * len(held[::_PAGE_BYTES])
    assert current_resident_bytes() > current_before
    # The peak may already be higher (from earlier tests): it is at least what is held now.
    assert peak_resident_bytes() >= current_resident_bytes() - BYTES_PER_MEGABYTE
    del held


def test_process_memory_is_plausible_and_grows_with_what_the_process_holds():
    # On macOS the footprint, elsewhere resident memory: the same checks on every OS.
    before = process_memory_bytes()
    assert _SMALLEST_PLAUSIBLE_MEGABYTES < before / BYTES_PER_MEGABYTE < _LARGEST_PLAUSIBLE_MEGABYTES
    assert before <= peak_process_memory_bytes() + BYTES_PER_MEGABYTE
    held = bytearray(_HELD_MEGABYTES * BYTES_PER_MEGABYTE)
    held[::_PAGE_BYTES] = b"x" * len(held[::_PAGE_BYTES])
    assert process_memory_bytes() > before
    # The peak may already be higher (from earlier tests): it is at least what is held now.
    assert peak_process_memory_bytes() >= process_memory_bytes() - BYTES_PER_MEGABYTE
    del held


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
