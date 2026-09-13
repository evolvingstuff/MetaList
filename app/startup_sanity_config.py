from __future__ import annotations

from pathlib import Path


EXCLUDE_DOT_FOLDERS = True
IGNORE_GLOBS: tuple[str, ...] = ()

INSTALLED_DISTRIBUTION_SOURCE_DIR_NAMES = frozenset({"app"})
INSTALLED_DISTRIBUTION_SOURCE_FILE_NAMES = frozenset({"main.py"})

PY_ALLOWED_TRY_CALLEE_PREFIXES = (
    "requests.",
    "httpx.",
    "socket.",
    "subprocess.",
    "urllib.",
    "ollama_provider.",
    "client.get",
    "client.create_with_completion",
    "client.stream",
    "client.chat.completions.create",
    "validate_openai_api_key",
    "_create_structured_completion",
    "self._inference.infer_structured",
    "json.",
)

PY_ALLOWED_EXCEPTION_NAMES = (
    "TimeoutError",
    "ConnectionError",
    "OSError",
    "httpx.HTTPError",
    "json.JSONDecodeError",
    "OllamaProviderError",
    "ManagedOllamaRuntimeError",
    "asyncio.CancelledError",
    "StructuredInferenceError",
    "InstructorRetryException",
    "APIError",
    "InferenceProviderError",
    "OpenAICredentialInputError",
)

JS_ALLOWED_TRY_CALLEE_NAMES = (
    "fetch",
    "JSON.parse",
    "clearAiChatSession",
    "copyAiChatResponse",
    "listOllamaModels",
    "listAiModels",
    "loadAiDebugSnapshot",
    "loadAiChatSession",
    "loadOpenAiCostSnapshot",
    "loadAgentPromptDefaults",
    "pullOllamaModel",
    "streamAiChat",
    "setAiDebugExactDetails",
    "loadOpenAiCredentialStatus",
    "saveOpenAiCredential",
    "clearOpenAiCredential",
    "previewCloudPrivacy",
    "resetOpenAiCostSnapshot",
)

JS_ALLOWED_TRY_CALLEE_PREFIXES = (
    "axios.",
    "fs.",
    "child_process.",
)

SANITY_PRUNE_NAMES = frozenset(
    {
        "node_modules",
        ".venv",
        "dist",
        "build",
        "coverage",
        "__pycache__",
    }
)

JS_TEST_DIR_NAMES = frozenset(
    {
        "__tests__",
        "__mocks__",
        "test",
        "tests",
        "cypress",
        "e2e",
        "playwright",
    }
)

JS_TEST_SUFFIXES = (
    ".test.js",
    ".spec.js",
    ".test.jsx",
    ".spec.jsx",
    ".test.ts",
    ".spec.ts",
    ".test.tsx",
    ".spec.tsx",
)

JS_TEST_BASENAMES = frozenset({"cypress.config.js", "cypress.config.ts"})
JS_EXCLUDED_RELATIVE_PREFIXES = ("app/static/js/vendor/",)


def is_installed_distribution_root(project_root: Path) -> bool:
    assert isinstance(project_root, Path)
    return (
        not (project_root / "pyproject.toml").is_file()
        and (project_root / "main.py").is_file()
        and (project_root / "app").is_dir()
    )


# Only these observed snapshots may reconcile an unchanged incoming value.
# Ordinary setter calls must continue to reject redundant transitions.
JS_STATE_OBSERVATION_BOUNDARIES = frozenset({
    "app/static/js/modules/reminder-store.js:_refreshLoop",  # Server refresh may be unchanged.
    "app/static/js/modules/command-palette/preferences-store.js:replaceAll",  # Server hydration.
    "app/static/js/modules/command-palette/usage-store.js:replaceAll",  # Server hydration.
    "app/static/js/modules/mode-manager/mode-context.js:hydrateTabState",  # Server hydration.
    "app/static/js/modules/mode-manager/services/search-suggestion-windows-service.js:receiveSearchSuggestionPreferences",
    "app/static/js/modules/mode-manager/services/tag-suggestions-service.js:renderSuggestions",  # Same DOM anchor, new results.
    "app/static/js/modules/modals/ontology-modal.js:_renderDialogSuggestions",  # Result selection observation.
    "app/static/js/modules/modals/ontology-modal.js:_hideDialogSuggestions",  # Dismissal of optional suggestions.
    "app/static/js/modules/modals/ontology-modal.js:_handleDialogKeydown",  # Arrow repeats at list boundaries.
})
