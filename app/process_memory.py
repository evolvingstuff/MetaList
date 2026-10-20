"""How much memory this server process uses, as the operating system reports it.

Current resident memory comes from each OS's own call (Linux /proc/self/statm, macOS
task_info, Windows GetProcessMemoryInfo); the peak comes from the same Windows call, or
from getrusage on macOS and Linux. Standard library only, so every supported OS reports
both without an extra dependency.
"""

from __future__ import annotations

import ctypes
import os
import platform
import sys
import time

if sys.platform == "win32":
    from ctypes import wintypes
else:
    import resource

BYTES_PER_MEGABYTE = 1024 * 1024
# ru_maxrss is in bytes on macOS and in kilobytes on Linux (and the other Unixes).
_RU_MAXRSS_BYTES_PER_UNIT_DARWIN = 1
_RU_MAXRSS_BYTES_PER_UNIT_OTHER = 1024
# /proc/self/statm: "size resident shared ...", in pages.
_STATM_RESIDENT_FIELD = 1
# <mach/task_info.h>: MACH_TASK_BASIC_INFO, and its structure packed to 4 bytes.
_MACH_TASK_BASIC_INFO = 20
# <mach/task_info.h>: TASK_VM_INFO, whose phys_footprint is what Activity Monitor shows.
_TASK_VM_INFO = 22
# Room in the buffer for task_vm_info's fields after the footprint peak, in 32-bit words.
_TASK_VM_INFO_LATER_WORDS = 128
_MACH_STRUCT_PACKING = 4
_KERN_SUCCESS = 0
_LIBSYSTEM_PATH = "/usr/lib/libSystem.B.dylib"

# Imported while the server starts, so this is when it started (to the second).
_STARTED_AT_MONOTONIC = time.monotonic()


def seconds_since_start() -> float:
    return time.monotonic() - _STARTED_AT_MONOTONIC


def current_resident_bytes() -> int:
    """The memory this process has resident now, in bytes."""
    if sys.platform == "win32":
        resident = _windows_memory_counters().WorkingSetSize
    elif sys.platform == "darwin":
        resident = _darwin_task_basic_info().resident_size
    else:
        with open("/proc/self/statm", encoding="ascii") as statm:
            pages = int(statm.read().split()[_STATM_RESIDENT_FIELD])
        resident = pages * os.sysconf("SC_PAGE_SIZE")
    if resident <= 0:
        raise OSError(f"the OS reported {resident} bytes resident for a running process")
    return resident


# What process_memory_bytes reports on each OS, as the Memory Usage dialog names it.
PROCESS_MEMORY_MEASURE = "resident"
if sys.platform == "darwin":
    PROCESS_MEMORY_MEASURE = "footprint"


def process_memory_bytes() -> int:
    """The memory the system charges this process now: on macOS its footprint, which
    Activity Monitor shows (resident memory there also counts shared system libraries
    and freed memory macOS takes back whenever it needs to, and leaves out compressed
    memory); elsewhere its resident memory, which top and Task Manager show."""
    if sys.platform != "darwin":
        return current_resident_bytes()
    footprint = _darwin_task_vm_info().phys_footprint
    if footprint <= 0:
        raise OSError(f"the OS reported a footprint of {footprint} bytes for a running process")
    return footprint


def peak_process_memory_bytes() -> int:
    """The most process_memory_bytes has been."""
    if sys.platform != "darwin":
        return peak_resident_bytes()
    peak = _darwin_task_vm_info().ledger_phys_footprint_peak
    if peak <= 0:
        raise OSError(f"the OS reported a footprint peak of {peak} bytes for a running process")
    return peak


# Which C library a Linux Python runs on: glibc can hand freed memory back (malloc_trim),
# others (musl) have no such call and keep it for reuse.
_LINUX_LIBC_NAME = "glibc"
_GLIBC_PATH = "libc.so.6"
_UCRT_NAME = "ucrtbase"
_HEAPMIN_SUCCESS = 0


def release_freed_memory() -> None:
    """Hands memory the process has freed back to the system, after a load that made
    and dropped many short-lived objects. glibc keeps it otherwise: on Linux a
    107,500-note unlock left 93 MB resident that malloc_trim gave back in 9 ms
    (2026-10-19). macOS takes freed memory back itself (the call is the same
    request), and Windows' C runtime returns its free heap with _heapmin."""
    if sys.platform == "win32":
        result = ctypes.CDLL(_UCRT_NAME)._heapmin()
        if result != _HEAPMIN_SUCCESS:
            raise OSError(f"_heapmin failed with {result}")
        return
    if sys.platform == "darwin":
        libsystem = ctypes.CDLL(_LIBSYSTEM_PATH)
        libsystem.malloc_zone_pressure_relief.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        libsystem.malloc_zone_pressure_relief.restype = ctypes.c_size_t
        libsystem.malloc_zone_pressure_relief(None, 0)
        return
    if platform.libc_ver()[0] != _LINUX_LIBC_NAME:
        # No malloc_trim outside glibc: that C library keeps freed memory for reuse.
        return
    ctypes.CDLL(_GLIBC_PATH).malloc_trim(0)


def peak_resident_bytes() -> int:
    """The most memory this process has had resident at once, in bytes."""
    if sys.platform == "win32":
        peak = _windows_memory_counters().PeakWorkingSetSize
    else:
        bytes_per_unit = _RU_MAXRSS_BYTES_PER_UNIT_OTHER
        if sys.platform == "darwin":
            bytes_per_unit = _RU_MAXRSS_BYTES_PER_UNIT_DARWIN
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * bytes_per_unit
    if peak <= 0:
        raise OSError(f"the OS reported a peak of {peak} bytes resident for a running process")
    return peak


class _MachTimeValue(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_int32), ("microseconds", ctypes.c_int32)]


class _MachTaskBasicInfo(ctypes.Structure):
    _pack_ = _MACH_STRUCT_PACKING
    _fields_ = [
        ("virtual_size", ctypes.c_uint64),
        ("resident_size", ctypes.c_uint64),
        ("resident_size_max", ctypes.c_uint64),
        ("user_time", _MachTimeValue),
        ("system_time", _MachTimeValue),
        ("policy", ctypes.c_int32),
        ("suspend_count", ctypes.c_int32),
    ]


class _TaskVmInfo(ctypes.Structure):
    """struct task_vm_info through ledger_phys_footprint_peak (revision 3), then room for
    the rest: macOS fills only whole revisions, and revision 3 has more fields."""
    _fields_ = [
        ("virtual_size", ctypes.c_uint64),
        ("region_count", ctypes.c_int32),
        ("page_size", ctypes.c_int32),
        *[(name, ctypes.c_uint64) for name in (
            "resident_size", "resident_size_peak", "device", "device_peak", "internal", "internal_peak",
            "external", "external_peak", "reusable", "reusable_peak", "purgeable_volatile_pmap",
            "purgeable_volatile_resident", "purgeable_volatile_virtual", "compressed", "compressed_peak",
            "compressed_lifetime", "phys_footprint", "min_address", "max_address",
        )],
        ("ledger_phys_footprint_peak", ctypes.c_int64),
        ("later_revisions", ctypes.c_uint32 * _TASK_VM_INFO_LATER_WORDS),
    ]


def _darwin_task_vm_info() -> _TaskVmInfo:
    libsystem = ctypes.CDLL(_LIBSYSTEM_PATH)
    info = _TaskVmInfo()
    word = ctypes.sizeof(ctypes.c_uint32)
    count = ctypes.c_uint32(ctypes.sizeof(_TaskVmInfo) // word)
    task = ctypes.c_uint32.in_dll(libsystem, "mach_task_self_")
    result = libsystem.task_info(task, _TASK_VM_INFO, ctypes.byref(info), ctypes.byref(count))
    if result != _KERN_SUCCESS:
        raise OSError(f"task_info(TASK_VM_INFO) failed with kern_return_t {result}")
    needed = _TaskVmInfo.later_revisions.offset // word
    if count.value < needed:
        raise OSError(f"task_info(TASK_VM_INFO) filled {count.value} words, {needed} needed for the footprint peak")
    return info


def _darwin_task_basic_info() -> _MachTaskBasicInfo:
    libsystem = ctypes.CDLL(_LIBSYSTEM_PATH)
    info = _MachTaskBasicInfo()
    count = ctypes.c_uint32(ctypes.sizeof(_MachTaskBasicInfo) // ctypes.sizeof(ctypes.c_uint32))
    task = ctypes.c_uint32.in_dll(libsystem, "mach_task_self_")
    result = libsystem.task_info(task, _MACH_TASK_BASIC_INFO, ctypes.byref(info), ctypes.byref(count))
    if result != _KERN_SUCCESS:
        raise OSError(f"task_info failed with kern_return_t {result}")
    return info


if sys.platform == "win32":

    class _ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    def _windows_memory_counters() -> _ProcessMemoryCounters:
        counters = _ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(_ProcessMemoryCounters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.K32GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(_ProcessMemoryCounters), wintypes.DWORD,
        ]
        kernel32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
        if not kernel32.K32GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb,
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return counters
