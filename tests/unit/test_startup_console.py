"""Startup output console (app/startup_console.py): colour where it is understood,
spinners only on real terminals."""

import io

from app.startup_console import make_startup_console, print_namespace_table, print_report


def test_pycharm_s_run_window_gets_colour_without_spinners() -> None:
    console = make_startup_console(environ={"PYCHARM_HOSTED": "1"})
    assert console.is_terminal is True
    assert console.is_interactive is False
    assert console.color_system is not None


def test_the_usual_colour_variables_override_the_pycharm_choice() -> None:
    forced = make_startup_console(environ={"PYCHARM_HOSTED": "1", "FORCE_COLOR": "1"})
    assert forced.is_terminal is True
    assert forced.is_interactive is True
    no_colour = make_startup_console(environ={"PYCHARM_HOSTED": "1", "NO_COLOR": "1"})
    assert no_colour.is_terminal is False
    not_a_terminal = make_startup_console(environ={"PYCHARM_HOSTED": "1", "TTY_COMPATIBLE": "0"})
    assert not_a_terminal.is_terminal is False


def test_a_pipe_outside_pycharm_gets_plain_text() -> None:
    # Under pytest stdout is captured, as when the output is piped to a file.
    console = make_startup_console(environ={})
    assert console.is_terminal is False
    assert console.color_system is None


def _table_output(environ: dict[str, str]) -> str:
    console = make_startup_console(environ=environ)
    # Without a console window attached (CI on Windows) Rich assumes the old
    # Windows console, which cannot show links, and leaves them out. A modern
    # terminal (Windows Terminal, macOS, Linux) is what these tests describe.
    console.legacy_windows = False
    console.file = io.StringIO()
    print_namespace_table(console, rows=[("default", "restarted", "http://127.0.0.1:8000", "https://127.0.0.1:8443")])
    return console.file.getvalue()


def test_pycharm_gets_plain_urls_it_can_link_itself_not_terminal_link_codes() -> None:
    output = _table_output({"PYCHARM_HOSTED": "1"})
    assert "\x1b]8;" not in output
    assert "   http://127.0.0.1:8000\n" in output


def test_a_real_terminal_gets_clickable_terminal_links() -> None:
    assert "\x1b]8;" in _table_output({"FORCE_COLOR": "1", "TTY_INTERACTIVE": "1"})


def test_a_report_prints_its_headline_beside_the_label_then_its_lines() -> None:
    console = make_startup_console(environ={})
    console.file = io.StringIO()
    print_report(console, label="ShockHarness report", detail="2 files · 1 errors", lines=("rules: DEF001 1", "most findings: a.py 1"))
    assert console.file.getvalue() == (
        " ▸ ShockHarness report        2 files · 1 errors\n"
        "     rules: DEF001 1\n"
        "     most findings: a.py 1\n"
    )
