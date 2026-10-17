# Mail IITB

Chrome extension and Django backend for IIT Bombay webmail, by the DAV Team, UGAC.

Features in the side panel: Daily Summary, Chat with my inbox, Summarize this email,
Add to Calendar, AI Reply Generator, Compose New Mail. Dark mode and Expand are built in.

## Layout

```
backend/     Django server: reads mail over IMAP (read-only), stores nothing, proxies Gemini
extension/   Chrome extension (Manifest V3), load this folder unpacked
tests/       Shared tests for the sensitive-mail filter and the chat search
```

## How the chat works

1. When the panel opens, the background worker (`inbox-prep.js`) syncs the last 15 days of
   mail from the backend into IndexedDB on the laptop. After the first time, only new mails are fetched.
2. Each new mail is turned into a MiniLM vector inside the extension (`offscreen.js`,
   all-MiniLM-L6-v2 via onnxruntime-web). Nothing is sent anywhere for this step.
3. For a question, `retrieval.js` reads dates in the question, scores mails with BM25 and
   with vectors, merges both with RRF and adds small boosts (date match, prof/TA sender,
   recency, unread).
4. `context.js` sends Gemini the list of all mails plus the full text of the best ones;
   `chat.js` shows the answer with clickable [E12] links that open the mail in webmail.

## Sensitive mails

OTP, login-code, password-reset and bank mails are replaced by a "Sensitive mail hidden"
stub on the server (`backend/api/sensitive.py`) and checked again in the extension
(`extension/sensitive.js`). They are never stored or sent to Gemini. Both use the same
rules and are tested against `tests/sensitive_samples.json`.

## Run locally

Backend (Python 3.10+):

```
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install "Django>=5.2,<6" django-cors-headers requests
python manage.py migrate
DJANGO_DEBUG=True python manage.py runserver
```

Extension:

```
bash extension/models/get-model.sh      # downloads the 23 MB search model once
```

Then in Chrome open `chrome://extensions`, turn on Developer mode, click **Load unpacked**
and pick the `extension` folder. In the panel, set Backend URL to `http://localhost:8000`,
save your Gemini API key and your LDAP ID and access token.

## Tests

```
node tests/sensitive.test.js
node tests/retrieval.test.js
cd backend && python manage.py test api
```

## Before deploying

- Remove the localhost auto-detect in `extension/store.js` and the localhost entries in
  `extension/manifest.json` host permissions.
- Add the extension-id check and rate limit to `/api/daily-summary/` and `/api/mail-window/`.
- Add the hosted `/api/mail-window/` URL to `host_permissions`.
