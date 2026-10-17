"""MetaList's application package."""

import sys

# MetaList relies on assert statements as executable invariants (AGENTS.md). Python's -O
# flag or PYTHONOPTIMIZE strips every one, so every entry point (each imports this
# package first) refuses to run that way.
if sys.flags.optimize:
    raise RuntimeError("MetaList must not run with python -O or PYTHONOPTIMIZE: it relies on assert statements")
