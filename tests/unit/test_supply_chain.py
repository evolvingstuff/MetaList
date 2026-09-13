import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/check_supply_chain.py'
spec = importlib.util.spec_from_file_location('check_supply_chain', SCRIPT)
chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chain)


def test_audit_includes_non_host_platform_markers():
    requirements = "colorama==0.4.6 ; sys_platform == 'win32' \\\n    --hash=sha256:abc\nexceptiongroup==1.3.1 ; python_version < '3.11' \\\n    --hash=sha256:def\n"
    assert chain.all_platform_requirements(requirements) == ['colorama==0.4.6', 'exceptiongroup==1.3.1']


def test_unpinned_requirement_fails():
    with pytest.raises(RuntimeError, match='exact package versions'):
        chain.all_platform_requirements('requests>=2\n')


def test_untracked_vendor_file_fails_manifest_check(tmp_path):
    (tmp_path / 'docs/security').mkdir(parents=True)
    (tmp_path / 'docs/security/vendor-manifest.json').write_text('[]')
    (tmp_path / 'app/static/js/vendor').mkdir(parents=True)
    (tmp_path / 'app/static/js/vendor/untracked.js').write_text('code')
    with pytest.raises(RuntimeError, match='cover every'):
        chain.check_vendor_files(tmp_path)


@pytest.mark.parametrize('step', ['  - name: Checkout\n    uses: actions/checkout@v4\n',
                                 '  - uses: actions/checkout@v4\n'])
@pytest.mark.parametrize('extension', ['yml', 'yaml'])
def test_mutable_action_reference_is_rejected(tmp_path, step, extension):
    (tmp_path / '.github/workflows').mkdir(parents=True)
    (tmp_path / f'.github/workflows/release.{extension}').write_text('steps:\n' + step)
    with pytest.raises(RuntimeError, match='immutable commit'):
        chain.check_action_pins(tmp_path)


def test_python_audit_failure_cannot_be_reported_as_success(tmp_path, monkeypatch):
    (tmp_path / 'requirements').mkdir()
    (tmp_path / 'requirements/ci.txt').write_text('example==1.0\n')
    monkeypatch.setattr(chain, 'check_vendor_files', lambda _: [])
    monkeypatch.setattr(chain, 'audit_vendor_versions', lambda _: [])
    monkeypatch.setattr(chain.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=1))
    with pytest.raises(RuntimeError, match='Python dependency audit failed'):
        chain.audit(tmp_path, tmp_path / 'output')


def test_vulnerability_result_blocks_release(tmp_path, monkeypatch):
    (tmp_path / 'requirements').mkdir()
    (tmp_path / 'requirements/ci.txt').write_text('example==1.0\n')
    monkeypatch.setattr(chain, 'check_vendor_files', lambda _: [])
    monkeypatch.setattr(chain, 'audit_vendor_versions', lambda _: [{'vulnerabilities': [{'id': 'GHSA-example'}]}])
    monkeypatch.setattr(chain.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=0))
    with pytest.raises(RuntimeError, match='known advisories'):
        chain.audit(tmp_path, tmp_path / 'output')
    assert json.loads((tmp_path / 'output/vendor.json').read_text())['libraries'][0]['vulnerabilities']


def test_distribution_rejects_obsolete_vendor_bundle():
    distribution_spec = importlib.util.spec_from_file_location('check_distribution', SCRIPT.with_name('check_distribution.py'))
    distribution = importlib.util.module_from_spec(distribution_spec)
    distribution_spec.loader.exec_module(distribution)
    expected = {'app/static/js/vendor/patched.js'}
    with pytest.raises(AssertionError, match='obsolete vendor bundles'):
        distribution.check_vendor_inventory(expected | {'app/static/js/vendor/old.js'}, expected)
