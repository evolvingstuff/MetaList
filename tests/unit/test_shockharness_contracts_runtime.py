"""The ShockHarness property-contracts runtime files are the copies ShockHarness installed.

MetaList's startup checks skip them (they are third-party code), so their integrity
rests on this: each file named in .shockharness-contracts.json still has the checksum
recorded when `shockharness contracts install` wrote it. Plain Python, so it runs on
every platform (.gitattributes keeps the bytes identical on Windows checkouts).
"""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_each_installed_runtime_file_is_unchanged():
    manifest = json.loads((ROOT / ".shockharness-contracts.json").read_text(encoding="utf-8"))
    installed = manifest["skills"]
    assert set(installed) == {"python", "javascript", "javascript-types"}
    for entry in installed.values():
        digest = hashlib.sha256((ROOT / entry["path"]).read_bytes()).hexdigest()
        assert digest == entry["sha256"], f"{entry['path']} differs from the copy ShockHarness installed"
