from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class QueryCommand(ABC):
    @abstractmethod
    def execute(self) -> Any:
        ...
