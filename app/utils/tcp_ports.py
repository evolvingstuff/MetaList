"""The TCP port numbers MetaList accepts, stated once.

The browser mirrors these in app/static/js/modules/tcp-ports.js; a unit test
(tests/unit/test_tcp_ports.py) keeps the two equal.
"""

LOWEST_PORT = 1
HIGHEST_PORT = 65535
PORT_RANGE_TEXT = f"between {LOWEST_PORT} and {HIGHEST_PORT}"


def is_tcp_port(value: int) -> bool:
    return LOWEST_PORT <= value <= HIGHEST_PORT
