import pytest

from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.skill_settings import LEGACY_NARROW_CONTEXT_SKILL_PREFERENCE_KEY
from app.services.agent.skill_settings import LEGACY_SCOPED_INVESTIGATION_V6_PREFERENCE_KEY
from app.services.agent.skill_settings import LEGACY_SEARCH_NOTES_SKILL_PREFERENCE_KEY
from app.services.agent.skill_settings import SCOPED_INVESTIGATION_SKILL_PREFERENCE_KEY
from app.services.agent.skill_settings import resolve_agent_skill_set
from app.services.agent.skill_settings import validate_agent_skill_content


def test_packaged_skill_describes_one_direct_evidence_payload() -> None:
    skill = DEFAULT_AGENT_SKILLS.for_action("investigate_current_scope")
    normalized = " ".join(skill.content.split())

    assert skill.preference_key == SCOPED_INVESTIGATION_SKILL_PREFERENCE_KEY
    assert "one authoritative evidence payload" in normalized
    assert "full agent-visible content" in normalized
    assert "longest leading prefix of complete result trees" in normalized
    assert "[[note_id]]" in normalized
    assert "working summary" not in normalized.casefold()
    assert "next page" not in normalized.casefold()


@pytest.mark.parametrize(
    "preference_key",
    [
        LEGACY_NARROW_CONTEXT_SKILL_PREFERENCE_KEY,
        LEGACY_SCOPED_INVESTIGATION_V6_PREFERENCE_KEY,
        LEGACY_SEARCH_NOTES_SKILL_PREFERENCE_KEY,
    ],
)
def test_removed_skill_overrides_are_explicitly_incompatible(
    preference_key: str,
) -> None:
    with pytest.raises(ValueError, match="direct scoped investigation v7"):
        resolve_agent_skill_set(preferences={preference_key: "Old instructions"})


def test_current_skill_override_is_supported() -> None:
    skills = resolve_agent_skill_set(
        preferences={
            SCOPED_INVESTIGATION_SKILL_PREFERENCE_KEY: "Custom direct instructions",
        }
    )
    assert (
        skills.for_action("investigate_current_scope").content
        == "Custom direct instructions"
    )


def test_skill_content_must_not_be_blank() -> None:
    with pytest.raises(ValueError, match="must not be blank"):
        validate_agent_skill_content("   ")
