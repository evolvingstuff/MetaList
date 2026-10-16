const PREVIEW_STATUSES = new Set(['writing', 'streaming', 'complete']);


function validatePreview(preview) {
    if (typeof preview !== 'object' || preview === null) {
        throw new TypeError('Summary batch preview must be an object');
    }
    const {
        batch_number: batchNumber,
        batch_count: batchCount,
        status,
        finding_count: findingCount,
        latest_text: latestText,
        output_tokens: outputTokens,
    } = preview;
    if (!Number.isInteger(batchNumber) || !Number.isInteger(batchCount)
        || batchNumber < 1 || batchNumber > batchCount) {
        throw new TypeError('Summary batch preview requires valid batch numbers');
    }
    if (!PREVIEW_STATUSES.has(status)) {
        throw new TypeError(`Unknown summary batch preview status: ${status}`);
    }
    if (!Number.isInteger(findingCount) || findingCount < 0
        || !Number.isInteger(outputTokens) || outputTokens < 0) {
        throw new TypeError('Summary batch preview counts must be non-negative integers');
    }
    if (typeof latestText !== 'string') {
        throw new TypeError('Summary batch preview text must be a string');
    }
    if (status === 'writing' && (findingCount !== 0 || latestText !== '' || outputTokens !== 0)) {
        throw new TypeError('A starting summary batch must have nothing streamed yet');
    }
    return { batchNumber, batchCount, status, findingCount, latestText, outputTokens };
}


function fillCard(card, validated) {
    const { batchNumber, status } = validated;
    card.className = `summary-batch-preview is-${status}`;
    card.dataset.summaryBatch = String(batchNumber);
    card.dataset.summaryStatus = status;
    card.replaceChildren(...buildCardBody(card.ownerDocument, validated));
}


function validateTransition(existing, { batchNumber, status }) {
    if (existing === undefined) {
        if (status !== 'writing') {
            const verb = status === 'streaming' ? 'streamed' : 'completed';
            throw new Error(`Summary batch ${batchNumber} ${verb} before it started`);
        }
        return;
    }
    const previousStatus = existing.dataset.summaryStatus;
    if (status === 'writing') {
        throw new Error(`Summary batch ${batchNumber} started more than once`);
    }
    if (status === 'streaming' && previousStatus === 'complete') {
        throw new Error(`Summary batch ${batchNumber} streamed after it completed`);
    }
    if (status === 'complete' && previousStatus === 'complete') {
        throw new Error(`Summary batch ${batchNumber} completed more than once`);
    }
}


function findingLabel(findingCount) {
    return findingCount === 1 ? '1 finding' : `${findingCount} findings`;
}


function activeMetaText({ findingCount, outputTokens }) {
    const parts = [];
    if (findingCount > 0) parts.push(findingLabel(findingCount));
    if (outputTokens > 0) parts.push(`${outputTokens} tokens`);
    return parts.join(' · ');
}


function buildCardBody(documentRef, validated) {
    const { batchNumber, batchCount, status, findingCount, latestText } = validated;
    if (status === 'complete') {
        const line = documentRef.createElement('span');
        line.className = 'summary-batch-line';
        let text = `✓ Batch ${batchNumber} of ${batchCount} · `;
        text += findingCount === 0 ? 'no relevant findings' : findingLabel(findingCount);
        if (findingCount > 0 && latestText !== '') text += ` — ${latestText}`;
        line.textContent = text;
        return [line];
    }
    const heading = documentRef.createElement('span');
    heading.className = 'summary-batch-heading';
    heading.textContent = `Batch ${batchNumber} of ${batchCount}`;
    const meta = documentRef.createElement('span');
    meta.className = 'summary-batch-meta';
    meta.textContent = activeMetaText(validated);
    // The ticker shows only the newest streamed tail; textContent keeps it inert.
    const ticker = documentRef.createElement('span');
    ticker.className = 'summary-batch-ticker';
    ticker.textContent = latestText;
    return [heading, meta, ticker];
}


/**
 * Show one batch transition in the summary progress stack.
 *
 * A batch card appears when its request starts, streams the tail of its newest
 * finding while the model writes, and collapses to one summary line when it
 * completes. Cards stay in batch-number order even when later batches complete
 * first. Any other transition is a protocol bug and throws.
 */
export function renderSummaryBatchPreview(stack, preview) {
    if (stack === null || typeof stack !== 'object') {
        throw new TypeError('Summary batch stack is missing');
    }
    const validated = validatePreview(preview);
    const { batchNumber, batchCount, status } = validated;
    const expectedBatchCount = stack.dataset.summaryBatchCount;
    if (expectedBatchCount !== undefined && expectedBatchCount !== String(batchCount)) {
        throw new Error(
            `Summary batch preview batch count ${batchCount} does not match ${expectedBatchCount}`,
        );
    }
    const existing = Array.from(stack.children).find(
        (card) => card.dataset.summaryBatch === String(batchNumber),
    );
    validateTransition(existing, validated);
    if (existing === undefined) {
        const card = stack.ownerDocument.createElement('section');
        fillCard(card, validated);
        const followingCard = Array.from(stack.children).find(
            (candidate) => Number(candidate.dataset.summaryBatch) > batchNumber,
        );
        if (followingCard === undefined) stack.append(card);
        else stack.insertBefore(card, followingCard);
    } else {
        fillCard(existing, validated);
    }
    stack.dataset.summaryBatchCount = String(batchCount);
    stack.hidden = false;
}
