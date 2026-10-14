"""Which AI MetaList can use, without features knowing any one provider.

Features ask whether an AI is set up (describe_ai_setup) and for a connection
to it (connect_to_ai); they never look for a particular provider's key. Each
provider is registered here, with how to tell it is set up and how to talk to
it. Today that is OpenAI only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.services.agent.inference import InferenceAdapter
from app.services.agent.openai_cost_tracking import openai_cost_tracker
from app.services.agent.openai_inference import OPENAI_API_BASE_URL
from app.services.agent.openai_inference import OpenAIInferenceAdapter
from app.services.openai_credentials import openai_credential_store


AiProvider = Literal["openai"]

# The providers MetaList can use, in the order it prefers them.
AI_PROVIDERS: tuple[AiProvider, ...] = ("openai",)


class AiNotSetUp(RuntimeError):
    """The AI a request named has no credentials (the user removed them, or never added any)."""


@dataclass(frozen=True, slots=True)
class AiSetup:
    # Set up and usable now, in preference order.
    ready_providers: tuple[AiProvider, ...]

    @property
    def is_ready(self) -> bool:
        return len(self.ready_providers) > 0

    def is_ready_for(self, provider: AiProvider) -> bool:
        assert provider in AI_PROVIDERS, f"Unregistered AI provider: {provider}"
        return provider in self.ready_providers


@dataclass(frozen=True, slots=True)
class AiConnection:
    provider: AiProvider
    # How the provider is named on screen ("Connecting to OpenAI API").
    label: str
    # Shown once connected, with the model's context size.
    ready_label: str
    base_url: str
    inference: InferenceAdapter


def _is_provider_ready(provider: AiProvider, *, token: str, session_key: str) -> bool:
    if provider == "openai":
        return openai_credential_store.status(token=token, session_key=session_key).configured
    raise AssertionError(f"Unregistered AI provider: {provider}")


def describe_ai_setup(*, token: str, session_key: str) -> AiSetup:
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")
    return AiSetup(ready_providers=tuple(
        provider for provider in AI_PROVIDERS
        if _is_provider_ready(provider, token=token, session_key=session_key)
    ))


def connect_to_ai(*, provider: AiProvider, token: str, session_key: str) -> AiConnection:
    """A connection to the named AI; AiNotSetUp when it has no credentials."""
    if not describe_ai_setup(token=token, session_key=session_key).is_ready_for(provider):
        raise AiNotSetUp(f"{provider} is not set up")
    if provider == "openai":
        api_key = openai_credential_store.resolve(token=token, session_key=session_key)
        return AiConnection(
            provider="openai",
            label="OpenAI",
            ready_label="OpenAI API ready · 1,050,000-token context",
            base_url=OPENAI_API_BASE_URL,
            inference=OpenAIInferenceAdapter(api_key=api_key, cost_tracker=openai_cost_tracker),
        )
    raise AssertionError(f"Unregistered AI provider: {provider}")
