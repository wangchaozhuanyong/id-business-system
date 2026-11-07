"""Read public-tool mailbox messages with fixed IMAP providers and app passwords."""
import imaplib
import json
import re
import ssl
import sys
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime

HOSTS = {"google": "imap.gmail.com", "apple": "imap.mail.me.com", "microsoft": "outlook.office365.com"}


class AuthorizationRejected(Exception):
    pass


def read_recent(data):
    host = HOSTS[data["provider"]]
    messages = []
    with imaplib.IMAP4_SSL(host, ssl_context=ssl.create_default_context(), timeout=8) as mailbox:
        try:
            if data["provider"] == "microsoft":
                oauth = f'user={data["email"]}\x01auth=Bearer {data["accessToken"]}\x01\x01'.encode()
                mailbox.authenticate("XOAUTH2", lambda challenge: oauth if not challenge else b"")
            else:
                mailbox.login(data["email"], data["appPassword"])
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error as error:
            detail = str(error).lower()
            if "authenticationfailed" in detail or "invalid credentials" in detail:
                raise AuthorizationRejected() from error
            raise
        if mailbox.select("INBOX", readonly=True)[0] != "OK":
            raise RuntimeError()
        if data.get("verifyOnly"):
            return messages
        status, entries = mailbox.uid("search", None, "ALL")
        if status != "OK":
            raise RuntimeError()
        limit = max(1, min(20, data.get("limit") or 10))
        storefront = data.get("storefront") is True
        for uid in reversed((entries[0] or b"").split()[-limit:]):
            if not uid.isdigit():
                continue
            status, result = mailbox.uid("fetch", uid, "(INTERNALDATE BODY.PEEK[]<0.65536>)")
            if status != "OK":
                continue
            envelope, raw = next((item for item in result if isinstance(item, tuple)), (b"", b""))
            if not raw:
                continue
            message = BytesParser(policy=policy.default).parsebytes(raw)
            part = message.get_body(preferencelist=("html", "plain"))
            try:
                body = str(part.get_content())[:16000] if part is not None else ""
            except (LookupError, ValueError):
                body = ""
            try:
                date = parsedate_to_datetime(message["Date"])
                received = date.isoformat() if date.tzinfo else ""
            except (TypeError, ValueError, OverflowError):
                received = ""
            if not received:
                internal_date = re.search(rb'INTERNALDATE "([^"]+)"', envelope)
                if internal_date:
                    try:
                        value = internal_date[1].decode("ascii").replace("-", " ", 2)
                        received = parsedate_to_datetime(value).isoformat()
                    except (TypeError, ValueError, OverflowError):
                        pass
            row = {"subject": str(message.get("Subject", ""))[:500],
                   "receivedAt": received, "body": body}
            if storefront:
                row.update({"from": str(message.get("From", ""))[:500],
                            "to": str(message.get("To", ""))[:500]})
            messages.append(row)
    return messages


if __name__ == "__main__":
    try:
        data = json.loads(sys.stdin.buffer.read(4096))
        print(json.dumps(read_recent(data), ensure_ascii=False))
    except AuthorizationRejected:
        sys.exit(2)
    except Exception:
        sys.exit(1)
