import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Right-clicking inside a note's rendered math (MathML) or a Mermaid diagram
// (SVG) must open MetaList's note menu, not the browser's: the menu works from
// the nearest HTML element around the clicked one.
const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/context-menu-events.js', import.meta.url), 'utf8');
const resolveSource = source.slice(source.indexOf('function resolveEventElement('), source.indexOf('function resolveTagFromSelection('));

class FakeElement {
    constructor(parentElement) {
        this.parentElement = parentElement;
        this.nodeType = 1;
    }
}
class FakeHTMLElement extends FakeElement {}
class FakeSVGElement extends FakeElement {}
class FakeMathMLElement extends FakeElement {}

const resolveEventElement = new Function('HTMLElement', 'Element', 'Node', `${resolveSource}\nreturn resolveEventElement;`)(FakeHTMLElement, FakeElement, {TEXT_NODE: 3});

test('an HTML element, or text inside one, is the target itself', () => {
    const content = new FakeHTMLElement(null);
    assert.equal(resolveEventElement(content), content);
    assert.equal(resolveEventElement({ nodeType: 3, parentElement: content }), content);
});

test('inside math or an SVG diagram, the target is the nearest HTML element around it', () => {
    const latexBlock = new FakeHTMLElement(null);
    const math = new FakeMathMLElement(latexBlock);
    const identifier = new FakeMathMLElement(math);
    assert.equal(resolveEventElement(identifier), latexBlock);
    assert.equal(resolveEventElement({ nodeType: 3, parentElement: identifier }), latexBlock);

    const diagram = new FakeHTMLElement(null);
    const svg = new FakeSVGElement(diagram);
    const path = new FakeSVGElement(new FakeSVGElement(svg));
    assert.equal(resolveEventElement(path), diagram);
});

test('nothing to resolve gives null', () => {
    assert.equal(resolveEventElement(null), null);
    assert.equal(resolveEventElement(new FakeSVGElement(null)), null);
});
