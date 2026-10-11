# Tag Suggestions: What the Offline Experiment Taught Us

In October 2026 we compared the tag-bar ranking with learned and rule-based
alternatives on a real namespace (about 107,000 notes, 67,000 tagged, 10,400
distinct tags, 8,000 rules). The experiment lives in
`experiments/tag_suggestions/` (see its README); it prints totals only. This
note records what we learned and the improvements left for later. The same
approach applied to search-bar suggestions is in
`search-suggestion-learnings.md` (no change resulted). The first
one, the one-letter fix, is already in (`docs/ui/tag-bar.md`).

## How we measured

- Time split: learn from older notes, test on tagged notes created in the
  latest 20%; every tag written after the cutoff is hidden from every model,
  including today's ranking.
- Moments: an empty tag bar, and the first letter of the next tag typed, each
  with 0, 1 or 2+ of the note's tags already in the bar (in the order written).
  Targets are tags not already applying through the bar, inheritance or rules.
- Main score: whether a correct tag is in the top 5 ("hit@5"); also the rank of
  the first correct tag and whether the first suggestion is right.

## Results (latest 20%, 500 test notes)

Hit@5, empty bar with no tags yet / all empty-bar moments / first letter:

| Ranking | No tags | Empty bar, all | First letter |
|---|---|---|---|
| Before (MetaList, Oct 2026) | 78.0% | 74.3% | 25.4% |
| Same, keeping the empty-bar order after one letter | 78.0% | 74.3% | 79.2% |
| Fixed formula (no training) | 84.1% | 79.9% | 82.6% |
| Gradient-boosted trees (LightGBM) | 85.8% | 81.7% | 83.3% |

- Candidate ceiling: a correct tag was among the candidates the learned rankers
  could choose from in 86.6% of moments, so the trees are near what those
  candidate sources allow.
- Time per request on that namespace: today's ranking about 200 ms; the
  experiment's candidates and inputs (including similar notes) about 4–5 ms.
- What the trees relied on: tag name appearing in the note's text (about 41%
  of gain), similar notes by text (about 34%), word statistics (about 10%);
  recency, usage, co-occurrence each a few percent. Hierarchy signals
  (siblings, parent, depth) barely mattered on this namespace.
- Merging today's list into the trees' list added nothing: today's ranking
  knows nothing the trees miss once they have name-in-text candidates.
- Today's ranking is still slightly better on rare tags (used 1–3 times: 64%
  vs 55–59%) and on never-used tags named in the text (28% vs 25–27%); the new
  methods are far better on common tags (58% vs 67–73%).

## Done

- One letter typed keeps the empty-bar order, with tags that already apply
  right after the evidence-based matches. Confirmed on the namespace with the
  shipped code: first-letter hit@5 25.4% → 79.4%, first suggestion right
  12.1% → 63.1%, correct tag anywhere in the 20 shown 43.0% → 85.1%; empty-bar
  results unchanged. Time per request in that run: median 262 ms after one
  letter vs 234 ms for an empty bar (slowest 5%: about 850 ms for both). The
  earlier one-letter time was not measured separately, and run-to-run machine
  load varied too much to compare across runs.

- The tree no longer boosts suggestions (October 2026, at the user's request):
  tags used on a note's children, siblings or anywhere under its parent, and
  tag names in those notes' or its ancestors' text, compete like any other tag.
  Only the note's own text counts. Tags are applied where they belong (a tag on
  two of three children does not belong on the parent), and the experiment
  found hierarchy signals barely mattered. Not re-measured on the namespace.

## Possible future improvements

In rough order of value for effort:

1. **A similar-notes signal in the existing ranking.** The strongest missing
   signal. A word index over notes (much like the search index, in plain
   Python, updated on save) giving "tags of the most similar notes". Needs a
   speed and memory measurement on a 100,000-note namespace before committing.
2. **The fixed formula** as the tag-bar ranking: similar-notes vote + 0.5 ×
   tag name in the text + 0.25 × share of notes with all the bar's tags that
   also carry the candidate (weights chosen by grid search on this namespace;
   recency and usage got zero). About 80% of the trees' gain with no training
   and no new dependencies, and about 40× faster than today's ranking. Before
   adopting: add word statistics (Naive Bayes counts) as a signal, use a finer
   grid, check the earlier time window, and check the first suggestion, where
   the formula is no better than today (62% vs 61%; trees 68%).
3. **Faster suggestions regardless of method.** A median of about 250 ms and
   a slowest 5% of about 850 ms per request is noticeable; profile today's
   ranking on a large namespace.
4. **Rare and never-used tags.** Keep today's literal content matching (it
   wins there) as one candidate source for whatever replaces it.
5. **Learned trees** only if the formula falls short. Costs found: about a
   minute of training after unlock at this size (mostly computing training
   inputs), retraining in the background, and shipping LightGBM/numpy/scipy/
   scikit-learn on every platform (LightGBM needs OpenMP installed separately
   on macOS).
6. **Feedback logging**: suggestions shown, picked, skipped,
   and tags typed in full without being offered. Would let weights adapt to
   actual use; needs a schema change and a privacy decision.
7. **More moments in the experiment:** two- and three-letter prefixes, and
   tags that already apply (6.5% of moments were skipped because the tag
   written already applied through inheritance or rules).

## Caveats

- One namespace, one time window measured in detail (the 60–80% window was not
  completed); results may differ for other people's tagging habits.
- Tag addition dates are not stored, so notes created before the cutoff keep
  their current tags in the experiment.
- Each comparison rests on a few hundred moments; differences of about 5 points
  or more are unlikely to be noise, smaller ones may be.
