"""OpenAI's models, endpoint and context size, without the OpenAI SDK.

Settings, routes and the login path need these; importing the SDK (about 250 ms) for
them made every namespace server pay for it at startup. Only openai_inference.py, which
talks to OpenAI, imports the SDK, and only when an AI connection is first made.
"""

from __future__ import annotations

OPENAI_API_BASE_URL = "https://api.openai.com/v1"
OPENAI_MODEL_CONTEXT_TOKENS = 1_050_000
OPENAI_MODELS = (
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
)


def validate_openai_model(model: str) -> str:
    if not isinstance(model, str):
        raise TypeError("OpenAI model must be text")
    normalized = model.strip()
    if normalized not in OPENAI_MODELS:
        raise ValueError(f"Unsupported OpenAI model: {model}")
    return normalized
