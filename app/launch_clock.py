"""When this process started MetaList. The launcher (main.py) imports this module before
anything else, so the time since covers every import after it, uvicorn and the app."""

import time

_LAUNCH_STARTED = time.perf_counter()


def seconds_since_launch() -> float:
    return time.perf_counter() - _LAUNCH_STARTED
