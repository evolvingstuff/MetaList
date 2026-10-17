"""Provide MetaList's checksum-pinned updater runtime on every supported OS."""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import io
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
from tempfile import NamedTemporaryFile
from urllib.request import urlopen
import zipfile


# Official immutable uv 0.12.17 release archives. These values match the
# upstream sha256.sum asset for the same release.
INSTALLER_VERSION = "0.12.17"
_INSTALLER_VERSION_CHECK_TIMEOUT_SECONDS = 30
_INSTALLER_DOWNLOAD_TIMEOUT_SECONDS = 120
_ARCHIVE_FILE_MODE = stat.S_IRUSR | stat.S_IWUSR
_EXECUTABLE_FILE_MODE = stat.S_IRWXU
INSTALLER_ARCHIVE_SHA256 = {
    "aarch64-apple-darwin": "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b",
    "aarch64-pc-windows-msvc": "3e1aa6849d77f0e00dc865e4afab5c5b32de053e21fe35bf5ad5cec3734ec976",
    "aarch64-unknown-linux-gnu": "d636d1b678e9e7f367ecb22b46bd1cabbed234d6bc3b4d96365d2b507f72f86c",
    "aarch64-unknown-linux-musl": "a6096da273d548cb9f277d237a01ac7344a39ef0f455c0e148e4dc9737c1596b",
    "armv7-unknown-linux-gnueabihf": "796e101976e18a0f92d90b6f3efd289f77fbc5afd1aaa6fdedd3c84c209eabab",
    "armv7-unknown-linux-musleabihf": "421c5f9c53d49088e705e7a64fea147082a2191178ea1d8c51d9ad758ca899f6",
    "i686-pc-windows-msvc": "1d3653cb6eafd1e675e979d7cd8eeac1456202f8927a2216419993077a4c473f",
    "i686-unknown-linux-gnu": "3faa79a70e2a1aa6eb3cd78eba02263f3e4b17b6be584a01429968f92ff74966",
    "i686-unknown-linux-musl": "fc05220cfa1c6585e0e209877c228393b25a96e17cd43028b06566ac894cd078",
    "powerpc64le-unknown-linux-gnu": "eb6dbedaaa622af32cba2388e0d2d47e34c8724d4214a129d614b96f071d8e53",
    "riscv64gc-unknown-linux-gnu": "65b807b24357133c49d97ca9394ee7e13ca62822e1095376c809654b35f39cf2",
    "riscv64gc-unknown-linux-musl": "87c339a735b578f285b961bebdefe0a671f3652477d1e84dc69cd1a829f45e92",
    "s390x-unknown-linux-gnu": "d99f69f47fc5e0975d6e7a5745cf2332317015caffb3bb81e5154cc7b66fa77a",
    "x86_64-apple-darwin": "8dcf05a8c809bb3c471d2b614788ba27a6e41298fc8c31ac84b5f4339fd468e5",
    "x86_64-pc-windows-msvc": "a252121d5b59398fcb137c6ea448176459a44010f33f67e0072305a637119ca7",
    "x86_64-unknown-linux-gnu": "fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63",
    "x86_64-unknown-linux-musl": "6401c4665d8fa2a9893e087c91f585430738e3170f5398a1141483efb4a93310",
}


def _installer_version(executable: str, environ: Mapping[str, str]) -> tuple[int, int, int]:
    completed = subprocess.run(
        [executable, "--version"], env=dict(environ), capture_output=True,
        text=True, check=True, timeout=_INSTALLER_VERSION_CHECK_TIMEOUT_SECONDS,
    )
    match = re.fullmatch(
        r"uv (\d+)\.(\d+)\.(\d+)(?: \([^\r\n]+\))?",
        completed.stdout.strip(),
    )
    if match is None:
        raise RuntimeError("Cannot verify the uv installer version; MetaList was not stopped")
    return tuple(int(part) for part in match.groups())


def _normalized_architecture() -> str:
    machine = platform.machine().casefold()
    aliases = {
        "amd64": "x86_64", "x86_64": "x86_64",
        "arm64": "aarch64", "aarch64": "aarch64",
        "x86": "i686", "i386": "i686", "i686": "i686",
        "armv7": "armv7", "armv7l": "armv7",
        "ppc64le": "powerpc64le", "powerpc64le": "powerpc64le",
        "riscv64": "riscv64gc", "riscv64gc": "riscv64gc",
        "s390x": "s390x",
    }
    if machine not in aliases:
        raise RuntimeError(f"Unsupported MetaList updater platform architecture: {machine}")
    return aliases[machine]


def _linux_environment() -> str:
    libc_name = platform.libc_ver()[0].casefold()
    if libc_name in {"glibc", "gnu libc"}:
        return "gnu"
    if libc_name == "musl":
        return "musl"
    raise RuntimeError(f"Unsupported MetaList updater platform C library: {libc_name!r}")


def _installer_target(platform_name: str) -> str:
    architecture = _normalized_architecture()
    if platform_name == "win32":
        target = f"{architecture}-pc-windows-msvc"
    elif platform_name == "darwin":
        target = f"{architecture}-apple-darwin"
    elif platform_name == "linux":
        environment = _linux_environment()
        if architecture == "armv7":
            if environment == "gnu":
                abi = "gnueabihf"
            elif environment == "musl":
                abi = "musleabihf"
            else:
                raise AssertionError(f"Unexpected Linux environment: {environment}")
        else:
            abi = environment
        target = f"{architecture}-unknown-linux-{abi}"
    else:
        raise RuntimeError(f"Unsupported MetaList updater platform: {platform_name}")
    if target not in INSTALLER_ARCHIVE_SHA256:
        raise RuntimeError(f"Unsupported MetaList updater platform target: {target}")
    return target


def _required_absolute_directory(environ: Mapping[str, str], name: str) -> Path:
    if name not in environ:
        raise RuntimeError(f"{name} is required for the MetaList update installer")
    directory = Path(environ[name])
    if not directory.is_absolute():
        raise RuntimeError(f"{name} must be an absolute path for the MetaList update installer")
    return directory


def _installer_cache_root(*, platform_name: str, environ: Mapping[str, str]) -> Path:
    if platform_name == "win32":
        return _required_absolute_directory(environ, "LOCALAPPDATA") / "MetaList" / "update-tools"
    if platform_name == "darwin":
        home = _required_absolute_directory(environ, "HOME")
        return home / "Library" / "Caches" / "MetaList" / "update-tools"
    if platform_name == "linux":
        if "XDG_CACHE_HOME" in environ:
            cache_home = _required_absolute_directory(environ, "XDG_CACHE_HOME")
        else:
            home = _required_absolute_directory(environ, "HOME")
            cache_home = home / ".cache"
        return cache_home / "metalist" / "update-tools"
    raise RuntimeError(f"Unsupported MetaList updater platform: {platform_name}")


def _archive_name(*, target: str, platform_name: str) -> str:
    if platform_name == "win32":
        extension = "zip"
    elif platform_name in {"darwin", "linux"}:
        extension = "tar.gz"
    else:
        raise RuntimeError(f"Unsupported MetaList updater platform: {platform_name}")
    return f"uv-{target}.{extension}"


def _download_installer_archive(asset_name: str) -> bytes:
    url = f"https://github.com/astral-sh/uv/releases/download/{INSTALLER_VERSION}/{asset_name}"
    with urlopen(url, timeout=_INSTALLER_DOWNLOAD_TIMEOUT_SECONDS) as response:
        return response.read()


def _extract_installer_binary(
    *, archive_body: bytes, asset_name: str, platform_name: str, target: str,
) -> bytes:
    if platform_name == "win32":
        member_name = "uv.exe"
    elif platform_name in {"darwin", "linux"}:
        member_name = f"uv-{target}/uv"
    else:
        raise RuntimeError(f"Unsupported MetaList updater platform: {platform_name}")
    if asset_name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive_body)) as archive:
            return archive.read(member_name)
    with tarfile.open(fileobj=io.BytesIO(archive_body), mode="r:gz") as archive:
        member = archive.extractfile(member_name)
        if member is None:
            raise RuntimeError("Verified update installer archive is missing the uv executable")
        return member.read()


def _publish_bytes(*, destination: Path, body: bytes, mode: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        dir=destination.parent, prefix=destination.name + "-", suffix=".tmp", delete=False,
    ) as staged:
        staged.write(body)
        staged.flush()
        os.fsync(staged.fileno())
        staged_path = Path(staged.name)
    os.chmod(staged_path, mode)
    os.replace(staged_path, destination)


def _load_verified_archive(
    *, archive_path: Path, expected_digest: str, asset_name: str,
) -> bytes:
    if archive_path.exists():
        archive_body = archive_path.read_bytes()
        if hashlib.sha256(archive_body).hexdigest() != expected_digest:
            raise RuntimeError(
                "Cached update installer archive failed checksum verification; "
                "MetaList was not stopped"
            )
        return archive_body
    print(f"Preparing verified MetaList update installer uv {INSTALLER_VERSION}...", flush=True)
    archive_body = _download_installer_archive(asset_name)
    if hashlib.sha256(archive_body).hexdigest() != expected_digest:
        raise RuntimeError(
            "Downloaded update installer failed checksum verification; MetaList was not stopped"
        )
    _publish_bytes(destination=archive_path, body=archive_body, mode=_ARCHIVE_FILE_MODE)
    return archive_body


def _managed_installer(*, platform_name: str, environ: Mapping[str, str]) -> str:
    target = _installer_target(platform_name)
    asset_name = _archive_name(target=target, platform_name=platform_name)
    directory = _installer_cache_root(platform_name=platform_name, environ=environ) / (
        f"uv-{INSTALLER_VERSION}-{target}"
    )
    archive_path = directory / asset_name
    archive_body = _load_verified_archive(
        archive_path=archive_path,
        expected_digest=INSTALLER_ARCHIVE_SHA256[target],
        asset_name=asset_name,
    )
    expected_binary = _extract_installer_binary(
        archive_body=archive_body, asset_name=asset_name,
        platform_name=platform_name, target=target,
    )
    if platform_name == "win32":
        executable = directory / "uv.exe"
    else:
        assert platform_name in {"darwin", "linux"}
        executable = directory / "uv"
    if executable.exists():
        if executable.read_bytes() != expected_binary:
            raise RuntimeError(
                "Cached update installer failed checksum verification; MetaList was not stopped"
            )
    else:
        _publish_bytes(destination=executable, body=expected_binary, mode=_EXECUTABLE_FILE_MODE)
    if platform_name != "win32":
        os.chmod(executable, _EXECUTABLE_FILE_MODE)
    return str(executable)


def resolve_update_installer(*, platform_name: str, environ: Mapping[str, str]) -> str:
    executable = _managed_installer(platform_name=platform_name, environ=environ)
    expected_version = tuple(int(part) for part in INSTALLER_VERSION.split("."))
    if _installer_version(executable, environ) != expected_version:
        raise RuntimeError(
            "Verified update installer reported the wrong version; MetaList was not stopped"
        )
    return executable


def repair_windows_update() -> None:
    if sys.platform != "win32":
        raise RuntimeError("This recovery launcher is for Windows installations")
    metalist_executable = shutil.which("metalist")
    if metalist_executable is None:
        raise RuntimeError("The existing MetaList command must be available on PATH")
    environ = dict(os.environ)
    installer = resolve_update_installer(platform_name="win32", environ=environ)
    # The already-installed updater discovers uv through PATH. Preserve that
    # updater's preflight, shutdown, backup, offline install, and restart flow.
    environ["PATH"] = str(Path(installer).parent) + os.pathsep + environ["PATH"]
    subprocess.run([metalist_executable, "update"], env=environ, check=True)


if __name__ == "__main__":
    repair_windows_update()
