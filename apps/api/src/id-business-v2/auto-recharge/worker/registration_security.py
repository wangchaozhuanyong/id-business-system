"""Registration-only validation and authenticator codes; no credential logging."""
from datetime import date, datetime
import base64
import hashlib
import hmac
import re
import struct
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from checkout_core import Stop


def validate_birthdate(value):
    try:
        born = date.fromisoformat(value)
        today = datetime.now(ZoneInfo('Asia/Kuala_Lumpur')).date()
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        if born.isoformat() != value or not 20 <= age <= 45:
            raise ValueError()
        return value
    except (TypeError, ValueError):
        raise Stop('invalid_registration_identity') from None


def verification_link(value):
    try:
        url = urlsplit(value)
        return (url.scheme == 'https' and url.hostname in {'auth.openai.com', 'auth0.openai.com'}
                and url.port in {None, 443} and not url.username and not url.password
                and bool(re.search(r'password|verify|email|confirmation', url.path, re.I)))
    except (ValueError, TypeError):
        return False


def totp_key(value):
    if not isinstance(value, str):
        raise Stop('mfa_unverified')
    key = re.sub(r'\s+', '', value).upper()
    if not re.fullmatch(r'[A-Z2-7]{16,128}', key):
        raise Stop('mfa_unverified')
    try:
        base64.b32decode(key + '=' * (-len(key) % 8))
    except ValueError:
        raise Stop('mfa_unverified') from None
    return key


def totp(value, at=None):
    key = totp_key(value)
    decoded = base64.b32decode(key + '=' * (-len(key) % 8))
    message = struct.pack('>Q', int(time.time() if at is None else at) // 30)
    digest = hmac.new(decoded, message, hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)


def offer_from_text(value):
    """Only explicit promotion wording. A generic upgrade button proves nothing."""
    normalized = re.sub(r'\s+', ' ', value).lower()
    if len(normalized) > 4000:
        return 'unknown'
    free_month = bool(re.search(r'(?:1|one)\s*month\s*free|free\s*for\s*(?:1|one)\s*month|免费(?:试用|使用)?\s*(?:1|一)\s*个月|(?:1|一)\s*个月免费', normalized))
    half = bool(re.search(r'50\s*%\s*off|50\s*%\s*折扣|半价|半折', normalized))
    if free_month and half:
        return 'unknown'
    if free_month:
        return 'free_trial'
    if half:
        return 'half_price'
    # No offer card, a regular price, or expired eligibility is not proof of full price.
    return 'unknown'
