# Offline Tag-Suggestion Experiment

Compare MetaList's tag-bar ranking with learned and rule-based rankers on your
own notes. Not part of the shipped package. Results and conclusions:
`docs/design/tag-suggestion-learnings.md`.

## Setup (once)

The experiment needs numpy, scipy, scikit-learn and LightGBM, which are not
MetaList dependencies. Either install them into `.venv` (adds only new packages;
uninstall later to return `.venv` to its shipped state):

```bash
.venv/bin/python -m pip install numpy==2.3.3 scipy==1.16.2 scikit-learn==1.7.2 lightgbm==4.6.0
```

or keep them in a separate environment:

```bash
uv venv .venv-experiments --python 3.12
uv pip install --python .venv-experiments/bin/python -r requirements/runtime.txt
uv pip install --python .venv-experiments/bin/python -r experiments/tag_suggestions/requirements.txt
```

The script checks for them before asking for a password.

## Run

```bash
.venv/bin/python -m experiments.tag_suggestions --namespace NAME --max-test-notes 500 --folds 3
.venv/bin/python -m experiments.tag_suggestions --synthetic 3000
```

- The namespace database is copied read-only (SQLite online backup, safe while
  MetaList runs) into a temporary directory. Only the copy is unlocked and read,
  and it is deleted at the end. The live database is never opened for writing.
- For a password-protected namespace you type the password at the prompt.
- Output is totals only: counts, scores, timings and model-input names. No note
  text, tag names or note ids are printed or written anywhere.
- Options: `--max-train-notes`, `--max-test-notes`, `--max-stage` (most tags
  already in the bar), `--folds`, `--latest-only` (skip the 60–80% window),
  `--hide-tag-names` (ablation: each note's own tag names removed from its text).
- Most of the time goes to MetaList's own ranking on the test moments (about
  0.2 s each on a large namespace) and to reloading the store per fold; progress
  and time left are printed.

## What is measured

- Two time splits: test on tagged notes created in the latest 20% and in the
  60–80% window. Tags of every note created at or after the cutoff are hidden.
- Moments: empty tag bar (every remaining tag counts) and the first one, two
  and three letters of the next tag typed (two and three only for tags longer
  than that), with 0, 1, 2+ tags already in the bar (in written order).
- Targets are explicit non-meta tags not already implied by the bar, inherited
  tags or tag rules.
- Models: `today` (MetaList's ranking), `narrowing` (the one-letter rule at every
  length; MetaList's ranking since October 21, 2026, so equal to `today` once that is in), `neighbors` (similar notes by text and
  context tags), `naive_bayes`, `logistic` (logistic regression on all inputs),
  `trees_yes_no` and `trees_ranking` (LightGBM, binary and lambdarank), and two
  merges of the trees with today's list (`trees+today_slots`: trees' top 3 then
  today's best 2; `trees+today_alternate`: interleaved).
- Candidates: similar notes, Naive Bayes, tags on notes carrying every tag in the
  bar, known tags named in the text (used, in the tag rules, or inherited), tags
  that go with the bar's or inherited tags, and the tree (parent, siblings,
  children, ancestors). Today's ranking is not an input: it is too slow to run
  for every training moment, and it only serves as the comparison.
- A check line describes today's first-letter lists (size, tags already applying,
  prefix matches, whether the correct tag is anywhere in its 20).
- Learned models train on the latest training notes with out-of-fold
  statistics (a note never learns from its own tags) and stop early on the
  latest 15% of them.
- Scores: hit@5, recall@5, MRR over the 20 shown, precision@1; and per correct
  tag found in the top 5 by how often it was used before.

## Code

`corpus.py` (data), `snapshot.py` (read-only copy), `extract.py` (unlock and
load), `cases.py` (split and moments), `world_store.py` (MetaList's store and
ranking on the World), `features.py` (candidates and inputs), `models.py`,
`metrics.py`, `experiment.py` (report), `synthetic.py` (test namespace).
Tests: `.venv-experiments/bin/python -m pytest -q experiments/tag_suggestions/tests`.
