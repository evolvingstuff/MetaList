const MEASURE_CANVAS = document.createElement('canvas');
const MEASURE_CONTEXT = MEASURE_CANVAS.getContext('2d');
const HALF_DIVISOR = 2;

function resolveFontString(style) {
    if (!style) {
        throw new Error('resolveFontString requires style');
    }

    if (typeof style.font === 'string' && style.font.trim() !== '') {
        return style.font;
    }

    const fontStyle = style.fontStyle;
    const fontVariant = style.fontVariant;
    const fontWeight = style.fontWeight;
    const fontSize = style.fontSize;
    const fontFamily = style.fontFamily;

    if (typeof fontStyle !== 'string' || fontStyle.trim() === '') {
        throw new Error('Computed fontStyle missing');
    }
    if (typeof fontVariant !== 'string' || fontVariant.trim() === '') {
        throw new Error('Computed fontVariant missing');
    }
    if (typeof fontWeight !== 'string' || fontWeight.trim() === '') {
        throw new Error('Computed fontWeight missing');
    }
    if (typeof fontSize !== 'string' || fontSize.trim() === '') {
        throw new Error('Computed fontSize missing');
    }
    if (typeof fontFamily !== 'string' || fontFamily.trim() === '') {
        throw new Error('Computed fontFamily missing');
    }

    return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
}

function parsePixelValue(rawValue, label, allowNormal) {
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
        throw new Error(`parsePixelValue requires string for ${label}`);
    }
    if (allowNormal && rawValue === 'normal') {
        return 0;
    }
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed)) {
        throw new Error(`parsePixelValue could not parse ${label}: ${rawValue}`);
    }
    return parsed;
}

function measureTextWidth(text, letterSpacing) {
    if (typeof text !== 'string') {
        throw new Error('measureTextWidth requires text string');
    }
    if (typeof letterSpacing !== 'number' || !Number.isFinite(letterSpacing)) {
        throw new Error('measureTextWidth requires letterSpacing number');
    }
    if (!MEASURE_CONTEXT) {
        throw new Error('Canvas 2D context unavailable for text measurement');
    }

    const metrics = MEASURE_CONTEXT.measureText(text);
    let width = metrics.width;
    if (letterSpacing !== 0 && text.length > 1) {
        width += letterSpacing * (text.length - 1);
    }
    return width;
}

// The pointer's x within the input's text, and how its text is measured.
function measureInputPoint(input, clientX) {
    if (!(input instanceof HTMLInputElement)) {
        throw new Error('measureInputPoint requires input element');
    }
    if (typeof clientX !== 'number' || !Number.isFinite(clientX)) {
        throw new Error('measureInputPoint requires clientX number');
    }

    const rawValue = input.value;
    if (typeof rawValue !== 'string') {
        throw new Error('Input value must be a string');
    }

    const style = window.getComputedStyle(input);
    if (!style) {
        throw new Error('Computed style missing for input');
    }

    const font = resolveFontString(style);
    if (!MEASURE_CONTEXT) {
        throw new Error('Canvas context missing for input measurement');
    }
    MEASURE_CONTEXT.font = font;

    const paddingLeft = parsePixelValue(style.paddingLeft, 'padding-left', false);
    const borderLeft = parsePixelValue(style.borderLeftWidth, 'border-left-width', false);
    const letterSpacing = parsePixelValue(style.letterSpacing, 'letter-spacing', true);

    const rect = input.getBoundingClientRect();
    if (!rect || typeof rect.left !== 'number') {
        throw new Error('Input bounding rect missing');
    }

    let textX = clientX - rect.left - paddingLeft - borderLeft + input.scrollLeft;
    if (textX < 0) {
        textX = 0;
    }
    return { rawValue, textX, letterSpacing };
}

// Whether the pointer is to the right of the input's text (trailing spaces
// count as empty), or the input is empty.
export function isInputPointPastText(input, clientX) {
    const { rawValue, textX, letterSpacing } = measureInputPoint(input, clientX);
    return textX >= measureTextWidth(rawValue.trimEnd(), letterSpacing);
}

export function getInputCaretIndexFromPoint(input, clientX) {
    const { rawValue, textX, letterSpacing } = measureInputPoint(input, clientX);
    const totalWidth = measureTextWidth(rawValue, letterSpacing);
    if (textX >= totalWidth) {
        return rawValue.length;
    }

    let low = 0;
    let high = rawValue.length;
    while (low < high) {
        const mid = Math.floor((low + high) / HALF_DIVISOR);
        const width = measureTextWidth(rawValue.slice(0, mid), letterSpacing);
        if (width < textX) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low;
}
