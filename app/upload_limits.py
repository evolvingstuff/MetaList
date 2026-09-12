"""Attachment limits shared by HTTP transport and non-HTTP storage callers."""

import os

UPLOAD_CHUNK_BYTES = 64 * 1024
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
if 'METALIST_MAX_ATTACHMENT_BYTES' in os.environ:
    MAX_ATTACHMENT_BYTES = int(os.environ['METALIST_MAX_ATTACHMENT_BYTES'])
if MAX_ATTACHMENT_BYTES <= 0:
    raise ValueError('METALIST_MAX_ATTACHMENT_BYTES must be positive')
MAX_UPLOAD_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024
