// The browser suites that run on their own (BROWSER_TEST_SUITE=<name> npm run test:browser),
// shared by the smoke script and the parallel runner (run-browser-suites.mjs).
// `core` is not among them: it runs the full smoke's own steps without the suites below
// that the full smoke also runs inline, so the runner does each suite once.
export const FOCUSED_SUITES = Object.freeze([
  'ai-selected-note', 'writing-assistant', 'ai-history', 'agent-help', 'ai-privacy', 'ai-response-menu', 'exit-edit-scroll', 'move-to-bottom', 'list-edges', 'sorted-tabs', 'search-input', 'dictation-paste', 'file-drop-previews', 'image-menu', 'image-resize-caret', 'tag-suggestion-menu', 'paste-formats', 'ai-note-tags', 'robot-proposals', 'export-print', 'url-cleaning', 'reference-paste', 'click-caret', 'editable-embeds', 'delete-warning', 'collapse-outlines', 'backup-reminder', 'reminder-surface', 'floating-controls', 'tab-switching', 'ai-chat-refusal', 'search-suggestions', 'tag-bar-suggestions', 'input-target', 'ontology-search', 'diagram-clicks', 'file-link-clicks', 'picture-drag', 'palette-activation', 'search-highlight',
]);
