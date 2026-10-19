"""How much memory this server process uses, as the operating system reports it.

Current resident memory comes from each OS's own call (Linux /proc/self/statm, macOS
task_info, Windows GetProcessMemoryInfo); the peak comes from the same Windows call, or
from getrusage on macOS and Linux. Standard library only, so every supported OS reports
both without an extra dependency.
"""

from __future__ import annotations

import ctypes
import os
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
