from __future__ import annotations

from app.exception_boundaries import CAPTURE_BOUNDARIES

class CapturedExceptionContext:
    def __init__(self, *exception_types: type[BaseException], boundary: str) -> None:
        if boundary not in CAPTURE_BOUNDARIES:
            raise ValueError(f"Unregistered exception boundary: {boundary}")
        if len(exception_types) == 0:
            raise ValueError("exception_types must not be empty")
        names = tuple(exception_type.__name__ for exception_type in exception_types)
        if names != CAPTURE_BOUNDARIES[boundary]:
            raise ValueError(f"Exception types do not match selected boundary: {boundary}")
        self._exception_types = exception_types
        self.captured_exception: BaseException | None = None

    def __enter__(self) -> "CapturedExceptionContext":
        self.captured_exception = None
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        _traceback: object,
    ) -> bool:
        if exc_type is None:
            return False
        for expected_type in self._exception_types:
            if issubclass(exc_type, expected_type):
                if exc is None:
                    raise RuntimeError("Captured exception context received missing exception")
                self.captured_exception = exc
                return True
        return False
