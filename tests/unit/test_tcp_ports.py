import re
from pathlib import Path

from app.utils.tcp_ports import HIGHEST_PORT, LOWEST_PORT, is_tcp_port

_JS_PORTS = Path(__file__).resolve().parents[2] / "app" / "static" / "js" / "modules" / "tcp-ports.js"


def test_browser_port_range_matches_the_server():
    source = _JS_PORTS.read_text(encoding="utf-8")
    assert re.search(r"^export const LOWEST_PORT = (\d+);$", source, re.M).group(1) == str(LOWEST_PORT)
    assert re.search(r"^export const HIGHEST_PORT = (\d+);$", source, re.M).group(1) == str(HIGHEST_PORT)


def test_port_range_edges():
    assert not is_tcp_port(0)
    assert is_tcp_port(1)
    assert is_tcp_port(65535)
    assert not is_tcp_port(65536)
