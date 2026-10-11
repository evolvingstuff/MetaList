"""OpenAI strict structured outputs for every structured AI step.

Instructor's JSON_SCHEMA mode sends the response schema without `strict: true`,
so OpenAI treats it as a hint and a reply can leave out a required field (a
summary step once wrote its note IDs into the text instead of the required
`supporting_note_ids`). With `strict: true` OpenAI guarantees the reply matches
the schema. Strict mode needs every property required and no extra properties
on every object; this fails loudly for a schema that does not meet that, rather
than sending a weaker one.

String length limits are not sent (strict mode may reject them); Pydantic still
checks them, with every other rule, when the reply is parsed.
"""

from __future__ import annotations

from typing import Any

from instructor.v2.core.decorators import register_mode_handler
from instructor.v2.core.mode import Mode
from instructor.v2.core.providers import Provider
# Imported first so Instructor's own OpenAI handlers are registered before ours replaces one.
from instructor.v2.providers.openai.handlers import OpenAIJSONSchemaHandler

# Checked locally by Pydantic after the reply; left out of the schema OpenAI enforces.
_LOCAL_ONLY_KEYWORDS = frozenset({"minLength", "maxLength"})


def strict_openai_schema(schema: object) -> object:
    """A copy of the schema for OpenAI strict mode (see the module docstring)."""
    if isinstance(schema, list):
        return [strict_openai_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if "properties" in schema:
        properties = schema["properties"]
        if not isinstance(properties, dict):
            raise TypeError("Schema properties must be an object")
        if "additionalProperties" not in schema or schema["additionalProperties"] is not False:
            raise ValueError("Strict structured outputs need additionalProperties false on every object")
        if "required" not in schema:
            raise ValueError("Strict structured outputs need every property required")
        required = schema["required"]
        if not isinstance(required, list) or set(required) != set(properties):
            raise ValueError("Strict structured outputs need every property required")
    converted: dict[str, object] = {}
    for key, value in schema.items():
        if key in _LOCAL_ONLY_KEYWORDS:
            continue
        if key in ("properties", "$defs"):
            if not isinstance(value, dict):
                raise TypeError(f"Schema {key} must be an object")
            converted[key] = {name: strict_openai_schema(nested) for name, nested in value.items()}
            continue
        converted[key] = strict_openai_schema(value)
    return converted


class StrictOpenAIJSONSchemaHandler(OpenAIJSONSchemaHandler):
    """Instructor's OpenAI JSON_SCHEMA handler, sending the schema with strict: true."""

    def prepare_request(self, response_model: Any, kwargs: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        prepared_model, prepared_kwargs = super().prepare_request(response_model, kwargs)
        if prepared_model is None:
            return prepared_model, prepared_kwargs
        response_format = prepared_kwargs["response_format"]
        json_schema = response_format["json_schema"]
        prepared_kwargs["response_format"] = {
            **response_format,
            "json_schema": {**json_schema, "schema": strict_openai_schema(json_schema["schema"]), "strict": True},
        }
        return prepared_model, prepared_kwargs


register_mode_handler(Provider.OPENAI, Mode.JSON_SCHEMA)(StrictOpenAIJSONSchemaHandler)
