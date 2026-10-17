"""Package the same verified-installer code for repairing an older Windows updater."""
from pathlib import Path
import sys
import zipfile

# The script name and the output ZIP path.
_EXPECTED_ARGV_LENGTH = 2


def build_repair_archive(destination: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(root / "scripts/Repair-MetaList.cmd", "Repair-MetaList.cmd")
        archive.write(root / "app/services/update_installer.py", "update_installer.py")
        archive.writestr("README.txt", (
            "Extract this ZIP, then double-click Repair-MetaList.cmd.\r\n\r\n"
            "The launcher uses your existing MetaList Python installation. If needed, it\r\n"
            "downloads and verifies a private uv installer, then runs metalist update.\r\n"
            "Normal preflight, backups, installation, and restart remain enabled.\r\n"
            "It does not replace your global uv installation or change security settings.\r\n"
        ))
    print(destination.resolve())


if __name__ == "__main__":
    if len(sys.argv) != _EXPECTED_ARGV_LENGTH:
        raise SystemExit("Expected output ZIP path")
    build_repair_archive(Path(sys.argv[1]))
