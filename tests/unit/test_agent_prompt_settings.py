import pytest

from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.prompt_settings import FINAL_RESPONSE_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import SYSTEM_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import TOOL_RESULT_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import resolve_agent_prompt_set


def test_packaged_agent_prompts_are_valid_and_renderable() -> None:
    assert DEFAULT_AGENT_PROMPTS.system_prompt != ""
    normalized_system_prompt = " ".join(DEFAULT_AGENT_PROMPTS.system_prompt.split())
    assert "Prefer Markdown for final answers" in DEFAULT_AGENT_PROMPTS.system_prompt
    assert "LaTeX math" in DEFAULT_AGENT_PROMPTS.system_prompt
    assert "Mermaid diagrams" in DEFAULT_AGENT_PROMPTS.system_prompt
    assert "investigate_current_scope" in DEFAULT_AGENT_PROMPTS.system_prompt
    assert "ordinary conversation/general knowledge" in normalized_system_prompt
    assert "frozen, server-enforced snapshot" in normalized_system_prompt
    assert "do not substitute general knowledge" in (
        DEFAULT_AGENT_PROMPTS.final_response_prompt.casefold()
    )
    normalized_final_prompt = " ".join(
        DEFAULT_AGENT_PROMPTS.final_response_prompt.split()
    )
    assert (
        "every note-derived paragraph or list item"
        in normalized_final_prompt.casefold()
    )
    assert "An uncited note-derived claim is invalid" in normalized_final_prompt
    assert "[[UUID]]" in normalized_final_prompt
    assert "same tree object" in normalized_final_prompt
    assert "candidate evidence set" in normalized_final_prompt
    assert "current question" in normalized_final_prompt
    assert "32 highest-rated notes" in normalized_final_prompt
    assert "use and cite only the supporting subset" in normalized_final_prompt
    assert "Do not introduce citation tokens with labels" in normalized_final_prompt
    assert "exact citation token" in DEFAULT_AGENT_PROMPTS.system_prompt
    assert "root-deduplicated reference links" in normalized_system_prompt
    assert "Citations are current-run evidence only" in normalized_system_prompt
    assert "must never be reused from an earlier turn" in normalized_system_prompt
    assert "elliptical follow-ups" in normalized_system_prompt
    assert "changed search or context followed by a retry request" in (
        normalized_system_prompt
    )
    assert "newly captured scope must be investigated" in normalized_system_prompt
    assert "do not write your own References section" in normalized_system_prompt
    assert "do not repeat or regenerate the previous answer" not in normalized_system_prompt
    assert "acknowledge the correction directly" not in normalized_final_prompt
    assert "Do not repeat prior answer" not in normalized_final_prompt
    assert "answer the exact current request directly" in normalized_final_prompt
    assert "revision, rewrite, or transformation" in normalized_final_prompt
    assert "produce the requested revised content" in normalized_final_prompt
    assert DEFAULT_AGENT_PROMPTS.render_final_response_request(
        basis="Use the retrieved note.",
    ).startswith("FINAL_RESPONSE_REQUEST\nStructured basis: Use the retrieved note.")
    assert "never print a bare UUID" in (
        DEFAULT_AGENT_PROMPTS.final_response_prompt
    )
    assert DEFAULT_AGENT_PROMPTS.render_tool_result(
        action_name="search_notes",
        payload_json='{"notes":[]}',
    ) == 'TOOL_RESULT search_notes\n{"notes":[]}'


def test_resolve_agent_prompt_set_uses_namespace_overrides() -> None:
    prompts = resolve_agent_prompt_set(
        preferences={
            SYSTEM_PROMPT_PREFERENCE_KEY: "Custom system prompt",
            FINAL_RESPONSE_PROMPT_PREFERENCE_KEY: "FINAL {basis}",
            TOOL_RESULT_PROMPT_PREFERENCE_KEY: "TOOL {action_name}\n{payload_json}",
        }
    )

    assert prompts.system_prompt == "Custom system prompt"
    assert prompts.render_final_response_request(basis="basis") == "FINAL basis"
    assert prompts.render_tool_result(
        action_name="read_notes_by_id",
        payload_json='{"notes":[]}',
    ) == 'TOOL read_notes_by_id\n{"notes":[]}'


@pytest.mark.parametrize(
    ("final_response_prompt", "error"),
    [
        ("No placeholder", "exactly one {basis}"),
        ("{basis} and {basis}", "exactly one {basis}"),
        ("{basis} {unknown}", "unsupported placeholder: unknown"),
        ("{basis!r}", "formatting modifiers"),
    ],
)
def test_agent_prompt_set_rejects_invalid_final_response_template(
    final_response_prompt: str,
    error: str,
) -> None:
    with pytest.raises(ValueError, match=error):
        AgentPromptSet(
            system_prompt="System",
            final_response_prompt=final_response_prompt,
            tool_result_prompt="{action_name}\n{payload_json}",
        )


@pytest.mark.parametrize(
    "tool_result_prompt",
    [
        "{action_name}",
        "{payload_json}",
        "{action_name} {payload_json} {extra}",
        "{action_name:>10} {payload_json}",
    ],
)
def test_agent_prompt_set_rejects_invalid_tool_result_template(
    tool_result_prompt: str,
) -> None:
    with pytest.raises(ValueError):
        AgentPromptSet(
            system_prompt="System",
            final_response_prompt="{basis}",
            tool_result_prompt=tool_result_prompt,
        )


def test_agent_prompt_set_rejects_blank_and_oversized_prompts() -> None:
    with pytest.raises(ValueError, match="System prompt must not be blank"):
        AgentPromptSet(
            system_prompt="  ",
            final_response_prompt="{basis}",
            tool_result_prompt="{action_name}\n{payload_json}",
        )
    with pytest.raises(ValueError, match="must not exceed 32000"):
        AgentPromptSet(
            system_prompt="x" * 32_001,
            final_response_prompt="{basis}",
            tool_result_prompt="{action_name}\n{payload_json}",
        )
