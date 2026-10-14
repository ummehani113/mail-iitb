import json
import re
from datetime import date, datetime, timedelta
from email.message import EmailMessage

import ssl
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase
from django.test.utils import override_settings

from .views import (
    build_secure_imap_ssl_context,
    build_email_record,
    daily_summary_api,
    extract_best_body,
    get_safe_fetch_query,
    is_allowed_extension_request,
    is_gemini_proxy_rate_limited,
    mail_window_api,
    parse_requested_summary_date,
    resolve_proxy_request,
    sanitize_proxy_payload,
    should_retry_imap_with_compatibility,
)


class DailySummaryHelpersTests(SimpleTestCase):
    def test_extract_best_body_prefers_plain_text(self):
        message = EmailMessage()
        message["Subject"] = "Assignment reminder"
        message["From"] = "Course Team <course@iitb.ac.in>"
        message.set_content("Submit the assignment by 5 PM tomorrow.")
        message.add_alternative(
            "<html><body><p>HTML version</p></body></html>",
            subtype="html",
        )
        message.add_attachment(
            b"ignore attachment",
            maintype="application",
            subtype="octet-stream",
            filename="notes.bin",
        )

        self.assertEqual(
            extract_best_body(message),
            "Submit the assignment by 5 PM tomorrow.",
        )

    def test_build_email_record_falls_back_to_html_and_marks_external(self):
        message = EmailMessage()
        message["Subject"] = "Interview Invitation"
        message["From"] = "Recruiter <jobs@example.com>"
        message["Date"] = "Thu, 02 Apr 2026 09:15:00 +0530"
        message.set_content(
            "<html><body><p>Your interview is scheduled for Friday.</p></body></html>",
            subtype="html",
        )

        record = build_email_record(message, is_unread=True)

        self.assertEqual(record["source"], "external")
        self.assertEqual(record["status"], "unread")
        self.assertIn("Your interview is scheduled for Friday.", record["snippet"])

    def test_parse_requested_summary_date_accepts_iso_date(self):
        request = type("Request", (), {"GET": QueryDict("date=2026-04-01")})()

        parsed_date, error = parse_requested_summary_date(request)

        self.assertEqual(parsed_date, date(2026, 4, 1))
        self.assertIsNone(error)

    def test_parse_requested_summary_date_rejects_invalid_date(self):
        request = type("Request", (), {"GET": QueryDict("date=04-01-2026")})()

        parsed_date, error = parse_requested_summary_date(request)

        self.assertIsNone(parsed_date)
        self.assertEqual(error, "Invalid date format. Use YYYY-MM-DD.")

    def test_get_safe_fetch_query_uses_body_peek(self):
        self.assertEqual(get_safe_fetch_query(), "(BODY.PEEK[])")

    def test_build_secure_imap_ssl_context_verifies_certificates(self):
        context = build_secure_imap_ssl_context()

        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_build_secure_imap_ssl_context_compatibility_mode_keeps_verification(self):
        context = build_secure_imap_ssl_context(compatibility_mode=True)

        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_should_retry_imap_with_compatibility_for_handshake_failure(self):
        exc = ssl.SSLError("[SSL: SSLV3_ALERT_HANDSHAKE_FAILURE] sslv3 alert handshake failure")

        self.assertTrue(should_retry_imap_with_compatibility(exc))

    def test_should_not_retry_imap_with_compatibility_for_cert_error(self):
        exc = ssl.SSLCertVerificationError("certificate verify failed")

        self.assertFalse(should_retry_imap_with_compatibility(exc))

    def test_resolve_proxy_request_uses_supported_model(self):
        model, payload = resolve_proxy_request(
            {
                "model": "gemini-2.5-pro",
                "payload": {"contents": [{"parts": [{"text": "Hello"}]}]},
            }
        )

        self.assertEqual(model, "gemini-2.5-pro")
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "Hello")

    def test_resolve_proxy_request_falls_back_for_unknown_model(self):
        model, payload = resolve_proxy_request(
            {
                "model": "unknown-model",
                "payload": {"contents": [{"parts": [{"text": "Hello"}]}]},
            }
        )

        self.assertEqual(model, "gemini-3.8-flash")
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "Hello")

    @override_settings(GEMINI_PROXY_MAX_TEXT_CHARS=10, GEMINI_PROXY_MAX_OUTPUT_TOKENS=512)
    def test_sanitize_proxy_payload_trims_text_and_caps_output_tokens(self):
        payload, error, status = sanitize_proxy_payload(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "123456789012345"},
                            {"inline_data": {"mime_type": "image/png"}},
                        ],
                    }
                ],
                "generationConfig": {"maxOutputTokens": 9999},
            }
        )

        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "1234567890")
        self.assertEqual(payload["generationConfig"]["maxOutputTokens"], 512)

    def test_sanitize_proxy_payload_keeps_json_mode_and_temperature(self):
        payload, error, _ = sanitize_proxy_payload(
            {
                "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                "generationConfig": {
                    "temperature": 0.3,
                    "responseMimeType": "application/json",
                    "tools": ["not allowed"],
                },
            }
        )

        self.assertIsNone(error)
        config = payload["generationConfig"]
        self.assertEqual(config["temperature"], 0.3)
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertNotIn("tools", config)

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_accepts_matching_extension_id(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_X_EXTENSION_ID="test-extension-id",
        )

        self.assertTrue(is_allowed_extension_request(request))

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_rejects_unknown_extension(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_X_EXTENSION_ID="other-extension-id",
        )

        self.assertFalse(is_allowed_extension_request(request))

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_accepts_matching_origin(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_ORIGIN="chrome-extension://test-extension-id",
        )

        self.assertTrue(is_allowed_extension_request(request))

    @override_settings(
        GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE=1,
        GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS=60,
    )
    def test_gemini_proxy_rate_limit_blocks_second_request_from_same_ip(self):
        cache.clear()
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            REMOTE_ADDR="203.0.113.10",
        )

        self.assertFalse(is_gemini_proxy_rate_limited(request))
        self.assertTrue(is_gemini_proxy_rate_limited(request))


class FakeImapConnection:
    """Stand-in for imaplib.IMAP4_SSL that only accepts UID commands."""

    def __init__(self, messages, unseen, uid_validity=b"777"):
        # messages: {uid: (received date, raw bytes)}
        self.messages = messages
        self.unseen = set(unseen)
        self.uid_validity = uid_validity
        self.selected = None
        self.fetched = []

    def login(self, user, password):
        return "OK", [b"logged in"]

    def select(self, mailbox, readonly=False):
        self.selected = (mailbox, readonly)
        return "OK", [str(len(self.messages)).encode()]

    def response(self, code):
        return code, [self.uid_validity]

    def uid(self, command, *args):
        if command == "search":
            criteria = args[-1]
            since = re.search(r'SINCE "([^"]+)"', criteria).group(1)
            since = datetime.strptime(since, "%d-%b-%Y").date()
            before = re.search(r'BEFORE "([^"]+)"', criteria)
            before = datetime.strptime(before.group(1), "%d-%b-%Y").date() if before else None
            uids = [
                uid for uid, (day, _raw) in self.messages.items()
                if day >= since and (before is None or day < before)
                and ("UNSEEN" not in criteria or uid in self.unseen)
            ]
            return "OK", [b" ".join(str(uid).encode() for uid in sorted(uids))]
        if command == "fetch":
            id_list, query = args
            items = []
            for uid in str(id_list).split(","):
                self.fetched.append((int(uid), query))
                raw = self.messages[int(uid)][1]
                items += [(f"1 (UID {uid} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
            return "OK", items
        raise AssertionError(f"Unexpected UID command {command}")

    def search(self, *args):
        raise AssertionError("Sequence-number SEARCH must not be used")

    def fetch(self, *args):
        raise AssertionError("Sequence-number FETCH must not be used")

    def logout(self):
        return "BYE", [b""]


def make_raw_email(subject, sender, when):
    message = EmailMessage()
    message["From"] = sender
    message["Subject"] = subject
    message["Date"] = when.strftime("%a, %d %b %Y %H:%M:%S +0530")
    message["Message-ID"] = f"<{subject.replace(' ', '-')}@test>"
    message.set_content(f"Body of {subject}")
    return message.as_bytes()


class MailEndpointsTests(SimpleTestCase):
    headers = {"X-LDAP-User": "24b0000", "X-LDAP-Pass": "token"}

    def make_mailbox(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        day = lambda n: now - timedelta(days=n)
        return FakeImapConnection(
            messages={
                205: (day(0).date(), make_raw_email("Newest", "HR <hr@example.com>", day(0))),
                150: (day(3).date(), make_raw_email("Three days", "Prof <p@iitb.ac.in>", day(3))),
                40: (day(30).date(), make_raw_email("Too old", "Old <o@iitb.ac.in>", day(30))),
            },
            unseen=[205],
        )

    def call_window(self, mailbox, **params):
        request = RequestFactory().get("/api/mail-window/", params, headers=self.headers)
        with patch("api.views.connect_to_iitb_imap", return_value=mailbox):
            response = mail_window_api(request)
        return response.status_code, json.loads(response.content)

    def test_daily_summary_returns_mails_with_uids_and_no_server_summary(self):
        mailbox = self.make_mailbox()
        today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
        request = RequestFactory().get("/api/daily-summary/", {"date": today}, headers=self.headers)

        with patch("api.views.connect_to_iitb_imap", return_value=mailbox):
            response = daily_summary_api(request)

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.content)
        self.assertEqual([item["uid"] for item in payload["emails"]], [205])
        self.assertEqual(payload["emails"][0]["status"], "unread")
        self.assertEqual(payload["stats"]["total"], 1)
        self.assertNotIn("overview", payload)
        self.assertEqual(mailbox.selected, ("inbox", True))
        self.assertTrue(all(query == "(BODY.PEEK[])" for _uid, query in mailbox.fetched))

    def test_mail_window_first_sync_sends_whole_window_newest_first(self):
        status, payload = self.call_window(self.make_mailbox(), days="15")

        self.assertEqual(status, 200)
        self.assertTrue(payload["full"])
        self.assertEqual([item["uid"] for item in payload["emails"]], [205, 150])
        self.assertEqual(payload["window_uids"], [205, 150])
        self.assertEqual(payload["unseen_uids"], [205])
        self.assertEqual(payload["uid_validity"], "777")
        self.assertFalse(payload["emails"][0]["is_read"])

    def test_mail_window_incremental_sync_fetches_only_newer_mails(self):
        mailbox = self.make_mailbox()
        status, payload = self.call_window(mailbox, days="15", max_uid="150", uidvalidity="777")

        self.assertEqual(status, 200)
        self.assertFalse(payload["full"])
        self.assertEqual([item["uid"] for item in payload["emails"]], [205])
        self.assertEqual(payload["window_uids"], [205, 150])
        self.assertEqual([uid for uid, _query in mailbox.fetched], [205])

    def test_mail_window_resends_everything_when_uidvalidity_changes(self):
        status, payload = self.call_window(
            self.make_mailbox(), days="15", max_uid="205", uidvalidity="111"
        )

        self.assertEqual(status, 200)
        self.assertTrue(payload["full"])
        self.assertEqual(len(payload["emails"]), 2)

    def test_mail_window_requires_credentials(self):
        request = RequestFactory().get("/api/mail-window/", {"days": "15"})
        response = mail_window_api(request)
        self.assertEqual(response.status_code, 401)

    def test_mail_window_rejects_bad_max_uid(self):
        request = RequestFactory().get(
            "/api/mail-window/", {"max_uid": "abc"}, headers=self.headers
        )
        response = mail_window_api(request)
        self.assertEqual(response.status_code, 400)
