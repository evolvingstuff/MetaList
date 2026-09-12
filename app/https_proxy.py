"""Bounded HTTP transport for the namespace HTTPS listener."""

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore
import time
from app.upload_limits import MAX_UPLOAD_REQUEST_BYTES

CHUNK_BYTES = 64 * 1024
MAX_CONNECTIONS = 32
IDLE_TIMEOUT_SECONDS = 60
MAX_REQUEST_SECONDS = 30 * 60
HOP_HEADERS = frozenset({'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                         'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade'})


class BoundedProxyServer(ThreadingHTTPServer):
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

        def _proxy(self):
            # One request per connection gives deterministic framing and bounds idle clients.
            self.close_connection = True
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
            connection = http.client.HTTPConnection(backend_host, backend_port, timeout=IDLE_TIMEOUT_SECONDS)
            deadline = time.monotonic() + MAX_REQUEST_SECONDS
            response_started = False
            # lint: allow-PY001 rationale="close upstream on client disconnect or expected transport failure without disclosing exception details"
            try:
                connection.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
                for key, value in headers.items():
                    connection.putheader(key, value)
                connection.endheaders()
                while remaining:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Proxy request deadline exceeded')
                    chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
                    if not chunk:
                        raise ConnectionError('Incomplete request body')
                    connection.send(chunk)
                    remaining -= len(chunk)
                response = connection.getresponse()
                self.send_response(response.status, response.reason)
                response_tokens = {part.strip().casefold() for value in response.headers.get_all('Connection', []) for part in value.split(',')}
                for key, value in response.getheaders():
                    if key.casefold() not in HOP_HEADERS | response_tokens | {'content-length'}:
                        self.send_header(key, value)
                has_body = self.command != 'HEAD' and response.status not in {204, 304} and response.status >= 200
                if has_body:
                    self.send_header('Transfer-Encoding', 'chunked')
                elif response.getheader('Content-Length') is not None and self.command == 'HEAD':
                    self.send_header('Content-Length', response.getheader('Content-Length'))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.flush()
                response_started = True
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
            # lint: allow-PY001 rationale="terminate a disconnected or failed external HTTP transport; emit only a sanitized upstream error"
            except (OSError, http.client.HTTPException):
                if not response_started:
                    self.send_error(502, 'Upstream transport failed')
            finally:
                connection.close()

        do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _proxy

        def log_message(self, format, *args):
            return

    return ProxyHandler
