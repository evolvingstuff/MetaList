// The AI chat panel's size limits, in CSS pixels, for every module that sizes or
// saves it. The server checks saved sizes against the same limits
// (app/services/client_state_service.py; tests/unit/test_ai_chat_size_limits.py
// keeps the two, and main.css's 280px and 480px, equal).

export const AI_CHAT_MINIMUM_WIDTH = 280;
export const AI_CHAT_MAXIMUM_WIDTH = 5000;
// The notes column keeps at least this much room beside the panel.
export const AI_CHAT_MINIMUM_NOTES_WIDTH = 480;
export const AI_CHAT_COMPOSER_MINIMUM_HEIGHT = 74;
export const AI_CHAT_COMPOSER_MAXIMUM_HEIGHT = 220;
