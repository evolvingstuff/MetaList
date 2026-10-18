# The cloud privacy boundary

Every path by which note content can reach a cloud AI provider (OpenAI), where
the privacy rules filter it, and where they do not. Mapped on 2026-10-17 from
`main` at `e58ef172`, as the catalog for the ShockHarness property-contracts
pilot (`shockharness_property_contracts_spec.md`): a property `cloud_disclosable`
produced only by the evaluator, and sinks at the calls that send to the provider.

## The evaluator

`app/services/agent/cloud_privacy.py`. `resolve_cloud_privacy_boundary` builds
the boundary from the user's privacy policy; `CloudPrivacyEvaluator.hidden_note_ids`
and `.exclusion_reason` decide, a whole note at a time:

- `@password` and `@username` notes are always hidden;
- blacklist tags are matched against the note's effective tags (explicit and
  inherited; proposed tags are not included);
- blacklist and whitelist phrases are matched against `strip_html(content)`;
- a hidden note hides its whole subtree.

The boundary is resolved once per Send (or per Suggest Tags or export-title
request), and that one value is used for the rest of the request.

## The paths

| Feature | Where note text enters | Where it is filtered |
| --- | --- | --- |
| Chat: view evidence (read, search, overview, summaries) | `ScopedSearchSnapshotFactory.freeze` (`scope.py`), text extracted lazily by `NoteText.text` | `hidden_note_ids` over the candidates at freeze |
| Chat: the selected note's tree | `_freeze_selected_note` | `exclusion_reason` on the note, `hidden_note_ids` on its tree |
| Chat: replayed history and earlier action logs | `ai_chat_store.provider_messages`, `.earlier_actions` | only the history reset (`synchronize_disclosure_boundary`, keyed by `history_disclosure_key`) |
| Chat: bulk tagging (a chat tool) | `tagging_run.tagging_trees` | the snapshot's id set from Send |
| Suggest Tags with AI (one note, or with children) | `note_tag_suggestions.build_note_tag_request` | `exclusion_reason` on the note, `hidden_note_ids` on children and on the tag vocabulary |
| Export and print title suggestion | `export_title_suggestions.build_export_title_request` | `hidden_note_ids` over the export tree |
| Cloud privacy preview | note ids from the browser | `hidden_note_ids`; nothing is sent to a provider |

Sinks, all through the `InferenceAdapter` protocol (keyword argument `messages`):
`OpenAIInferenceAdapter.stream_tool_turn` (chat agent turns, sent as Responses
`input`), `.stream_text` (chat final answers), `.infer_structured` (summaries,
tagging, Suggest Tags, export titles). Outbound requests to other sites, not the
AI provider: `web_fetch` (chat web access), `link_titles` (page titles for links
in shown notes), `remote_image_proxy` (remote images in shown notes).

## Gaps, most serious first

1. **What is judged is not what is sent (fixed).** Phrases were matched against
   `strip_html(content)`, the visible text, while the text sent, built by
   `extract_agent_note_text`, also holds a link's URL when its label hides it and
   the cached titles of linked pages. A blacklisted phrase only in a link URL or a
   linked page's title was sent, on every path. The evaluator now matches phrases
   against `extract_note_text_for_agent`'s output, the exact text sent
   (`test_cloud_privacy_judges_the_text_the_ai_is_sent`).
2. **Bulk tagging read notes live, after Send (fixed).** `tagging_trees` read each
   note from the store when generation started, which can be several model turns
   (and a wait for a confirmation) after Send, instead of the text the privacy rules
   judged at Send: a blacklisted tag or phrase added meanwhile, or a move under a
   blacklisted parent, was not seen. The snapshot now keeps every tree note's record
   as of Send (`ScopedSearchSnapshot.note_records_at_send`; records are immutable),
   and tagging sends those (`test_bulk_tagging_sends_the_notes_as_they_were_at_send`).
3. **A policy tightened during a run was not applied (fixed).** The boundary is
   resolved once; saving preferences is allowed during a bulk operation and did not
   stop it, so bulk tagging waiting on its scope card, Suggest Tags sending batches
   2..N, or a chat several model turns in sent notes the new policy hides. Now
   `save_client_preferences` advances `cloud_privacy_revision` when the policy
   changes, and every AI connection (`connect_to_ai`) is wrapped in
   `PrivacyGuardedInference`, which remembers the revision at its start and raises
   `CloudPrivacyChanged` before any further send once it has moved; the chat and the
   AI routes show its message ("Your cloud privacy settings changed while this was
   running...") as for any provider error. Provider-neutral: it wraps whichever
   adapter is built (`tests/unit/test_privacy_guard.py`,
   `test_saving_a_changed_cloud_privacy_policy_advances_its_revision`).
4. **History can replay content that has since become private: left to the user,
   decided.** The history reset key hashes the provider, the policy and the ids of
   permitted notes, not their content. If an AI answer quoted text from a permitted
   note and that text is then moved out (into a private note, or simply deleted),
   no id changes, the history is not reset, and the quote is resent on later turns
   of that chat (history lives in server memory for the sign-in session, up to the
   last 100 messages). Making the note private does reset the history. A heuristic
   (drop earlier answers that share text with private notes) was considered and
   rejected: it misses deletions and rewordings, so it would add complexity and
   false confidence without a guarantee. The user presses Clear Chat when the AI
   saw something it should not have; the AI's privacy help says so.
5. **The search query and view label are sent unchecked.** With `#health`
   blacklisted and a `#health` search, every matching note is hidden, but the
   provider still receives the query. Decided: a blacklisted tag's name is never
   sent, in the query or the label; it is replaced with a neutral placeholder so
   the AI still knows the search had a term there.
6. **A blacklisted tag only proposed is sent.** Proposed tags are sent with the
   note but are not among the effective tags the evaluator checks.
7. **Tag existence can be probed.** In bulk tagging with the "existing" policy, a
   tag that exists only on private notes is accepted silently while a nonexistent
   one is reported back to the model: a one-bit leak.
8. **Export titles accept earlier titles from the browser unchecked**
   (`previous_titles`), so a title made from notes that have since become private
   is sent again on "another title".
9. **Outside the cloud contract, considered and left as is:** MetaList fetches page
   titles and remote images for links and images in every shown note, private ones
   included. No note content goes out, the AI sees none of it, and the linked site
   learns only that its address was shown, as it would on a click. Browser
   extensions such as Grammarly read edited text themselves; the server cannot
   prevent that.

Checked and not gaps: Suggest Tags on a private note (refused), bulk tagging over a
scope with private notes (filtered at Send), export titles over private notes
(filtered), ancestors of a permitted note (permitted by the hierarchy rule), kept
summary batches (keyed by content and cleared on a boundary change), a hidden
note asked for by full id (reported as unknown).

## Catalog for the pilot

- Producer of `cloud_disclosable`: `ScopedSearchSnapshotFactory.freeze` (and
  `_freeze_selected_note`) for the chat, the filtering steps in
  `note_tag_suggestions` and `export_title_suggestions` for the others, relying on
  `CloudPrivacyEvaluator.hidden_note_ids` and `.exclusion_reason`.
- Sinks: `InferenceAdapter.stream_tool_turn`, `.stream_text` and
  `.infer_structured`, argument `messages` (the pilot needs keyword addressing or
  their positions).
- Sanctioned sources that are not note text, declared explicitly: the user's
  message, the search query and label (gap 5 decides this), provider output, web
  evidence, static prompts and skills.
- `extract_agent_note_text` must not be declared `preserves` until gap 1 is fixed:
  it adds text the evaluator never saw, and declaring it would hide the gap.
