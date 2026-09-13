from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass
from pathlib import Path

from tree_sitter import Language
from tree_sitter import Node
from tree_sitter import Parser
import tree_sitter_javascript as tree_sitter_javascript

from app.startup_sanity_config import EXCLUDE_DOT_FOLDERS
from app.startup_sanity_config import IGNORE_GLOBS
from app.startup_sanity_config import INSTALLED_DISTRIBUTION_SOURCE_DIR_NAMES
from app.startup_sanity_config import INSTALLED_DISTRIBUTION_SOURCE_FILE_NAMES
from app.startup_sanity_config import JS_ALLOWED_TRY_CALLEE_NAMES
from app.startup_sanity_config import JS_ALLOWED_TRY_CALLEE_PREFIXES
from app.startup_sanity_config import JS_EXCLUDED_RELATIVE_PREFIXES
from app.startup_sanity_config import JS_STATE_OBSERVATION_BOUNDARIES
from app.startup_sanity_config import JS_TEST_BASENAMES
from app.startup_sanity_config import JS_TEST_DIR_NAMES
from app.startup_sanity_config import JS_TEST_SUFFIXES
from app.startup_sanity_config import SANITY_PRUNE_NAMES
from app.startup_sanity_config import is_installed_distribution_root


_JS_EXTENSIONS = frozenset({".js", ".jsx"})
_TS_EXTENSIONS = frozenset({".ts", ".tsx"})
_MAX_VIOLATIONS = 200
_PARSER = Parser(Language(tree_sitter_javascript.language()))


@dataclass(frozen=True)
class StartupJsViolation:
    rule_id: str
    message: str
    path: str
    lineno: int
    col: int
    codeframe: str


@dataclass(frozen=True)
class _JsSanityConfig:
    exclude_dot_folders: bool
    ignore_globs: list[str]
    allowed_try_callee_names: list[str]
    allowed_try_callee_prefixes: list[str]


def _load_js_sanity_config() -> _JsSanityConfig:
    return _JsSanityConfig(
        exclude_dot_folders=EXCLUDE_DOT_FOLDERS,
        ignore_globs=list(IGNORE_GLOBS),
        allowed_try_callee_names=list(JS_ALLOWED_TRY_CALLEE_NAMES),
        allowed_try_callee_prefixes=list(JS_ALLOWED_TRY_CALLEE_PREFIXES),
    )


def _ignored(*, rel_path: str, ignore_globs: list[str]) -> bool:
    for pattern in ignore_globs:
        if fnmatch.fnmatch(rel_path, pattern):
            return True
    return False


def _is_js_test_file(rel_path: str) -> bool:
    parts = rel_path.split("/")
    if len(parts) > 1:
        for directory_name in parts[:-1]:
            if directory_name in JS_TEST_DIR_NAMES:
                return True

    basename = parts[-1]
    if basename in JS_TEST_BASENAMES:
        return True

    for suffix in JS_TEST_SUFFIXES:
        if basename.endswith(suffix):
            return True
    return False


def _discover_source_paths(
    *,
    project_root: Path,
    extensions: frozenset[str],
) -> list[Path]:
    config = _load_js_sanity_config()
    is_installed_distribution = is_installed_distribution_root(project_root)
    paths: list[Path] = []

    for current_root, directory_names, file_names in os.walk(project_root):
        current_root_path = Path(current_root)
        rel_root_path = current_root_path.relative_to(project_root)
        rel_root = rel_root_path.as_posix()
        if rel_root == ".":
            rel_root = ""

        kept_dirs: list[str] = []
        for directory_name in directory_names:
            if (
                is_installed_distribution
                and current_root_path == project_root
                and directory_name not in INSTALLED_DISTRIBUTION_SOURCE_DIR_NAMES
            ):
                continue
            if directory_name in SANITY_PRUNE_NAMES:
                continue
            if config.exclude_dot_folders and directory_name.startswith("."):
                continue

            child_rel = directory_name
            if rel_root != "":
                child_rel = f"{rel_root}/{directory_name}"
            if _ignored(rel_path=child_rel, ignore_globs=config.ignore_globs):
                continue
            if _ignored(rel_path=f"{child_rel}/", ignore_globs=config.ignore_globs):
                continue
            if any(
                child_rel == prefix.removesuffix("/") or child_rel.startswith(prefix)
                for prefix in JS_EXCLUDED_RELATIVE_PREFIXES
            ):
                continue
            kept_dirs.append(directory_name)
        directory_names[:] = kept_dirs

        for file_name in file_names:
            if (
                is_installed_distribution
                and current_root_path == project_root
                and file_name not in INSTALLED_DISTRIBUTION_SOURCE_FILE_NAMES
            ):
                continue
            if Path(file_name).suffix not in extensions:
                continue

            rel_path = file_name
            if rel_root != "":
                rel_path = f"{rel_root}/{file_name}"
            if _ignored(rel_path=rel_path, ignore_globs=config.ignore_globs):
                continue
            if any(rel_path.startswith(prefix) for prefix in JS_EXCLUDED_RELATIVE_PREFIXES):
                continue
            if _is_js_test_file(rel_path):
                continue
            paths.append(project_root / rel_path)

    paths.sort()
    return paths


def discover_javascript_source_paths(project_root: Path) -> list[Path]:
    if not isinstance(project_root, Path):
        raise TypeError(f"project_root must be a Path, got {type(project_root)}")
    return _discover_source_paths(project_root=project_root, extensions=_JS_EXTENSIONS)


def discover_typescript_source_paths(project_root: Path) -> list[Path]:
    if not isinstance(project_root, Path):
        raise TypeError(f"project_root must be a Path, got {type(project_root)}")
    return _discover_source_paths(project_root=project_root, extensions=_TS_EXTENSIONS)


def _path_rel(project_root: Path, path: Path) -> str:
    return os.path.relpath(path, project_root)


def _codeframe(lines: list[str], lineno: int, col: int, context_lines: int) -> str:
    assert lineno >= 1
    assert col >= 0
    assert context_lines >= 0

    start = max(1, lineno - context_lines)
    end = min(len(lines), lineno + context_lines)
    width = len(str(end))
    out: list[str] = []
    current = start
    while current <= end:
        prefix = str(current).rjust(width)
        out.append(f"{prefix} | {lines[current - 1]}")
        if current == lineno:
            out.append(" " * (width + 3 + col) + "^")
        current += 1
    return "\n".join(out)


def _collect_comments(root: Node, source_bytes: bytes) -> list[tuple[int, int, str]]:
    comments: list[tuple[int, int, str]] = []
    stack = [root]
    while len(stack) != 0:
        node = stack.pop()
        if node.type == "comment":
            comments.append(
                (
                    node.start_point.row + 1,
                    node.end_point.row + 1,
                    source_bytes[node.start_byte:node.end_byte].decode("utf-8"),
                )
            )
        for child in reversed(node.children):
            stack.append(child)
    comments.sort()
    return comments


def _suppressed(*, comments: list[tuple[int, int, str]], lineno: int, rule_id: str) -> bool:
    pattern = re.compile(rf'lint: allow-{re.escape(rule_id)}\s+rationale=".+\"')

    for start_line, end_line, text in comments:
        if start_line == lineno and pattern.search(text) is not None:
            return True

    preceding: list[tuple[int, int, str]] = []
    for start_line, end_line, text in comments:
        if end_line < lineno:
            preceding.append((start_line, end_line, text))
            continue
        break

    expected_line = lineno - 1
    index = len(preceding) - 1
    while index >= 0:
        start_line, end_line, text = preceding[index]
        if end_line < expected_line:
            return False
        if pattern.search(text) is not None:
            return True
        expected_line = start_line - 1
        index -= 1
    return False


def _node_text(source_bytes: bytes, node: Node) -> str:
    return source_bytes[node.start_byte:node.end_byte].decode("utf-8")


class _StartupJsChecker:
    def __init__(
        self,
        *,
        project_root: Path,
        path: Path,
        source_text: str,
        config: _JsSanityConfig,
    ) -> None:
        self._project_root = project_root
        self._path = path
        self._source_text = source_text
        self._source_bytes = source_text.encode("utf-8")
        self._lines = source_text.splitlines()
        self._config = config
        self._violations: list[StartupJsViolation] = []
        self._tree = _PARSER.parse(self._source_bytes)
        self._root = self._tree.root_node
        self._comments = _collect_comments(self._root, self._source_bytes)
        self._constant_collections: set[str] = set()

    def violations(self) -> list[StartupJsViolation]:
        return list(self._violations)

    def run(self) -> None:
        self._check_parse_errors(self._root)
        self._check_state_ownership()
        self._walk(self._root)

    def _check_state_ownership(self) -> None:
        if self._path.name == "application-state.js":
            return
        for top in self._root.named_children:
            node = top
            if top.type == "export_statement":
                declarations = [child for child in top.named_children if child.type in {"lexical_declaration", "variable_declaration", "class_declaration"}]
                if not declarations:
                    continue
                node = declarations[0]
            if node.type in {"lexical_declaration", "variable_declaration"}:
                text = _node_text(self._source_bytes, node)
                if text.startswith(("let ", "var ")):
                    self._add(node=node, rule_id="JS007", message="module state must be owned by ApplicationState")
                for declaration in node.named_children:
                    if declaration.type != "variable_declarator":
                        continue
                    name_node = declaration.child_by_field_name("name")
                    value = declaration.child_by_field_name("value")
                    if name_node is None or value is None or name_node.type != "identifier":
                        continue
                    name = _node_text(self._source_bytes, name_node)
                    is_collection = value.type == "array"
                    if value.type in {"new_expression", "call_expression"}:
                        is_collection = re.match(r"(?:new (?:Map|Set|WeakMap|WeakSet)\(|Object.create\()", _node_text(self._source_bytes, value)) is not None
                    is_record = value.type == "object" and any(child.type == "pair" for child in value.named_children)
                    if (is_collection or is_record) and name.isupper():
                        self._constant_collections.add(name)
                    if (is_collection or is_record) and not name.isupper():
                        owned = f"ApplicationState.own({name}," in self._source_text
                        if not owned:
                            self._add(node=declaration, rule_id="JS007", message="mutable module record must use ApplicationState")
            if node.type == "class_declaration":
                name_node = node.child_by_field_name("name")
                assert name_node is not None
                name = _node_text(self._source_bytes, name_node)
                text = _node_text(self._source_bytes, node)
                if not name.endswith("Error") and re.search(r"this\.[\w$]+\s*=", text) and "ApplicationState.own(this," not in text:
                    self._add(node=node, rule_id="JS007", message="controller state must be owned by ApplicationState")

    def _has_exception_guard_import(self) -> bool:
        for node in self._root.named_children:
            if node.type != "import_statement":
                continue
            text = _node_text(self._source_bytes, node)
            if re.search(r"import\s*\{[^}]*\brethrowUnexpectedError\b[^}]*\}\s*from\s*['\"][./a-zA-Z_-]+expected-errors\.js['\"]", text):
                return True
        return False

    def _walk(self, node: Node) -> None:
        self._check_constant_mutation(node)
        if node.type == "try_statement":
            self._check_try_statement(node)
        elif node.type in {"function_declaration", "function_expression", "arrow_function"}:
            self._check_default_params(node)
        elif node.type in {"object_pattern", "array_pattern"}:
            self._check_destructuring_defaults(node)
        elif node.type == "binary_expression":
            self._check_defaulting_operator(node)
        elif node.type == "augmented_assignment_expression":
            self._check_defaulting_assignment(node)
        elif node.type == "call_expression":
            self._check_native_browser_dialog(node)
            self._check_promise_handler(node)
            self._check_state_observation(node)
        elif node.type == "assignment_expression":
            left = node.child_by_field_name("left")
            if left is not None:
                target = _node_text(self._source_bytes, left)
                if re.match(r"(?:ModeContext|ModeContextInstance)\s*[.\[]", target):
                    self._add(node=node, rule_id="JS006", message="direct client state mutation is forbidden")

        for child in node.children:
            self._walk(child)

    def _root_identifier(self, node: Node | None) -> str | None:
        while node is not None and node.type in {"member_expression", "subscript_expression"}:
            node = node.child_by_field_name("object")
        if node is not None and node.type == "identifier":
            return _node_text(self._source_bytes, node)
        return None

    def _check_constant_mutation(self, node: Node) -> None:
        target = None
        if node.type in {"assignment_expression", "augmented_assignment_expression"}:
            target = node.child_by_field_name("left")
        elif node.type == "update_expression":
            target = node.child_by_field_name("argument")
        elif node.type == "call_expression":
            function = node.child_by_field_name("function")
            if function is not None and function.type == "member_expression":
                property_node = function.child_by_field_name("property")
                assert property_node is not None
                if _node_text(self._source_bytes, property_node) in {"set", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"}:
                    target = function.child_by_field_name("object")
        if self._root_identifier(target) in self._constant_collections:
            self._add(node=node, rule_id="JS007", message="module constants may not become mutable state")

    def _add(self, *, node: Node, rule_id: str, message: str) -> None:
        lineno = node.start_point.row + 1
        col = node.start_point.column
        if _suppressed(comments=self._comments, lineno=lineno, rule_id=rule_id):
            return
        self._violations.append(
            StartupJsViolation(
                rule_id=rule_id,
                message=message,
                path=_path_rel(self._project_root, self._path),
                lineno=lineno,
                col=col,
                codeframe=_codeframe(self._lines, lineno, col, 2),
            )
        )

    def _check_parse_errors(self, node: Node) -> None:
        if node.type == "ERROR":
            self._add(node=node, rule_id="JS000", message="parse error")
        for child in node.children:
            self._check_parse_errors(child)

    def _check_try_statement(self, node: Node) -> None:
        catch_clause = None
        for child in node.children:
            if child.type == "catch_clause":
                catch_clause = child
                break
        if catch_clause is None:
            self._add(node=node, rule_id="JS001", message="try without catch is forbidden")
            return

        if not self._try_has_allowlisted_call(node):
            self._add(node=node, rule_id="JS001", message="try block has no allowlisted external call")

        catch_body = None
        for child in catch_clause.children:
            if child.type == "statement_block":
                catch_body = child
                break
        assert catch_body is not None, "catch_clause missing statement_block"

        if self._contains_return(catch_body):
            self._add(node=catch_clause, rule_id="JS001", message="catch must not return")
        if not self._contains_throw(catch_body):
            self._add(node=catch_clause, rule_id="JS001", message="catch must throw (no silent handling)")

    def _try_has_allowlisted_call(self, try_node: Node) -> bool:
        try_block = None
        for child in try_node.children:
            if child.type == "statement_block":
                try_block = child
                break
        assert try_block is not None, "try_statement missing statement_block"

        stack = [try_block]
        while len(stack) != 0:
            node = stack.pop()
            if node.type == "call_expression":
                callee_name = self._call_expression_name(node)
                if callee_name is not None:
                    if callee_name in self._config.allowed_try_callee_names:
                        return True
                    for prefix in self._config.allowed_try_callee_prefixes:
                        if callee_name.startswith(prefix):
                            return True
            for child in reversed(node.children):
                stack.append(child)
        return False

    def _call_expression_name(self, node: Node) -> str | None:
        function_node = node.child_by_field_name("function")
        if function_node is None:
            return None
        return self._dotted_name(function_node)

    def _dotted_name(self, node: Node) -> str | None:
        if node.type in {"identifier", "property_identifier"}:
            return _node_text(self._source_bytes, node)
        if node.type == "member_expression":
            object_node = node.child_by_field_name("object")
            property_node = node.child_by_field_name("property")
            if object_node is None or property_node is None:
                return None
            base = self._dotted_name(object_node)
            if base is None:
                return None
            if property_node.type not in {"identifier", "property_identifier"}:
                return None
            return f"{base}.{_node_text(self._source_bytes, property_node)}"
        return None

    def _contains_throw(self, node: Node) -> bool:
        if node.type == "throw_statement":
            return True
        for current in node.named_children:
            if current.type == "throw_statement":
                return True
            if current.type == "expression_statement":
                text = _node_text(self._source_bytes, current)
                if self._has_exception_guard_import() and re.fullmatch(r"rethrowUnexpectedError\([a-zA-Z_$][\w$]*\);?", text.strip()):
                    return True
            if current.type == "if_statement":
                condition = current.child_by_field_name("condition")
                consequence = current.child_by_field_name("consequence")
                alternative = current.child_by_field_name("alternative")
                if consequence is not None and self._contains_throw(consequence):
                    if alternative is not None and self._contains_throw(alternative):
                        return True
                    if condition is not None:
                        text = _node_text(self._source_bytes, condition)
                        if re.fullmatch(r"\(!\([\w$]+ instanceof (?:AiApiError|HttpRequestError)\)\)", text):
                            return True
            if current.type in {"return_statement", "if_statement"}:
                # Unknown branching before an unconditional guard may skip it.
                return False
        return False

    def _check_promise_handler(self, node: Node) -> None:
        function = node.child_by_field_name("function")
        if function is None or function.type != "member_expression":
            return
        property_node = function.child_by_field_name("property")
        if property_node is None:
            return
        name = _node_text(self._source_bytes, property_node)
        arguments = node.child_by_field_name("arguments")
        assert arguments is not None
        values = [child for child in arguments.named_children if child.type != "comment"]
        if name == "catch" and values:
            handler = values[0]
        elif name == "then" and len(values) > 1:
            handler = values[1]
        else:
            return
        body = handler.child_by_field_name("body")
        if body is None or not self._contains_throw(body):
            self._add(node=handler, rule_id="JS001", message="promise rejection handler must propagate unapproved errors")

    def _check_state_observation(self, node: Node) -> None:
        function = node.child_by_field_name("function")
        assert function is not None
        text = _node_text(self._source_bytes, function)
        if text != "ApplicationState.receiveOwnerSnapshot" and not text.endswith(".receive"):
            return
        parent = node.parent
        while parent is not None and parent.type not in {"method_definition", "function_declaration"}:
            parent = parent.parent
        name = "module"
        if parent is not None:
            name_node = parent.child_by_field_name("name")
            assert name_node is not None
            name = _node_text(self._source_bytes, name_node)
        boundary = f"{_path_rel(self._project_root, self._path)}:{name}"
        if boundary not in JS_STATE_OBSERVATION_BOUNDARIES:
            self._add(node=node, rule_id="JS007", message="state reconciliation requires a selected observation boundary")

    def _contains_return(self, node: Node) -> bool:
        stack = [node]
        while len(stack) != 0:
            current = stack.pop()
            if current.type == "return_statement":
                return True
            for child in reversed(current.children):
                stack.append(child)
        return False

    def _check_default_params(self, node: Node) -> None:
        if node.type == "arrow_function":
            parameter_node = node.child_by_field_name("parameter")
            if parameter_node is not None and parameter_node.type == "assignment_pattern":
                self._add(node=parameter_node, rule_id="JS002", message="default parameters are forbidden")

        parameters_node = node.child_by_field_name("parameters")
        if parameters_node is None:
            return
        for child in parameters_node.children:
            if child.type == "assignment_pattern":
                self._add(node=child, rule_id="JS002", message="default parameters are forbidden")

    def _check_destructuring_defaults(self, node: Node) -> None:
        stack = [node]
        while len(stack) != 0:
            current = stack.pop()
            if current is not node and current.type in {"object_pattern", "array_pattern"}:
                pass
            if current.type in {"assignment_pattern", "object_assignment_pattern"}:
                self._add(node=current, rule_id="JS003", message="destructuring defaults are forbidden")
            for child in reversed(current.children):
                stack.append(child)

    def _check_defaulting_operator(self, node: Node) -> None:
        operator = self._binary_operator(node)
        if operator not in {"||", "??"}:
            return
        if self._is_value_context(node):
            self._add(node=node, rule_id="JS004", message="defaulting operator is forbidden")

    def _check_defaulting_assignment(self, node: Node) -> None:
        operator = self._augmented_assignment_operator(node)
        if operator in {"||=", "??="}:
            self._add(node=node, rule_id="JS004", message="defaulting operator is forbidden")

    def _check_native_browser_dialog(self, node: Node) -> None:
        callee_name = self._call_expression_name(node)
        forbidden_names = {
            "alert",
            "confirm",
            "prompt",
            "globalThis.alert",
            "globalThis.confirm",
            "globalThis.prompt",
            "window.alert",
            "window.confirm",
            "window.prompt",
        }
        if callee_name in forbidden_names:
            self._add(
                node=node,
                rule_id="JS005",
                message="native browser dialogs are forbidden",
            )

    def _binary_operator(self, node: Node) -> str | None:
        for child in node.children:
            if child.type in {"||", "??"}:
                return child.type
        return None

    def _augmented_assignment_operator(self, node: Node) -> str | None:
        for child in node.children:
            if child.type in {"||=", "??="}:
                return child.type
        return None

    def _is_value_context(self, node: Node) -> bool:
        parent = node.parent
        if parent is None:
            return False
        if parent.type == "variable_declarator":
            return parent.child_by_field_name("value") == node
        if parent.type == "assignment_expression":
            return parent.child_by_field_name("right") == node
        if parent.type == "return_statement":
            for index, child in enumerate(parent.children):
                if child == node:
                    return parent.field_name_for_child(index) in {None, "argument"}
            return False
        if parent.type == "arguments":
            return True
        return False


def collect_startup_js_sanity_violations(project_root: Path) -> tuple[list[Path], list[StartupJsViolation]]:
    config = _load_js_sanity_config()
    js_paths = discover_javascript_source_paths(project_root)
    violations: list[StartupJsViolation] = []

    for path in js_paths:
        source_text = path.read_text(encoding="utf-8")
        checker = _StartupJsChecker(
            project_root=project_root,
            path=path,
            source_text=source_text,
            config=config,
        )
        checker.run()
        violations.extend(checker.violations())

    return js_paths, violations


def _render_report(violations: list[StartupJsViolation]) -> str:
    out: list[str] = []
    for violation in violations:
        out.append(
            f"{violation.path}:{violation.lineno}:{violation.col} "
            f"{violation.rule_id} {violation.message}",
        )
        out.append(violation.codeframe)
        out.append("")
    out.append(f"Total: {len(violations)}")
    return "\n".join(out).rstrip() + "\n"


def assert_startup_js_sanity(project_root: Path) -> None:
    print("[startup] Running JS sanity checks...", flush=True)

    typescript_paths = discover_typescript_source_paths(project_root)
    if len(typescript_paths) != 0:
        print("[startup] JS sanity checks failed", flush=True)
        rel_paths = [_path_rel(project_root, path) for path in typescript_paths]
        joined = "\n".join(rel_paths)
        raise RuntimeError(
            "TypeScript files are not supported by the Python JS sanity checker yet:\n"
            f"{joined}\n",
        )

    paths, violations = collect_startup_js_sanity_violations(project_root)
    if len(violations) == 0:
        print(f"[startup] JS sanity checks passed ({len(paths)} JS/JSX files)", flush=True)
        return

    shown = violations[:_MAX_VIOLATIONS]
    report = _render_report(shown)
    print("[startup] JS sanity checks failed", flush=True)
    if len(violations) > _MAX_VIOLATIONS:
        remaining = len(violations) - _MAX_VIOLATIONS
        report += f"(truncated) Remaining: {remaining}\n"
    raise RuntimeError(report)
