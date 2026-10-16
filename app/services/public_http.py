"""Shared public HTTP URL validation and DNS-pinned synchronous transport."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import socket
from typing import Iterable
from urllib.parse import SplitResult, urlsplit, urlunsplit

import httpcore
import httpx

from app.services.exception_capture import CapturedExceptionContext


class PublicHttpTargetRejected(Exception):
    def __init__(self, reason: str) -> None:
        if reason not in {
            "blocked_private_address", "dns_error", "missing_hostname",
            "unsupported_scheme",
        }:
            raise ValueError(f"Unsupported public HTTP target rejection reason: {reason}")
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class ResolvedPublicHttpTarget:
    hostname: str
    port: int
    public_addresses: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.hostname == "":
            raise ValueError("Resolved public HTTP target hostname must not be empty")
        if not 0 < self.port < 65536:
            raise ValueError(f"Resolved public HTTP target port is invalid: {self.port}")
        if len(self.public_addresses) == 0:
            raise ValueError("Resolved public HTTP target requires an address")
        for address in self.public_addresses:
            if not ipaddress.ip_address(address).is_global:
                raise ValueError(f"Resolved public HTTP target address is not public: {address}")


class _PinnedNetworkBackend(httpcore.NetworkBackend):
    def __init__(self, *, target: ResolvedPublicHttpTarget,
                 network_backend: httpcore.NetworkBackend) -> None:
        self._target = target
        self._network_backend = network_backend

    def connect_tcp(self, host: str, port: int, timeout: float | None,
                    local_address: str | None,
                    socket_options: Iterable[tuple[int, int, int | bytes]] | None,
                    ) -> httpcore.NetworkStream:
        if host != self._target.hostname or port != self._target.port:
            raise RuntimeError("Pinned link-title transport received an unexpected host or port")
        for address in self._target.public_addresses[:-1]:
            connect_capture = CapturedExceptionContext(
                httpcore.ConnectError, httpcore.ConnectTimeout,
                boundary='app/services/public_http.py:connect_tcp:connect_capture')
            with connect_capture:
                return self._network_backend.connect_tcp(
                    host=address, port=port, timeout=timeout,
                    local_address=local_address, socket_options=socket_options)
        return self._network_backend.connect_tcp(
            host=self._target.public_addresses[-1], port=port, timeout=timeout,
            local_address=local_address, socket_options=socket_options)

    def connect_unix_socket(self, path: str, timeout: float | None,
                            socket_options: Iterable[tuple[int, int, int | bytes]] | None,
                            ) -> httpcore.NetworkStream:
        raise RuntimeError("Public HTTP transport does not support Unix sockets")

    def sleep(self, seconds: float) -> None:
        self._network_backend.sleep(seconds)


class _PinnedResponseStream(httpx.SyncByteStream):
    def __init__(self, stream: Iterable[bytes]) -> None:
        self._stream = stream

    def __iter__(self):
        yield from self._stream

    def close(self) -> None:
        self._stream.close()


class PinnedPublicHTTPTransport(httpx.BaseTransport):
    def __init__(self, *, target: ResolvedPublicHttpTarget,
                 network_backend: httpcore.NetworkBackend) -> None:
        pinned_backend = _PinnedNetworkBackend(
            target=target, network_backend=network_backend)
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=True),
            max_connections=1, max_keepalive_connections=0, retries=0,
            network_backend=pinned_backend)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if not isinstance(request.stream, httpx.SyncByteStream):
            raise TypeError("Pinned public HTTP transport requires a synchronous stream")
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(scheme=request.url.raw_scheme,
                             host=request.url.raw_host, port=request.url.port,
                             target=request.url.raw_path),
            headers=request.headers.raw, content=request.stream,
            extensions=request.extensions)
        core_response = self._pool.handle_request(core_request)
        if not isinstance(core_response.stream, Iterable):
            raise TypeError("Pinned public HTTP transport received a non-iterable stream")
        return httpx.Response(
            status_code=core_response.status, headers=core_response.headers,
            stream=_PinnedResponseStream(core_response.stream),
            extensions=core_response.extensions)

    def close(self) -> None:
        self._pool.close()


# The URL split, with its port read (ValueError when the port is not a number in range).
def _split_with_port(url: str) -> tuple[SplitResult, int | None]:
    parsed = urlsplit(url)
    return parsed, parsed.port


def normalize_public_http_url(url: str) -> str | None:
    if not isinstance(url, str):
        raise TypeError("url must be a string")
    stripped = url.strip()
    if stripped == "":
        return None
    parse_capture = CapturedExceptionContext(
        ValueError,
        boundary='app/services/public_http.py:normalize_public_http_url:parse_capture',
    )
    split: tuple[SplitResult, int | None] | None = None
    with parse_capture:
        split = _split_with_port(stripped)
    if parse_capture.captured_exception is not None:
        return None
    if split is None:
        raise RuntimeError("Public HTTP URL parsing returned no result")
    parsed, port = split
    hostname = parsed.hostname
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"}:
        return None
    if hostname is None or hostname == "":
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    hostname = hostname.casefold()
    netloc = hostname
    if ":" in hostname:
        netloc = f"[{hostname}]"
    if port is not None:
        default_port = 443
        if scheme == "http":
            default_port = 80
        if port != default_port:
            netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))


def resolve_public_http_target(url: str) -> ResolvedPublicHttpTarget:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise PublicHttpTargetRejected("unsupported_scheme")
    hostname = parsed.hostname
    if hostname is None or hostname == "":
        raise PublicHttpTargetRejected("missing_hostname")
    request_hostname = httpx.URL(url).raw_host.decode("ascii")
    port = parsed.port
    if port is None:
        port = 80
        if parsed.scheme == "https":
            port = 443
    resolve_capture = CapturedExceptionContext(
        socket.gaierror,
        boundary='app/services/public_http.py:resolve_public_http_target:resolve_capture')
    infos = []
    with resolve_capture:
        infos = socket.getaddrinfo(
            request_hostname, port, type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP)
    if resolve_capture.captured_exception is not None:
        raise PublicHttpTargetRejected("dns_error") from resolve_capture.captured_exception
    if not infos:
        raise PublicHttpTargetRejected("dns_error")
    public_addresses: list[str] = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise PublicHttpTargetRejected("blocked_private_address")
        normalized_address = str(ip)
        if normalized_address not in public_addresses:
            public_addresses.append(normalized_address)
    return ResolvedPublicHttpTarget(
        hostname=request_hostname, port=port,
        public_addresses=tuple(public_addresses))
