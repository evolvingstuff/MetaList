import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A view indicator pill (Untagged notes, sorted notes, Reference source) is
// dismissed with its × while a note may be edited. Pressing the mouse on it
// must not end the edit first: that counts as the press's action and the click
// that dismisses the view is then ignored, so the × needs a second click
// (reported on Windows Chrome for Untagged notes). Every pill is therefore on
// the list of places a press does not end editing.
const template = readFileSync(new URL('../../app/templates/index.html', import.meta.url), 'utf8');
const mouseEvents = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/mouse-events.js', import.meta.url), 'utf8');

function viewIndicatorIds() {
    const start = template.indexOf('class="view-indicators"');
    assert.notEqual(start, -1, 'view indicators container missing');
    const section = template.slice(start, template.indexOf('<!--', start));
    return [...section.matchAll(/<div id="([a-z-]+-indicator)" class="[a-z- ]*indicator[a-z- ]*"/g)].map((match) => match[1]);
}

function editExitExclusions() {
    const start = mouseEvents.indexOf('function isMouseDownOutsideEditExclusion(');
    const body = mouseEvents.slice(start, mouseEvents.indexOf('\n}\n', start));
    return [...body.matchAll(/'#([a-z-]+)'/g)].map((match) => match[1]);
}

test('every view indicator pill is pressed without ending the edit', () => {
    const ids = viewIndicatorIds();
    assert.deepEqual(ids, ['root-sort-indicator', 'untagged-view-indicator']);
    // A reference view's chip sits in the search bar instead.
    assert.match(template, /<div id="reference-source-indicator" class="reference-view-chip"/);
    const exclusions = editExitExclusions();
    for (const id of [...ids, 'reference-source-indicator']) {
        assert.ok(exclusions.includes(id), `#${id} must not end editing on mousedown`);
    }
});
