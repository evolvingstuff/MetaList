"""The launcher's startup output: aligned, coloured, readable at a glance (Rich).

Rich draws colour and live spinners only on a real terminal. PyCharm's Run
window is not one (output is a pipe), but it shows colours; redrawn lines would
print as a mess there, so it gets colour without spinners. NO_COLOR, FORCE_COLOR
and TTY_COMPATIBLE keep their usual meaning. Failures and warnings are not drawn
here: they stay loud on stderr where they are raised.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager

from rich.console import Console
from rich.text import Text

_LABEL_WIDTH = 27
_ACTION_STYLES = {"launched": "green", "restarted": "cyan"}
_AUDIT_STATUS_STYLES = {"PASS": "green"}


def make_startup_console(*, environ: Mapping[str, str]) -> Console:
    is_pycharm = "PYCHARM_HOSTED" in environ
    has_explicit_choice = any(name in environ for name in ("NO_COLOR", "FORCE_COLOR", "TTY_COMPATIBLE"))
    if is_pycharm and not has_explicit_choice:
        return Console(force_terminal=True, force_interactive=False, highlight=False, soft_wrap=True,
                       _environ=environ)
    return Console(highlight=False, soft_wrap=True, _environ=environ)


def print_environment(console: Console, *, version: str, environment: str) -> None:
    console.print(Text.assemble(("MetaList", "bold"), " ", (version, "bold"), " · ", (environment, "cyan")))


def print_shell_enabled(console: Console) -> None:
    console.print(Text.assemble(
        (" @shell", "bold yellow"), " enabled for authenticated loopback clients (this launch only)",
    ))


@contextmanager
def working(console: Console, label: str) -> Iterator[None]:
    """A spinner while a check runs (terminals only)."""
    if not console.is_interactive:
        yield
        return
    with console.status(label, spinner="dots"):
        yield


def print_check_passed(console: Console, *, label: str, detail: str) -> None:
    console.print(Text.assemble((" ✓ ", "bold green"), label.ljust(_LABEL_WIDTH), (detail, "dim")))


def print_report(console: Console, *, label: str, detail: str, lines: Sequence[str]) -> None:
    """A report that gates nothing: its headline beside the label, then its lines."""
    console.print(Text.assemble((" ▸ ", "bold cyan"), label.ljust(_LABEL_WIDTH), (detail, "dim")))
    for line in lines:
        console.print(Text.assemble("     ", (line, "dim")))


def print_audit_namespaces(console: Console, *, statuses: Sequence[tuple[str, str]]) -> None:
    """The encrypted namespaces and their results (unencrypted ones have nothing to check)."""
    shown = [(namespace, status) for namespace, status in statuses if status != "SKIPPED (not encrypted)"]
    width = 0
    for namespace, _status in shown:
        width = max(width, len(namespace))
    for namespace, status in shown:
        style = "yellow"
        if status in _AUDIT_STATUS_STYLES:
            style = _AUDIT_STATUS_STYLES[status]
        console.print(Text.assemble("     ", namespace.ljust(width + 2), (status, style)))


def print_namespace_table(console: Console, *, rows: Sequence[tuple[str, str, str, str]]) -> None:
    """Per namespace: its name and action, then its HTTP and HTTPS URLs on their own
    lines, so it fits a narrow window; URLs are terminal links on real terminals."""
    width = 0
    for namespace, _action, _http_url, _https_url in rows:
        width = max(width, len(namespace))
    console.print()
    for namespace, action, http_url, https_url in rows:
        action_style = ""
        if action in _ACTION_STYLES:
            action_style = _ACTION_STYLES[action]
        console.print(Text.assemble(" ", (namespace.ljust(width + 2), "bold"), (action, action_style)))
        for url in (http_url, https_url):
            console.print(Text.assemble("   ", _url_text(url, is_linked=console.is_interactive)))


def _url_text(value: str, *, is_linked: bool) -> Text:
    # "disabled" (no HTTPS listener) is not a link.
    if not value.startswith(("http://", "https://")):
        return Text(value, style="dim")
    # Terminal hyperlinks (OSC 8) only on real terminals: PyCharm's Run window
    # prints them as raw codes, and makes plain URLs clickable itself.
    if not is_linked:
        return Text(value)
    return Text(value, style=f"link {value}")


def run_check(console: Console, *, label: str, check: Callable[[], str]) -> None:
    """Run a check with a spinner and print it as passed with the detail it returns."""
    with working(console, label):
        detail = check()
    print_check_passed(console, label=label, detail=detail)
