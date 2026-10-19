"""The Memory Usage dialog reads this server process's memory from the OS on every
platform (the same tests run on Windows, macOS and Linux in CI, so each OS's call and
unit is exercised)."""

from app.process_memory import BYTES_PER_MEGABYTE, current_resident_bytes, peak_resident_bytes

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
    current_before, peak_before = current_resident_bytes(), peak_resident_bytes()
    held = bytearray(_HELD_MEGABYTES * BYTES_PER_MEGABYTE)
    held[::_PAGE_BYTES] = b"x" * len(held[::_PAGE_BYTES])
    assert current_resident_bytes() > current_before
    assert peak_resident_bytes() > peak_before
    del held
