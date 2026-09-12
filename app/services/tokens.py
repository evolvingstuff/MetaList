"""Token management service for multi-client authentication."""

import hashlib
import secrets
from functools import wraps
from threading import RLock
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from app.services.session_timeout_service import get_session_timeout_minutes


def _synchronized(method):
    @wraps(method)
    def locked(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return locked


class TokenService:
    """Service for managing authentication tokens in memory."""

    def __init__(self):
        # In-memory storage: {token_hash: {client_info, expires_at, created_at}}
        self._lock = RLock()
        self.tokens: Dict[str, Dict[str, Any]] = {}

    def _hash_token(self, token: str) -> str:
        """Hash a token for storage.

        Args:
            token: Plain text token

        Returns:
            SHA-256 hash of the token
        """
        return hashlib.sha256(token.encode()).hexdigest()

    @_synchronized
    def reset(self) -> None:
        self.tokens.clear()

    def _build_expiry_datetime(self, *, now: datetime) -> datetime | None:
        timeout_minutes = get_session_timeout_minutes()
        if timeout_minutes == 0:
            return None
        return now + timedelta(minutes=timeout_minutes)

    @_synchronized
    def create_token(
        self,
        client_info: str,
        owner_tab_id: str,
        dek: Optional[bytes],
    ) -> str:
        """Generate new authentication token for client.

        Args:
            client_info: Information about the client (user agent, IP, etc.)
            dek: Data Encryption Key (stored in memory for note encryption)

        Returns:
            New authentication token
        """
        # Enforce single active session: wipe previous tokens before issuing a new one
        if self.tokens:
            self.tokens.clear()

        # Generate cryptographically secure token
        token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(token)
        now = datetime.now(timezone.utc)

        # Store token info including keys for encryption
        self.tokens[token_hash] = {
            "client_info": client_info,
            "owner_tab_id": owner_tab_id,
            "created_at": now,
            "expires_at": self._build_expiry_datetime(now=now),
            "last_activity": now,
            "dek": dek,  # Store DEK for note encryption
        }

        # Clean up expired tokens periodically
        self.cleanup_expired_tokens()

        return token

    @_synchronized
    def verify_token(self, token: str) -> bool:
        """Check if token is valid and not expired.

        Args:
            token: Token to verify

        Returns:
            True if token is valid, False otherwise
        """
        if not token:
            return False

        token_hash = self._hash_token(token)

        if token_hash not in self.tokens:
            return False

        token_info = self.tokens[token_hash]

        # Check if expired
        expires_at = token_info["expires_at"]
        if expires_at is not None and datetime.now(timezone.utc) > expires_at:
            # Remove expired token
            del self.tokens[token_hash]
            return False

        return True

    @_synchronized
    def verify_token_for_tab(self, token: str, owner_tab_id: str) -> bool:
        if not owner_tab_id:
            return False
        if not self.verify_token(token):
            return False

        token_hash = self._hash_token(token)
        token_info = self.tokens.get(token_hash)
        if not token_info:
            return False
        return token_info["owner_tab_id"] == owner_tab_id

    @_synchronized
    def claim_token_for_tab(self, token: str, owner_tab_id: str) -> bool:
        if not owner_tab_id:
            return False
        if not self.verify_token(token):
            return False

        token_hash = self._hash_token(token)
        token_info = self.tokens.get(token_hash)
        if not token_info:
            return False

        token_info["owner_tab_id"] = owner_tab_id
        token_info["last_activity"] = datetime.now(timezone.utc)
        return True

    @_synchronized
    def refresh_token(self, token: str) -> Optional[str]:
        """Extend token expiry on activity (sliding window).

        Args:
            token: Token to refresh

        Returns:
            Same token if refreshed, None if invalid
        """
        if not self.verify_token(token):
            return None

        token_hash = self._hash_token(token)
        now = datetime.now(timezone.utc)

        # Update expiry time (sliding window)
        self.tokens[token_hash]["expires_at"] = self._build_expiry_datetime(now=now)
        self.tokens[token_hash]["last_activity"] = now

        return token

    @_synchronized
    def refresh_active_tokens_for_current_timeout(self) -> None:
        if not self.tokens:
            return

        now = datetime.now(timezone.utc)
        expires_at = self._build_expiry_datetime(now=now)
        for token_info in self.tokens.values():
            token_info["expires_at"] = expires_at
            token_info["last_activity"] = now

    @_synchronized
    def revoke_token(self, token: str) -> bool:
        """Invalidate specific token.

        Args:
            token: Token to revoke

        Returns:
            True if token was revoked, False if not found
        """
        if not token:
            return False

        token_hash = self._hash_token(token)

        if token_hash in self.tokens:
            del self.tokens[token_hash]
            return True

        return False

    @_synchronized
    def revoke_all_tokens(self) -> int:
        """Clear all tokens (used on password change).

        Returns:
            Number of tokens revoked
        """
        count = len(self.tokens)
        self.tokens.clear()
        return count

    @_synchronized
    def cleanup_expired_tokens(self) -> int:
        """Remove expired tokens from memory.

        Returns:
            Number of tokens removed
        """
        now = datetime.now(timezone.utc)
        expired = []

        for token_hash, info in self.tokens.items():
            expires_at = info["expires_at"]
            if expires_at is not None and now > expires_at:
                expired.append(token_hash)

        for token_hash in expired:
            del self.tokens[token_hash]

        return len(expired)

    @_synchronized
    def has_active_tokens(self) -> bool:
        self.cleanup_expired_tokens()
        return bool(self.tokens)

    @_synchronized
    def get_token_info(self, token: str) -> Optional[Dict[str, Any]]:
        """Get information about a token.

        Args:
            token: Token to get info for

        Returns:
            Token information dictionary or None if not found
        """
        if not token:
            return None

        token_hash = self._hash_token(token)

        if token_hash in self.tokens:
            info = self.tokens[token_hash].copy()
            if "dek" in info:
                del info["dek"]
            return info

        return None

    @_synchronized
    def get_session_key(self, token: str) -> str:
        """Return the opaque, non-secret key for a currently valid session."""
        if not self.verify_token(token):
            raise RuntimeError("AI session key requires a valid authentication token")
        token_hash = self._hash_token(token)
        assert token_hash in self.tokens
        return token_hash

    @_synchronized
    def get_dek(self, token: str) -> Optional[bytes]:
        """Get the DEK for a valid token.

        Args:
            token: Token to get encryption keys for

        Returns:
            DEK bytes or None if not found/invalid
        """
        if not self.verify_token(token):
            return None

        token_hash = self._hash_token(token)
        token_info = self.tokens.get(token_hash)

        if not token_info:
            return None

        return token_info["dek"]

    @_synchronized
    def list_active_sessions(self) -> list:
        """List all active sessions.

        Returns:
            List of active session information
        """
        sessions = []
        now = datetime.now(timezone.utc)

        for token_hash, info in self.tokens.items():
            expires_at = info["expires_at"]
            if expires_at is not None and now > expires_at:
                continue
            expires_in_minutes = None
            if expires_at is not None:
                expires_in_minutes = int(
                    (expires_at - now).total_seconds() / 60
                )
            sessions.append({
                "client_info": info["client_info"],
                "created_at": info["created_at"].isoformat(),
                "last_activity": info["last_activity"].isoformat(),
                "expires_in_minutes": expires_in_minutes,
                "timeout_disabled": expires_at is None,
            })

        return sessions


# Global token service instance (singleton)
token_service = TokenService()
