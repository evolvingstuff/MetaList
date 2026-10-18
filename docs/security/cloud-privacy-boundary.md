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
- blacklist tags are matched against the note's effective tags: explicit,
  proposed and inherited, with what the tag rules infer from them;
- whitelist tags are matched against accepted tags only (gap 6), so a proposal
  can hide a note but never reveal one;
- blacklist and whitelist phrases are matched against the text the AI is sent (gap 1);
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
5. **The search query and view label were sent unchecked (fixed).** With `#health`
   blacklisted and a `#health` search, every matching note was hidden, but the
   provider still received the query. Now the AI is shown a search term only if it
   can see at least one note the term picks out: for a term, a note its OR clause
   finds; for an excluded term (`-x`), a note the exclusion removes (the clause with
   `x` required instead). Other terms become `[private]` (withheld excluded terms
   are shown once as `-[private]`). The rule does not depend on why the notes are
   private, so it covers blacklisted tags, synonyms, implications, text and
   combination rules, and phrases alike. A term that finds nothing is withheld the
   same way, so the AI cannot tell "no matches" from "only private matches".
   `cloud_privacy.disclosable_search_query` computes this at freeze, running one
   search per clause and one per excluded term, each checked with
   `CloudPrivacyEvaluator.has_visible_note` (stops at the first visible note), into
   `ScopedSearchSnapshot.disclosable_search_query` and `.disclosable_label`. Every
   AI-facing view context uses those, while the server's own searches use the
   descriptor's query as typed (`tests/unit/test_private_search_terms.py`,
   `test_the_ai_is_not_sent_a_search_term_whose_notes_it_cannot_see`).
6. **A proposed tag could make a note visible (fixed; first described wrongly).**
   The map first said proposed tags escape the check. They do not: the evaluator
   reads each note's tags from the search index, which counts proposals (and what
   they imply) the same as accepted tags, so a proposed blacklisted tag already hid
   the note. The real gap was the reverse: proposals counted toward the whitelist
   too, so the AI could propose a whitelisted tag on a note and make it visible to
   itself. Now the whitelist counts only accepted tags (the note's own, those its
   parents and embeds give it, and what the tag rules infer from those and the
   text: `NoteStore.accepted_effective_tag_terms`), while the blacklist and the
   credential tags still count proposals. A proposed private tag keeps the note
   hidden until the user rejects it
   (`test_a_proposed_tag_can_make_a_note_private_but_never_visible`).
7. **Tagging feedback depended on notes the AI cannot see (fixed).** Checking the
   AI's tags against the whole namespace leaked three ways: in "existing tags only"
   mode a tag found only on private notes was accepted while an invented one was
   rejected; the accepted tag took the private tag's capitalization, which the run
   reports back; and a private note's ID was answered "outside the current scope"
   while an unknown one was "nonexistent". Now the check (`tagging.validate_proposals`,
   bulk tagging and Suggest Tags alike) uses only what the AI may see: the tags on
   visible notes (`cloud_privacy.visible_tag_counts`, judged by the boundary from
   Send) and the note IDs the request sent. A tag outside them is answered like an
   invented one (in a new-tags pass it is simply new, with the AI's spelling), and
   any ID outside the request is "nonexistent". Ancestors are sent without IDs, so
   this costs the AI nothing it could know
   (`test_a_private_note_id_is_answered_like_an_invented_one`,
   `test_a_tag_only_private_notes_carry_is_answered_like_an_invented_one`).
8. **Export titles accept earlier titles from the browser: checked, not a gap.**
   "Another title" sends the titles already shown in this opening of the dialog,
   so the AI does not repeat one. A title made from a note that became private
   before the next click would be sent again, but nothing can make a note private
   in between: signing in ends every other session (`tokens.py`, one active
   session) and each session belongs to one browser tab; the export dialog is
   modal, so no edit or settings change happens behind it; and a bulk tagging run
   makes everything outside the chat panel inert and holds the command gate for
   its whole length (`bulk-proposal-ui.js`), so Export cannot open while one runs.
   The titles are dropped when the dialog closes.
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

## Property contracts (ShockHarness)

The boundary is declared as the property `cloud_disclosable` ("built only from what the
cloud privacy rules let the AI see, at Send"), checked by ShockHarness on every run
(`.shockharness.toml`, `[tool.shockharness.rules.property_contracts]`; the runtime file
is `app/contracts.py`, identity-only unless a test enables it).

- **One send path.** Every message sent to an AI goes through
  `app/services/agent/ai_send.py` (`send_structured`, `send_text_stream`,
  `send_tool_turn`), and each starts with `requires(messages, "cloud_disclosable")`.
  `tests/unit/test_ai_send.py` fails when any other application module calls an
  adapter's send methods, or when one of those `requires` lines changes, so no send is
  left unchecked. (The adapters' own methods are called on injected objects, which the
  analysis cannot resolve; `PrivacyGuardedInference` is an adapter and delegates.)
- **Producers** (the catalog's list): `ScopedSearchSnapshotFactory.freeze`,
  `note_tag_suggestions.build_note_tag_request` and
  `export_title_suggestions.build_export_title_request`, the filtering steps above.
- **Message builders** say `preserves(messages, source)`: a reviewable claim that the
  messages hold only what the filtered source held, plus static instructions and the
  AI's own output (`export_title_messages`, `request_messages`, `tag_batch_messages`,
  the tagging correction turn).
- **Verified end to end:** export and print title suggestion, and Suggest Tags with AI.
- **Not followed yet** (four PROP001 review findings, left visible on purpose): chat
  agent turns, chat summaries, chat final answers and bulk tagging. Their messages are
  built by an injected builder object from a snapshot stored on objects, which
  ShockHarness 0.10 does not follow; `docs/design/shockharness-0.10-contracts-feedback.md`
  asks for it. Adding unchecked `preserves` claims there instead was rejected: it would
  look verified without being so.

## Catalog for the pilot

- Producer of `cloud_disclosable`: `ScopedSearchSnapshotFactory.freeze` (and
  `_freeze_selected_note`) for the chat, the filtering steps in
  `note_tag_suggestions` and `export_title_suggestions` for the others, relying on
  `CloudPrivacyEvaluator.hidden_note_ids` and `.exclusion_reason`.
- Sinks: `InferenceAdapter.stream_tool_turn`, `.stream_text` and
  `.infer_structured`, argument `messages`; in practice the three `ai_send` functions
  (above).
- Sanctioned sources that are not note text, declared explicitly: the user's
  message, the snapshot's disclosable search query and label, provider output, web
  evidence, static prompts and skills.
- `extract_agent_note_text` must not be declared `preserves` until gap 1 is fixed:
  it adds text the evaluator never saw, and declaring it would hide the gap.
