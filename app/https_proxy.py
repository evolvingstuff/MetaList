"""Bounded HTTP transport for the namespace HTTPS listener."""

from http import HTTPStatus
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
from threading import BoundedSemaphore
import time
from app.upload_limits import MAX_UPLOAD_REQUEST_BYTES

CHUNK_BYTES = 64 * 1024
MAX_CONNECTIONS = 32
IDLE_TIMEOUT_SECONDS = 60
MAX_REQUEST_SECONDS = 30 * 60
HOP_HEADERS = frozenset({'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                         'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'})
RETRYABLE_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS'})
LOGGER = logging.getLogger(__name__)


class BoundedProxyServer(ThreadingHTTPServer):
    # Admit a browser's initial connection burst before worker dispatch. The
    # inherited five-entry accept queue can reset the sixth concurrent TLS open.
    request_queue_size = MAX_CONNECTIONS
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self._slots = BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        started = False
        try:
            request.settimeout(IDLE_TIMEOUT_SECONDS)
            super().process_request(request, client_address)
            started = True
        finally:
            if not started:
                self._slots.release()

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def make_proxy_handler(*, backend_host: str, backend_port: int, forward_headers):
    class ProxyHandler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        # Sends the request line, headers and body upstream; the upstream's response.
        def _exchange(self, connection, *, headers, content_length: int, deadline: float):
            connection.putrequest(
                self.command, self.path, skip_host=True, skip_accept_encoding=True,
            )
            for key, value in headers.items():
                connection.putheader(key, value)
            connection.endheaders()
            remaining = content_length
            while remaining:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Proxy request deadline exceeded')
                chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
                if not chunk:
                    raise ConnectionError('Incomplete request body')
                connection.send(chunk)
                remaining -= len(chunk)
            return connection.getresponse()

        def _request_upstream(self, *, headers, content_length: int, deadline: float):
            attempts = 1
            if self.command in RETRYABLE_METHODS and content_length == 0:
                attempts = 2
            for attempt in range(attempts):
                connection = http.client.HTTPConnection(
                    backend_host, backend_port, timeout=IDLE_TIMEOUT_SECONDS,
                )
                # lint: allow-PY001 rationale="retry a bodyless safe request after an expected transient upstream transport failure"
                try:
                    response = self._exchange(
                        connection, headers=headers, content_length=content_length, deadline=deadline,
                    )
                # lint: allow-PY001 rationale="retry once, then re-raise the expected upstream transport failure"
                except (OSError, http.client.HTTPException):
                    connection.close()
                    if attempt + 1 == attempts:
                        raise
                    continue
                return connection, response
            raise AssertionError('Upstream request attempts were not exhausted')

        def _log_response_transport_failure(self, error) -> None:
            LOGGER.error(
                'HTTPS proxy response transport failed method=%s backend=%s:%s error=%s',
                self.command, backend_host, backend_port, type(error).__name__,
            )

        # The status line and headers, flushed; whether a body follows.
        def _send_response_head(self, response) -> bool:
            self.send_response(response.status, response.reason)
            response_tokens = {part.strip().casefold() for value in response.headers.get_all('Connection', []) for part in value.split(',')}
            for key, value in response.getheaders():
                if key.casefold() not in HOP_HEADERS | response_tokens | {'content-length'}:
                    self.send_header(key, value)
            has_body = self.command != 'HEAD' and response.status not in {HTTPStatus.NO_CONTENT, HTTPStatus.NOT_MODIFIED} and response.status >= HTTPStatus.OK
            if has_body:
                self.send_header('Transfer-Encoding', 'chunked')
            elif response.getheader('Content-Length') is not None and self.command == 'HEAD':
                self.send_header('Content-Length', response.getheader('Content-Length'))
            if self.close_connection:
                self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.flush()
            return has_body

        # The body, chunked, within the deadline.
        def _relay_response_body(self, response, *, has_body: bool, deadline: float) -> None:
            if has_body:
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Proxy response deadline exceeded')
                    chunk = response.read1(CHUNK_BYTES)
                    if not chunk:
                        if response.length is not None and response.length != 0:
                            raise http.client.IncompleteRead(b'', response.length)
                        break
                    self.wfile.write(f'{len(chunk):X}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()

        def _proxy(self):
            # Preserve the browser's HTTP/1.1 connection across module requests.
            # Chunked response framing and the socket timeout bound each transfer.
            lengths = self.headers.get_all('Content-Length', [])
            transfers = self.headers.get_all('Transfer-Encoding', [])
            if len(self.headers.get_all('Host', [])) != 1 or len(lengths) > 1 or (lengths and transfers):
                self.send_error(400, 'Ambiguous request framing')
                return
            if transfers:
                self.send_error(501, 'Chunked request bodies are not supported; send Content-Length')
                return
            remaining = 0
            if lengths:
                if not lengths[0].isascii() or not lengths[0].isdigit():
                    self.send_error(400, 'Invalid Content-Length')
                    return
                remaining = int(lengths[0])
            if self.path.split('?', 1)[0].endswith('/files/upload') and remaining > MAX_UPLOAD_REQUEST_BYTES:
                self.send_error(413, 'Upload exceeds the configured size limit')
                return
            if not self.path.startswith('/') or self.path.startswith('//'):
                self.send_error(400, 'Expected an origin-form request target')
                return
            connection_tokens = {part.strip().casefold() for value in self.headers.get_all('Connection', []) for part in value.split(',')}
            if connection_tokens & {'host', 'content-length'}:
                self.send_error(400, 'Invalid Connection header')
                return
            headers = forward_headers(incoming_headers=self.headers.items(), client_ip=self.client_address[0])
            headers = {key: value for key, value in headers.items() if key.casefold() not in connection_tokens | HOP_HEADERS}
            headers['Connection'] = 'close'
            deadline = time.monotonic() + MAX_REQUEST_SECONDS
            # lint: allow-PY001 rationale="translate the final external upstream transport failure into a sanitized gateway response"
            try:
                connection, response = self._request_upstream(
                    headers=headers, content_length=remaining, deadline=deadline,
                )
            # lint: allow-PY001 rationale="return a sanitized gateway error after retrying an expected upstream transport failure"
            except (OSError, http.client.HTTPException) as error:
                self.close_connection = True
                LOGGER.error(
                    'HTTPS proxy upstream transport failed method=%s backend=%s:%s error=%s',
                    self.command, backend_host, backend_port, type(error).__name__,
                )
                self.send_error(502, 'Upstream transport failed')
                return
            # lint: allow-PY001 rationale="a transport failure before the first response byte gets a sanitized gateway error"
            try:
                has_body = self._send_response_head(response)
            # lint: allow-PY001 rationale="return a sanitized gateway error for an expected transport failure before the first response byte"
            except (OSError, http.client.HTTPException) as error:
                # A partial request/response cannot be reused for another request.
                self.close_connection = True
                self._log_response_transport_failure(error)
                self.send_error(502, 'Upstream transport failed')
                connection.close()
                return
            # lint: allow-PY001 rationale="terminate a disconnected or failed external HTTP transport once the response has started"
            try:
                self._relay_response_body(response, has_body=has_body, deadline=deadline)
            # lint: allow-PY001 rationale="terminate a disconnected or failed external HTTP transport; the response has started, so only a sanitized log line is possible"
            except (OSError, http.client.HTTPException) as error:
                self.close_connection = True
                self._log_response_transport_failure(error)
            finally:
                connection.close()

        do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _proxy

        def log_message(self, format, *args):
            return

    return ProxyHandler
