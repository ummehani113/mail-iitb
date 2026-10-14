from datetime import date
from email.message import EmailMessage

import ssl
from django.core.cache import cache
from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase
from django.test.utils import override_settings

from .views import (
    build_secure_imap_ssl_context,
    build_email_record,
    build_model_input,
    extract_best_body,
    extract_json_object,
    fallback_overview,
    get_safe_fetch_query,
    is_allowed_extension_request,
    is_gemini_proxy_rate_limited,
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

    def test_build_model_input_keeps_each_email_visible(self):
        records = [
            {
                "subject": "Subject A",
                "sender": "Sender A",
                "sender_email": "a@iitb.ac.in",
                "status": "unread",
                "source": "internal",
                "received_label": "02 Apr 09:00",
                "snippet": "Alpha",
                "body_excerpt": "Alpha details",
            },
            {
                "subject": "Subject B",
                "sender": "Sender B",
                "sender_email": "b@example.com",
                "status": "read",
                "source": "external",
                "received_label": "02 Apr 10:00",
                "snippet": "Beta",
                "body_excerpt": "Beta details",
            },
        ]

        corpus = build_model_input(records, char_limit=1200)

        self.assertIn("Subject: Subject A", corpus)
        self.assertIn("Subject: Subject B", corpus)
        self.assertIn("Source: EXTERNAL", corpus)

    def test_extract_json_object_handles_markdown_wrapped_json(self):
        payload = """
        ```json
        {
          "overview": "2 emails today",
          "action_items": []
        }
        ```
        """

        parsed = extract_json_object(payload)

        self.assertEqual(parsed["overview"], "2 emails today")
        self.assertEqual(parsed["action_items"], [])

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

    def test_fallback_overview_includes_selected_date(self):
        overview = fallback_overview(
            {"total": 3, "unread": 1, "read": 2, "external_total": 1},
            date(2026, 4, 1),
        )

        self.assertIn("2026-04-01", overview)

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

        self.assertEqual(model, "gemini-2.5-flash")
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
