import { ApplicationState } from './application-state.js';
import { PASSWORD_MIN_ZXCVBN_SCORE } from './password-policy.js';

const ZXCVBN_SCRIPT_ELEMENT_ID = 'metalist-zxcvbn-script';
const ZXCVBN_SCRIPT_URL = '/static/js/vendor/zxcvbn-4.4.2.js';
const SCORE_LABELS = [
    'Very weak',
    'Weak',
    'Fair',
    'Strong',
    'Very strong',
];

const moduleState = ApplicationState.createFields('password-strength', {
    zxcvbnLoadPromise: null,
});


export function describePasswordScore(score) {
    if (!Number.isInteger(score) || score < 0 || score > 4) {
        throw new Error('zxcvbn score must be an integer from 0 through 4');
    }
    return {
        label: SCORE_LABELS[score],
        meetsScoreThreshold: score >= PASSWORD_MIN_ZXCVBN_SCORE,
    };
}


export function evaluatePasswordStrength(password, estimator) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('password must be a non-empty string');
    }
    if (typeof estimator !== 'function') {
        throw new Error('password strength estimator must be a function');
    }

    const estimatorResult = estimator(password, ['metalist']);
    if (!estimatorResult || typeof estimatorResult !== 'object') {
        throw new Error('zxcvbn result must be an object');
    }
    const score = estimatorResult.score;
    const description = describePasswordScore(score);
    return {
        score,
        label: description.label,
        meetsScoreThreshold: description.meetsScoreThreshold,
    };
}


export function loadPasswordStrengthEstimator() {
    if (typeof globalThis.zxcvbn === 'function') {
        return Promise.resolve(globalThis.zxcvbn);
    }
    if (moduleState.zxcvbnLoadPromise !== null) {
        return moduleState.zxcvbnLoadPromise;
    }
    if (typeof document !== 'object' || !(document.head instanceof HTMLElement)) {
        throw new Error('Cannot load zxcvbn without a document head');
    }
    if (document.getElementById(ZXCVBN_SCRIPT_ELEMENT_ID) !== null) {
        throw new Error('zxcvbn script exists without a usable estimator');
    }

    moduleState.zxcvbnLoadPromise = new Promise((resolve, reject) => {
        const scriptElement = document.createElement('script');
        scriptElement.id = ZXCVBN_SCRIPT_ELEMENT_ID;
        scriptElement.src = ZXCVBN_SCRIPT_URL;
        scriptElement.async = true;
        scriptElement.onload = () => {
            if (typeof globalThis.zxcvbn !== 'function') {
                reject(new Error('zxcvbn loaded without exposing its estimator'));
                return;
            }
            resolve(globalThis.zxcvbn);
        };
        scriptElement.onerror = () => {
            reject(new Error('Failed to load the local zxcvbn estimator'));
        };
        document.head.appendChild(scriptElement);
    });
    return moduleState.zxcvbnLoadPromise;
}
