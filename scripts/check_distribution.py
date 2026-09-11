"""Check release artifacts against source resources, then import from the wheel alone."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import zipfile


def check_distribution(distribution_directory: Path) -> None:
    project_root = Path(__file__).resolve().parents[1]
    wheels = list(distribution_directory.glob("*.whl"))
    sources = list(distribution_directory.glob("*.tar.gz"))
    assert len(wheels) == len(sources) == 1, "Expected exactly one wheel and one source distribution"
    paths = {project_root / "main.py"}
    for pattern in (
        "app/**/*.py", "app/services/agent/**/*.md",
        "app/templates/**/*.html", "app/static/**/*",
    ):
        paths.update(
            path for path in project_root.glob(pattern)
            if path.is_file() and path.name != ".DS_Store" and "__pycache__" not in path.parts
        )
    with zipfile.ZipFile(wheels[0]) as wheel, tarfile.open(sources[0], "r:gz") as source:
        wheel_names = set(wheel.namelist())
        source_names = set(source.getnames())
        source_roots = {name.split("/")[0] for name in source_names}
        assert len(source_roots) == 1, "Source distribution must have one root directory"
        source_root = source_roots.pop()
        for path in sorted(paths):
            name = path.relative_to(project_root).as_posix()
            assert name in wheel_names, f"Wheel is missing runtime file: {name}"
            assert wheel.read(name) == path.read_bytes(), f"Wheel contains stale runtime file: {name}"
            source_name = f"{source_root}/{name}"
            assert source_name in source_names, f"Source distribution is missing runtime file: {name}"
            member = source.extractfile(source_name)
            assert member is not None
            with member:
                assert member.read() == path.read_bytes(), f"Source distribution contains stale runtime file: {name}"
    with tempfile.TemporaryDirectory(prefix="metalist-wheel-import-") as temporary_directory:
        subprocess.run(
            [sys.executable, "-I", "-c", (
                "import sys; sys.path.insert(0, sys.argv[1]); "
                "from app.services.agent.skills import SCOPED_INVESTIGATION_SKILL; "
                "from app.services.agent.prompts import AGENT_SYSTEM_PROMPT, FINAL_RESPONSE_REQUEST_PROMPT, TOOL_RESULT_PROMPT; "
                "assert all(value.strip() for value in (SCOPED_INVESTIGATION_SKILL, "
                "AGENT_SYSTEM_PROMPT, FINAL_RESPONSE_REQUEST_PROMPT, TOOL_RESULT_PROMPT))"
            ), str(wheels[0].resolve())],
            cwd=temporary_directory, check=True, timeout=30,
        )
    print(f"Verified {len(paths)} runtime files in both distributions and imported packaged agent resources.")


if __name__ == "__main__":
    assert len(sys.argv) == 2, "Usage: python scripts/check_distribution.py DIST_DIRECTORY"
    check_distribution(Path(sys.argv[1]))
