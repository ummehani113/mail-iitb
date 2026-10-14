import email
import hashlib
import imaplib
import json
import re
import ssl
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

import requests
from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt

from .models import DayCoverage, EmailMessage, MailboxState

GEMINI_AVAILABLE = False
GEMINI_NEW_API = False
DEFAULT_PROXY_MODEL = "gemini-2.5-flash"
SUPPORTED_PROXY_MODELS = {
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
}

RETIRED_PROXY_MODEL_REPLACEMENTS = {
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
}
PROXY_MODEL_FALLBACKS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"]

try:
    import google.generativeai as genai

    GEMINI_AVAILABLE = True
except ImportError:
    try:
        import google.genai as genai_new

        GEMINI_AVAILABLE = True
        GEMINI_NEW_API = True
    except ImportError:
        pass


class HTMLTextExtractor(HTMLParser):

    BLOCK_TAGS = {
        "br",
        "div",
        "p",
        "li",
        "tr",
        "table",
        "section",
        "article",
        "header",
        "footer",
    }
    SKIP_TAGS = {"script", "style", "head", "title", "meta", "noscript"}

    def __init__(self):
        super().__init__()
        self._parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0 and data:
            self._parts.append(data)

    def get_text(self):
        return "".join(self._parts)


def decode_mime_header(value):
    if not value:
        return ""

    decoded = []
    for part, encoding in decode_header(value):
        if isinstance(part, bytes):
            try:
                decoded.append(part.decode(encoding or "utf-8", errors="ignore"))
            except LookupError:
                decoded.append(part.decode("utf-8", errors="ignore"))
        else:
            decoded.append(part)
    return "".join(decoded).strip()


def decode_part_payload(part):
    payload = part.get_payload(decode=True)
    if isinstance(payload, bytes):
        charset = part.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="ignore")
        except LookupError:
            return payload.decode("utf-8", errors="ignore")

    raw_payload = part.get_payload()
    if isinstance(raw_payload, str):
        return raw_payload
    return ""


def clean_extracted_text(text):
    if not text:
        return ""

    text = unescape(text)
    text = text.replace("\xa0", " ").replace("\u200b", "")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def html_to_text(html):
    if not html:
        return ""

    parser = HTMLTextExtractor()
    parser.feed(html)
    parser.close()
    return clean_extracted_text(parser.get_text())


def build_snippet(text, limit=320):
    cleaned = clean_extracted_text(text)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(limit - 3, 0)].rstrip() + "..."


def clamp(value, low, high):
    return max(low, min(high, value))


def extract_best_body(message):
    plain_candidates = []
    html_candidates = []

    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        content_type = part.get_content_type()
        disposition = (part.get("Content-Disposition") or "").lower()

        if part.get_filename() or "attachment" in disposition:
            continue

        payload = decode_part_payload(part)
        if not payload:
            continue

        if content_type == "text/plain":
            plain_candidates.append(clean_extracted_text(payload))
        elif content_type == "text/html":
            html_candidates.append(html_to_text(payload))

    plain_candidates = [candidate for candidate in plain_candidates if candidate]
    if plain_candidates:
        return max(plain_candidates, key=len)

    html_candidates = [candidate for candidate in html_candidates if candidate]
    if html_candidates:
        return max(html_candidates, key=len)

    return ""


def classify_sender(sender_email):
    domain = sender_email.split("@")[-1].lower() if sender_email else ""
    return "internal" if domain.endswith("iitb.ac.in") else "external"


def format_received_label(raw_value):
    if not raw_value:
        return "Today"

    try:
        dt = parsedate_to_datetime(raw_value)
        return dt.strftime("%d %b %H:%M")
    except Exception:
        return raw_value[:32]


def build_email_record(message, is_unread):
    raw_from = decode_mime_header(message.get("From", ""))
    sender_name, sender_email = parseaddr(raw_from)
    sender_name = sender_name.strip() or sender_email or "Unknown sender"
    sender_email = sender_email.strip()

    subject = decode_mime_header(message.get("Subject", "")) or "(No subject)"
    body = extract_best_body(message)
    fallback_text = f"Subject: {subject}. From: {sender_name}."
    snippet_source = body or fallback_text

    return {
        "subject": subject,
        "sender": sender_name,
        "sender_email": sender_email,
        "status": "unread" if is_unread else "read",
        "source": classify_sender(sender_email),
        "received_label": format_received_label(message.get("Date", "")),
        "snippet": build_snippet(snippet_source, 320),
        "body_excerpt": build_snippet(snippet_source, 900),
    }


def build_model_input(email_records, char_limit=26000):
    if not email_records:
        return ""

    per_email_limit = clamp((char_limit // len(email_records)) - 120, 180, 900)
    sections = []

    for index, record in enumerate(email_records, start=1):
        sections.append(
            "\n".join(
                [
                    f"EMAIL {index}",
                    f"Status: {record['status'].upper()}",
                    f"Source: {record['source'].upper()}",
                    f"From: {record['sender']}" + (
                        f" <{record['sender_email']}>" if record["sender_email"] else ""
                    ),
                    f"Subject: {record['subject']}",
                    f"Received: {record['received_label']}",
                    f"Content: {build_snippet(record['body_excerpt'] or record['snippet'], per_email_limit)}",
                ]
            )
        )

    return "\n\n---\n\n".join(sections)


def generate_text(prompt):
    if not GEMINI_AVAILABLE:
        return ""

    if not GEMINI_NEW_API:
        genai.configure(api_key=settings.GEMINI_API_KEY)
        model = genai.GenerativeModel("gemini-2.5-flash")
        response = model.generate_content(prompt)
        return getattr(response, "text", "") or ""

    client = genai_new.Client(api_key=settings.GEMINI_API_KEY)
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
    )
    return response.text if hasattr(response, "text") else str(response)


def summarize_email_group(email_records, category_name, summary_date):
    if not email_records:
        return f"No {category_name.lower()} emails on {summary_date.isoformat()}."

    prompt = f"""
You are creating a structured daily inbox digest for an IIT Bombay student.

Summarize the following {category_name.lower()} emails from {summary_date.isoformat()}.

Output rules:
- Start with the exact heading: {category_name} EMAILS
- Group related emails under bold headings using Markdown syntax like **Heading**
- Under each heading, add 2-4 bullet points
- Explicitly mention deadlines, required actions, and meeting times
- If an important email is from outside IIT Bombay, mention "(External)" in the heading or bullet
- Ignore boilerplate and signatures
- Maximum 220 words

Emails:
{build_model_input(email_records, char_limit=26000)}
"""

    summary = generate_text(prompt).strip()
    if summary:
        return summary

    return f"DEBUG: {len(email_records)} {category_name.lower()} emails found for {summary_date.isoformat()}."


def extract_json_object(text):
    if not text:
        return None

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def build_stats(email_records, mailbox_total):
    unread_count = sum(1 for record in email_records if record["status"] == "unread")
    read_count = len(email_records) - unread_count
    internal_records = [record for record in email_records if record["source"] == "internal"]
    external_records = [record for record in email_records if record["source"] == "external"]

    return {
        "mailbox_total": mailbox_total,
        "processed_total": len(email_records),
        "total": len(email_records),
        "unread": unread_count,
        "read": read_count,
        "internal_total": len(internal_records),
        "external_total": len(external_records),
        "internal_unread": sum(1 for record in internal_records if record["status"] == "unread"),
        "external_unread": sum(1 for record in external_records if record["status"] == "unread"),
    }


def parse_requested_summary_date(request):
    raw_value = (request.GET.get("date") or "").strip()
    if not raw_value:
        return date.today(), None

    try:
        return date.fromisoformat(raw_value), None
    except ValueError:
        return None, "Invalid date format. Use YYYY-MM-DD."


def get_safe_fetch_query():
    return "(BODY.PEEK[])"


def resolve_proxy_request(data):
    if not isinstance(data, dict):
        return DEFAULT_PROXY_MODEL, {}

    model = data.get("model")
    if isinstance(model, str):
        model = RETIRED_PROXY_MODEL_REPLACEMENTS.get(model, model)
    if model not in SUPPORTED_PROXY_MODELS:
        model = DEFAULT_PROXY_MODEL

    payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
    return model, payload


def is_model_unavailable_response(response):
    if response.status_code == 404:
        return True

    try:
        body = response.json()
    except ValueError:
        body = {}

    message = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        elif isinstance(error, str):
            message = error

    return bool(re.search(r"no longer available|not found|is not found|deprecated", message, re.I))


def build_secure_imap_ssl_context(compatibility_mode=False):
    context = ssl.create_default_context()

    if compatibility_mode:
        try:
            context.set_ciphers("DEFAULT:@SECLEVEL=1")
        except ssl.SSLError:
            pass

        tls_version = getattr(ssl, "TLSVersion", None)
        if tls_version is not None and hasattr(tls_version, "TLSv1"):
            try:
                context.minimum_version = tls_version.TLSv1
            except ValueError:
                pass

    return context


def should_retry_imap_with_compatibility(exc):
    message = str(exc).lower()
    retry_markers = (
        "handshake failure",
        "no shared cipher",
        "wrong version number",
        "version too low",
        "tlsv1 alert protocol version",
    )
    return any(marker in message for marker in retry_markers)


def connect_to_iitb_imap():
    strict_context = build_secure_imap_ssl_context()

    try:
        return imaplib.IMAP4_SSL(
            host="imap.iitb.ac.in",
            port=993,
            ssl_context=strict_context,
        )
    except ssl.SSLCertVerificationError:
        raise
    except ssl.SSLError as exc:
        if not should_retry_imap_with_compatibility(exc):
            raise

        compatibility_context = build_secure_imap_ssl_context(compatibility_mode=True)
        return imaplib.IMAP4_SSL(
            host="imap.iitb.ac.in",
            port=993,
            ssl_context=compatibility_context,
        )


def get_client_ip(request):
    forwarded_for = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return (request.META.get("REMOTE_ADDR") or "unknown").strip() or "unknown"


def is_allowed_extension_request(request):
    allowed_ids = getattr(settings, "ALLOWED_EXTENSION_IDS", []) or []
    if not allowed_ids:
        return True

    header_extension_id = (request.headers.get("X-Extension-Id") or "").strip()
    origin = (request.headers.get("Origin") or "").strip()
    allowed_origins = {f"chrome-extension://{extension_id}" for extension_id in allowed_ids}
    return header_extension_id in allowed_ids or origin in allowed_origins


def is_gemini_proxy_rate_limited(request):
    limit = max(int(getattr(settings, "GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE", 60)), 1)
    window_seconds = max(
        int(getattr(settings, "GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS", 60)),
        1,
    )
    client_ip = get_client_ip(request)
    cache_key = f"gemini-proxy-rate:{client_ip}"

    if cache.add(cache_key, 1, timeout=window_seconds):
        return False

    try:
        current_count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, timeout=window_seconds)
        return False

    return current_count > limit


def sanitize_proxy_payload(payload):
    if not isinstance(payload, dict):
        return None, "Invalid payload", 400

    contents = payload.get("contents")
    if not isinstance(contents, list) or not contents:
        return None, "Payload must include contents", 400

    max_total_chars = max(int(getattr(settings, "GEMINI_PROXY_MAX_TEXT_CHARS", 25000)), 1)
    remaining_chars = max_total_chars
    sanitized_contents = []

    for content in contents[:6]:
        if not isinstance(content, dict):
            continue

        role = str(content.get("role") or "user").strip() or "user"
        raw_parts = content.get("parts")
        if not isinstance(raw_parts, list):
            continue

        sanitized_parts = []
        for part in raw_parts[:8]:
            if not isinstance(part, dict):
                continue

            text = part.get("text")
            if not isinstance(text, str):
                continue

            cleaned_text = text.strip()
            if not cleaned_text:
                continue

            if remaining_chars <= 0:
                break

            if len(cleaned_text) > remaining_chars:
                cleaned_text = cleaned_text[:remaining_chars]

            sanitized_parts.append({"text": cleaned_text})
            remaining_chars -= len(cleaned_text)

        if sanitized_parts:
            sanitized_contents.append({"role": role, "parts": sanitized_parts})

        if remaining_chars <= 0:
            break

    if not sanitized_contents:
        return None, "Payload does not contain supported text parts", 400

    sanitized_payload = {"contents": sanitized_contents}

    system_instruction = payload.get("systemInstruction")
    if isinstance(system_instruction, dict):
        sanitized_instruction, _, _ = sanitize_proxy_payload({"contents": [system_instruction]})
        if sanitized_instruction and sanitized_instruction.get("contents"):
            sanitized_payload["systemInstruction"] = sanitized_instruction["contents"][0]

    requested_generation_config = payload.get("generationConfig")
    requested_max_tokens = None
    if isinstance(requested_generation_config, dict):
        candidate_tokens = requested_generation_config.get("maxOutputTokens")
        if isinstance(candidate_tokens, int):
            requested_max_tokens = candidate_tokens

    max_output_tokens = max(int(getattr(settings, "GEMINI_PROXY_MAX_OUTPUT_TOKENS", 1536)), 256)
    sanitized_payload["generationConfig"] = {
        "maxOutputTokens": min(requested_max_tokens or max_output_tokens, max_output_tokens)
    }

    return sanitized_payload, None, 200


def fallback_overview(stats, summary_date):
    return (
        f"{stats['total']} inbox emails arrived on {summary_date.isoformat()}: {stats['unread']} unread and "
        f"{stats['read']} read. {stats['external_total']} came from outside IIT Bombay."
    )


def fallback_action_items(email_records):
    keywords = (
        "deadline",
        "due",
        "submit",
        "meeting",
        "interview",
        "register",
        "payment",
        "exam",
        "quiz",
        "assignment",
    )
    actions = []
    for record in email_records:
        haystack = f"{record['subject']} {record['snippet']}".lower()
        if any(keyword in haystack for keyword in keywords):
            actions.append(
                {
                    "title": record["subject"],
                    "detail": record["snippet"],
                    "priority": "high" if record["status"] == "unread" else "medium",
                    "status": record["status"],
                    "source": record["source"],
                }
            )
        if len(actions) >= 5:
            break
    return actions


def generate_digest_insights(email_records, stats, summary_date):
    if not email_records:
        return "", []

    prompt = f"""
You are generating an actionable inbox digest for an IIT Bombay student.

Return JSON only in this format:
{{
  "overview": "1-2 concise sentences",
  "action_items": [
    {{
      "title": "short action title",
      "detail": "what to do and any deadline/time if available",
      "priority": "high | medium | low",
      "status": "unread | read",
      "source": "internal | external"
    }}
  ]
}}

Rules:
- Include only concrete actions, deadlines, submissions, meetings, interviews, payments, registrations, or approvals
- Sort action_items by urgency
- Maximum 5 action_items
- Mention if an action comes from an external sender when relevant
- If no action exists, return an empty array

Email stats for {summary_date.isoformat()}:
- Total emails: {stats['total']}
- Unread emails: {stats['unread']}
- External emails: {stats['external_total']}

Emails:
{build_model_input(email_records, char_limit=22000)}
"""

    parsed = extract_json_object(generate_text(prompt))
    if not parsed:
        return fallback_overview(stats, summary_date), fallback_action_items(email_records)

    overview = parsed.get("overview") or fallback_overview(stats, summary_date)
    action_items = parsed.get("action_items")
    if not isinstance(action_items, list):
        action_items = fallback_action_items(email_records)

    normalized_items = []
    for item in action_items[:5]:
        if not isinstance(item, dict):
            continue
        normalized_items.append(
            {
                "title": str(item.get("title", "")).strip() or "Action item",
                "detail": str(item.get("detail", "")).strip(),
                "priority": str(item.get("priority", "medium")).strip().lower() or "medium",
                "status": str(item.get("status", "unread")).strip().lower() or "unread",
                "source": str(item.get("source", "internal")).strip().lower() or "internal",
            }
        )

    return overview, normalized_items


@csrf_exempt
def gemini_proxy(request):
    if request.method != "POST":
        return JsonResponse({"error": "Only POST allowed"}, status=405)

    try:
        max_body_bytes = max(
            int(getattr(settings, "GEMINI_PROXY_MAX_REQUEST_BODY_BYTES", 50000)),
            1024,
        )
        if len(request.body or b"") > max_body_bytes:
            return JsonResponse({"error": "Request body too large"}, status=413)

        if not request.body:
            return JsonResponse({"error": "Empty request body"}, status=400)

        if not is_allowed_extension_request(request):
            return JsonResponse({"error": "Unauthorized extension client"}, status=403)

        if is_gemini_proxy_rate_limited(request):
            return JsonResponse({"error": "Rate limit exceeded. Please try again shortly."}, status=429)

        data = json.loads(request.body)
        model, payload = resolve_proxy_request(data)
        sanitized_payload, payload_error, payload_status = sanitize_proxy_payload(payload)
        if payload_error:
            return JsonResponse({"error": payload_error}, status=payload_status)

        api_key = getattr(settings, "GEMINI_API_KEY", None)

        candidates = [model]
        for fallback in PROXY_MODEL_FALLBACKS:
            if fallback not in candidates:
                candidates.append(fallback)

        response = None
        for candidate in candidates:
            url = (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{candidate}:generateContent?key={api_key}"
            )
            response = requests.post(url, json=sanitized_payload, timeout=60)
            if response.status_code == 200:
                model = candidate
                break
            if not is_model_unavailable_response(response):
                break

        if response.status_code != 200:
            return JsonResponse(
                {
                    "error": "Google API Error",
                    "details": response.text,
                },
                status=response.status_code,
            )

        gemini_response = response.json()

        text_content = ""
        if "candidates" in gemini_response and gemini_response["candidates"]:
            candidate = gemini_response["candidates"][0]
            if "content" in candidate and "parts" in candidate["content"]:
                for part in candidate["content"]["parts"]:
                    if "text" in part:
                        text_content += part["text"]

        return JsonResponse(
            {
                "ok": True,
                "text": text_content,
                "summary": text_content,
                "raw": gemini_response,
            }
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": f"Invalid JSON: {request.body.decode()}"}, status=400)
    except Exception as exc:
        return JsonResponse({"error": str(exc)}, status=500)


def daily_summary_api(request):
    requested_date, date_error = parse_requested_summary_date(request)
    if date_error:
        return JsonResponse(
            {"status": "error", "message": date_error},
            status=400,
        )

    print(f"[API] daily_summary_api called for {requested_date.isoformat()}")

    mail = None
    try:
        user = request.headers.get("X-LDAP-User")
        password = request.headers.get("X-LDAP-Pass")

        if not user or not password:
            return JsonResponse(
                {"status": "error", "message": "LDAP credentials missing"},
                status=401,
            )

        mail = connect_to_iitb_imap()

        mail.login(user, password)
        mail.select("inbox", readonly=True)

        imap_start = requested_date.strftime("%d-%b-%Y")
        imap_end = (requested_date + timedelta(days=1)).strftime("%d-%b-%Y")

        all_status, all_messages = mail.search(None, f'(SINCE "{imap_start}" BEFORE "{imap_end}")')
        unread_status, unread_messages = mail.search(
            None,
            f'(SINCE "{imap_start}" BEFORE "{imap_end}" UNSEEN)',
        )

        if all_status != "OK":
            return JsonResponse(
                {"status": "error", "message": "Failed to fetch inbox messages"},
                status=500,
            )

        all_ids = list(reversed(all_messages[0].split()))
        unread_ids = set(unread_messages[0].split()) if unread_status == "OK" else set()

        if not all_ids:
            return JsonResponse(
                {
                    "status": "success",
                    "generated_for": requested_date.isoformat(),
                    "overview": f"No inbox emails arrived on {requested_date.isoformat()}.",
                    "stats": build_stats([], 0),
                    "action_items": [],
                    "external_highlights": [],
                    "recent_emails": [],
                    "unread_summary": f"No unread emails on {requested_date.isoformat()}.",
                    "read_summary": f"No read emails on {requested_date.isoformat()}.",
                }
            )

        email_records = []
        for email_id in all_ids:
            fetch_status, msg_data = mail.fetch(email_id, get_safe_fetch_query())
            if fetch_status != "OK" or not msg_data:
                continue

            raw_message = next(
                (item[1] for item in msg_data if isinstance(item, tuple) and len(item) > 1),
                None,
            )
            if not raw_message:
                continue

            message = email.message_from_bytes(raw_message)
            email_records.append(build_email_record(message, email_id in unread_ids))

        stats = build_stats(email_records, len(all_ids))
        unread_records = [record for record in email_records if record["status"] == "unread"]
        read_records = [record for record in email_records if record["status"] == "read"]

        overview, action_items = generate_digest_insights(email_records, stats, requested_date)
        unread_summary = summarize_email_group(unread_records, "UNREAD", requested_date)
        read_summary = summarize_email_group(read_records, "READ", requested_date)

        external_highlights = sorted(
            [record for record in email_records if record["source"] == "external"],
            key=lambda record: (record["status"] != "unread",),
        )[:5]

        recent_emails = email_records

        return JsonResponse(
            {
                "status": "success",
                "generated_for": requested_date.isoformat(),
                "overview": overview,
                "stats": stats,
                "action_items": action_items,
                "external_highlights": external_highlights,
                "recent_emails": recent_emails,
                "unread_summary": unread_summary,
                "read_summary": read_summary,
            }
        )

    except ssl.SSLCertVerificationError as exc:
        return JsonResponse(
            {
                "status": "error",
                "message": (
                    "Secure connection to IITB IMAP failed certificate verification. "
                    f"Details: {exc}"
                ),
            },
            status=502,
        )
    except ssl.SSLError as exc:
        return JsonResponse(
            {
                "status": "error",
                "message": f"Secure IMAP connection failed: {exc}",
            },
            status=502,
        )
    except Exception as exc:
        return JsonResponse(
            {
                "status": "error",
                "message": str(exc),
            },
            status=500,
        )
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass


MAIL_WINDOW_DEFAULT_DAYS = 15
MAIL_WINDOW_MAX_DAYS = 45
MAIL_WINDOW_BODY_LIMIT = 6000
IMAP_FETCH_CHUNK_SIZE = 25
IST_TIMEZONE = ZoneInfo("Asia/Kolkata")

WINDOW_RECORD_FIELDS = (
    "message_id",
    "received_at",
    "received_label",
    "sender_name",
    "sender_email",
    "subject",
    "body",
    "snippet",
    "excerpt",
    "is_read",
    "source",
)


def derive_user_key(username):
    normalized = (username or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:40]


def current_ist_date():
    return datetime.now(IST_TIMEZONE).date()


def parse_message_datetime(raw_date):
    if not raw_date:
        return None

    try:
        parsed = parsedate_to_datetime(raw_date)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None

    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt_timezone.utc)
    return parsed.astimezone(dt_timezone.utc)


def read_uid_validity(mail):
    try:
        code, data = mail.response("UIDVALIDITY")
    except Exception:
        return ""

    if not code or not data:
        return ""

    first = data[0] if isinstance(data, (list, tuple)) and data else data
    if isinstance(first, bytes):
        return first.decode("ascii", errors="ignore").strip()
    return str(first or "").strip()


def merge_contiguous_days(days):
    if not days:
        return []

    ordered = sorted(set(days))
    ranges = [(ordered[0], ordered[0])]
    for day in ordered[1:]:
        start, end = ranges[-1]
        if day == end + timedelta(days=1):
            ranges[-1] = (start, day)
        else:
            ranges.append((day, day))
    return ranges


def imap_search_range(mail, start_day, end_day, unseen_only=False):
    imap_start = start_day.strftime("%d-%b-%Y")
    imap_end = (end_day + timedelta(days=1)).strftime("%d-%b-%Y")
    criteria = f'(SINCE "{imap_start}" BEFORE "{imap_end}"'
    if unseen_only:
        criteria += " UNSEEN"
    criteria += ")"

    try:
        status, data = mail.uid("search", None, criteria)
    except Exception:
        return []

    if status != "OK" or not data or not data[0]:
        return []
    return [int(uid) for uid in data[0].split()]


def parse_fetched_messages(items):
    messages = {}
    for item in items or []:
        if not isinstance(item, tuple) or len(item) < 2:
            continue

        header, payload = item[0], item[1]
        if not isinstance(payload, (bytes, bytearray)) or not payload:
            continue

        header_bytes = (
            header
            if isinstance(header, bytes)
            else str(header).encode("utf-8", errors="ignore")
        )
        match = re.search(rb"UID\s+(\d+)", header_bytes)
        if not match:
            continue

        messages[int(match.group(1))] = email.message_from_bytes(payload)
    return messages


def fetch_messages_by_uid(mail, uids):
    messages = {}
    for start in range(0, len(uids), IMAP_FETCH_CHUNK_SIZE):
        chunk = uids[start : start + IMAP_FETCH_CHUNK_SIZE]
        id_list = ",".join(str(uid) for uid in chunk)

        try:
            status, items = mail.uid("fetch", id_list, get_safe_fetch_query())
        except Exception:
            status, items = "NO", []

        if status == "OK":
            messages.update(parse_fetched_messages(items))

        for uid in chunk:
            if uid in messages:
                continue
            try:
                single_status, single_items = mail.uid("fetch", str(uid), get_safe_fetch_query())
            except Exception:
                continue
            if single_status == "OK":
                messages.update(parse_fetched_messages(single_items))

    return messages


def build_window_record(message_obj, uid, is_read):
    record = build_email_record(message_obj, is_read)
    body = clean_extracted_text(extract_best_body(message_obj))[:MAIL_WINDOW_BODY_LIMIT]
    received_at = parse_message_datetime(message_obj.get("Date", "")) or timezone.now()
    message_id = (message_obj.get("Message-ID") or "").strip()[:255] or f"uid:{uid}"

    return {
        "message_id": message_id,
        "received_at": received_at,
        "received_label": received_at.astimezone(IST_TIMEZONE).strftime("%d %b %H:%M"),
        "sender_name": record["sender"][:255],
        "sender_email": record["sender_email"][:255],
        "subject": record["subject"][:1000],
        "body": body,
        "snippet": record["snippet"][:400],
        "excerpt": record["body_excerpt"][:1000],
        "is_read": is_read,
        "source": record["source"],
    }


def upsert_window_email(user_key, uid, record):
    existing = EmailMessage.objects.filter(user_key=user_key, imap_uid=uid).first()
    if existing is None:
        EmailMessage.objects.create(user_key=user_key, imap_uid=uid, **record)
        return "created"

    changed = any(getattr(existing, field) != record[field] for field in WINDOW_RECORD_FIELDS)
    if not changed:
        return "unchanged"

    for field in WINDOW_RECORD_FIELDS:
        setattr(existing, field, record[field])
    existing.save(update_fields=[*WINDOW_RECORD_FIELDS, "updated_at"])
    return "updated"


def count_window_emails_by_day(user_key, start_day, end_day):
    range_start = datetime.combine(start_day, time.min, tzinfo=IST_TIMEZONE).astimezone(dt_timezone.utc)
    range_end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=IST_TIMEZONE).astimezone(dt_timezone.utc)

    counts = {}
    rows = EmailMessage.objects.filter(
        user_key=user_key,
        received_at__gte=range_start,
        received_at__lt=range_end,
    ).values_list("received_at", flat=True)

    for received_at in rows:
        day = received_at.astimezone(IST_TIMEZONE).date()
        counts[day] = counts.get(day, 0) + 1
    return counts


def mark_days_covered(user_key, start_day, end_day, counts_by_day):
    day = start_day
    while day <= end_day:
        DayCoverage.objects.update_or_create(
            user_key=user_key,
            day=day,
            defaults={"message_count": counts_by_day.get(day, 0)},
        )
        day += timedelta(days=1)


def serialize_window_email(row):
    return {
        "uid": row.imap_uid,
        "message_id": row.message_id,
        "received_at": row.received_at.isoformat(),
        "received_label": row.received_label,
        "sender_name": row.sender_name,
        "sender_email": row.sender_email,
        "subject": row.subject,
        "body": row.body,
        "snippet": row.snippet,
        "excerpt": row.excerpt,
        "is_read": row.is_read,
        "source": row.source,
    }


@csrf_exempt
def mail_window_api(request):
    if request.method not in ("GET", "POST"):
        return JsonResponse({"status": "error", "message": "Only GET or POST allowed"}, status=405)

    days_raw = (request.GET.get("days") or "").strip()
    try:
        days = int(days_raw) if days_raw else MAIL_WINDOW_DEFAULT_DAYS
    except ValueError:
        return JsonResponse({"status": "error", "message": "days must be an integer"}, status=400)
    days = max(1, min(days, MAIL_WINDOW_MAX_DAYS))

    since_raw = (request.GET.get("since") or "").strip()
    since_at = None
    if since_raw:
        try:
            since_at = datetime.fromisoformat(since_raw.replace("Z", "+00:00"))
        except ValueError:
            return JsonResponse(
                {"status": "error", "message": "Invalid since format. Use ISO-8601."},
                status=400,
            )
        if since_at.tzinfo is None:
            since_at = since_at.replace(tzinfo=dt_timezone.utc)
        since_at = since_at.astimezone(dt_timezone.utc)

    user = request.headers.get("X-LDAP-User")
    password = request.headers.get("X-LDAP-Pass")
    if not user or not password:
        return JsonResponse({"status": "error", "message": "LDAP credentials missing"}, status=401)

    user_key = derive_user_key(user)
    mail = None

    try:
        today = current_ist_date()
        window_start_day = today - timedelta(days=days - 1)
        window_start_at = datetime.combine(
            window_start_day, time.min, tzinfo=IST_TIMEZONE
        ).astimezone(dt_timezone.utc)

        pruned_qs = EmailMessage.objects.filter(
            user_key=user_key, received_at__lt=window_start_at
        )
        pruned_uids = list(pruned_qs.values_list("imap_uid", flat=True))
        pruned_qs.delete()
        DayCoverage.objects.filter(user_key=user_key, day__lt=window_start_day).delete()

        state, _created = MailboxState.objects.get_or_create(user_key=user_key)
        had_previous_sync = state.last_sync_at is not None

        mail = connect_to_iitb_imap()
        mail.login(user, password)
        mail.select("inbox", readonly=True)

        uid_validity = read_uid_validity(mail)
        rescan = bool(
            state.uid_validity and uid_validity and state.uid_validity != uid_validity
        )
        if rescan:
            EmailMessage.objects.filter(user_key=user_key).delete()
            DayCoverage.objects.filter(user_key=user_key).delete()
        if uid_validity:
            state.uid_validity = uid_validity

        covered = set(
            DayCoverage.objects.filter(
                user_key=user_key, day__gte=window_start_day
            ).values_list("day", flat=True)
        )
        window_days = [window_start_day + timedelta(days=offset) for offset in range(days)]
        refresh_days = {today, today - timedelta(days=1)}
        gap_days = [day for day in window_days if day not in covered and day not in refresh_days]
        refresh_in_window = [day for day in window_days if day in refresh_days]

        counters = {
            "created": 0,
            "updated": 0,
            "unchanged": 0,
            "flag_updates": 0,
            "gap_days": len(gap_days),
            "refresh_days": len(refresh_in_window),
        }

        for start_day, end_day in merge_contiguous_days(gap_days):
            uids = imap_search_range(mail, start_day, end_day)
            unseen_uids = set(imap_search_range(mail, start_day, end_day, unseen_only=True))
            messages = fetch_messages_by_uid(mail, uids)

            for uid in uids:
                message_obj = messages.get(uid)
                if message_obj is None:
                    continue
                record = build_window_record(message_obj, uid, uid not in unseen_uids)
                counters[upsert_window_email(user_key, uid, record)] += 1

            mark_days_covered(
                user_key, start_day, end_day, count_window_emails_by_day(user_key, start_day, end_day)
            )

        for start_day, end_day in merge_contiguous_days(refresh_in_window):
            uids = imap_search_range(mail, start_day, end_day)
            unseen_uids = set(imap_search_range(mail, start_day, end_day, unseen_only=True))
            known_uids = set(
                EmailMessage.objects.filter(
                    user_key=user_key, imap_uid__in=uids
                ).values_list("imap_uid", flat=True)
            )
            new_uids = [uid for uid in uids if uid not in known_uids]

            messages = fetch_messages_by_uid(mail, new_uids)
            for uid in new_uids:
                message_obj = messages.get(uid)
                if message_obj is None:
                    continue
                record = build_window_record(message_obj, uid, uid not in unseen_uids)
                counters[upsert_window_email(user_key, uid, record)] += 1

            for row in EmailMessage.objects.filter(
                user_key=user_key, imap_uid__in=known_uids
            ):
                should_be_read = row.imap_uid not in unseen_uids
                if row.is_read != should_be_read:
                    row.is_read = should_be_read
                    row.save(update_fields=["is_read", "updated_at"])
                    counters["flag_updates"] += 1

            mark_days_covered(
                user_key, start_day, end_day, count_window_emails_by_day(user_key, start_day, end_day)
            )

        window_qs = EmailMessage.objects.filter(user_key=user_key, received_at__gte=window_start_at)
        total_in_window = window_qs.count()

        full_sync = since_at is None or rescan or not had_previous_sync
        rows = window_qs if full_sync else window_qs.filter(updated_at__gt=since_at)
        emails = [serialize_window_email(row) for row in rows.order_by("-received_at")]

        state.window_days = days
        state.last_sync_at = timezone.now()
        state.save(update_fields=["window_days", "last_sync_at", "uid_validity"])

        stats = {
            **counters,
            "pruned": len(pruned_uids),
            "total_in_window": total_in_window,
        }

        print(
            f"[API] mail_window_api user={user_key[:8]} days={days} "
            f"full={full_sync} fetched={counters['created'] + counters['updated']} "
            f"gap_days={counters['gap_days']} pruned={len(pruned_uids)}"
        )

        return JsonResponse(
            {
                "status": "success",
                "full": full_sync,
                "days": days,
                "window_start": window_start_day.isoformat(),
                "window_end": today.isoformat(),
                "synced_at": timezone.now().isoformat(),
                "total_in_window": total_in_window,
                "count": len(emails),
                "pruned_uids": pruned_uids,
                "stats": stats,
                "emails": emails,
            }
        )

    except ssl.SSLCertVerificationError as exc:
        return JsonResponse(
            {
                "status": "error",
                "message": (
                    "Secure connection to IITB IMAP failed certificate verification. "
                    f"Details: {exc}"
                ),
            },
            status=502,
        )
    except ssl.SSLError as exc:
        return JsonResponse(
            {"status": "error", "message": f"Secure IMAP connection failed: {exc}"},
            status=502,
        )
    except Exception as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass
