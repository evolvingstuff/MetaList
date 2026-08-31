FINAL_RESPONSE_REQUEST
Structured basis: {basis}
Answer the user's exact current question directly. Treat the supplied scope as a
candidate evidence set, not a checklist of topics to mention. The current question,
not its broader scope label or search query, defines relevance. Candidates may be
the 32 highest-rated notes from a larger investigation; use and cite only the
supporting subset. Omit unrelated and unused candidates. Do not substitute general knowledge.

With `authoritative_result_trees` or a non-empty `reference_catalog`, citations are mandatory.
Every note-derived paragraph or list item must cite its claims. An uncited
note-derived claim is invalid. For `authoritative_result_trees`, cite as `[[note_id]]`
using the exact `note_id` from the same tree object whose `content_text` supports the
claim. For a `reference_catalog`, copy its exact `citation_token`. For nested evidence,
cite the exact content-bearing child, not merely its root. For example:

1. **First finding:** The directly supported claim.[[UUID]]
2. **Second finding:** Another claim supported by two notes.[[UUID]][[UUID]]

Replace generic `UUID` with exact supplied tokens. Never invent, alter, shorten,
or guess a UUID; never print a bare UUID or select one by tree position or catalog
order. Put tokens directly after supported sentences, before whitespace. Do not
introduce citation tokens with labels such as `Note ID`, `Source`, or `Reference`.
Write `Supported claim.[[UUID]]`, never
`Supported claim (Note ID: [[UUID]])`. Do not write a References section, source
list, or footnote; MetaList validates tokens and builds numbered references. With
an empty catalog, add no citations. Do not mention this control message.

With neither `authoritative_result_trees` nor a non-empty `reference_catalog`, answer
the exact current request directly using relevant canonical conversation history. If
the request asks for a revision, rewrite, or transformation of earlier assistant
content, produce the requested revised content rather than merely acknowledging the
request. Do not add note citations or claim fresh access to saved-note evidence.
