"""Compatibility layer for encryption utilities.

This module provides backward compatibility for the old encryption interface.
It now uses the token-based DEK system for encryption operations.
"""

import logging
from types import SimpleNamespace
from typing import Optional, Tuple

from app.security.sensitive_cache import enable_sensitive_caches
from app.db.settings_sql import fetch_settings
from app.models.database import SafeSession
from app.services.encryption import EncryptionService
from app.services.tokens import token_service

# Global encryption service instance (per-request)
_encryption_service: Optional[EncryptionService] = None
_current_token: Optional[str] = None
_encryption_required: bool = False

logger = logging.getLogger(__name__)


def get_encryption_service_with_token(token: str) -> Optional[EncryptionService]:
    """Get encryption service with DEK loaded from token.
    
    Args:
        token: Authentication token to get DEK from
        
    Returns:
        EncryptionService instance with DEK loaded or None
    """
    global _encryption_service, _current_token
    
    # If we have a cached service for this token, return it
    if _encryption_service and _current_token == token and token:
        return _encryption_service
    
    if not token:
        return None
        
    # Get DEK from token
    dek = token_service.get_dek(token)
    if dek is None:
        return None
    
    # Create new encryption service with keys
    _encryption_service = EncryptionService()
    _encryption_service.dek = dek
    _current_token = token
    
    return _encryption_service


def get_encryption_service() -> Optional[EncryptionService]:
    """Get the global encryption service if encryption is available.
    
    Returns:
        EncryptionService instance or None if no encryption available
    """
    # This is kept for backward compatibility but requires active session
    global _encryption_service
    return _encryption_service


def set_encryption_required(required: bool) -> None:
    if not isinstance(required, bool):
        raise TypeError("required must be a bool")
    global _encryption_required
    _encryption_required = required


def is_encryption_required() -> bool:
    return _encryption_required


def encrypt(content: str, token: str) -> Tuple[str, Optional[bytes], Optional[bytes]]:
    """Encrypt note content using DEK from token.
    
    Args:
        content: Plain text content to encrypt
        token: Authentication token (optional, uses global service if not provided)
        
    Returns:
        Tuple of (ciphertext_base64, nonce_bytes, tag_bytes) or (content, None, None) if no encryption
    """
    if content is None:
        raise ValueError("Cannot encrypt None content")

    # Try to get service with token first
    if token:
        service = get_encryption_service_with_token(token)
    else:
        service = get_encryption_service()
    
    if service and service.dek:
        return service.encrypt_for_storage(content)

    if _encryption_required:
        raise RuntimeError("Encryption is required but no DEK is available")

    # No encryption available, return as-is
    return content, None, None


def decrypt(encrypted_content: str, nonce: bytes, tag: bytes, token: str) -> str:
    """Decrypt note content using DEK from token.
    
    Args:
        encrypted_content: Encrypted content to decrypt or plain text
        nonce: Nonce bytes (None if not encrypted)
        tag: Tag bytes (None if not encrypted)
        token: Authentication token (optional, uses global service if not provided)
        
    Returns:
        Decrypted plain text content or original if decryption not available
    """
    if encrypted_content is None:
        raise ValueError("Cannot decrypt None content")

    # If no nonce/tag, assume unencrypted content
    if nonce is None and tag is None:
        return encrypted_content

    if (nonce is None) != (tag is None):
        raise ValueError(
            "Encrypted content provided with incomplete metadata: "
            f"nonce={nonce is not None} tag={tag is not None}"
        )
    
    # Try to get service with token first
    if token:
        service = get_encryption_service_with_token(token)
    else:
        service = get_encryption_service()
    
    if service and service.dek:
        return service.decrypt_from_storage(encrypted_content, nonce, tag)

    raise RuntimeError("Encrypted content provided but no encryption key is available")


def set_session_dek(dek: bytes) -> None:
    """Set the session DEK without retaining the password or master key."""
    global _encryption_service, _current_token
    if not dek:
        raise ValueError("DEK must be provided")
    _encryption_service = EncryptionService()
    _encryption_service.master_key = None
    _encryption_service.dek = dek
    _current_token = None
    enable_sensitive_caches()


def clear_encryption_key() -> None:
    """Clear the encryption key from memory.
    
    This clears the global encryption service.
    """
    global _encryption_service, _current_token
    if _encryption_service:
        _encryption_service.clear_keys()
    _encryption_service = None
    _current_token = None


def is_encryption_available(token: str) -> bool:
    """Check if encryption is available.
    
    Args:
        token: Authentication token to check
        
    Returns:
        True if encryption is available, False otherwise
    """
    if token:
        service = get_encryption_service_with_token(token)
        return service is not None and service.dek is not None
    else:
        service = get_encryption_service()
        return service is not None and service.dek is not None


def get_encryption_status() -> dict:
    """Get current encryption status.
    
    Returns:
        Dictionary with encryption status information
    """
    db = SafeSession()
    try:
        with SafeSession.allow_reads("utils:encryption:status:settings"):
            row = fetch_settings(db.connection())
        if row:
            settings = SimpleNamespace(**row)
        else:
            settings = None

        return {
            "encryption_enabled": settings.encryption_enabled if settings else False,
            "has_dek": bool(settings and settings.encrypted_dek),
            "algorithm": settings.encryption_algorithm if settings else None,
            "global_service_active": _encryption_service is not None and _encryption_service.dek is not None
        }
    finally:
        db.close()
