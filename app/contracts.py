"""ShockHarness property contracts: the Python runtime (one file, no dependencies).

Copy it into a project with ``shockharness contracts install --language python --dest
<path>`` and list that path under ``rules.property_contracts.runtime_module``; the project
then owns the file, and ``shockharness contracts install --check`` reports an edited or
stale copy. Python 3.10 or later.

Declarations, each returning its first argument unchanged::

    requires(value, property, ...)
    produces(value, property, ...)
    preserves(result, source)
    preserves_except(result, source, property, ...)

The static analysis reads them from the source. At run time the module is identity-only
until test code calls ``enable("check", static_properties)`` (or ``"verify"``) once,
before any declaration has run (a ``conftest.py``, or a test-only entry script that then
starts the server exactly as the production entry does). Production never calls
``enable``.

In ``check`` mode ``produces`` records the properties on the value, ``preserves`` copies
the source's recorded properties to the result, and ``requires`` raises
:class:`ContractError` when a property is not recorded on the value. A property listed in
``static_properties`` (the catalog's ``runtime = "static"``: strings, numbers, anything
that cannot carry a runtime property) is never recorded or checked; each skip is counted
and :func:`report` returns the counts. A property not listed there that reaches a
str, bytes, number, bool or None raises in ``check`` mode, because that is a catalog
mistake rather than a program state.

``verify`` mode does what ``check`` does and also runs each property's predicate, which
the project registers once at startup with ``register(name, predicate, description)``:
``produces`` runs it before recording (a producer may not claim what is false),
``requires`` after the presence check. A value that cannot carry runtime properties (a
string) is checked by its predicate alone. A non-static property with no registered
predicate raises in ``verify`` mode.

The registry is keyed by object identity. A value that can be weakly referenced is
forgotten when it is collected; one that cannot (a list, a dict, a tuple) is held for
the life of the process, a memory cost of ``check`` mode that is one reason it is for
tests, never production.
"""

import weakref
from collections.abc import Callable, Iterable
from typing import TypeVar

T = TypeVar("T")

MODE_OFF = "off"
MODE_CHECK = "check"
MODE_VERIFY = "verify"
# Values that cannot carry a runtime property: id() collides and small values are interned.
SCALARS = (str, bytes, int, float, complex, bool, type(None))


class ContractError(AssertionError):
    """A declaration that does not hold at run time, or a misuse of the module."""

    def __init__(self, message: str, property_name: str | None) -> None:
        super().__init__(message)
        self.message = message
        self.property = property_name
        self.function = None  # not determined: a stack walk on every check is not cheap


class _Entry:
    """The recorded properties of one value; ``holder`` is a weak reference to the value
    or, for a value that cannot be weakly referenced, the value itself."""

    def __init__(self, holder: object, properties: frozenset[str], weak: bool) -> None:
        self.holder = holder
        self.properties = properties
        self.weak = weak

    def holds(self, value: object) -> bool:
        if self.weak:
            assert isinstance(self.holder, weakref.ref), "a weak entry holds a reference"
            return self.holder() is value
        return self.holder is value


class _Forget:
    """Weak-reference callback: drop the entry of a value that was collected."""

    def __init__(self, registry: "_Registry", key: int) -> None:
        self.registry = registry
        self.key = key

    def __call__(self, reference: object) -> None:
        entries = self.registry.entries
        if self.key in entries and entries[self.key].holder is reference:
            del entries[self.key]


class _Registry:
    """The process's contract state, owned by this module: a test run's single registry."""

    def __init__(self) -> None:
        self.mode = MODE_OFF
        self.declarations = 0
        self.static: frozenset[str] = frozenset()
        self.skips: dict[str, int] = {}
        self.entries: dict[int, _Entry] = {}
        self.predicates: dict[str, tuple[Callable[[object], bool], str]] = {}

    def recorded(self, value: object) -> frozenset[str]:
        key = id(value)
        found: frozenset[str] = frozenset()
        if key in self.entries and self.entries[key].holds(value):
            found = self.entries[key].properties
        return found

    def record(self, value: object, properties: frozenset[str]) -> None:
        if isinstance(value, SCALARS) or len(properties) == 0:
            return  # verify mode: a scalar is checked by its predicates, never recorded
        key = id(value)
        if type(value).__weakrefoffset__ == 0:
            self.entries[key] = _Entry(value, properties, weak=False)
            return
        reference = weakref.ref(value, _Forget(self, key))
        self.entries[key] = _Entry(reference, properties, weak=True)

    def tracked(self, properties: Iterable[str], value: object) -> frozenset[str]:
        """The properties checked at run time; counts every static one it skips."""
        checked: set[str] = set()
        for name in properties:
            if name in self.static:
                if name not in self.skips:
                    self.skips[name] = 0
                self.skips[name] += 1
                continue
            if isinstance(value, SCALARS) and self.mode == MODE_CHECK:
                raise ContractError(
                    f"{name!r} is a check-level property but {type(value).__name__} values "
                    'cannot carry runtime properties; mark it runtime = "static" or "verify"',
                    name,
                )
            checked.add(name)
        return frozenset(checked)

    def verified(self, properties: Iterable[str], value: object) -> None:
        """In verify mode, each property's predicate must hold for the value."""
        if self.mode != MODE_VERIFY:
            return
        for name in sorted(properties):
            if name not in self.predicates:
                raise ContractError(f"no predicate registered for {name!r}", name)
            predicate, description = self.predicates[name]
            if not predicate(value):
                raise ContractError(f"{name!r} does not hold for this value: {description}", name)


_REGISTRY = _Registry()


def enable(mode: str, static_properties: list[str]) -> None:
    """Turn checking on, once, from test code, before any declaration has run.

    ``static_properties``: the list of properties the catalog marks ``runtime =
    "static"`` (``[]`` when there are none); they are counted, never recorded or checked.
    ``shockharness contracts static-properties`` prints it, and the analyzer reports a
    literal list that disagrees with the catalog (PROP005).
    """
    if not isinstance(static_properties, list) or not all(
        isinstance(name, str) for name in static_properties
    ):
        raise ContractError(
            "enable takes the catalog's static properties as a list of strings, not "
            f"{type(static_properties).__name__}",
            None,
        )
    if mode not in (MODE_CHECK, MODE_VERIFY):
        raise ContractError(f"enable takes {MODE_CHECK!r} or {MODE_VERIFY!r}, not {mode!r}", None)
    if _REGISTRY.mode != MODE_OFF:
        raise ContractError("enable was already called; it is called once per process", None)
    if _REGISTRY.declarations > 0:
        raise ContractError(
            f"enable was called after {_REGISTRY.declarations} declaration(s) had run; call "
            "it before the application's modules are imported",
            None,
        )
    _REGISTRY.static = frozenset(static_properties)
    _REGISTRY.mode = mode


def register(name: str, predicate: Callable[[object], bool], description: str) -> None:
    """The predicate ``verify`` mode runs for a property; registered once, at startup. The
    predicate must be pure and must not change the value."""
    if not isinstance(name, str) or not isinstance(description, str) or not callable(predicate):
        raise ContractError("register takes a name, a predicate and a description", None)
    if name in _REGISTRY.predicates:
        raise ContractError(f"a predicate for {name!r} is already registered", name)
    _REGISTRY.predicates[name] = (predicate, description)


def report() -> dict[str, object]:
    """The mode ("off" until enabled), the declarations seen and the static skips."""
    return {
        "mode": _REGISTRY.mode,
        "declarations": _REGISTRY.declarations,
        "static_skips": dict(sorted(_REGISTRY.skips.items())),
    }


def _checking() -> bool:
    _REGISTRY.declarations += 1
    return _REGISTRY.mode != MODE_OFF


def requires(value: T, *properties: str) -> T:
    """``value`` must carry every property; returns ``value``."""
    if not _checking():
        return value
    required = _REGISTRY.tracked(properties, value)
    missing: list[str] = []
    if not isinstance(value, SCALARS):
        missing = sorted(required - _REGISTRY.recorded(value))
    if len(missing) > 0:
        raise ContractError(
            f"the value does not carry {', '.join(map(repr, missing))} "
            f"(a {type(value).__name__} with {sorted(_REGISTRY.recorded(value))})",
            missing[0],
        )
    _REGISTRY.verified(required, value)
    return value


def produces(value: T, *properties: str) -> T:
    """``value`` now carries the properties; returns ``value``."""
    if not _checking():
        return value
    added = _REGISTRY.tracked(properties, value)
    _REGISTRY.verified(added, value)
    _REGISTRY.record(value, _REGISTRY.recorded(value) | added)
    return value


def preserves(result: T, source: object) -> T:
    """``result`` carries what ``source`` carries; returns ``result``."""
    if not _checking():
        return result
    _carry(result, _REGISTRY.recorded(source))
    return result


def preserves_except(result: T, source: object, *properties: str) -> T:
    """``result`` carries what ``source`` carries, less ``properties``; returns ``result``."""
    if not _checking():
        return result
    _carry(result, _REGISTRY.recorded(source) - frozenset(properties))
    return result


def _carry(result: object, properties: frozenset[str]) -> None:
    if len(properties) == 0:
        return
    carried = _REGISTRY.tracked(properties, result)
    _REGISTRY.record(result, _REGISTRY.recorded(result) | carried)
