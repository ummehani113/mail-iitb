const MAIL_WINDOW_DAYS = 15;
const MAIL_WINDOW_DB = "mail-window-db";
const MAIL_WINDOW_DB_VERSION = 1;
const MAIL_WINDOW_EMAILS = "emails";
const MAIL_WINDOW_META = "meta";
const MAIL_WINDOW_META_KEY = "window";
const MAIL_WINDOW_SYNC_GAP_MS = 5 * 60 * 1000;
const MAIL_WINDOW_SINCE_OVERLAP_MS = 60 * 1000;
const MAIL_WINDOW_BACKEND_BASE = "https://webmailextensionugac-260151192882.asia-south1.run.app";
const MAIL_WINDOW_LOCAL_CANDIDATES = ["http://127.0.0.1:8000", "http://localhost:8000"];

let mailWindowDbPromise = null;

function mailWindowBackendBase(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  return trimmed || MAIL_WINDOW_BACKEND_BASE;
}

function mailWindowStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

function openMailWindowDb() {
  if (mailWindowDbPromise) return mailWindowDbPromise;

  mailWindowDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MAIL_WINDOW_DB, MAIL_WINDOW_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MAIL_WINDOW_EMAILS)) {
        const emails = db.createObjectStore(MAIL_WINDOW_EMAILS, { keyPath: "uid" });
        emails.createIndex("receivedAt", "receivedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(MAIL_WINDOW_META)) {
        db.createObjectStore(MAIL_WINDOW_META, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return mailWindowDbPromise;
}

function normalizeWindowEmail(row) {
  const receivedAt = new Date(row.received_at);
  return {
    uid: Number(row.uid),
    messageId: row.message_id || "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? "" : receivedAt.toISOString(),
    receivedLabel: row.received_label || "",
    senderName: row.sender_name || "",
    senderEmail: row.sender_email || "",
    subject: row.subject || "",
    body: row.body || "",
    snippet: row.snippet || "",
    excerpt: row.excerpt || "",
    isRead: !!row.is_read,
    source: row.source || "internal",
  };
}

async function detectMailWindowBackend(stored) {
  const explicit = (stored.backendBaseUrl || "").trim().replace(/\/+$/, "");
  if (explicit) return { base: explicit, source: "custom" };

  for (const candidate of MAIL_WINDOW_LOCAL_CANDIDATES) {
    try {
      const options = { method: "GET", headers: { Accept: "application/json" } };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        options.signal = AbortSignal.timeout(2000);
      }
      const probe = await fetch(`${candidate}/api/mail-window/?days=1`, options);
      const body = await probe.json();
      if (body && typeof body.status === "string") {
        return { base: candidate, source: "local" };
      }
    } catch (err) {
    }
  }

  return { base: MAIL_WINDOW_BACKEND_BASE, source: "hosted" };
}

async function applyMailWindowSync(payload, metaExtra = {}) {
  const db = await openMailWindowDb();
  const tx = db.transaction([MAIL_WINDOW_EMAILS, MAIL_WINDOW_META], "readwrite");
  const emailsStore = tx.objectStore(MAIL_WINDOW_EMAILS);
  const metaStore = tx.objectStore(MAIL_WINDOW_META);

  if (payload.full) emailsStore.clear();

  const windowStartIso = new Date(`${payload.window_start}T00:00:00+05:30`).toISOString();
  const pruneCursor = emailsStore
    .index("receivedAt")
    .openCursor(IDBKeyRange.upperBound(windowStartIso, true));
  pruneCursor.onsuccess = () => {
    const cursor = pruneCursor.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  for (const uid of payload.pruned_uids || []) {
    emailsStore.delete(Number(uid));
  }
  for (const raw of payload.emails || []) {
    const emailRow = normalizeWindowEmail(raw);
    if (emailRow.receivedAt) emailsStore.put(emailRow);
  }

  metaStore.put({
    key: MAIL_WINDOW_META_KEY,
    windowStart: payload.window_start,
    windowEnd: payload.window_end,
    syncedAt: payload.synced_at,
    count: payload.total_in_window,
    full: !!payload.full,
    stats: payload.stats || {},
    ...metaExtra,
  });

  await idbTxDone(tx);
}

async function getMailWindowMeta() {
  try {
    const db = await openMailWindowDb();
    const store = db.transaction(MAIL_WINDOW_META, "readonly").objectStore(MAIL_WINDOW_META);
    const row = await idbRequest(store.get(MAIL_WINDOW_META_KEY));
    return row || null;
  } catch (err) {
    return null;
  }
}

async function getMailWindowEmails() {
  const db = await openMailWindowDb();
  const store = db.transaction(MAIL_WINDOW_EMAILS, "readonly").objectStore(MAIL_WINDOW_EMAILS);
  const rows = await idbRequest(store.getAll());
  return (rows || []).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
}

async function clearMailWindow() {
  try {
    const db = await openMailWindowDb();
    const tx = db.transaction([MAIL_WINDOW_EMAILS, MAIL_WINDOW_META], "readwrite");
    tx.objectStore(MAIL_WINDOW_EMAILS).clear();
    tx.objectStore(MAIL_WINDOW_META).clear();
    await idbTxDone(tx);
  } catch (err) {
  }
}

async function syncMailWindow(options = {}) {
  const force = options.force !== false;
  const days = options.days || MAIL_WINDOW_DAYS;

  const stored = await mailWindowStorageGet(["ldap_user", "ldap_pass", "backendBaseUrl"]);
  if (!stored.ldap_user || !stored.ldap_pass) {
    return {
      ok: false,
      error: "Save your LDAP ID and access token in the LDAP Credentials section first.",
    };
  }

  const meta = await getMailWindowMeta();
  const lastSyncMs = meta && meta.syncedAt ? Date.parse(meta.syncedAt) : 0;

  if (!force && lastSyncMs && Date.now() - lastSyncMs < MAIL_WINDOW_SYNC_GAP_MS) {
    return { ok: true, skipped: true, meta };
  }

  const target = await detectMailWindowBackend(stored);
  const base = target.base;
  const params = new URLSearchParams({ days: String(days) });
  if (!force && lastSyncMs) {
    params.set("since", new Date(lastSyncMs - MAIL_WINDOW_SINCE_OVERLAP_MS).toISOString());
  }

  let response;
  try {
    response = await fetch(`${base}/api/mail-window/?${params.toString()}`, {
      method: "GET",
      headers: {
        "X-LDAP-User": stored.ldap_user,
        "X-LDAP-Pass": stored.ldap_pass,
        "X-Client-Feature": "iitb-mail-extension",
        "X-Extension-Id": chrome.runtime.id,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Backend unreachable at ${base}. Is the local server running?`,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }

  if (!response.ok || !payload || payload.status !== "success") {
    const message = (payload && (payload.message || payload.error)) ||
      `Window sync failed (HTTP ${response.status}) at ${base}.` +
        (response.status === 404 ? " The server does not have the mail-window route." : "");
    return { ok: false, error: message };
  }

  await applyMailWindowSync(payload, {
    backendUsed: base,
    backendSource: target.source,
  });
  const nextMeta = await getMailWindowMeta();

  return {
    ok: true,
    skipped: false,
    full: !!payload.full,
    fetched: payload.count,
    stats: payload.stats || {},
    backend: { base, source: target.source },
    meta: nextMeta,
  };
}
