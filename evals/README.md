# Prompt regression suite

Regression runs always exercise **current production prompts and request builders**
against fixed scenarios and expected behavior. Cases contain conversation, scope,
selected-note data or evidence, and expectations. They contain no executable
captured system prompts, catalogs, response schemas, or prompt bindings.

`evals/production.py` calls the application's `AgentContextBuilder` with current
packaged prompts and skills. Instructions, skills, selected-note context,
final-response formatting, and response schemas therefore track production changes
automatically. Prompts and skills are not user-editable, so the packaged
defaults the suite tests are what every user runs; it does not read credentials or
a live note database.

There are two kinds of cases:

- **Agent cases** (`agent-cases/`, run with `python -m evals agent`): a whole run of
  the production tool-using agent. See [Agent cases](#agent-cases).
- **Summary-stage cases** (`cases/staged-summary/`, run with `python -m evals run`):
  single structured or text requests of the whole-view summary the agent hands over
  to. The rest of this README up to "Agent cases" describes this runner.

Historical results: [September 19](RESULTS-2026-09-19.md), 757/760 correct on the
earlier up-front routing design; they describe that design, not the current agent.

## Run current prompts and compare reports

This live suite is opt-in, separate from pytest, browser tests, startup checks, and
routine CI. Cases default to five independent repetitions. Without `--live`, the
command builds and validates requests without provider calls or an API key.

Execution defaults to four concurrent requests (`--concurrency 4`); use
`--concurrency 1` for serial execution. All current production requests are prepared
before inference begins. Cases are grouped by model, reasoning setting, response
schema, and the leading system/developer messages. For each group, the first
successful request finishes before concurrent requests using that prefix proceed.
That first request is a scored trial, not an extra paid warm-up call. Each case's
five trials run sequentially, allowing later trials to reuse its full input prefix.
Judge calls share the same concurrency bound and prefix coordination. Histories,
outputs, errors, and report files remain isolated per case and repetition.

This scheduling encourages reuse without altering production messages or API
options. GPT-5.6-family models route caches automatically; no artificial cache keys,
retention changes, or prompt padding are added. Cache hits are not guaranteed:
prefix length, provider placement, and cache availability still matter. Reports
include actual cached, cache-write, and uncached input-token counts from the
provider, including judges and retries. See the
[official OpenAI caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching).

```bash
# Validate all cases against current production code; no paid calls.
.venv/bin/python -m evals run evals/cases/staged-summary/*.json \
  --judge evals/judge.json --output /tmp/metalist-regressions-check

# Record current performance before editing production prompts.
# Output steps need an explicit judge; five repetitions is the default.
.venv/bin/python -m evals run evals/cases/staged-summary/*.json \
  --judge evals/judge.json --live --output /tmp/metalist-before

# After editing prompts/code, repeat the same cases and compare saved reports.
.venv/bin/python -m evals run evals/cases/staged-summary/*.json \
  --judge evals/judge.json --live --output /tmp/metalist-after
.venv/bin/python -m evals compare \
  /tmp/metalist-before/report.json /tmp/metalist-after/report.json
```

## Run only affected cases

For prompt or skill edits, pass the full candidate suite with
`--changed-since /path/to/previous/report.json`. The runner still builds every
request through current production code, but only changed or new cases make live
calls. No hand-maintained skill dependencies or frozen-prompt execution are used.

```bash
# Preview affected cases and why they were selected; no API calls.
.venv/bin/python -m evals run evals/cases/staged-summary/*.json \
  --judge evals/judge.json --changed-since /tmp/metalist-before/report.json \
  --output /tmp/metalist-affected-preview

# Add --live and use a new output directory to run that selection.
```

- A detailed skill edit selects cases that actually include that skill. Shared
  system instructions, catalogs, context builders, response schemas, scenario
  inputs, expectations, model settings, and repetition changes select every
  affected case automatically. A changed step reruns its entire multistep case.
- Judge configuration/schema changes select judged-output cases only. Older
  reports can use their recorded diagnostic judge schemas without replaying any
  prompts. If that provenance is absent, output cases are conservatively rerun
  once. Missing cases always run; malformed or incomplete baselines fail.
- Selected cases still default to five repetitions and four concurrent requests,
  with the same cache-aware scheduling. No changes means no provider calls and no
  API key is required, even with `--live`.
- `cases` contains only fresh results. `selection` identifies selected/skipped
  cases and reasons. `coverage` retains compact prior results with their original
  report paths, allowing the new partial report to be the next baseline without
  losing coverage. Skipped results are historical, never newly measured passes.
- Previously recorded failures/errors remain visible and preserve exit status 1/2
  until those cases are rerun successfully. They are not silently erased by a
  passing affected subset. `compare` labels results that were not rerun.

Omit `--changed-since` to force a full run. Do this when changing provider adapters,
execution/evaluation logic, or other behavior not represented in prepared requests;
request comparison cannot detect external model changes under the same model name.
This selection is an optimization for prompt regressions, not a substitute for
ordinary tests of note retrieval, privacy filtering, or the application runtime.

Live runs with selected cases take `OPENAI_API_KEY` from the shell, or else from the repository's `.env` (git-ignored). Reports must use new directories.
Every completed repetition is saved immediately. Reports retain actual generated
requests, current schemas, raw provider pairs, judge verdicts, errors, timings,
and estimated cost. Scenario and effective-request fingerprints are separate:
comparisons allow prompts to change but reject changed scenarios, expectations,
models, judges, or repetition counts. Keep before/after reports; there is no mode
that reruns frozen old prompts. Historical v1 reports are archival results and are
not comparable to migrated v2 fingerprints; establish a new v2 report for comparison.

**Exit status:** 0 means all repetitions passed; 1 means at least one incorrect
answer; 2 means at least one provider/judge error. Errors stay in the denominator:
8 correct, 1 incorrect, 1 error is 80%. Instructor retries are internal to a trial;
there is no retry-until-pass policy. Internal bugs and invalid fixtures fail loudly.
Small samples and LLM judges have uncertainty; inspect individual verdicts.

## Fixed expectations and scenarios

The staged-summary case builds one structured batch request and one final synthesis
request through the current production system prompt, summary skill, context
builders, and response schema. It checks supporting-note selection, preservation of
fixed facts, original-note citation tokens, and complete-scope wording; deterministic
tests verify application-owned exact root coverage.
Historical measured results remain historical; they do not establish current
prompt accuracy.

Action `expectation.alternatives` entries match specified dictionary fields.
Arrays must match exactly in length/order; scalar types must match. Do not score
free-form reasons unless needed. Output cases specify stable criterion IDs,
instructions, and reference facts. Every criterion must pass; missing or duplicate
judge criteria count as errors. Do not revise expectations simply to pass a new prompt.

Each step has `conversation`, a tagged `context`, `max_output_tokens`, and
`expectation`. Supported contexts are `summary_batch` and `summary_final`.
Scope metadata and selected-note state are explicit. Selection fixtures can provide
a complete containing tree with required node IDs, parent IDs, content, and tags;
production code derives the edited-node marker from the selected ID.
Summary-batch contexts supply fixed result trees and coverage IDs; summary-final
contexts supply verified structured findings with original supporting note IDs. A
scenario never executes application actions or retrieves actual notes.

Steps and repetitions are independent. To use a freshly generated earlier output,
include `{"role":"assistant","from_step":0}` in a later step's conversation.
Only these explicit references carry generated outputs forward. Skills and runtime
instructions are reconstructed for each step and never accumulate implicitly.

## Capture a failure

AI Chat's **⇩ Export LLM history** exports chronological `[input, output]` pairs,
one per provider attempt, including the agent's tool turns. Exported note content is
real: review it before using it in a fixture. No credential headers are included.
The command that drafted cases from an export handled only the removed routing
stages; agent-stage cases (Phase 6) will bring their own way to capture a failure.
Until then, write the case by hand from the exported conversation, with expectations
written independently of the observed output.

## Coverage boundary

These tests check individual model decisions/outputs using production request
builders, schemas, and inference transport. They do not execute a full interactive
agent, tag mutations, retrieval, or browser acknowledgments. Runtime and browser
tests cover those paths separately. A passing mocked harness test or dry run proves
wiring, **not live model behavior**.

`tests/unit/test_prompt_regressions.py` checks production-change propagation,
fixed expectations, output judging, repetition isolation, comparisons, and failure
exit statuses without paid calls. `test_agent_history.py` checks the
real SDK/Instructor against a simulated provider. Browser history export can be
checked with `BROWSER_TEST_SUITE=ai-history npm run test:browser`.

The suite belongs in Git but is excluded from PyPI wheels/source distributions.
The history recording/export feature remains part of the installed application.

## Agent cases

`python -m evals agent <cases…> --judge evals/judge.json [--live] [--repetitions N]
[--concurrency N] --output DIR` runs each case through `AgentRuntime.stream_agent`
with the real OpenAI adapter and the current production instructions, skills and tool
schemas. Without `--live` it validates the cases and prints the run count. Live runs
use **Luna at Low thinking only** (the case format allows nothing else): stronger
models are not worth paying to find failures Luna doesn't have.

A case (`schema_version: 3`, `evals/agent_models.py`) fixes:

- the conversation, ending with the user's request;
- `earlier_actions`: the agent's record of what each earlier answer in the conversation
  did (`{answer, question, actions}`, see `action_log.py`); usually empty. The judge sees
  it too, so answers about earlier turns are checked against it;
- the view: scope label, search and the notes (id, parent, text, tags, pending
  proposals); the selected note uses the same fixtures as summary cases;
- web access: the mode, the pages a fixture web serves (with fixed citation ids the
  judge criteria refer to), and pages already opened earlier in the chat;
- how the simulated user answers any Yes/No or scope question (`yes` or `no`);
- the expectation: required calls (a tool, optionally with argument values; lists
  match as subsets and addresses after normalization), forbidden tools, forbidden
  specific calls, whether a confirmation must be asked, and judge criteria for the
  final answer.

Every run also checks the **default tool order** (help and menus, then notes, then
the web, then changes); going back to an earlier group is a failure. The runner
(`evals/agent_runner.py`) serves only recorded pages, records tag operations without
writing anything, acknowledges menus as opened, gives each trial its own question
guard so trials can run concurrently, and maps live web citation ids onto the
fixture ids before judging. Reports use the same `case_id`, fingerprints, counts and
`compare` as summary-stage reports; each trial is saved under `trials/`. Exit status
is 0 when every run passed, 1 for a wrong behavior, 2 for a provider error.

Three `actions/summarize-*` cases (non-neural papers, vegetarian and non-meat
recipes) guard a reported regression: a summary of notes chosen by a category the
notes don't spell out must use the whole-view summary, not a word search.
`papers-without-notes-word` is back to its legacy expectation for the same reason.
Three `combined/` cases cover requests the old routing could not handle (help + web,
notes + help, notes + web). The 168 others were migrated from the routing-era suite. Each records its source, the
mapping applied and the legacy expectation in `provenance`; 15 whose expected
behavior the redesign changed carry an `expectation_change` reason (re-opening
earlier web pages, opening menus directly, topical and empty-view summaries, a
truthful "settings opened", and the new release-notes help topic).

Latest run (2026-10-05, Luna Low, 5 runs per case): 832/840 correct, no errors,
161/168 cases 5/5; the misses are answer wording and three miscopied note ids.
Since then the model sees short note ids (`n12`) instead of UUIDs; the cases that
miscopied ids pass 5/5.
