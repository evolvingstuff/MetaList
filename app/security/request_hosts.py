"""Host validation shared by early launch settings and HTTP request checks."""
from __future__ import annotations

from collections.abc import Mapping
import ipaddress
import re

from app.services.exception_capture import CapturedExceptionContext


_LOOPBACK_REQUEST_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
_WILDCARD_BIND_HOSTS = frozenset({"0.0.0.0", "::"})
_DNS_HOSTNAME_PATTERN = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"
)


def _normalize_hostname(*, hostname: str, context: str) -> str:
    normalized = hostname.strip().casefold().rstrip(".")
    if normalized == "":
        raise ValueError(f"{context} hostname must not be empty")

    ip_capture = CapturedExceptionContext(ValueError, boundary='app/security/request_hosts.py:_normalize_hostname:ip_capture')
    parsed_ip: ipaddress._BaseAddress | None = None
    with ip_capture:
        parsed_ip = ipaddress.ip_address(normalized)
    if ip_capture.captured_exception is None:
        if parsed_ip is None:
            raise RuntimeError("IP parser returned no address")
        return parsed_ip.compressed.casefold()

    if _DNS_HOSTNAME_PATTERN.fullmatch(normalized) is None:
        raise ValueError(f"{context} contains an invalid hostname: {hostname!r}")
    return normalized


def _normalize_configured_hostname(*, raw_value: str) -> str:
    value = raw_value.strip()
    if value == "":
        raise RuntimeError("METALIST_ALLOWED_HOSTS contains an empty entry")
    if value == "*":
        raise RuntimeError("METALIST_ALLOWED_HOSTS must not contain '*'")
    if "://" in value or "/" in value or "@" in value:
        raise RuntimeError(
            "METALIST_ALLOWED_HOSTS entries must be hostnames without schemes, ports, or paths"
        )

    unbracketed_value = value
    if value.startswith("[") and value.endswith("]"):
        unbracketed_value = value[1:-1]
    normalize_capture = CapturedExceptionContext(ValueError, boundary='app/security/request_hosts.py:_normalize_configured_hostname:normalize_capture')
    normalized_hostname: str | None = None
    with normalize_capture:
        normalized_hostname = _normalize_hostname(
            hostname=unbracketed_value,
            context="METALIST_ALLOWED_HOSTS",
        )
    if normalize_capture.captured_exception is not None:
        exc = normalize_capture.captured_exception
        raise RuntimeError(str(exc)) from exc
    if normalized_hostname is None:
        raise RuntimeError("METALIST_ALLOWED_HOSTS parser returned no hostname")
    return normalized_hostname


def resolve_allowed_request_hosts(*, environ: Mapping[str, str]) -> frozenset[str]:
    allowed_hosts = set(_LOOPBACK_REQUEST_HOSTS)
    bind_host = environ.get("METALIST_HOST", "127.0.0.1").strip()
    if bind_host == "":
        raise RuntimeError("METALIST_HOST must not be empty")
    normalized_bind_host = _normalize_configured_hostname(raw_value=bind_host)
    if normalized_bind_host not in _WILDCARD_BIND_HOSTS:
        allowed_hosts.add(normalized_bind_host)

    configured_hosts = environ.get("METALIST_ALLOWED_HOSTS")
    if configured_hosts is not None:
        if configured_hosts.strip() == "":
            raise RuntimeError("METALIST_ALLOWED_HOSTS must not be empty when set")
        for raw_host in configured_hosts.split(","):
            allowed_hosts.add(_normalize_configured_hostname(raw_value=raw_host))
    return frozenset(allowed_hosts)


