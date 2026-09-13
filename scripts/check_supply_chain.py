"""Check reproducible dependency inputs; audit package metadata without executing packages."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
EXPORT_OPTIONS = ['--frozen', '--offline', '--no-emit-project', '--no-header', '--no-annotate']


def check_exports(root: Path) -> None:
    subprocess.run(['uv', 'lock', '--check', '--offline'], cwd=root, check=True)
    for name, options in [('runtime', ['--no-default-groups']),
                          ('ci', ['--all-extras', '--group', 'release'])]:
        exported = subprocess.run(['uv', 'export', *EXPORT_OPTIONS, *options], cwd=root,
                                  check=True, capture_output=True, text=True).stdout
        expected = (root / 'requirements' / f'{name}.txt').read_text()
        if exported != expected:
            raise RuntimeError(f'requirements/{name}.txt differs from uv.lock; regenerate both exports')


def check_vendor_files(root: Path) -> list[dict]:
    libraries = json.loads((root / 'docs/security/vendor-manifest.json').read_text())
    actual = {path.relative_to(root).as_posix() for path in (root / 'app/static/js/vendor').glob('*.js')}
    declared = {library['path'] for library in libraries}
    if actual != declared or len(declared) != len(libraries):
        raise RuntimeError('Vendor manifest must cover every JavaScript bundle exactly once')
    for library in libraries:
        if hashlib.sha256((root / library['path']).read_bytes()).hexdigest() != library['sha256']:
            raise RuntimeError(f'Vendor checksum mismatch: {library["path"]}')
        if not (root / library['license']).is_file():
            raise RuntimeError(f'Vendor license missing: {library["name"]}')
    return libraries


def check_action_pins(root: Path) -> None:
    workflows = root / '.github/workflows'
    for path in [*workflows.glob('*.yml'), *workflows.glob('*.yaml')]:
        for action in re.findall(r'^\s*(?:-\s+)?uses:\s*(\S+)', path.read_text(), flags=re.MULTILINE):
            if not re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', action):
                raise RuntimeError(f'Action must use a full immutable commit: {path.name}: {action}')


def all_platform_requirements(requirements: str) -> list[str]:
    """Ignore host markers so the audit includes every exported platform branch."""
    packages = set()
    for line in requirements.splitlines():
        if not line or line[0].isspace() or line.startswith('#'):
            continue
        requirement = line.split(';', 1)[0].removesuffix('\\').strip()
        if not re.fullmatch(r'[A-Za-z0-9_.-]+==[^\s;\\]+', requirement):
            raise RuntimeError(f'Audit requires exact package versions: {requirement}')
        packages.add(requirement)
    if not packages:
        raise RuntimeError('Audit requirements are empty')
    if len({package.split('==')[0] for package in packages}) != len(packages):
        raise RuntimeError('Multiple versions of one package require separate pip-audit runs')
    return sorted(packages)


def audit_vendor_versions(libraries: list[dict]) -> list[dict]:
    results = []
    for library in libraries:
        query = {'package': {'name': library['name'], 'ecosystem': 'npm'}, 'version': library['version']}
        request = Request('https://api.osv.dev/v1/query', data=json.dumps(query).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=45) as response:
            report = json.load(response)
        if not isinstance(report, dict):
            raise RuntimeError('OSV response must be an object')
        if 'next_page_token' in report:
            raise RuntimeError('OSV returned a partial page; audit is incomplete')
        vulnerabilities = []
        if 'vulns' in report:
            vulnerabilities = report['vulns']
        if not isinstance(vulnerabilities, list):
            raise RuntimeError('OSV vulnerabilities must be a list')
        results.append({'name': library['name'], 'version': library['version'],
                        'vulnerabilities': vulnerabilities})
    return results


def audit(root: Path, output: Path) -> None:
    libraries = check_vendor_files(root)
    packages = all_platform_requirements((root / 'requirements/ci.txt').read_text())
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='metalist-audit-') as directory:
        requirements = Path(directory) / 'all-platforms.txt'
        requirements.write_text('\n'.join(packages) + '\n')
        completed = subprocess.run([
            sys.executable, '-m', 'pip_audit', '--no-deps', '--disable-pip',
            '-r', str(requirements), '--format', 'json', '--output', str(output / 'python.json'),
        ], cwd=root, check=False)
    vendor_results = audit_vendor_versions(libraries)
    (output / 'vendor.json').write_text(json.dumps({
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'source': 'https://api.osv.dev/v1/query', 'libraries': vendor_results,
    }, indent=2) + '\n')
    if completed.returncode != 0:
        raise RuntimeError(f'Python dependency audit failed (exit {completed.returncode}); inspect python.json')
    if any(library['vulnerabilities'] for library in vendor_results):
        raise RuntimeError('Vendored dependencies have known advisories; inspect vendor.json')
    print(f'Audited {len(packages)} Python versions across all platform markers and {len(libraries)} vendor versions: no known advisories')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'audit'])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'check':
        check_exports(ROOT)
        check_vendor_files(ROOT)
        check_action_pins(ROOT)
        print('Lock exports, vendor checksums/licenses, and Action pins verified')
        return
    if args.output is None:
        parser.error('audit requires --output')
    audit(ROOT, args.output.resolve())


if __name__ == '__main__':
    main()
