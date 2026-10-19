# ShockHarness 0.13.0: `sanitized_html` on MetaList, first findings

From declaring the HTML sink on MetaList (2026-10-18, `feature/sanitized-html-contracts`):
`escaped_html` (produced by `html-escape.js:escapeHtml`), `sanitized_html` (the note
sanitizer, Mermaid's strict render, and `literal_satisfies`), template-literal and concat
compositions from either, and the sink `target = "innerHTML"`. One hang, then the gaps
that account for the remaining findings.

## Bug: an accumulating template literal in a loop never finishes

`shockharness check app/static/js/modules/modals/ai-agent-settings-modal.js` runs at 100%
CPU and never ends (stopped after 11 minutes) when one line of `renderInstalledModelOptions`
is written as a template that includes the accumulator:

```javascript
let options = `<option value="" disabled ${placeholderSelected}>Select model</option>`;
for (const model of state.installedModels) {
    // ...
    const selected = model === state.model ? 'selected' : '';
    options = `${options}<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(model)}</option>`;
}
return options;
```

With `options += \`<option ...>\`` (the form in the repository) the same file is analyzed
in seconds. The function alone, copied into an empty project with the same catalog,
finishes in a second, so the hang needs the file's context (the function's result is one
part of a large template assigned to `modalElement.innerHTML` at line 189, among about 20
other parts). Expected: the loop's fixed point converges (the property set is finite).

## Gaps behind the remaining findings (32 unknown, plus some violations)

1. **`.join` of safe parts (26 unknown).** `items.map(item => \`<li>${escapeHtml(item)}</li>\`).join('')`
   is the commonest way MetaList builds lists. A join of an array whose elements all carry
   `sanitized_html`, with a literal separator, could be a composition (`join`), like
   `concat`.
2. **`+=` with a template literal is not a composition.** `options += \`...\`` destroys the
   property, though `options = options + \`...\`` with a literal in the chain is `concat`.
   An augmented assignment could be read as its expanded form.
3. **Imported string and number constants (5 unknown).** `${LOWEST_PORT}`,
   `${MAX_PASSWORD_LENGTH}`, `${REMINDER_RENDER_ICON}`: module-level `const` bindings of a
   literal, imported from another file, are "not a local value". A `const` bound once to a
   literal could carry what the literal carries (`literal_satisfies`).
4. **`literal_satisfies` applies in every language.** Setting it on `sanitized_html` (for
   JavaScript markup) adds 170 PROP004 findings in Python files, where every function
   returning both a literal string and a computed one now has "inconsistent returns" for a
   property no Python code declares. Scoping `literal_satisfies` by language, or reporting
   PROP004 only for properties a unit declares or requires, would remove them.
5. **Numbers and booleans in markup.** `size="${count}"`, `data-pending="${isUpdating}"`:
   MetaList wraps each in `escapeHtml(String(...))` to satisfy the rule. Not a bug; a
   catalog-level "primitive numbers and booleans are safe in markup" option for JavaScript
   would remove noise, if the analysis can know the type (often it cannot).
