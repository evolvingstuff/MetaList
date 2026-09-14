import asyncio
from email.message import Message
from types import SimpleNamespace
from threading import BoundedSemaphore
import sqlite3
from app.db.file_schema import initialize_file_schema
from app.db.files_sql import AttachmentSizeExceeded, fetch_file_metadata, require_file_size
from app.api.note_requests import SearchSuggestionsRequest, MoveNoteEndpointRequest
import os
import subprocess
import sys
from starlette import formparsers
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import ssl
from threading import Event, Thread

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.https_proxy import BoundedProxyServer, make_proxy_handler
from app.api import upload_limits
from app.api.transactions import transactional_route
from app.api.note_requests import ViewDiffRequest, UpdateNoteRequest, ResizeNoteImageRequest
from app.security.request_boundary import RequestBoundaryMiddleware
from app.services import file_storage
from main import _build_https_proxy_forward_headers


def test_https_delivers_first_chunk_before_backend_finishes(tmp_path):
    release = Event()
    class Backend(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            self.wfile.write(b'6\r\nfirst\n\r\n')
            self.wfile.flush()
            assert release.wait(3)
            self.wfile.write(b'5\r\nlast\n\r\n0\r\n\r\n')
        def log_message(self, *args):
            return
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1)).sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path/'cert.pem', tmp_path/'key.pem'
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    proxy = BoundedProxyServer(('127.0.0.1', 0), make_proxy_handler(backend_host='127.0.0.1', backend_port=backend.server_port, forward_headers=_build_https_proxy_forward_headers))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    proxy.socket = context.wrap_socket(proxy.socket, server_side=True, do_handshake_on_connect=False)
    threads = [Thread(target=server.serve_forever, daemon=True) for server in (backend, proxy)]
    for thread in threads:
        thread.start()
    client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client_context.check_hostname = False
    client_context.verify_mode = ssl.CERT_NONE
    client = http.client.HTTPSConnection('127.0.0.1', proxy.server_port, context=client_context, timeout=2)
    try:
        client.request('GET', '/')
        response = client.getresponse()
        assert response.read(6) == b'first\n'
        assert not release.is_set()
        release.set()
        assert response.read() == b'last\n'
    finally:
        release.set()
        client.close()
        for server in (proxy, backend):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(3)


@pytest.mark.parametrize('limit_delta', [0, 1])
def test_upload_checks_limit_and_closes_file(monkeypatch, limit_delta):
    monkeypatch.setattr(upload_limits, 'MAX_ATTACHMENT_BYTES', 64)
    stream = BytesIO(b'a' * (64 + limit_delta))
    upload = UploadFile(stream, filename='fixture')
    if limit_delta:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_limits.read_attachment(upload))
        assert exc.value.status_code == 413
    else:
        assert asyncio.run(upload_limits.read_attachment(upload)) == b'a'*64
    assert stream.closed


def test_non_http_upload_cannot_bypass_limit(monkeypatch):
    monkeypatch.setattr(file_storage, 'MAX_ATTACHMENT_BYTES', 64)
    with pytest.raises(ValueError, match='size limit'):
        file_storage.create_file(original_filename='fixture', mime_type='text/plain', content_bytes=b'a'*65, token='fixture')


@pytest.mark.parametrize('header,value', [('Host','[broken'),('Origin','http://[broken')])
def test_malformed_authority_returns_4xx_through_middleware(header, value):
    app = FastAPI()
    app.add_middleware(RequestBoundaryMiddleware, allowed_hosts=frozenset({'localhost'}))
    @app.post('/fixture')
    @transactional_route
    def endpoint():
        raise AssertionError('Malformed request reached route')
    with TestClient(app, base_url='http://localhost') as client:
        response = client.post('/fixture', headers={'Host':'localhost','Origin':'http://localhost',header:value})
    assert response.status_code in (400, 403)


def test_required_request_schema_rejects_bad_input_before_route():
    app = FastAPI()
    @app.post('/view')
    @transactional_route
    def endpoint(payload: ViewDiffRequest):
        raise AssertionError('Invalid body reached route')
    client = TestClient(app)
    assert client.post('/view', json={}).status_code == 422
    assert client.post('/view', json={'clientId': 'PRIVATE_CANARY'}).status_code == 422
    schema = app.openapi()['components']['schemas']['ViewDiffRequest']
    assert set(schema['required']) == {'clientId','editingNoteId','search','tabId','undoContext','clientNoteUuidHashes','visibleRootAnchorId','isUntaggedView'}


@pytest.fixture
def transport_proxy():
    class Backend(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers['Content-Length']))
            assert self.headers.get('X-Remove') is None
            assert self.headers['X-Forwarded-For'] == '127.0.0.1'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'X-Private')
            self.send_header('X-Private', 'upstream-only')
            self.end_headers()
            self.wfile.write(body)
        def do_HEAD(self):
            self.send_response(200)
            self.send_header('Content-Length', '123')
            self.end_headers()
        def log_message(self, *args):
            return
    backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    proxy = BoundedProxyServer(('127.0.0.1', 0), make_proxy_handler(backend_host='127.0.0.1', backend_port=backend.server_port, forward_headers=_build_https_proxy_forward_headers))
    threads = [Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True) for server in (backend, proxy)]
    for thread in threads:
        thread.start()
    try:
        yield proxy
    finally:
        for server in (proxy, backend):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(2)


@pytest.mark.parametrize('headers,status', [
    ([('Content-Length', '0'), ('Content-Length', '0')], 400),
    ([('Transfer-Encoding', 'chunked')], 501),
    ([('Content-Length', '0'), ('Transfer-Encoding', 'chunked')], 400),
    ([('Host', 'second-host')], 400),
    ([('Content-Length', '-1')], 400),
    ([('Connection', 'Content-Length')], 400),
])
def test_proxy_rejects_ambiguous_framing(transport_proxy, headers, status):
    client = http.client.HTTPConnection('127.0.0.1', transport_proxy.server_port, timeout=2)
    try:
        client.putrequest('POST', '/')
        for key, value in headers:
            client.putheader(key, value)
        client.endheaders()
        assert client.getresponse().status == status
    finally:
        client.close()


def test_proxy_streams_binary_body_strips_hop_headers_and_preserves_head(transport_proxy):
    body = bytes(range(256)) * 1024
    client = http.client.HTTPConnection('127.0.0.1', transport_proxy.server_port, timeout=2)
    try:
        client.request('POST', '/', body=body, headers={'Connection': 'X-Remove', 'X-Remove': 'secret', 'X-Forwarded-For': 'spoofed'})
        response = client.getresponse()
        assert response.status == 200
        assert response.getheader('X-Private') is None
        assert response.read() == body
        client.request('HEAD', '/')
        response = client.getresponse()
        assert response.status == 200
        assert response.getheader('Content-Length') == '123'
        assert response.getheader('Transfer-Encoding') is None
        assert response.read() == b''
    finally:
        client.close()


def test_multipart_limit_without_content_length_closes_spooled_files(monkeypatch):
    created = []
    original = formparsers.SpooledTemporaryFile
    def spool(*args, **kwargs):
        stream = original(*args, **kwargs)
        created.append(stream)
        return stream
    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', spool)
    monkeypatch.setattr(upload_limits, 'MAX_UPLOAD_REQUEST_BYTES', 200)
    app = FastAPI()
    app.add_middleware(upload_limits.UploadLimitMiddleware)
    @app.post('/files/upload')
    @transactional_route
    async def upload(file: UploadFile):
        raise AssertionError('Oversized file reached endpoint')
    async def scenario():
        parts = iter([b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="fixture"\r\n\r\n'+b'a'*20, b'b'*300+b'\r\n--boundary--\r\n'])
        messages = []
        async def receive():
            return {'type': 'http.request', 'body': next(parts), 'more_body': True}
        async def send(message):
            messages.append(message)
        await app({'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http','path':'/files/upload','query_string':b'', 'headers':[(b'content-type',b'multipart/form-data; boundary=boundary')], 'client':('127.0.0.1',1),'server':('127.0.0.1',80)}, receive, send)
        assert messages[0]['status'] == 413
    asyncio.run(scenario())
    assert created and all(stream.closed for stream in created)


def test_canceled_attachment_read_closes_file():
    class CanceledUpload:
        closed = False
        async def read(self, size):
            raise asyncio.CancelledError()
        async def close(self):
            self.closed = True
    upload = CanceledUpload()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(upload_limits.read_attachment(upload))
    assert upload.closed


def test_real_application_rejects_invalid_input_without_disclosing_body(tmp_path):
    script = '''
from fastapi.testclient import TestClient
from app.main import app
from app.services.tokens import token_service
from app.config import API_PREFIX
client = TestClient(app, base_url="http://localhost")
token = token_service.create_token(client_info="fixture", owner_tab_id="tab", dek=None)
headers = {"Authorization": "Bearer " + token, "X-Metalist-Tab-Id":"tab", "Origin":"http://localhost"}
for path, payload in [("/notes/view", {"clientId":"PRIVATE_CANARY"}), ("/auth/client-state/preferences", {"preferences":{"unknown":"PRIVATE_CANARY"}})]:
    method = "PUT" if "preferences" in path else "POST"
    response = client.request(method, API_PREFIX + path, json=payload, headers=headers)
    assert response.status_code == 422, (response.status_code, response.text)
    assert "PRIVATE_CANARY" not in response.text
for header, value in [("Host", "[broken"), ("Origin", "http://[broken")]:
    response = client.post(API_PREFIX + "/notes/view", headers=dict(headers, **{header:value}), json={})
    assert response.status_code in (400,403), response.text
assert client.post("/api/obsolete", headers=headers).status_code == 410
assert not any("/sounds" in path for path in app.openapi()["paths"])
assert client.post(API_PREFIX + "/ontology/rules", headers=headers, json={}).status_code == 422
assert client.post(API_PREFIX + "/notes/tab-state/new-tab", headers=headers, json={"copyFromTabId":"stale"}).status_code == 400
assert client.post(API_PREFIX + "/reminders/evaluate", headers=headers, json={"now":"bad-date","local_date":"bad-date","activity_kind":"visible"}).status_code == 400
state = client.get(API_PREFIX + "/notes/tab-state", headers=headers).json()
view = {"clientId":"client", "editingNoteId":None, "search":None, "tabId":state["activeTabId"], "undoContext":"client", "clientNoteUuidHashes":{}, "visibleRootAnchorId":None,"isUntaggedView":False}
response = client.post(API_PREFIX + "/notes/view", headers=headers, json=view)
assert response.status_code == 200, (response.status_code, response.text)
'''
    environment = dict(os.environ, METALIST_DATA_DIRECTORY=str(tmp_path), METALIST_ENVIRONMENT='production')
    result = subprocess.run([sys.executable, '-c', script], env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize('body', [
    {'query':'', 'windowDays':[1,1]},
    {'query':'', 'windowDays':[366]},
    {'query':'', 'windowDays':[True]},
])
def test_search_window_contract_rejects_invalid_values(body):
    with pytest.raises(ValidationError):
        TypeAdapter(SearchSuggestionsRequest).validate_python(body)


def test_browser_move_and_viewport_contract_remain_accepted():
    payload = {'tab_id':'tab','new_parent_id':None,'sibling_id':'sibling','position':'BEFORE',
               'clientId':'client','undoContext':'tab','viewport':{'scrollY':0,'scrollAnchor':None}}
    assert TypeAdapter(MoveNoteEndpointRequest).validate_python(payload) == payload
    payload['position'] = 'sideways'
    with pytest.raises(ValidationError):
        TypeAdapter(MoveNoteEndpointRequest).validate_python(payload)


def test_metadata_reads_omit_blobs_and_download_limit_is_checked_in_sql():
    with sqlite3.connect(':memory:') as connection:
        connection.row_factory = sqlite3.Row
        initialize_file_schema(connection)
        connection.execute("INSERT INTO files VALUES ('file','title',NULL,NULL,'{}',NULL,NULL,zeroblob(1000000),NULL,NULL,'2026-09-12','2026-09-12')")
        queries = []
        connection.set_trace_callback(queries.append)
        assert fetch_file_metadata(connection, 'file')['blob_data'] == b''
        with pytest.raises(AttachmentSizeExceeded):
            require_file_size(connection, 'file', 64)
        assert all('SELECT *' not in query for query in queries)
        assert any('length(blob_data)' in query for query in queries)


@pytest.mark.parametrize('disconnect_at', ['client', 'backend', 'truncated'])
def test_proxy_closes_upstream_when_transfer_disconnects(monkeypatch, disconnect_at):
    closed = Event()
    def read_chunk(size):
        assert size == 64 * 1024
        if disconnect_at == 'backend':
            raise ConnectionResetError()
        if disconnect_at == 'truncated':
            return b''
        return b'chunk'
    response = SimpleNamespace(length=10, status=200, reason='OK', headers=Message(), getheaders=lambda:[], getheader=lambda name:None, read1=read_chunk)
    connection = SimpleNamespace(putrequest=lambda *a,**k:None, putheader=lambda *a:None, endheaders=lambda:None, getresponse=lambda:response, close=closed.set)
    monkeypatch.setattr(http.client, 'HTTPConnection', lambda *a,**k:connection)
    handler_type = make_proxy_handler(backend_host='127.0.0.1', backend_port=1, forward_headers=_build_https_proxy_forward_headers)
    handler = object.__new__(handler_type)
    handler.headers = Message()
    handler.headers['Host'] = 'localhost'
    handler.command, handler.path, handler.client_address = 'GET', '/', ('127.0.0.1', 1)
    handler.close_connection = False
    handler.send_response = lambda *a:None
    handler.send_header = lambda *a:None
    handler.end_headers = lambda:None
    class DisconnectedWriter:
        def flush(self):
            return
        def write(self, value):
            raise BrokenPipeError()
    handler.wfile = DisconnectedWriter()
    handler._proxy()
    assert closed.is_set()
    assert handler.close_connection


def test_attachment_transfer_slots_are_released_on_cancellation():
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        async def app(scope, receive, send):
            entered.set()
            await release.wait()
        middleware = upload_limits.UploadLimitMiddleware(app)
        middleware._slots = BoundedSemaphore(1)
        scope = {'type':'http','path':'/files/id/download'}
        async def receive():
            raise AssertionError('Download should not read a request body')
        messages = []
        async def send(message):
            messages.append(message)
        first = asyncio.create_task(middleware(scope, receive, send))
        await entered.wait()
        await middleware(scope, receive, send)
        assert messages[0]['status'] == 429
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert middleware._slots.acquire(blocking=False)
        middleware._slots.release()
    asyncio.run(scenario())
