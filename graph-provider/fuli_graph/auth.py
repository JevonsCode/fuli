import hashlib
import hmac
import secrets


def issue_access_token() -> str:
    return secrets.token_urlsafe(48)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def matches_bootstrap_token(provided: str | None, expected: str) -> bool:
    if not provided:
        return False
    return hmac.compare_digest(provided, expected)


def matches_human_review_token(
    provided: str | None,
    expected: str | None,
) -> bool:
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided, expected)


def matches_workflow_observation_token(
    provided: str | None,
    expected: str | None,
) -> bool:
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided, expected)
