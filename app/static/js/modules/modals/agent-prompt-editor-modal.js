import { ApplicationState } from '../application-state.js';
import { rethrowUnexpectedError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import {
    AiApiError,
    loadAgentPromptDefaults,
} from '../ai-chat/ai-chat-api.js';
import {
    MAX_AGENT_PROMPT_CHARACTERS,
    inspectAgentInstructionSet,
    validateAgentPromptDefaultsPayload,
    validateAgentInstructionSet,
} from '../ai-chat/agent-prompt-service.js';


function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new Error('escapeHtml requires string');
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}


function resolveEffectiveInstructions(defaults, overrides) {
    const resolved = {};
    for (const key of ['systemPrompt', 'finalResponsePrompt', 'toolResultPrompt']) {
        const override = overrides[key];
        if (override !== null && typeof override !== 'string') {
            throw new Error(`Agent prompt override ${key} must be a string or null`);
        }
        resolved[key] = override === null ? defaults[key] : override;
    }
    if (!Array.isArray(overrides.skills)) {
        throw new Error('Agent skill overrides must be an array');
    }
    if (overrides.skills.length !== defaults.skills.length) {
        throw new Error('Agent skill overrides must match packaged skills');
    }
    resolved.skills = defaults.skills.map((defaultSkill) => {
        const matches = overrides.skills.filter(
            (override) => override.skillId === defaultSkill.skillId,
        );
        if (matches.length !== 1) {
            throw new Error(`Expected one override for skill ${defaultSkill.skillId}`);
        }
        const override = matches[0].content;
        if (override !== null && typeof override !== 'string') {
            throw new Error(
                `Agent skill override ${defaultSkill.skillId} must be a string or null`,
            );
        }
        return {
            ...defaultSkill,
            content: override === null ? defaultSkill.content : override,
        };
    });
    return validateAgentInstructionSet(resolved);
}


export class AgentPromptEditorModal extends BaseModal {
    constructor(readOverrides, saveOverrides, resetOverrides) {
        super('agentPromptEditorModal', 'agent-prompt-editor-modal');
        if (typeof readOverrides !== 'function') {
            throw new Error('AgentPromptEditorModal requires readOverrides');
        }
        if (typeof saveOverrides !== 'function') {
            throw new Error('AgentPromptEditorModal requires saveOverrides');
        }
        if (typeof resetOverrides !== 'function') {
            throw new Error('AgentPromptEditorModal requires resetOverrides');
        }
        this._readOverrides = readOverrides;
        this._saveOverrides = saveOverrides;
        this._resetOverrides = resetOverrides;

        ApplicationState.own(this, 'AgentPromptEditorModal', new.target === AgentPromptEditorModal);
    }

    getInitialModalState() {
        return {
            systemPrompt: '',
            finalResponsePrompt: '',
            toolResultPrompt: '',
            skills: [],
            isLoading: true,
            isSaving: false,
            hasActiveOverrides: false,
            incompatiblePreferenceKeys: [],
            error: '',
        };
    }

    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            document.body.appendChild(modalElement);
        }
        this.renderModalContent();
        modalElement.style.display = 'block';
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const state = this.getModalState();
        const disabled = state.isSaving ? 'disabled' : '';
        const sourceLabel = state.hasActiveOverrides
            ? 'Using namespace-specific overrides.'
            : 'Using packaged defaults.';
        const compatibilityNotice = state.incompatiblePreferenceKeys.length === 0
            ? ''
            : `
                <p class="agent-prompt-editor-compatibility" role="status">
                    A saved override targets an older agent action contract and is not
                    being applied. Save these prompts or Restore packaged defaults to
                    remove the incompatible override.
                </p>
            `;
        const controlsDisabled = [
            state.isLoading,
            state.isSaving,
            state.skills.length === 0,
        ].some((value) => value === true);
        const skillEditors = state.skills.map((skill, index) => `
            <details class="agent-prompt-editor-field agent-skill-editor-field" data-skill-id="${escapeHtml(skill.skillId)}">
                <summary>
                    <span class="agent-skill-editor-summary-label">
                        <span class="agent-skill-editor-chevron" aria-hidden="true">▶</span>
                        <span>${escapeHtml(skill.title)}</span>
                    </span>
                    <code>${escapeHtml(skill.triggerAction)}</code>
                </summary>
                <p>${escapeHtml(skill.description)}</p>
                <textarea data-agent-skill-index="${index}" maxlength="${MAX_AGENT_PROMPT_CHARACTERS}" spellcheck="false" ${disabled}>${escapeHtml(skill.content)}</textarea>
            </details>
        `).join('');
        const editor = state.isLoading ? `
            <p class="agent-prompt-editor-loading" role="status">Loading packaged prompts…</p>
        ` : `
            <div class="agent-prompt-editor-fields">
                <details class="agent-prompt-editor-field" data-prompt="system" open>
                    <summary>Agent system prompt</summary>
                    <p>Defines the agent role, action loop, safety boundaries, and action-selection instructions.</p>
                    <textarea id="agent-prompt-system" maxlength="${MAX_AGENT_PROMPT_CHARACTERS}" spellcheck="false" ${disabled}>${escapeHtml(state.systemPrompt)}</textarea>
                </details>
                <details class="agent-prompt-editor-field" data-prompt="final-response">
                    <summary>Final-response control prompt</summary>
                    <p>Must contain exactly one <code>{basis}</code> placeholder. Use doubled braces for literal braces.</p>
                    <textarea id="agent-prompt-final-response" maxlength="${MAX_AGENT_PROMPT_CHARACTERS}" spellcheck="false" ${disabled}>${escapeHtml(state.finalResponsePrompt)}</textarea>
                </details>
                <details class="agent-prompt-editor-field" data-prompt="tool-result">
                    <summary>Tool-result wrapper prompt</summary>
                    <p>Must contain exactly one <code>{action_name}</code> and one <code>{payload_json}</code> placeholder. Use doubled braces for literal braces.</p>
                    <textarea id="agent-prompt-tool-result" maxlength="${MAX_AGENT_PROMPT_CHARACTERS}" spellcheck="false" ${disabled}>${escapeHtml(state.toolResultPrompt)}</textarea>
                </details>
                <section class="agent-skill-editor-section">
                    <h3>Skills</h3>
                    <p>Each skill is injected only after its trigger action is selected. Skill instructions are transient and are not added to later conversation history.</p>
                    ${skillEditors}
                </section>
            </div>
        `;
        modalElement.innerHTML = `
            <div class="modal-content agent-prompt-editor-modal-content">
                <h2>Agent Prompts &amp; Skills</h2>
                <p class="agent-prompt-editor-description">
                    Inspect or override the prompts and skills MetaList sends during agent runs.
                    Overrides are scoped to this namespace, apply to the next run, and are not
                    conversation history.
                </p>
                <p class="agent-prompt-editor-source">${sourceLabel}</p>
                ${compatibilityNotice}
                ${editor}
                <p class="error-message" role="alert">${escapeHtml(state.error)}</p>
                <div class="form-actions agent-prompt-editor-actions">
                    <button type="button" class="secondary-btn" id="agent-prompt-reset" ${controlsDisabled ? 'disabled' : ''}>Restore packaged defaults</button>
                    <button type="button" class="primary-btn" id="agent-prompt-save" data-modal-enter-action ${controlsDisabled ? 'disabled' : ''}>${state.isSaving ? 'Saving…' : 'Save overrides'}</button>
                </div>
            </div>
        `;
        this._setupControls();
    }

    _setupControls() {
        const state = this.getModalState();
        const resetButton = document.getElementById('agent-prompt-reset');
        const saveButton = document.getElementById('agent-prompt-save');
        if (!(resetButton instanceof HTMLButtonElement)) {
            throw new Error('Agent prompt reset button missing');
        }
        if (!(saveButton instanceof HTMLButtonElement)) {
            throw new Error('Agent prompt save button missing');
        }
        resetButton.onclick = () => void this._handleReset();
        saveButton.onclick = () => void this._handleSave();
        if (state.isLoading) {
            return;
        }
        const systemPrompt = document.getElementById('agent-prompt-system');
        const finalResponsePrompt = document.getElementById('agent-prompt-final-response');
        const toolResultPrompt = document.getElementById('agent-prompt-tool-result');
        if (!(systemPrompt instanceof HTMLTextAreaElement)) {
            throw new Error('Agent system prompt input missing');
        }
        if (!(finalResponsePrompt instanceof HTMLTextAreaElement)) {
            throw new Error('Agent final-response prompt input missing');
        }
        if (!(toolResultPrompt instanceof HTMLTextAreaElement)) {
            throw new Error('Agent tool-result prompt input missing');
        }
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }
        const skillInputs = Array.from(
            modalElement.querySelectorAll('textarea[data-agent-skill-index]'),
        );
        if (skillInputs.length !== state.skills.length) {
            throw new Error('Agent skill inputs do not match loaded skills');
        }
        systemPrompt.oninput = () => this.updateModalState({
            systemPrompt: systemPrompt.value,
            error: '',
        });
        finalResponsePrompt.oninput = () => this.updateModalState({
            finalResponsePrompt: finalResponsePrompt.value,
            error: '',
        });
        toolResultPrompt.oninput = () => this.updateModalState({
            toolResultPrompt: toolResultPrompt.value,
            error: '',
        });
        for (const skillInput of skillInputs) {
            if (!(skillInput instanceof HTMLTextAreaElement)) {
                throw new Error('Agent skill input must be a textarea');
            }
            const rawIndex = skillInput.dataset.agentSkillIndex;
            const skillIndex = Number.parseInt(rawIndex, 10);
            if (!Number.isInteger(skillIndex) || skillIndex < 0) {
                throw new Error('Agent skill input index is invalid');
            }
            if (skillIndex >= state.skills.length) {
                throw new Error('Agent skill input index is out of bounds');
            }
            skillInput.oninput = () => {
                const currentSkills = this.getModalState().skills;
                const skills = currentSkills.map((skill, index) => (
                    index === skillIndex
                        ? { ...skill, content: skillInput.value }
                        : skill
                ));
                this.updateModalState({ skills, error: '' });
            };
        }
    }

    onOpen() {
        void this._loadPrompts();
    }

    canRequestClose() {
        return this.getModalState().isSaving !== true;
    }

    async _loadPrompts() {
        let payload = null;
        let loadError = '';
        try {
            payload = await loadAgentPromptDefaults();
        } catch (error) {
            rethrowUnexpectedError(error);
            if (!(error instanceof AiApiError)) {
                throw error;
            }
            loadError = error.message;
        }
        if (!this.isOpen) {
            return;
        }
        if (loadError !== '') {
            this.updateModalState({
                isLoading: false,
                error: loadError,
            });
        }
        if (payload !== null) {
            const defaults = validateAgentPromptDefaultsPayload(payload);
            const overrides = this._readOverrides(defaults.skills);
            const instructions = resolveEffectiveInstructions(defaults, overrides);
            const incompatiblePreferenceKeys = overrides.skills.flatMap(
                (skill) => skill.incompatiblePreferenceKeys,
            );
            const hasActiveOverrides = [
                overrides.systemPrompt,
                overrides.finalResponsePrompt,
                overrides.toolResultPrompt,
                ...overrides.skills.map((skill) => skill.content),
            ].some((value) => value !== null);
            this.updateModalState({
                ...instructions,
                isLoading: false,
                incompatiblePreferenceKeys,
                hasActiveOverrides,
                error: '',
            });
        }
        this.renderModalContent();
    }

    async _handleSave() {
        const state = this.getModalState();
        const inspected = inspectAgentInstructionSet({
            systemPrompt: state.systemPrompt,
            finalResponsePrompt: state.finalResponsePrompt,
            toolResultPrompt: state.toolResultPrompt,
            skills: state.skills,
        });
        if (inspected.error !== '') {
            this.updateModalState({ error: inspected.error });
            this.renderModalContent();
            return;
        }
        this.updateModalState({ isSaving: true, error: '' });
        this.renderModalContent();
        await this._saveOverrides(inspected.settings);
        this.close();
    }

    async _handleReset() {
        this.updateModalState({ isSaving: true, error: '' });
        this.renderModalContent();
        await this._resetOverrides(this.getModalState().skills);
        this.close();
    }
}
