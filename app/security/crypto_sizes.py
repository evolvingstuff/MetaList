"""Sizes of MetaList's AES-256-GCM encryption, stated once.

Nothing is imported here, so the standalone encryption audit and the logging
setup can use these without loading the server's configuration.
"""

AES_256_KEY_BYTES = 32
GCM_NONCE_BYTES = 12
GCM_TAG_BYTES = 16
SALT_BYTES = 32
