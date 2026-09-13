import { ApplicationState } from '../../application-state.js';
import {
    normalizeTagBarInput,
    parseTagBarSuggestionContext,
} from './tag-syntax-service.js';

export const PASSWORD_TAG = '@password';

const moduleState = ApplicationState.createFields('password-clipboard-service', {
    rememberedGeneratedPassword: null,
});

function extractExplicitTags(rawTags) {
    if (typeof rawTags !== 'string') {
        throw new Error('extractExplicitTags requires rawTags string');
    }

    const normalizedTags = normalizeTagBarInput(rawTags);
    if (normalizedTags.length === 0) {
        return [];
    }

    const context = parseTagBarSuggestionContext(normalizedTags, normalizedTags.length);
    if (context !== null) {
        return context.explicitTags.slice();
    }

    return normalizedTags.split(/\s+/).filter((token) => token.length > 0);
}

export function rememberGeneratedPasswordCopy(passwordText) {
    if (typeof passwordText !== 'string' || passwordText.length === 0) {
        throw new Error('rememberGeneratedPasswordCopy requires non-empty passwordText');
    }
    // Copying the same generated password again confirms the existing clipboard contents.
    if (moduleState.rememberedGeneratedPassword !== passwordText) {
        moduleState.rememberedGeneratedPassword = passwordText;
    }
}

export function clearRememberedGeneratedPasswordCopy() {
    if (moduleState.rememberedGeneratedPassword === null) return;
    moduleState.rememberedGeneratedPassword = null;
}

export function clipboardMatchesRememberedGeneratedPassword(clipboardPlainText) {
    if (typeof clipboardPlainText !== 'string') {
        throw new Error('clipboardMatchesRememberedGeneratedPassword requires clipboardPlainText string');
    }

    if (moduleState.rememberedGeneratedPassword === null) {
        return false;
    }
    if (clipboardPlainText === moduleState.rememberedGeneratedPassword) {
        return true;
    }
    if (clipboardPlainText.length > 0) {
        moduleState.rememberedGeneratedPassword = null;
    }
    return false;
}

export function tagBarHasPasswordTag(rawTags) {
    return extractExplicitTags(rawTags).includes(PASSWORD_TAG);
}

export function addPasswordTag(rawTags) {
    if (typeof rawTags !== 'string') {
        throw new Error('addPasswordTag requires rawTags string');
    }

    const normalizedTags = normalizeTagBarInput(rawTags);
    if (tagBarHasPasswordTag(normalizedTags)) {
        return normalizedTags;
    }
    if (normalizedTags.length === 0) {
        return PASSWORD_TAG;
    }
    return normalizeTagBarInput(`${normalizedTags} ${PASSWORD_TAG}`);
}

export function shouldAutoTagGeneratedPasswordPaste({
    clipboardPlainText,
    existingTags,
    noteIsEmpty,
}) {
    if (typeof clipboardPlainText !== 'string') {
        throw new Error('shouldAutoTagGeneratedPasswordPaste requires clipboardPlainText string');
    }
    if (typeof existingTags !== 'string') {
        throw new Error('shouldAutoTagGeneratedPasswordPaste requires existingTags string');
    }
    if (typeof noteIsEmpty !== 'boolean') {
        throw new Error('shouldAutoTagGeneratedPasswordPaste requires noteIsEmpty boolean');
    }

    if (!noteIsEmpty) {
        return false;
    }
    if (tagBarHasPasswordTag(existingTags)) {
        return false;
    }
    return clipboardMatchesRememberedGeneratedPassword(clipboardPlainText);
}
