"""Process-local OpenAI token usage and estimated-cost accounting."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from threading import Lock


OPENAI_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD = 272_000
# OpenAI quotes prices per million tokens.
_TOKENS_PER_PRICE_QUOTE = 1_000_000
_ONE_MILLION = Decimal(_TOKENS_PER_PRICE_QUOTE)


@dataclass(frozen=True, slots=True)
class OpenAIPricing:
    input_per_million: Decimal
    cached_input_per_million: Decimal
    cache_write_per_million: Decimal
    output_per_million: Decimal

    def __post_init__(self) -> None:
        for field_name, value in (
            ("input_per_million", self.input_per_million),
            ("cached_input_per_million", self.cached_input_per_million),
            ("cache_write_per_million", self.cache_write_per_million),
            ("output_per_million", self.output_per_million),
        ):
            if not isinstance(value, Decimal) or value < 0:
                raise ValueError(f"OpenAI {field_name} must be a non-negative Decimal")


@dataclass(frozen=True, slots=True)
class OpenAITokenUsage:
    prompt_tokens: int
    cached_input_tokens: int
    cache_write_tokens: int
    output_tokens: int
    total_tokens: int

    def __post_init__(self) -> None:
        for field_name, value in (
            ("prompt_tokens", self.prompt_tokens),
            ("cached_input_tokens", self.cached_input_tokens),
            ("cache_write_tokens", self.cache_write_tokens),
            ("output_tokens", self.output_tokens),
            ("total_tokens", self.total_tokens),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"OpenAI {field_name} must be a non-negative integer")
        if self.cached_input_tokens + self.cache_write_tokens > self.prompt_tokens:
            raise ValueError("OpenAI cached and cache-write tokens exceed prompt tokens")
        if self.total_tokens != self.prompt_tokens + self.output_tokens:
            raise ValueError("OpenAI total tokens must equal prompt plus output tokens")

    @property
    def uncached_input_tokens(self) -> int:
        return self.prompt_tokens - self.cached_input_tokens - self.cache_write_tokens

    def as_inference_usage(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "uncached_input_tokens": self.uncached_input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_write_tokens": self.cache_write_tokens,
        }


@dataclass(frozen=True, slots=True)
class OpenAICostSnapshot:
    estimated_cost_usd: Decimal
    uncached_input_tokens: int
    cached_input_tokens: int
    cache_write_tokens: int
    output_tokens: int


_OPENAI_STANDARD_PRICING: dict[str, tuple[OpenAIPricing, OpenAIPricing]] = {
    "gpt-5.6-sol": (
        OpenAIPricing(
            input_per_million=Decimal("4.00"),
            cached_input_per_million=Decimal("0.40"),
            cache_write_per_million=Decimal("5.00"),
            output_per_million=Decimal("20.00"),
        ),
        OpenAIPricing(
            input_per_million=Decimal("8.00"),
            cached_input_per_million=Decimal("0.80"),
            cache_write_per_million=Decimal("10.00"),
            output_per_million=Decimal("30.00"),
        ),
    ),
    "gpt-5.6-terra": (
        OpenAIPricing(
            input_per_million=Decimal("2.00"),
            cached_input_per_million=Decimal("0.20"),
            cache_write_per_million=Decimal("2.50"),
            output_per_million=Decimal("12.00"),
        ),
        OpenAIPricing(
            input_per_million=Decimal("4.00"),
            cached_input_per_million=Decimal("0.40"),
            cache_write_per_million=Decimal("5.00"),
            output_per_million=Decimal("18.00"),
        ),
    ),
    "gpt-5.6-luna": (
        OpenAIPricing(
            input_per_million=Decimal("0.20"),
            cached_input_per_million=Decimal("0.02"),
            cache_write_per_million=Decimal("0.25"),
            output_per_million=Decimal("1.20"),
        ),
        OpenAIPricing(
            input_per_million=Decimal("0.40"),
            cached_input_per_million=Decimal("0.04"),
            cache_write_per_million=Decimal("0.50"),
            output_per_million=Decimal("1.80"),
        ),
    ),
}


def _pricing_for_usage(*, model: str, usage: OpenAITokenUsage) -> OpenAIPricing:
    if model not in _OPENAI_STANDARD_PRICING:
        raise ValueError(f"OpenAI pricing is missing for model: {model}")
    short_context_pricing, long_context_pricing = _OPENAI_STANDARD_PRICING[model]
    if usage.prompt_tokens > OPENAI_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD:
        return long_context_pricing
    return short_context_pricing


def estimate_openai_request_cost(
    *,
    model: str,
    usage: OpenAITokenUsage,
) -> Decimal:
    pricing = _pricing_for_usage(model=model, usage=usage)
    cost_per_million = (
        Decimal(usage.uncached_input_tokens) * pricing.input_per_million
        + Decimal(usage.cached_input_tokens) * pricing.cached_input_per_million
        + Decimal(usage.cache_write_tokens) * pricing.cache_write_per_million
        + Decimal(usage.output_tokens) * pricing.output_per_million
    )
    return cost_per_million / _ONE_MILLION


class OpenAICostTracker:
    """Thread-safe aggregate that intentionally disappears with the server process."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._estimated_cost_usd = Decimal(0)
        self._uncached_input_tokens = 0
        self._cached_input_tokens = 0
        self._cache_write_tokens = 0
        self._output_tokens = 0

    def record(self, *, model: str, usage: OpenAITokenUsage) -> None:
        request_cost = estimate_openai_request_cost(model=model, usage=usage)
        with self._lock:
            self._estimated_cost_usd += request_cost
            self._uncached_input_tokens += usage.uncached_input_tokens
            self._cached_input_tokens += usage.cached_input_tokens
            self._cache_write_tokens += usage.cache_write_tokens
            self._output_tokens += usage.output_tokens

    def snapshot(self) -> OpenAICostSnapshot:
        with self._lock:
            return OpenAICostSnapshot(
                estimated_cost_usd=self._estimated_cost_usd,
                uncached_input_tokens=self._uncached_input_tokens,
                cached_input_tokens=self._cached_input_tokens,
                cache_write_tokens=self._cache_write_tokens,
                output_tokens=self._output_tokens,
            )

    def reset(self) -> None:
        with self._lock:
            self._estimated_cost_usd = Decimal(0)
            self._uncached_input_tokens = 0
            self._cached_input_tokens = 0
            self._cache_write_tokens = 0
            self._output_tokens = 0


openai_cost_tracker = OpenAICostTracker()
