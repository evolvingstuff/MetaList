from __future__ import annotations

import ast
import os
import re
from app.exception_boundaries import CAPTURE_BOUNDARIES
from dataclasses import dataclass
from pathlib import Path

from app.startup_sanity_config import INSTALLED_DISTRIBUTION_SOURCE_DIR_NAMES
from app.startup_sanity_config import INSTALLED_DISTRIBUTION_SOURCE_FILE_NAMES
from app.startup_sanity_config import PY_ALLOWED_EXCEPTION_NAMES
from app.startup_sanity_config import PY_ALLOWED_TRY_CALLEE_PREFIXES
from app.startup_sanity_config import SANITY_PRUNE_NAMES
from app.startup_sanity_config import is_installed_distribution_root


_MUTATION_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_ROUTE_DECORATOR_METHODS = frozenset({"post", "put", "patch", "delete"})
_MAX_VIOLATIONS = 200
_BACKUP_SERVICE_PATH = "app/services/backup_service.py"
_DATABASE_MIGRATIONS_PATH = "app/db/migrations.py"
_AUTH_SERVICE_PATH = "app/services/auth_service.py"
_AUTH_ROUTES_PATH = "app/api/routes/auth.py"
_MAIN_PATH = "app/main.py"
_BACKUP_SERVICE_MODULE = "app.services.backup_service"
_BACKUP_DELETE_FUNCTION = "delete_oldest_backups_in_directory"
_FORBIDDEN_BACKUP_MUTATION_CALLEES = frozenset(
    {
        "os.chmod",
        "os.remove",
        "os.rename",
        "os.replace",
        "os.truncate",
        "os.unlink",
        "os.utime",
        "shutil.copy",
        "shutil.copy2",
        "shutil.copyfile",
        "shutil.move",
    }
)
_FORBIDDEN_BACKUP_PATH_METHODS = frozenset(
    {
        "chmod",
        "rename",
        "replace",
        "touch",
        "write_bytes",
        "write_text",
    }
)
_FORBIDDEN_BACKUP_FUNCTION_TERMS = frozenset({"migrate", "replace", "rewrite", "upgrade"})


@dataclass(frozen=True)
class StartupSanityViolation:
    rule_id: str
    message: str
    path: str
    lineno: int
    col: int
    codeframe: str


@dataclass(frozen=True)
class _RouteDecorator:
    methods: tuple[str, ...]
    full_path: str
    lineno: int
    col: int


def _path_rel(project_root: Path, path: Path) -> str:
    return os.path.relpath(path, project_root)


def _suppressed(lines: list[str], lineno: int, rule_id: str) -> bool:
    assert lineno >= 1
    pattern = re.compile(rf'lint: allow-{re.escape(rule_id)}\s+rationale=".+\"')
    idx = lineno - 1

    if idx < len(lines) and pattern.search(lines[idx]) is not None:
        return True
    if idx - 1 >= 0 and pattern.search(lines[idx - 1]) is not None:
        return True
    return False


def _codeframe(lines: list[str], lineno: int, col: int, context_lines: int) -> str:
    assert lineno >= 1
    assert col >= 0
    assert context_lines >= 0

    start = lineno - context_lines
    if start < 1:
        start = 1
    end = lineno + context_lines
    if end > len(lines):
        end = len(lines)

    width = len(str(end))
    out: list[str] = []
    current = start
    while current <= end:
        prefix = str(current).rjust(width)
        out.append(f"{prefix} | {lines[current - 1]}")
        if current == lineno:
            marker = " " * (width + 3 + col) + "^"
            out.append(marker)
        current += 1
    return "\n".join(out)


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted_name(node.value)
        if base is None:
            return None
        return f"{base}.{node.attr}"
    return None


def _iter_exception_names(handler_type: ast.AST) -> list[str] | None:
    if isinstance(handler_type, ast.Tuple):
        names: list[str] = []
        for elt in handler_type.elts:
            name = _dotted_name(elt)
            if name is None:
                return None
            names.append(name)
        return names

    single = _dotted_name(handler_type)
    if single is None:
        return None
    return [single]


def _contains_raise(node: ast.AST) -> bool:
    for sub in node.body:
        if isinstance(sub, ast.Raise):
            return True
        if isinstance(sub, ast.If) and sub.orelse:
            if _contains_raise(sub) and _statements_raise(sub.orelse):
                return True
    return False


def _statements_raise(statements: list[ast.stmt]) -> bool:
    return _contains_raise(ast.Module(body=statements, type_ignores=[]))


def _contains_return(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Return):
            return True
    return False


def _try_has_allowlisted_call(try_node: ast.Try) -> bool:
    for stmt in try_node.body:
        for sub in ast.walk(stmt):
            if not isinstance(sub, ast.Call):
                continue
            callee = _dotted_name(sub.func)
            if callee is None:
                continue
            for prefix in PY_ALLOWED_TRY_CALLEE_PREFIXES:
                if callee.startswith(prefix):
                    return True
    return False


def _is_value_context(parent: ast.AST, field_name: str) -> bool:
    if isinstance(parent, ast.Assign) and field_name == "value":
        return True
    if isinstance(parent, ast.AnnAssign) and field_name == "value":
        return True
    if isinstance(parent, ast.Return) and field_name == "value":
        return True
    if isinstance(parent, ast.keyword) and field_name == "value":
        return True
    if isinstance(parent, ast.Call):
        if field_name == "args":
            return True
        if field_name == "keywords":
            return True
    return False


def _node_string_list(node: ast.AST) -> list[str] | None:
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None

    values: list[str] = []
    for elt in node.elts:
        if not isinstance(elt, ast.Constant) or not isinstance(elt.value, str):
            return None
        values.append(elt.value)
    return values


def _scope_prefixes(tree: ast.Module) -> dict[str, str]:
    prefixes: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if not isinstance(node.value, ast.Call):
            continue

        callee_name = _dotted_name(node.value.func)
        if callee_name is None:
            continue

        if callee_name.endswith("FastAPI"):
            prefixes[target.id] = ""
            continue

        if not callee_name.endswith("APIRouter"):
            continue

        prefix = ""
        for keyword in node.value.keywords:
            if keyword.arg != "prefix":
                continue
            value = keyword.value
            if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
                raise RuntimeError(
                    f"APIRouter prefix must be a string literal: router={target.id} line={node.lineno}",
                )
            prefix = value.value
            break
        prefixes[target.id] = prefix
    return prefixes


def _transactional_decorator(node: ast.AST) -> bool:
    name = _dotted_name(node)
    if name == "transactional_route":
        return True
    return isinstance(name, str) and name.endswith(".transactional_route")


def _route_decorator(node: ast.AST, prefixes: dict[str, str]) -> _RouteDecorator | None:
    if not isinstance(node, ast.Call):
        return None
    if not isinstance(node.func, ast.Attribute):
        return None

    attr_name = node.func.attr
    methods: tuple[str, ...] = ()
    if attr_name in _ROUTE_DECORATOR_METHODS:
        methods = (attr_name.upper(),)
    elif attr_name == "api_route":
        methods_node = None
        for keyword in node.keywords:
            if keyword.arg == "methods":
                methods_node = keyword.value
                break
        if methods_node is None:
            return None
        method_names = _node_string_list(methods_node)
        if method_names is None:
            return _RouteDecorator(
                methods=("DYNAMIC",),
                full_path="<dynamic>",
                lineno=getattr(node, "lineno", 1),
                col=getattr(node, "col_offset", 0),
            )
        mutation_methods = sorted(
            method_name
            for method_name in method_names
            if method_name in _MUTATION_METHODS
        )
        if len(mutation_methods) == 0:
            return None
        methods = tuple(mutation_methods)
    else:
        return None

    owner_name = _dotted_name(node.func.value)
    if owner_name is None:
        return None
    prefix = ""
    if owner_name in prefixes:
        prefix = prefixes[owner_name]

    path = "<dynamic>"
    if len(node.args) >= 1:
        first_arg = node.args[0]
        if isinstance(first_arg, ast.Constant) and isinstance(first_arg.value, str):
            path = first_arg.value

    return _RouteDecorator(
        methods=methods,
        full_path=f"{prefix}{path}",
        lineno=getattr(node, "lineno", 1),
        col=getattr(node, "col_offset", 0),
    )


class _StartupSanityChecker(ast.NodeVisitor):
    def __init__(
        self,
        *,
        project_root: Path,
        path: Path,
        source_text: str,
        tree: ast.Module,
    ) -> None:
        self._project_root = project_root
        self._path = path
        self._source_text = source_text
        self._lines = source_text.splitlines()
        self._violations: list[StartupSanityViolation] = []
        self._dict_like_names: set[str] = set()
        self._parent_stack: list[tuple[ast.AST, str]] = []
        self._prefixes = _scope_prefixes(tree)
        self._relative_path = _path_rel(project_root, path)
        self._exception_aliases: dict[str, str] = {}
        for statement in ast.walk(tree):
            if isinstance(statement, ast.ImportFrom) and statement.module in {"contextlib", "app.services.exception_capture"}:
                for name in statement.names:
                    local_name = name.name
                    if name.asname is not None:
                        local_name = name.asname
                    self._exception_aliases[local_name] = f"{statement.module}.{name.name}"
            if isinstance(statement, ast.Import):
                for name in statement.names:
                    if name.asname is not None:
                        self._exception_aliases[name.asname] = name.name

    def violations(self) -> list[StartupSanityViolation]:
        return list(self._violations)

    def _index_dict_like_names(self, tree: ast.AST) -> None:
        dict_like: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
                dict_like.add(node.value.id)

            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                annotation = _dotted_name(node.annotation)
                if annotation is not None and (annotation == "dict" or annotation.endswith(".dict")):
                    dict_like.add(node.target.id)

            if not isinstance(node, ast.Assign):
                continue

            if isinstance(node.value, ast.Dict):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        dict_like.add(target.id)

            if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
                if node.value.func.id == "dict":
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            dict_like.add(target.id)

        self._dict_like_names = dict_like

    def _add(self, *, node: ast.AST, rule_id: str, message: str) -> None:
        lineno = getattr(node, "lineno", 1)
        col = getattr(node, "col_offset", 0)
        if rule_id != "BKP001" and _suppressed(self._lines, lineno, rule_id):
            return
        frame = _codeframe(self._lines, lineno, col, 2)
        self._violations.append(
            StartupSanityViolation(
                rule_id=rule_id,
                message=message,
                path=self._relative_path,
                lineno=lineno,
                col=col,
                codeframe=frame,
            ),
        )

    def generic_visit(self, node: ast.AST) -> None:
        for field_name, value in ast.iter_fields(node):
            if isinstance(value, list):
                for item in value:
                    if not isinstance(item, ast.AST):
                        continue
                    self._parent_stack.append((node, field_name))
                    self.visit(item)
                    self._parent_stack.pop()
            elif isinstance(value, ast.AST):
                self._parent_stack.append((node, field_name))
                self.visit(value)
                self._parent_stack.pop()

    def visit_Try(self, node: ast.Try) -> None:
        if len(node.handlers) == 0:
            if len(node.finalbody) != 0:
                self.generic_visit(node)
                return

            self._add(node=node, rule_id="PY001", message="try without except/finally is forbidden")
            self.generic_visit(node)
            return

        if not _try_has_allowlisted_call(node):
            self._add(node=node, rule_id="PY001", message="try body has no allowlisted external call")

        for handler in node.handlers:
            if handler.type is None:
                self._add(node=handler, rule_id="PY001", message="bare except is forbidden")
                continue

            names = _iter_exception_names(handler.type)
            if names is None:
                self._add(node=handler, rule_id="PY001", message="except type must be a simple name")
                continue

            for exc_name in names:
                if exc_name == "Exception" or exc_name == "BaseException":
                    self._add(node=handler, rule_id="PY001", message=f"forbidden exception type: {exc_name}")
                    continue
                if exc_name not in PY_ALLOWED_EXCEPTION_NAMES:
                    self._add(
                        node=handler,
                        rule_id="PY001",
                        message=f"exception type not allowlisted: {exc_name}",
                    )

            if _contains_return(handler):
                self._add(node=handler, rule_id="PY001", message="except handler must not return")
            if not _contains_raise(handler):
                self._add(node=handler, rule_id="PY001", message="except handler must raise")

        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node.name in {"__exit__", "__aexit__"} and self._relative_path != "app/services/exception_capture.py":
            for statement in ast.walk(node):
                if isinstance(statement, ast.Return) and statement.value is not None:
                    if not isinstance(statement.value, ast.Constant) or statement.value.value not in (None, False):
                        self._add(node=statement, rule_id="PY001", message="custom context manager may not suppress exceptions")
        self._check_backup_function_name(node)
        self._check_defaults(node)
        self._check_route_transaction_decorators(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._check_backup_function_name(node)
        self._check_defaults(node)
        self._check_route_transaction_decorators(node)
        self.generic_visit(node)

    def _check_backup_function_name(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
    ) -> None:
        if not self._relative_path.startswith("app/"):
            return
        lowered_name = node.name.casefold()
        if "backup" not in lowered_name:
            return
        if any(term in lowered_name for term in _FORBIDDEN_BACKUP_FUNCTION_TERMS):
            self._add(
                node=node,
                rule_id="BKP001",
                message="historical backup transformation functions are forbidden",
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if (
            self._relative_path in {_DATABASE_MIGRATIONS_PATH, _MAIN_PATH}
            and node.module == _BACKUP_SERVICE_MODULE
        ):
            self._add(
                node=node,
                rule_id="BKP001",
                message="startup and database migrations must not import the backup service",
            )
        if self._relative_path == _AUTH_SERVICE_PATH and node.module == _BACKUP_SERVICE_MODULE:
            for alias in node.names:
                if alias.name != "create_timestamped_backup":
                    self._add(
                        node=node,
                        rule_id="BKP001",
                        message="authenticated migration may only create a new backup",
                    )
        self.generic_visit(node)

    def _check_defaults(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        args = node.args
        positional = list(args.posonlyargs) + list(args.args)
        defaults = list(args.defaults)

        def rule_for_default(expr: ast.AST) -> str:
            if isinstance(expr, ast.Constant) and expr.value is None:
                return "PY002"
            return "PY005"

        if len(defaults) != 0:
            offset = len(positional) - len(defaults)
            assert offset >= 0
            idx = 0
            while idx < len(defaults):
                default_expr = defaults[idx]
                if 0 <= offset + idx < len(positional):
                    arg = positional[offset + idx]
                    self._add(
                        node=default_expr,
                        rule_id=rule_for_default(default_expr),
                        message=f"default for parameter '{arg.arg}' is forbidden",
                    )
                else:
                    self._add(
                        node=default_expr,
                        rule_id=rule_for_default(default_expr),
                        message="default parameters are forbidden",
                    )
                idx += 1

        if len(args.kwonlyargs) == 0:
            return

        assert len(args.kwonlyargs) == len(args.kw_defaults)
        kw_index = 0
        while kw_index < len(args.kwonlyargs):
            kw_default = args.kw_defaults[kw_index]
            if kw_default is not None:
                self._add(
                    node=kw_default,
                    rule_id=rule_for_default(kw_default),
                    message=f"default for parameter '{args.kwonlyargs[kw_index].arg}' is forbidden",
                )
            kw_index += 1

    def _check_route_transaction_decorators(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
    ) -> None:
        decorators = list(node.decorator_list)
        for index, decorator in enumerate(decorators):
            route = _route_decorator(decorator, self._prefixes)
            if route is None:
                continue

            if "DYNAMIC" in route.methods:
                self._add(
                    node=decorator,
                    rule_id="TXN003",
                    message=f"api_route methods for {node.name} must be a literal list of strings",
                )
                continue

            if index + 1 < len(decorators) and _transactional_decorator(decorators[index + 1]):
                continue

            any_transactional = any(_transactional_decorator(candidate) for candidate in decorators)
            methods_text = ",".join(route.methods)
            if any_transactional:
                self._add(
                    node=decorator,
                    rule_id="TXN002",
                    message=(
                        f"{methods_text} {route.full_path} ({node.name}) must place "
                        "@transactional_route directly below the route decorator"
                    ),
                )
            else:
                self._add(
                    node=decorator,
                    rule_id="TXN001",
                    message=f"{methods_text} {route.full_path} ({node.name}) missing @transactional_route",
                )

    def visit_Call(self, node: ast.Call) -> None:
        callee = _dotted_name(node.func)
        if isinstance(callee, str):
            root_name, separator, suffix = callee.partition(".")
            if root_name in self._exception_aliases:
                callee = self._exception_aliases[root_name] + separator + suffix
        if callee in {"CapturedExceptionContext", "app.services.exception_capture.CapturedExceptionContext"}:
            boundary = None
            for keyword in node.keywords:
                if keyword.arg == "boundary" and isinstance(keyword.value, ast.Constant):
                    boundary = keyword.value.value
            expected_owner = f"{_path_rel(self._project_root, self._path)}:{self._enclosing_function_name()}:"
            if not isinstance(boundary, str) or boundary not in CAPTURE_BOUNDARIES or not boundary.startswith(expected_owner):
                self._add(node=node, rule_id="PY001", message="unregistered exception capture boundary")
            elif not any(isinstance(arg, ast.Starred) for arg in node.args):
                names = tuple(ast.unparse(arg).split('.')[-1] for arg in node.args)
                if names != CAPTURE_BOUNDARIES[boundary]:
                    self._add(node=node, rule_id="PY001", message="exception capture types differ from selected boundary")
        if callee in {"suppress", "contextlib.suppress"}:
            names = tuple(ast.unparse(arg) for arg in node.args)
            if names not in {("asyncio.CancelledError",), ("ProcessLookupError",)}:
                self._add(node=node, rule_id="PY001", message="exception suppression is not allowlisted")
        self._check_backup_immutability(node)
        self._check_default_value_apis(node)
        self.generic_visit(node)

    def _enclosing_function_name(self) -> str | None:
        for parent, _field_name in reversed(self._parent_stack):
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return parent.name
        return None

    def _check_backup_immutability(self, node: ast.Call) -> None:
        callee = _dotted_name(node.func)
        if (
            self._relative_path == _AUTH_ROUTES_PATH
            and self._enclosing_function_name() == "login"
            and isinstance(callee, str)
            and "backup" in callee.casefold()
        ):
            self._add(
                node=node,
                rule_id="BKP001",
                message="login must not enumerate or mutate backup files",
            )
            return
        if self._relative_path.startswith("app/") and self._relative_path != _BACKUP_SERVICE_PATH:
            call_text = ast.unparse(node).casefold()
            if callee in _FORBIDDEN_BACKUP_MUTATION_CALLEES and "backup" in call_text:
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message=f"existing backup mutation via {callee} is forbidden",
                )
                return
            if isinstance(node.func, ast.Attribute):
                receiver = _dotted_name(node.func.value)
                receiver_mentions_backup = (
                    isinstance(receiver, str) and "backup" in receiver.casefold()
                )
                if receiver_mentions_backup and (
                    node.func.attr in _FORBIDDEN_BACKUP_PATH_METHODS
                    or node.func.attr == "unlink"
                ):
                    self._add(
                        node=node,
                        rule_id="BKP001",
                        message="existing backups may only be deleted by the retention workflow",
                    )
                    return
            if callee == "tarfile.open" and "backup" in call_text:
                mode_node = None
                if len(node.args) >= 2:
                    mode_node = node.args[1]
                for keyword in node.keywords:
                    if keyword.arg == "mode":
                        mode_node = keyword.value
                if not isinstance(mode_node, ast.Constant) or not isinstance(mode_node.value, str):
                    self._add(
                        node=node,
                        rule_id="BKP001",
                        message="backup archive mode must be a literal read or exclusive-create mode",
                    )
                    return
                if not mode_node.value.startswith(("r", "x")):
                    self._add(
                        node=node,
                        rule_id="BKP001",
                        message="backup archives may only be read or created exclusively",
                    )
                    return
        if self._relative_path != _BACKUP_SERVICE_PATH:
            return
        if callee in _FORBIDDEN_BACKUP_MUTATION_CALLEES:
            self._add(
                node=node,
                rule_id="BKP001",
                message=f"existing backup mutation via {callee} is forbidden",
            )
            return

        if callee == "tarfile.open":
            mode_node = None
            if len(node.args) >= 2:
                mode_node = node.args[1]
            for keyword in node.keywords:
                if keyword.arg == "mode":
                    mode_node = keyword.value
            if not isinstance(mode_node, ast.Constant) or not isinstance(mode_node.value, str):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup archive mode must be a literal read or exclusive-create mode",
                )
                return
            if not mode_node.value.startswith(("r", "x")):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup archives may only be read or created exclusively",
                )
            return

        if callee in {"open", "bz2.open", "gzip.open", "lzma.open"}:
            if len(node.args) == 0:
                return
            target_text = ast.unparse(node.args[0]).casefold()
            if "backup" not in target_text:
                return
            mode_node = None
            if len(node.args) >= 2:
                mode_node = node.args[1]
            for keyword in node.keywords:
                if keyword.arg == "mode":
                    mode_node = keyword.value
            if mode_node is None:
                return
            if not isinstance(mode_node, ast.Constant) or not isinstance(mode_node.value, str):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup file open mode must be a literal read mode",
                )
                return
            if any(marker in mode_node.value for marker in ("w", "a", "x", "+")):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="existing backup files must not be opened for writing",
                )
            return

        if callee == "sqlite3.connect" and len(node.args) >= 1:
            target_text = ast.unparse(node.args[0]).casefold()
            if "backup" in target_text:
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup databases must not be opened through a writable SQLite connection",
                )
            return

        if not isinstance(node.func, ast.Attribute):
            return
        receiver = _dotted_name(node.func.value)
        receiver_mentions_backup = isinstance(receiver, str) and "backup" in receiver.casefold()
        if receiver_mentions_backup and node.func.attr in _FORBIDDEN_BACKUP_PATH_METHODS:
            self._add(
                node=node,
                rule_id="BKP001",
                message=f"existing backup mutation via .{node.func.attr}(...) is forbidden",
            )
            return
        if receiver_mentions_backup and node.func.attr == "open":
            mode_node = None
            if len(node.args) >= 1:
                mode_node = node.args[0]
            for keyword in node.keywords:
                if keyword.arg == "mode":
                    mode_node = keyword.value
            if mode_node is None:
                return
            if not isinstance(mode_node, ast.Constant) or not isinstance(mode_node.value, str):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup path open mode must be a literal read mode",
                )
                return
            if any(marker in mode_node.value for marker in ("w", "a", "x", "+")):
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="existing backup paths must not be opened for writing",
                )
            return
        if receiver_mentions_backup and node.func.attr == "unlink":
            if self._enclosing_function_name() != _BACKUP_DELETE_FUNCTION:
                self._add(
                    node=node,
                    rule_id="BKP001",
                    message="backup deletion is restricted to the explicit retention/delete workflow",
                )

    def _check_default_value_apis(self, node: ast.Call) -> None:
        callee = _dotted_name(node.func)
        if callee is not None:
            if callee == "os.getenv":
                self._add(node=node, rule_id="PY003", message="os.getenv(...) is forbidden")
                return
            if callee == "os.environ.get":
                self._add(node=node, rule_id="PY003", message="os.environ.get(...) is forbidden")
                return
            if callee == "collections.defaultdict":
                self._add(node=node, rule_id="PY003", message="collections.defaultdict(...) is forbidden")
                return
            if callee == "next" and len(node.args) >= 2:
                self._add(node=node, rule_id="PY003", message="next(it, default) is forbidden")
                return
            if callee == "dataclasses.field" or callee == "field":
                for kw in node.keywords:
                    if kw.arg == "default" or kw.arg == "default_factory":
                        self._add(node=node, rule_id="PY003", message="dataclasses.field(default=...) is forbidden")
                        return
            if callee == "pydantic.Field" or callee == "Field":
                for kw in node.keywords:
                    if kw.arg == "default" or kw.arg == "default_factory":
                        self._add(node=node, rule_id="PY003", message="pydantic.Field(default=...) is forbidden")
                        return

        if not isinstance(node.func, ast.Attribute):
            return

        is_dict_like = False
        if isinstance(node.func.value, ast.Dict):
            is_dict_like = True
        elif isinstance(node.func.value, ast.Name):
            is_dict_like = node.func.value.id in self._dict_like_names

        if not is_dict_like:
            return
        if node.func.attr == "get":
            self._add(node=node, rule_id="PY003", message="dict.get(...) is forbidden")
            return
        if node.func.attr == "setdefault":
            self._add(node=node, rule_id="PY003", message="dict.setdefault(...) is forbidden")
            return
        if node.func.attr == "pop" and len(node.args) >= 2:
            self._add(node=node, rule_id="PY003", message="dict.pop(key, default) is forbidden")

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        if isinstance(node.op, ast.Or) and len(self._parent_stack) != 0:
            parent, field_name = self._parent_stack[-1]
            if _is_value_context(parent, field_name):
                self._add(node=node, rule_id="PY004", message="defaulting via 'or' is forbidden")
        self.generic_visit(node)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        if len(self._parent_stack) != 0:
            parent, field_name = self._parent_stack[-1]
            if _is_value_context(parent, field_name):
                self._add(node=node, rule_id="PY004", message="defaulting via conditional expression is forbidden")
        self.generic_visit(node)


def discover_python_source_paths(project_root: Path) -> list[Path]:
    if not isinstance(project_root, Path):
        raise TypeError(f"project_root must be a Path, got {type(project_root)}")

    is_installed_distribution = is_installed_distribution_root(project_root)
    paths: list[Path] = []
    for current_root, directory_names, file_names in os.walk(project_root):
        current_root_path = Path(current_root)
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
            if directory_name.startswith("."):
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
            if not file_name.endswith(".py"):
                continue
            path = current_root_path / file_name
            paths.append(path)

    paths.sort()
    return paths


def collect_startup_sanity_violations(project_root: Path) -> tuple[list[Path], list[StartupSanityViolation]]:
    paths = discover_python_source_paths(project_root)
    violations: list[StartupSanityViolation] = []

    for path in paths:
        source_text = path.read_text(encoding="utf-8")
        tree = ast.parse(source_text, filename=str(path))
        checker = _StartupSanityChecker(
            project_root=project_root,
            path=path,
            source_text=source_text,
            tree=tree,
        )
        checker._index_dict_like_names(tree)
        checker.visit(tree)
        violations.extend(checker.violations())

    return paths, violations


def _render_report(violations: list[StartupSanityViolation]) -> str:
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


def assert_startup_sanity(project_root: Path) -> None:
    print("[startup] Running Python sanity checks (AST + transaction routes)...", flush=True)
    paths, violations = collect_startup_sanity_violations(project_root)
    if len(violations) == 0:
        print(f"[startup] Python sanity checks passed ({len(paths)} Python files)", flush=True)
        return

    shown = violations[:_MAX_VIOLATIONS]
    report = _render_report(shown)
    print("[startup] Python sanity checks failed", flush=True)
    if len(violations) > _MAX_VIOLATIONS:
        remaining = len(violations) - _MAX_VIOLATIONS
        report += f"(truncated) Remaining: {remaining}\n"
    raise RuntimeError(report)
