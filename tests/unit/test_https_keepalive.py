"""Browser module graphs reuse HTTPS connections without losing streaming."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import gzip
from http.client import HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import ssl
from threading import Thread

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import pytest

from app.https_proxy import BoundedProxyServer, make_proxy_handler


MODULE_BODY = b'export const moduleLoaded = true;\n' * 100


def _create_test_tls_contexts(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([
            x509.IPAddress(ipaddress.ip_address('127.0.0.1')),
        ]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    return server_context, ssl.create_default_context(cafile=str(cert_path))


class _ModuleBackend(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = gzip.compress(MODULE_BODY)
        self.send_response(200)
        self.send_header('Content-Type', 'text/javascript')
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        return


class _ModuleServer(ThreadingHTTPServer):
    # The mock upstream must admit all six proxy workers. Python's default
    # five-entry queue can reset upstream connects during the module burst;
    # the real Uvicorn backend uses a larger backlog.
    request_queue_size = 32


@pytest.fixture
def tls_proxy(tmp_path):
    server_context, client_context = _create_test_tls_contexts(tmp_path)
    backend = _ModuleServer(('127.0.0.1', 0), _ModuleBackend)
    proxy = BoundedProxyServer(('127.0.0.1', 0), make_proxy_handler(
        backend_host='127.0.0.1', backend_port=backend.server_port,
        forward_headers=lambda incoming_headers, client_ip: dict(incoming_headers),
    ))
    proxy.socket = server_context.wrap_socket(
        proxy.socket, server_side=True, do_handshake_on_connect=False,
    )
    threads = [Thread(target=server.serve_forever, daemon=True) for server in (backend, proxy)]
    for thread in threads:
        thread.start()
    try:
        yield proxy.server_port, client_context
    finally:
        for server in (proxy, backend):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(3)
            assert not thread.is_alive()


def test_parallel_module_graph_reuses_six_tls_connections(tls_proxy):
    port, context = tls_proxy

    def load_modules(worker):
        client = HTTPSConnection('127.0.0.1', port, context=context, timeout=3)
        try:
            client.connect()
            original_socket = client.sock
            assert original_socket is not None
            for index in range(24):
                client.request('GET', f'/static/module-{worker}-{index}.js')
                response = client.getresponse()
                assert response.status == 200
                assert gzip.decompress(response.read()) == MODULE_BODY
                assert not response.will_close, 'Each module must not force a new TLS connection'
                assert client.sock is original_socket
        finally:
            client.close()

    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(load_modules, range(6)))


def test_explicit_client_close_remains_supported(tls_proxy):
    port, context = tls_proxy
    client = HTTPSConnection('127.0.0.1', port, context=context, timeout=3)
    try:
        client.request('GET', '/static/module.js', headers={'Connection': 'close'})
        response = client.getresponse()
        assert response.status == 200
        assert response.will_close
        assert gzip.decompress(response.read()) == MODULE_BODY
    finally:
        client.close()
