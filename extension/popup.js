const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_BACKEND_BASE = "https://webmailextensionugac-260151192882.asia-south1.run.app";
const SUPPORTED_CUSTOM_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];
const RETIRED_MODEL_REPLACEMENTS = {
  "gemini-2.5-flash": "gemini-3.8-flash",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
};

function geminiEndpointFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function normalizeBackendBase(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_BACKEND_BASE;
}

async function buildBackendUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["backendBaseUrl"], (data) => resolve(data || {}));
  });
  return `${normalizeBackendBase(stored.backendBaseUrl)}${normalizedPath}`;
}


async function refreshMailWindowStatus() {
  const statusEl = document.getElementById("chat-sync-status");
  if (!statusEl || typeof getMailWindowMeta !== "function") return;

  const meta = await getMailWindowMeta();
  if (!meta || !meta.syncedAt) {
    statusEl.textContent = `Not synced yet · via ${await currentBackendLabel()}`;
    return;
  }
  const count = typeof meta.count === "number" ? meta.count : "?";
  statusEl.textContent =
    `${count} mails stored · ${meta.windowStart} → ${meta.windowEnd} · via ${await currentBackendLabel()}`;
}

async function persistBackendUrlFromInput() {
  const input = document.getElementById("backendBaseUrl");
  if (!input) return;

  const value = input.value.trim().replace(/\/+$/, "");
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["backendBaseUrl"], (data) => resolve(data || {}));
  });
  const current = (stored.backendBaseUrl || "").trim();

  if (value === current) return;

  if (value) {
    await new Promise((resolve) => chrome.storage.local.set({ backendBaseUrl: value }, resolve));
  } else if (current) {
    await new Promise((resolve) => chrome.storage.local.remove(["backendBaseUrl"], resolve));
  }
}

async function currentBackendLabel() {
  const meta = await getMailWindowMeta();
  if (meta && meta.backendUsed) {
    if (meta.backendSource === "hosted") return "hosted backend (auto)";
    const short = meta.backendUsed.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return meta.backendSource === "local" ? `${short} (auto)` : short;
  }

  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["backendBaseUrl"], (data) => resolve(data || {}));
  });
  const base = (stored.backendBaseUrl || "").trim();
  return base ? base.replace(/^https?:\/\//, "").replace(/\/$/, "") : "auto-detect";
}

async function runMailWindowSync(options = {}) {
  const statusEl = document.getElementById("chat-sync-status");
  const btn = document.getElementById("syncWindowBtn");
  const force = options.force !== false;

  await persistBackendUrlFromInput();

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Syncing…";
  }
  if (statusEl) statusEl.textContent = "Scraping the 15-day window…";

  try {
    const result = await syncMailWindow({ force });

    if (!result.ok) {
      if (statusEl) statusEl.textContent = result.error;
      return result;
    }

    if (result.skipped) {
      if (statusEl) statusEl.textContent = "Already synced in the last 5 minutes.";
      return result;
    }

    const meta = result.meta || {};
    const count = typeof meta.count === "number" ? meta.count : "?";
    if (statusEl) {
      statusEl.textContent = `${count} mails stored · ${meta.windowStart} → ${meta.windowEnd}` +
        (result.full ? "" : " (updated)") +
        ` · via ${await currentBackendLabel()}`;
    }
    return result;
  } catch (err) {
    if (statusEl) statusEl.textContent = `Sync failed: ${err && err.message ? err.message : err}`;
    return { ok: false, error: String(err) };
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Sync 15 days";
    }
  }
}

function sendToGemini(prompt, callback) {

  chrome.storage.local.get(['selectedModel'], (res) => {
    const model = res.selectedModel || DEFAULT_MODEL;
    chrome.runtime.sendMessage({
      type: "GEMINI_SUMMARY",
      prompt: prompt,
      model: model
    }, (response) => {
      if (response && response.ok) {
        callback(response);
      } else {
        console.error("Gemini Error:", response?.error);
        callback({ ok: false, text: "Error: " + (response?.error || "Unknown error") });
      }
    });
  });
}


let calendarChecked = false;
let currentReplyText = "";
let currentComposeText = "";
let cardEventIds = {};

function escapeHtml(s = "") {
  return s.toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttr(s = "") {
  return s
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSafeInlineMarkdown(text = "") {
  const escaped = escapeHtml(text);
  return escaped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

function cleanBullet(text = "") {
  return text.replace(/^\*+\s*/, "").replace(/\*+$/g, "").replace(/\*\**/g, "").trim();
}

function getTodayIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
  return local.toISOString().slice(0, 10);
}

function formatSummaryDate(dateString) {
  if (!dateString) return "the selected date";
  const parsed = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateString;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function showMessage(msg, section = "summary", err = false) {
  const map = {
    summary: "summary-status",
    calendar: "calendar-status",
    reply: "reply-status",
    compose: "compose-status",
    setup: "setup-status",
    status: "status",
    voice: "recordStatus"
  };
  const targetId = map[section] || "status";
  const el = document.getElementById(targetId) || document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = err ? "crimson" : "inherit";
}


function injectToWebmail(body, subject = null) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    if (!tabs[0].url.includes("webmail.iitb.ac.in")) {
      const section = subject ? "compose" : "reply";
      showMessage("Please stay on the Webmail tab", section, true);
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, {
      type: "COMPOSE_NEW_MAIL",
      subject: subject,
      body: body
    }, (response) => {
      const section = subject ? "compose" : "reply";
      if (chrome.runtime.lastError) {
        showMessage("Error: Refresh the mail page", section, true);
      } else if (response && response.ok) {
        showMessage("Injected successfully!", section);
      } else {
        showMessage("Input field not found", section, true);
      }
    });
  });
}


function openAccordionSoft(sectionId) {
  document.getElementById(sectionId)?.classList.add("active");
}

function toggleAccordion(section) {
  section.classList.toggle("active");
}


function renderSummary(text) {
  const out = document.getElementById("summary-result");
  if (!out) return;
  out.className = "summary-card";
  out.innerHTML = "";

  const ul = document.createElement("ul");
  ul.className = "summary-list";

  text.split("\n").forEach(line => {
    if (!line.trim()) return;
    const li = document.createElement("li");
    li.textContent = cleanBullet(line.replace(/^•\s*/, ""));
    ul.appendChild(li);
  });

  out.appendChild(ul);
}

async function bulkConfirmAllEvents() {
  const container = document.getElementById("calendar-result");
  if (!container) return;

  const allConfirmButtons = container.querySelectorAll('.confirm-btn');
  if (allConfirmButtons.length === 0) return;

  showMessage(`Syncing ${allConfirmButtons.length} events...`, "calendar");

  for (let i = 0; i < allConfirmButtons.length; i++) {
    allConfirmButtons[i].click();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function renderCalendarResult(data, isManual = false) {
  const out = document.getElementById("calendar-result");
  const checkBtn = document.getElementById("calOnly");
  const manualBtn = document.getElementById("manualEntry");
  if (!out) return;

  if (!data && !isManual) {
    out.innerHTML = "";
    if (manualBtn) manualBtn.style.display = 'block';
    if (checkBtn) checkBtn.style.display = 'block';
    return;
  }

  if (manualBtn) manualBtn.style.display = 'none';
  if (checkBtn) checkBtn.style.display = 'none';

  const events = Array.isArray(data) ? data : (data && data.hasEvent ? [data] : []);

  if (events.length === 0 && !isManual) {
    out.innerHTML = `<p class="muted">No event detected from this mail.</p>`;
    return;
  }

  const backButtonHtml = `
    <div style="margin-bottom: 12px;">
      <button id="backToOptions" style="background: none; border: none; color: #666; cursor: pointer; display: flex; align-items: center; font-size: 13px; padding: 0;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        Back to options
      </button>
    </div>`;

  const manualEventData = isManual ? { title: "", date: "", startTime: "", endTime: "", description: "" } : null;
  const eventsToRender = isManual ? [manualEventData] : events;

  let formsHtml = backButtonHtml;

  if (eventsToRender.length > 1 && !isManual) {
    formsHtml += `
      <div class="bulk-action-container" style="margin-bottom: 15px; padding: 12px; background: #f8f9fa; border: 1px solid #eee; border-radius: 8px; text-align: center;">
        <p style="font-size: 12px; color: #666; margin-bottom: 8px; font-weight: 500;">Multiple events detected!</p>
        <button id="addAllEventsBtn" class="primary-btn" style="width: 100%; background: #000000; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: 600; cursor: pointer;">
          Add All Events to Calendar
        </button>
      </div>
    `;
  }

  if (calendarChecked && events.length === 0 && !isManual) {
      formsHtml += `<p class="muted" style="margin-bottom:10px;">No event detected. You can enter details manually below:</p>`;
  }

  eventsToRender.forEach((event, index) => {
    const uniqueCardId = `card-${Date.now()}-${index}`;
    formsHtml += `
      <div id="${uniqueCardId}" class="calendar-card" style="margin-bottom: 20px; border-left: 3px solid var(--accent-dark);">
        <div class="field-group">
          <label class="field-label">Event Title ${eventsToRender.length > 1 ? (index + 1) : ""}</label>
          <input type="text" id="edit-title-${index}" class="edit-input" placeholder="e.g. Project Sync" value="${escapeHtmlAttr(event.title || '')}">
        </div>
        <div class="field-row" style="display: flex; gap: 10px;">
          <div class="field-group" style="flex: 1;">
            <label class="field-label">Date</label>
            <input type="date" id="edit-date-${index}" class="edit-input" value="${escapeHtmlAttr(event.date || '')}">
          </div>
          <div class="field-group" style="flex: 1;">
            <label class="field-label">Start Time (Optional)</label>
            <input type="time" id="edit-time-${index}" class="edit-input" value="${escapeHtmlAttr(event.startTime || event.time || '')}">
          </div>
          <div class="field-group" style="flex: 1;">
            <label class="field-label">End Time (Optional)</label>
            <input type="time" id="edit-endtime-${index}" class="edit-input" value="${escapeHtmlAttr(event.endTime || '')}">
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Description</label>
          <textarea id="edit-desc-${index}" class="edit-input" rows="2" placeholder="Add details...">${escapeHtml(event.description || '')}</textarea>
        </div>
        <div class="action-container-${index}">
          <button class="primary-btn large-btn confirm-btn" data-index="${index}" data-card-id="${uniqueCardId}" id="confirm-${index}">Confirm & Add to Calendar</button>
        </div>
      </div>`;
  });

  out.innerHTML = formsHtml;

  const backBtn = document.getElementById('backToOptions');
  if (backBtn) {
    backBtn.onclick = () => {
      calendarChecked = false;
      renderCalendarResult(null);
    };
  }

  const addAllBtn = document.getElementById("addAllEventsBtn");
  if (addAllBtn) {
    addAllBtn.onclick = bulkConfirmAllEvents;
  }

  attachConfirmListeners(out);
}

function attachConfirmListeners(container) {
  container.querySelectorAll('.confirm-btn').forEach(btn => {
    btn.onclick = (e) => {
      const idx = e.target.getAttribute('data-index');
      const cardId = e.target.getAttribute('data-card-id');

      const titleEl = document.getElementById(`edit-title-${idx}`);
      const dateEl = document.getElementById(`edit-date-${idx}`);
      const startTimeVal = document.getElementById(`edit-time-${idx}`).value;
      const endTimeVal = document.getElementById(`edit-endtime-${idx}`).value;
      const descEl = document.getElementById(`edit-desc-${idx}`);

      if (!titleEl.value || !dateEl.value) {
        showMessage("Title and Date are required", "calendar", true);
        return;
      }

      const eventData = {
        title: titleEl.value,
        date: dateEl.value,
        startTime: startTimeVal,
        endTime: endTimeVal,
        description: descEl.value
      };

      if (cardEventIds[cardId]) {
        showMessage("Updating event...", "calendar");
        chrome.runtime.sendMessage({
          type: "UPDATE_CALENDAR_EVENT",
          eventData,
          cardId,
          eventId: cardEventIds[cardId]
        });
      } else {
        showMessage("Check the Google login window...", "calendar");
        chrome.runtime.sendMessage({ type: "ADD_CALENDAR_EVENT", eventData, cardId });
      }

      e.target.parentElement.innerHTML = `
        <div class="status-waiting" style="text-align: center; padding: 10px;">
          <p style="color: #666; font-size: 13px; line-height: 1.5;">
            Syncing with Calendar...
          </p>
        </div>`;
    };
  });
}

function handleLDAPLogout() {
  if (!confirm("Are you sure you want to logout? This will clear your saved LDAP credentials.")) {
    return;
  }

  chrome.storage.local.remove(['ldap_user', 'ldap_pass'], () => {
    const logoutStatus = document.getElementById('logout-status');
    if (chrome.runtime.lastError) {
      logoutStatus.textContent = "Error clearing credentials";
      logoutStatus.style.color = "crimson";
    } else {
      updateAuthUI();
      logoutStatus.textContent = "✓ Successfully logged out. Credentials cleared.";
      logoutStatus.style.color = "#166534";

      document.getElementById('ldap-user').value = '';
      document.getElementById('ldap-pass').value = '';

      const dailyResult = document.getElementById('daily-summary-result');
      if (dailyResult) dailyResult.style.display = 'none';

      const dailyStatus = document.getElementById('daily-summary-status');
      if (dailyStatus) dailyStatus.textContent = '';

      setTimeout(() => {
        logoutStatus.textContent = '';
      }, 3000);
    }
  });
}

function updateAuthUI() {
    const statusText = document.getElementById('auth-status-text');
    const statusBanner = document.getElementById('auth-status-banner');
    const userField = document.getElementById('ldap-user');
    const passField = document.getElementById('ldap-pass');

    chrome.storage.local.get(['ldap_user', 'ldap_pass'], (res) => {
        if (res.ldap_user) {
            if (userField) userField.value = res.ldap_user;
            if (passField) passField.value = res.ldap_pass;

            statusText.innerText = `Currently logged in as ${res.ldap_user}`;
            statusBanner.className = 'status-active';
            statusBanner.style.background = "#ecfdf5";
            statusBanner.style.borderColor = "#10b981";
        } else {
            if (userField) userField.value = '';
            if (passField) passField.value = '';

            statusText.innerText = `No saved credentials right now`;
            statusBanner.className = 'status-inactive';
            statusBanner.style.background = "var(--bg-soft)";
            statusBanner.style.borderColor = "var(--border)";
        }
    });
}


let recognition;
let isRecognizing = false;
let activeVoiceBtn = null;
let activeTargetInput = null;
let pendingVoiceRequest = null;
let ignoreEndEvent = false;

async function toggleVoiceRecording(targetInputId, btnElement) {
  if (isRecognizing) {
    if (activeVoiceBtn === btnElement) {
      recognition.stop();
      return;
    }
    pendingVoiceRequest = { targetInputId, btnElement };
    recognition.stop();
    return;
  }

  if (!recognition) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showVoiceStatus("Voice API not supported", true, targetInputId);
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isRecognizing = true;
      ignoreEndEvent = false;
      if (activeVoiceBtn) {
        activeVoiceBtn.classList.add("recording");
        activeVoiceBtn.innerHTML = `<span>🛑 Stop Recording</span>`;
        activeVoiceBtn.style.background = "#d9534f";

        if (activeTargetInput) {
             activeTargetInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
             activeTargetInput.focus();
        }
        showVoiceStatus("Listening...", false);
      }
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (activeTargetInput && finalTranscript) {
        const prefix = activeTargetInput.value ? " " : "";
        activeTargetInput.value += prefix + finalTranscript;
      }
    };

    recognition.onerror = (event) => {
      console.error("Voice Error:", event.error);

      if (event.error !== 'no-speech') {
         ignoreEndEvent = true;
         stopRecognitionUI(false);
      }

      if (event.error === 'not-allowed' || event.error === 'permission-denied' || event.error === 'service-not-allowed') {
        const statusEl = getVoiceStatusElement();
        if (statusEl) {
             statusEl.innerHTML = `
                <span style="color:crimson">Microphone blocked.</span> 
                <button id="fixPermBtn" style="margin-left:5px; background:#000; color:#fff; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">
                    Fix Now
                </button>`;

             document.getElementById("fixPermBtn").onclick = () => {
                 chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mic_setup=true") });
             };
        }
      } else {
        showVoiceStatus("Error: " + event.error, true);
      }
    };

    recognition.onend = () => {
      if (!ignoreEndEvent) {
         stopRecognitionUI(true);
      } else {
         isRecognizing = false;
         if (activeVoiceBtn) resetVoiceBtnStyle(activeVoiceBtn);
         activeVoiceBtn = null;
         activeTargetInput = null;
      }

      if (pendingVoiceRequest) {
        const { targetInputId, btnElement } = pendingVoiceRequest;
        pendingVoiceRequest = null;
        ignoreEndEvent = false;
        toggleVoiceRecording(targetInputId, btnElement);
      }
    };
  }

  activeVoiceBtn = btnElement;
  activeTargetInput = document.getElementById(targetInputId);
  showVoiceStatus("Starting...", false);

  try {
    recognition.start();
  } catch (err) {
    isRecognizing = false;
  }
}


document.getElementById('saveCredsBtn').onclick = () => {
  const user = document.getElementById('ldap-user').value;
  const pass = document.getElementById('ldap-pass').value;

  if (!user || !pass) {
    showMessage("Please fill both fields", "settings", true);
    return;
  }

  chrome.storage.local.set({
    'ldap_user': user,
    'ldap_pass': pass
  }, () => {
      console.log("Credentials stored safely");
      updateAuthUI();
      showMessage("Credentials saved!", "settings");
  });
};

document.getElementById('getDailySummaryBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('daily-summary-status');
    const resultEl = document.getElementById('daily-summary-result');
    const btn = document.getElementById('getDailySummaryBtn');
    const summaryDateInput = document.getElementById('dailySummaryDate');
    const selectedDate = summaryDateInput?.value || getTodayIsoDate();

    const storage = await chrome.storage.local.get(['ldap_user', 'ldap_pass']);

    if (!storage.ldap_user || !storage.ldap_pass) {
        statusEl.textContent = "Error: Please set LDAP credentials in settings first.";
        statusEl.style.color = "crimson";
        return;
    }

    statusEl.textContent = `Authenticating with IITB Webmail for ${formatSummaryDate(selectedDate)}...`;
    statusEl.style.color = "inherit";
    btn.disabled = true;
    resultEl.style.display = "none";

    try {
        const dailySummaryBaseUrl = await buildBackendUrl('/api/daily-summary/');
        const dailySummaryUrl = `${dailySummaryBaseUrl}?date=${encodeURIComponent(selectedDate)}`;
        const response = await fetch(dailySummaryUrl, {
            method: 'GET',
            headers: {
                'X-LDAP-User': storage.ldap_user,
                'X-LDAP-Pass': storage.ldap_pass
            }
        });

        const data = await response.json();

        if (!response.ok) {
            statusEl.textContent = `Error: ${data.message || data.error || `Server responded with ${response.status}`}`;
            statusEl.style.color = "crimson";
            resultEl.style.display = "none";
            return;
        }

        if (data.status === "success") {
            const processedTotal = data.stats?.processed_total ?? data.stats?.total ?? 0;
            const mailboxTotal = data.stats?.mailbox_total ?? processedTotal;
            statusEl.textContent = mailboxTotal > processedTotal
              ? `Summary generated for ${formatSummaryDate(data.generated_for || selectedDate)}: ${processedTotal} of ${mailboxTotal} inbox emails.`
              : `Summary generated for ${formatSummaryDate(data.generated_for || selectedDate)}: ${processedTotal} inbox emails.`;
            resultEl.style.display = "block";

            resultEl.innerHTML = renderDailySummaryDashboard(data);
        } else {
            statusEl.textContent = "Error: " + (data.message || "Backend failed");
            statusEl.style.color = "crimson";
        }

    } catch (err) {
        statusEl.textContent = `Network error while loading ${formatSummaryDate(selectedDate)}. Check console.`;
        statusEl.style.color = "crimson";
        console.error("Daily Summary Error:", err);
    } finally {
        btn.disabled = false;
    }
});

function renderDailySummaryDashboard(data) {
    const hasRichData = !!(
        data.overview ||
        data.stats ||
        (Array.isArray(data.action_items) && data.action_items.length) ||
        (Array.isArray(data.recent_emails) && data.recent_emails.length)
    );

    if (!hasRichData) {
        const unread = data.unread_summary || "No unread emails today.";
        const read = data.read_summary || "No read emails today.";

        return `
            <div class="summary-section">
                <h3 style="margin-bottom: 6px;">Unread Emails</h3>
                ${renderStructuredSummary(unread)}
            </div>

            <div class="summary-section" style="margin-top: 20px;">
                <h3 style="margin-bottom: 6px;">Read Emails</h3>
                ${renderStructuredSummary(read)}
            </div>
        `;
    }

    const unread = data.unread_summary || "No unread emails today.";
    const read = data.read_summary || "No read emails today.";

    return `
        <div class="daily-summary-dashboard">
            ${data.overview ? `<div class="daily-overview">${escapeHtml(data.overview)}</div>` : ""}
            ${renderDailyStats(data.stats)}
            ${renderDailyActionItems(data.action_items || [])}
            <div class="daily-summary-split">
                <div class="daily-summary-panel unread-summary-panel">
                    <h3 class="daily-section-title daily-summary-heading unread-heading">🔴 Unread Emails</h3>
                    ${renderStructuredSummary(unread)}
                </div>
                <div class="daily-summary-panel read-summary-panel">
                    <h3 class="daily-section-title daily-summary-heading read-heading">🟢 Read Emails</h3>
                    ${renderStructuredSummary(read)}
                </div>
            </div>
            ${renderDailyEmailSection("Inbox Snapshot", data.recent_emails || [], "No emails arrived today.")}
        </div>
    `;
}

function renderDailyStats(stats = {}) {
    const cards = [
        { label: "Total Today", value: stats.total ?? 0 },
        { label: "Unread", value: stats.unread ?? 0 },
        { label: "Read", value: stats.read ?? 0 },
        { label: "External", value: stats.external_total ?? 0 },
    ];

    const metaLine = (stats.mailbox_total && stats.processed_total && stats.mailbox_total !== stats.processed_total)
      ? `<p class="daily-meta-line">Processed ${stats.processed_total} of ${stats.mailbox_total} inbox emails that matched today's search.</p>`
      : "";

    return `
        <div class="daily-stats-grid">
            ${cards.map(card => `
                <div class="daily-stat-card">
                    <div class="daily-stat-value">${escapeHtml(String(card.value))}</div>
                    <div class="daily-stat-label">${escapeHtml(card.label)}</div>
                </div>
            `).join("")}
        </div>
        ${metaLine}
    `;
}

function renderDailyActionItems(actionItems = []) {
    const content = actionItems.length
      ? actionItems.map(item => {
            const priority = (item.priority || "medium").toLowerCase();
            const status = (item.status || "unread").toLowerCase();
            const source = (item.source || "internal").toLowerCase();

            return `
                <div class="daily-action-card">
                    <div class="daily-action-header">
                        <h3>${escapeHtml(item.title || "Action item")}</h3>
                        <div class="daily-pill-row">
                            <span class="daily-pill priority-${escapeHtml(priority)}">${escapeHtml(priority)}</span>
                            <span class="daily-pill source-${escapeHtml(source)}">${escapeHtml(source)}</span>
                            <span class="daily-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>
                        </div>
                    </div>
                    <p>${escapeHtml(item.detail || "No extra detail available.")}</p>
                </div>
            `;
        }).join("")
      : `<div class="daily-empty-state">No concrete action items were detected from today's inbox.</div>`;

    return `
        <div class="daily-section">
            <h3 class="daily-section-title">Action Items</h3>
            <div class="daily-action-list">${content}</div>
        </div>
    `;
}

function renderDailyEmailSection(title, emails = [], emptyMessage) {
    const content = emails.length
      ? emails.map(email => {
            const source = (email.source || "internal").toLowerCase();
            const status = (email.status || "read").toLowerCase();

            return `
                <div class="daily-email-card">
                    <div class="daily-email-topline">
                        <strong>${escapeHtml(email.subject || "(No subject)")}</strong>
                        <span class="daily-email-time">${escapeHtml(email.received_label || "Today")}</span>
                    </div>
                    <div class="daily-email-meta">
                        <span>${escapeHtml(email.sender || "Unknown sender")}</span>
                        <div class="daily-pill-row">
                            <span class="daily-pill source-${escapeHtml(source)}">${escapeHtml(source)}</span>
                            <span class="daily-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>
                        </div>
                    </div>
                    <p>${escapeHtml(email.snippet || "No preview available.")}</p>
                </div>
            `;
        }).join("")
      : `<div class="daily-empty-state">${escapeHtml(emptyMessage)}</div>`;

    return `
        <div class="daily-section">
            <h3 class="daily-section-title">${escapeHtml(title)}</h3>
            <div class="daily-email-list">${content}</div>
        </div>
    `;
}

function renderStructuredSummary(text) {
    const lines = text.split('\n').filter(l => l.trim() !== "");
    let html = "";
    let inList = false;

    for (let rawLine of lines) {
        let line = rawLine.trim();
        if (line.startsWith("-") || line.startsWith("*")) {

            if (!inList) {
                html += "<ul class='daily-structured-list' style='margin: 6px 0 10px 18px; padding: 0;'>";
                inList = true;
            }
            line = line.replace(/^[-*]\s*/, "");

            html += `<li style="margin-bottom: 4px;">${renderSafeInlineMarkdown(line)}</li>`;
        }
        else {
            if (inList) {
                html += "</ul>";
                inList = false;
            }

            html += `<div class="daily-structured-heading" style="font-weight: 600; margin-top: 10px;">${renderSafeInlineMarkdown(line)}</div>`;
        }
    }

    if (inList) {
        html += "</ul>";
    }

    return html;
}

function getVoiceStatusElement() {
  if (!activeTargetInput) return null;
  if (activeTargetInput.id === 'composeIntent') return document.getElementById('compose-status');
  if (activeTargetInput.id === 'replyPrompt') return document.getElementById('reply-status');
  return document.getElementById('status');
}

function showVoiceStatus(msg, isError, forcedInputId = null) {
  let el;
  if (forcedInputId) {
      if (forcedInputId === 'composeIntent') el = document.getElementById('compose-status');
      else if (forcedInputId === 'replyPrompt') el = document.getElementById('reply-status');
  } else {
      el = getVoiceStatusElement();
  }

  if (el) {
    el.textContent = msg;
    el.style.color = isError ? "crimson" : "inherit";
  }
}

function resetVoiceBtnStyle(btn) {
  btn.classList.remove("recording");
  btn.style.background = "";
  btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
      </svg>
      <span>Voice Typing</span>`;
}
function stopRecognitionUI(resetMessage = true) {
  isRecognizing = false;
  if (activeVoiceBtn) resetVoiceBtnStyle(activeVoiceBtn);

  if (resetMessage) showVoiceStatus("", false);

  if (resetMessage) {
      activeVoiceBtn = null;
      activeTargetInput = null;
  }
}

async function getOpenedMail(cb) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showMessage("No active tab", "summary", true);
    return;
  }

  if (!tab.url || !tab.url.includes("webmail.iitb.ac.in")) {
    cb({ ok: false, error: "mail_only_on_webmail" });
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "GET_OPENED_MAIL" }, (response) => {
    if (!chrome.runtime.lastError) {
      cb(response);
      return;
    }

    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, files: ["content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          showMessage("Could not access the current mail tab", "summary", true);
          return;
        }

        chrome.tabs.sendMessage(tab.id, { type: "GET_OPENED_MAIL" }, cb);
      }
    );
  });
}


function actionSummarize() {
  showMessage("Summarizing...", "summary");
  openAccordionSoft("summary-section");

  getOpenedMail(resp => {
    if (!resp || !resp.ok) {
      showMessage(resp?.error === "mail_only_on_webmail" ? "Open IITB webmail to use this feature" : "No mail detected", "summary", true);
      return;
    }

    const body = resp.mail.body;
    const mode = document.getElementById("mode").value;

    const combinedPrompt = `
Follow the instructions for Task 1 and Task 2 separately based on the email provided.
- Recurring office hours or weekly schedules without a specific calendar date

 ---TASK 1: EMAIL SUMMARY (PARAGRAPH FORMAT) ---
You will summarize an email strictly in a single concise paragraph.

Ignore:
- unsubscribe warnings
- boilerplate
- OTP / authentication texts
- banners of "="
- automated disclaimers
- email confidentiality notices
- repeated headers or signatures
- emotional filler

Rules:
- The paragraph must contain at most the same information as ${mode === "brief" ? "3" : "5"} bullet points would
- Use clear, concise sentences
- Only extract actionable or informational meaning
- Highlight deadlines or required actions explicitly in text
- Do not repeat information
- Do not hallucinate
- If nothing meaningful exists, output exactly: "No action required."
- Do NOT extract recurring weekly schedules or office hours

--- TASK 2: EVENT DETECTION ---
You are a precise calendar event extractor.
If an event specifies a time range (e.g., "6 AM to 4 PM"),
extract BOTH startTime and endTime.

Output format for each event:
{
  "title": string,
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM or null",
  "endTime": "HH:MM or null",
  "description": string
}

Your task is to analyze the email text below and determine whether it contains
ANY calendar-worthy events that the user should reasonably add to their calendar.

Calendar-worthy events INCLUDE (but are not limited to):
- Meetings, calls, interviews, or appointments
- Classes, lectures, sessions, workshops, seminars, or programs
- Exams, quizzes, evaluations, or assessments
- Assignments, submissions, tasks, or deliverables with a due date
- Deadlines, or last dates to act
- Any event where the user is expected to DO something on a specific date
- Events that are one-time or fixed to a particular day or time

Calendar-worthy events DO NOT include:
- Purely promotional emails
- General announcements with no required action
- Informational notices with no clear date
- Ongoing reminders without a specific date
- Vague references like "soon", "next week", or "in the future" without a date

Time interpretation rules:
- If a specific time is explicitly mentioned, use it
- If the email mentions "EOD" or "end of day", interpret the time as 23:59
- If no time is mentioned, set "startTime" and "endTime" to null.
- Do NOT guess or infer times other than the EOD rule above

Decision rules:
- A CLEAR date is REQUIRED (YYYY-MM-DD must be derivable)
- Time is OPTIONAL (set to null if not explicitly mentioned)
- IF MULTIPLE EVENTS EXIST, EXTRACT ALL OF THEM
- Do NOT infer or guess missing dates or times
- Do NOT hallucinate titles, dates, or descriptions
- If no events are found, return an empty list for "events"
- Do NOT extract recurring weekly schedules or office hours

--- OUTPUT FORMAT ---
You must provide the output in two distinct sections. 

[SUMMARY]
<Provide the summary for Task 1 here>

[CALENDAR_JSON]
<Provide the JSON object for Task 2 here - EXACTLY as requested: { "hasEvent": boolean, "events": [ { "title": string, "date": "YYYY-MM-DD", "startTime": "HH:MM or null", "endTime": "HH:MM or null", "description": string } ] }>

EMAIL:
${body.slice(0, 12000)}
`;

    sendToGemini(combinedPrompt, res => {
        if (!res || !res.ok) {
          showMessage("Gemini failed", "summary", true);
          return;
        }

        const parts = res.text.split("[CALENDAR_JSON]");
        const summaryPart = parts[0].replace("[SUMMARY]", "").trim();
        const jsonPart = parts[1] ? parts[1].trim().replace(/```json/g, "").replace(/```/g, "") : null;

        renderSummary(summaryPart);
        showMessage("Summary ready", "summary");

        calendarChecked = true;
        if (jsonPart) {
          try {
            const parsed = JSON.parse(jsonPart);
            const validEvents = (parsed.events || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date));

            if (parsed.hasEvent && validEvents.length > 0) {
              renderCalendarResult(validEvents);
              openAccordionSoft("calendar-section");
            } else {
              renderCalendarResult([]);
            }
          } catch (e) {
            console.error("Combined JSON Parse Error:", e);
            renderCalendarResult([]);
          }
        } else {
          renderCalendarResult([]);
        }
      }
    );
  });
}


function actionCalendarOnly() {
  showMessage("Checking...", "calendar");
  openAccordionSoft("calendar-section");

  getOpenedMail(resp => {
    if (!resp || !resp.ok) {
      showMessage(resp?.error === "mail_only_on_webmail" ? "Open IITB webmail to use this feature" : "No mail detected", "calendar", true);
      return;
    }

    const body = resp.mail.body;

    const prompt = `
You are a precise calendar event extractor.
If an event specifies a time range (e.g., "6 AM to 4 PM"),
extract BOTH startTime and endTime.

Output format for each event:
{
  "title": string,
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM or null",
  "endTime": "HH:MM or null",
  "description": string
}

Your task is to analyze the email text below and determine whether it contains
ANY calendar-worthy events that the user should reasonably add to their calendar.
Recurring office hours or weekly schedules without a specific calendar date

Calendar-worthy events INCLUDE (but are not limited to):
- Meetings, calls, interviews, or appointments
- Classes, lectures, sessions, workshops, seminars, or programs
- Exams, quizzes, evaluations, or assessments
- Assignments, submissions, tasks, or deliverables with a due date
- Deadlines, or last dates to act
- Any event where the user is expected to DO something on a specific date
- Events that are one-time or fixed to a particular day or time

Calendar-worthy events DO NOT include:
- Purely promotional emails
- General announcements with no required action
- Informational notices with no clear date
- Ongoing reminders without a specific date
- Vague references like "soon", "next week", or "in the future" without a date

Time interpretation rules:
- If a specific time is explicitly mentioned, use it
- If the email mentions "EOD" or "end of day", interpret the time as 23:59
- If no time is mentioned, set "startTime" and "endTime" to null.
- Do NOT guess or infer times other than the EOD rule above

Decision rules:
- A CLEAR date is REQUIRED (YYYY-MM-DD must be derivable)
- Time is OPTIONAL (set to null if not explicitly mentioned)
- IF MULTIPLE EVENTS EXIST, EXTRACT ALL OF THEM
- Do NOT infer or guess missing dates or times
- Do NOT hallucinate titles, dates, or descriptions
- Do NOT extract recurring weekly schedules or office hours

If events ARE detected, return STRICT JSON ONLY in this format:
{
  "hasEvent": true,
  "events": [
    {
      "title": "short, clear event title",
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM or null",
      "endTime": "HH:MM or null",
      "description": "one-line explanation"
    }
  ]
}

If NO events are detected, return EXACTLY:
{ "hasEvent": false, "events": [] }

Output JSON ONLY. No explanations. No markdown.
EMAIL:
${body.slice(0, 12000)}
`;

    sendToGemini(prompt, res => {
        calendarChecked = true;
        if (!res || !res.ok) {
          renderCalendarResult([]);
          showMessage("Failed", "calendar", true);
          return;
        }
        try {
          const jsonMatch = res.text.match(/\{[\s\S]*\}/);
          const cleanJson = jsonMatch ? jsonMatch[0] : "{}";
          const parsed = JSON.parse(cleanJson);
          const validEvents = (parsed.events || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
          renderCalendarResult(validEvents);
          showMessage("", "calendar");
        } catch (e) {
          console.error("Single Path JSON Parse Error:", e);
          renderCalendarResult([]);
        }
      }
    );
  });
}


function actionReply() {
  showMessage("Generating reply…", "reply");
  openAccordionSoft("reply-section");

  getOpenedMail(resp => {
    if (!resp || !resp.ok) {
      showMessage(resp?.error === "mail_only_on_webmail" ? "Open IITB webmail to use this feature" : "No mail detected", "reply", true);
      return;
    }

    const body = resp.mail.body;
    const userInstruction = document.getElementById("replyPrompt")?.value.trim();

    const prompt = `
You are an expert AI Email Assistant for the IIT Bombay community. 
Analyze the ORIGINAL EMAIL and USER INSTRUCTION to draft a professional reply.

DECISION LOGIC (MANDATORY):
1. DEFAULT BEHAVIOR: If USER INSTRUCTION is empty or vague, draft an [ACKNOWLEDGEMENT].
2. [ACKNOWLEDGEMENT/THANK YOU]: Professionally confirm receipt, express gratitude, or state that the information has been noted.
3. [REPLY]: Only provide specific answers if the USER INSTRUCTION contains the facts to do so.
4. [CLARIFICATION]: Only ask questions if the USER INSTRUCTION explicitly asks to inquire further.

STRICT RULES:
- TONE: Professional academic tone. 
- FORMAT: Unlike the standalone mail, write ONLY the content from Salutation to Signature.
- DO NOT ask questions unless the user explicitly tells you to ask one.
- DO NOT invent commitments.

SALUTATION & SIGN-OFF:
- Use "Dear Professor," or "Dear [Name]," based on the original sender.
- End with "Thank you," "Regards," or "Sincerely," depending on the hierarchy.

EXAMPLE (Default/Vague Instruction):
Original: "Meeting is moved to 4 PM in the lounge."
Instruction: "" (Empty)
AI Result: 
Dear Professor,
Thank you for the update regarding the meeting time and venue. I have noted the change.
Regards,
[Your Name]

OUTPUT FORMAT (MANDATORY):
[INTENT]
<REPLY | CLARIFICATION | ACKNOWLEDGEMENT>

[EMAIL]
<Salutation>,

<Email body content.>

<Context-appropriate Sign-off>,
[Your Name]
[Your Roll Number/Department]

USER INSTRUCTION:
${userInstruction || "(none)"}

ORIGINAL EMAIL:
${body.slice(0, 12000)}
`;

    sendToGemini(prompt, res => {
        if (!res || !res.ok) {
          showMessage("Reply generation failed", "reply", true);
          return;
        }

        const raw = res.text || "";
        const emailPart = raw.split("[EMAIL]")[1];

        if (!emailPart) {
          showMessage("Failed to generate email", "reply", true);
          return;
        }

        const finalEmail = emailPart.trim();
        currentReplyText = finalEmail;
        renderReply(finalEmail);
        showMessage("Reply ready", "reply");
      }
    );
  });
}


function renderReply(text) {
  const out = document.getElementById("reply-result");
  if (!out) return;

  out.className = "summary-card";

  out.innerHTML = `
    <pre style="white-space:pre-wrap; margin-bottom: 12px;">${escapeHtml(text)}</pre>
    
    <div style="display: flex; gap: 10px; margin-bottom: 10px;">
      <button id="shortenReply" class="primary-btn" style="flex: 1; padding: 8px; font-size: 12px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">Shorten</button>
      <button id="formalizeReply" class="primary-btn" style="flex: 1; padding: 8px; font-size: 12px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">Formalize</button>
    </div>

    <button id="injectReplyBtn" class="primary-btn" style="width:100%; background:#000; color:#fff; border: none; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer;">
        Inject into Reply Box
    </button>
  `;

  document.getElementById("injectReplyBtn").onclick = () => {
    injectToWebmail(text, null);
  };

  document.getElementById("shortenReply").onclick = () => {
    modifyReply('shorten');
  };

  document.getElementById("formalizeReply").onclick = () => {
    modifyReply('formalize');
  };
}

function modifyReply(mode) {
  if (!currentReplyText) {
    showMessage("Generate a reply first", "reply", true);
    return;
  }
  showMessage(`${mode === 'shorten' ? 'Shortening' : 'Formalizing'}...`, "reply");

  const prompt = `Take the following email reply and ${mode === 'shorten' ? 'make it significantly shorter and more concise' : 'make the tone more formal and professional'}. 
  Maintain the original intent. Output ONLY the modified reply text.
  
  REPLY:
  ${currentReplyText}`;

  sendToGemini(prompt, res => {
      if (!res || !res.ok) {
        showMessage("Modification failed", "reply", true);
        return;
      }
      currentReplyText = res.text;
      renderReply(res.text);
      showMessage("Reply updated", "reply");
    }
  );
}


function actionCompose() {
  const intent = document.getElementById("composeIntent")?.value.trim();
  if (!intent) {
    showMessage("Enter what you want to write", "compose", true);
    return;
  }

  showMessage("Composing Mail...", "compose");

  const prompt = `
You are an expert academic and professional correspondent at a premier institute (IIT Bombay). 
Your task is to compose a NEW standalone email based ONLY on the user's intent.

TONE & STYLE:
- Professional, academic, and highly courteous.
- Direct and purposeful: the first sentence must clearly state the reason for writing.
- Neutral formality suitable for Professors, Deans, Institute Bodies, or Colleagues.

STRICT GUARDRAILS:
- DO NOT invent names, dates, or facts. Use [Name] or [Details] if unknown.
- NO emojis, slang, or casual fillers.
- NO "Hope you are well" or generic apologies.
- The Salutation and Signature MUST be included within the "Body" section for correct injection.

SALUTATION GUIDELINES:
- To a Professor: "Dear Professor [Name]," or "Respected Professor,".
- To an Office/Body: "To the [Department Name] Office," or "Dear Sir/Madam,".
- To a Peer/Staff member: "Dear [Name]," or "Hi [Name]," (if professional relationship is established).
- Use context-appropriate greetings like "Good morning," only if the intent implies immediate timing.

SIGNATURE GUIDELINES:
- Formal (Faculty/Administration): "Sincerely," or "Respectfully,".
- Professional (Staff/General Office): "Regards," or "Thank you,".
- Collaborative (Peers/TAs): "Best regards," or "Thanks,".

EXAMPLE:
Intent: Ask Prof. Sharma for a meeting about the project.
Subject: Request for Meeting: [Project Name]
Body: Dear Professor Sharma,
I am writing to request a brief meeting to discuss the current progress of our project. I am available during your office hours or at any other time convenient for you.
Respectfully,
[Your Name]

OUTPUT FORMAT (STRICTLY FOLLOW THIS):
Subject: <One specific, professional subject line>

Body:
<Salutation>,

<Well-structured email body stating purpose and details.>

<Context-appropriate Sign-off>,
[Your Name]
[Your Roll Number/Department]

Intent:
${intent}
`;

    sendToGemini(prompt, res => {
        if (!res || !res.ok) {
          showMessage("Compose failed", "compose", true);
          return;
        }

        let subject = "New Mail";
        let body = res.text;

        if (res.text.toLowerCase().includes("subject:")) {
            const parts = res.text.split(/body:/i);
            subject = parts[0].replace(/subject:/i, "").trim();
            body = parts[1] ? parts[1].trim() : res.text;
            body = body.split(/signature:/i)[0].trim();
        }

        currentComposeText = res.text;
        renderCompose(res.text, subject, body);
        showMessage("Draft ready. Click 'Inject' to transfer to Webmail.", "compose");
      }
    );
}

function modifyCompose(mode) {
  if (!currentComposeText) {
    showMessage("Generate an email first", "compose", true);
    return;
  }
  showMessage(`${mode === 'shorten' ? 'Shortening' : 'Formalizing'}...`, "compose");

  const prompt = `Take the following email draft and ${mode === 'shorten' ? 'make it significantly shorter and more concise' : 'make the tone more formal and professional'}. 
  Maintain the original intent. Keep the "Subject: " line if present. Output ONLY the modified text.
  
  EMAIL DRAFT:
  ${currentComposeText}`;

  sendToGemini(prompt, res => {
      if (!res || !res.ok) {
        showMessage("Modification failed", "compose", true);
        return;
      }

      currentComposeText = res.text;

      let subject = "New Mail";
      let body = res.text;

      if (res.text.toLowerCase().includes("subject:")) {
          const parts = res.text.split(/body:/i);
          subject = parts[0].replace(/subject:/i, "").trim();
          body = parts[1] ? parts[1].trim() : res.text;
          body = body.split(/signature:/i)[0].trim();
      }

      renderCompose(res.text, subject, body);
      showMessage("Email updated", "compose");
    }
  );
}

function renderCompose(fullText, subject, body) {
  const out = document.getElementById("compose-result");
  out.className = "summary-card";
  out.innerHTML = `
    <div class="ai-response-text" style="white-space:pre-wrap">${escapeHtml(fullText)}</div>
    <div style="display: flex; gap: 10px; margin-top: 10px;">
      <button id="shortenCompose" class="primary-btn" style="flex: 1; padding: 8px; font-size: 12px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">Shorten</button>
      <button id="formalizeCompose" class="primary-btn" style="flex: 1; padding: 8px; font-size: 12px; background: #000; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">Formalize</button>
    </div>
    <button id="injectComposeBtn" class="primary-btn" style="width:100%; margin-top:10px; background:#000; color:#fff;">
        Inject into New Mail
    </button>
  `;

  document.getElementById("injectComposeBtn").onclick = () => {
    injectToWebmail(body, subject);
  };

  document.getElementById("shortenCompose").onclick = () => modifyCompose('shorten');
  document.getElementById("formalizeCompose").onclick = () => modifyCompose('formalize');
}


document.addEventListener("DOMContentLoaded", () => {
  updateAuthUI();
  const urlParams = new URLSearchParams(window.location.search);
  const dailySummaryDateInput = document.getElementById("dailySummaryDate");
  if (dailySummaryDateInput && !dailySummaryDateInput.value) {
    dailySummaryDateInput.value = getTodayIsoDate();
  }
  if (urlParams.get('mic_setup') === 'true') {
      document.body.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:'Inter',sans-serif; text-align:center; padding:20px;">
            <div style="font-size:40px; margin-bottom:20px;">🎙️</div>
            <h2 style="margin:0 0 10px 0;">Microphone Setup</h2>
            <p id="permText" style="color:#666; line-height:1.5;">
               Browser requires permission to use Voice Typing.<br>
               Check the <b>top-left</b> of this window and click <b>Allow</b>.
            </p>
        </div>`;

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(() => {
            const permText = document.getElementById("permText");
            permText.innerHTML = `
                <span style="color:#166534; font-weight:bold; font-size:16px;">Success! You're all set.</span><br><br>
                <button id="closeSetupBtn" style="background:#000; color:#fff; border:none; padding:10px 20px; border-radius:8px; cursor:pointer; font-weight:600;">
                    Close this Tab
                </button>`;

            document.getElementById("closeSetupBtn").addEventListener("click", () => {
                window.close();
            });
        })
        .catch(err => {
            document.getElementById("permText").innerHTML = `
                <span style="color:crimson; font-weight:bold;">Permission Blocked.</span><br>
                Click the 🔒 lock icon in the address bar (top left) and toggle <b>Microphone</b> to ON.`;
        });

      return;
  }

  const apiKeyInput = document.getElementById("userApiKey");
  const modelSelect = document.getElementById("modelSelect");

  if (apiKeyInput || modelSelect) {
    chrome.storage.local.get(['customApiKey', 'selectedModel'], (result) => {
      const hasKey = !!result.customApiKey;
      if (apiKeyInput && result.customApiKey) {
        apiKeyInput.value = result.customApiKey;
      }

      if (modelSelect) {
        const upgradedModel = RETIRED_MODEL_REPLACEMENTS[result.selectedModel] || result.selectedModel;
        const savedModel = SUPPORTED_CUSTOM_MODELS.includes(upgradedModel) ? upgradedModel : DEFAULT_MODEL;
        if (upgradedModel && upgradedModel !== result.selectedModel) {
          chrome.storage.local.set({ selectedModel: savedModel });
        }
        modelSelect.value = savedModel;
        if (!hasKey) {
          modelSelect.value = DEFAULT_MODEL;
          modelSelect.disabled = true;
          showMessage(`Model locked to ${DEFAULT_MODEL} until you add an API key`, "setup");
        } else {
          modelSelect.disabled = false;
        }
      }
    });
  }

  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      if (modelSelect.disabled) {
        showMessage("Enter API Key to change model", "setup", true);
        modelSelect.value = DEFAULT_MODEL;
        return;
      }
      chrome.storage.local.set({ selectedModel: modelSelect.value }, () => {
        showMessage(`Model set to ${modelSelect.value}`, "setup");
      });
    });
  }

  const backendInput = document.getElementById("backendBaseUrl");
  if (backendInput) {
    chrome.storage.local.get(["backendBaseUrl"], (res) => {
      backendInput.value = res.backendBaseUrl || "";
    });
    backendInput.addEventListener("change", () => {
      const value = backendInput.value.trim().replace(/\/+$/, "");
      if (value) chrome.storage.local.set({ backendBaseUrl: value });
      else chrome.storage.local.remove(["backendBaseUrl"]);
      showMessage(value ? `Backend set to ${value}` : "Using hosted backend", "setup");
    });
  }

  const saveSettingsBtn = document.getElementById("saveSettings");
  if (false && saveSettingsBtn) {
    saveSettingsBtn.onclick = async () => {
      const key = apiKeyInput.value.trim();

      if (!key) {
        chrome.storage.local.remove('customApiKey', () => {
          if (modelSelect) {
            modelSelect.value = DEFAULT_MODEL;
            modelSelect.disabled = true;
            chrome.storage.local.set({ selectedModel: DEFAULT_MODEL });
          }
          showMessage("API Key cleared.", "setup");
        });
        return;
      }

      showMessage("Verifying key...", "setup");

      try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
        const response = await fetch(testUrl);

        if (response.ok) {
          chrome.storage.local.set({ customApiKey: key }, () => {
            if (modelSelect) {
              modelSelect.disabled = false;
              showMessage(`Saved Successfully! Model selection enabled.`, "setup");
            } else {
              showMessage("Saved Successfully!", "setup");
            }
          });
        } else {
          const errorData = await response.json();
          const errorMsg = errorData.error?.message || "Invalid Key";
          showMessage(`❌ Error: ${errorMsg}`, "setup", true);
        }
      } catch (err) {
        showMessage("❌ Connection failed", "setup", true);
      }
    };
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.onclick = async () => {
      const key = apiKeyInput.value.trim();

      if (!key) {
        chrome.storage.local.remove(['customApiKey'], async () => {
          if (modelSelect) {
            modelSelect.value = DEFAULT_MODEL;
            modelSelect.disabled = true;
            await chrome.storage.local.set({ selectedModel: DEFAULT_MODEL });
          }
          showMessage("API key cleared.", "setup");
        });
        return;
      }

      showMessage("Verifying key...", "setup");

      try {
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
        const response = await fetch(testUrl);

        if (response.ok) {
          chrome.storage.local.set({ customApiKey: key }, () => {
            if (modelSelect) {
              modelSelect.disabled = false;
            }
            showMessage("Saved successfully. Model selection enabled.", "setup");
          });
        } else {
          const errorData = await response.json();
          const errorMsg = errorData.error?.message || "Invalid Key";
          showMessage(`Error: ${errorMsg}`, "setup", true);
        }
      } catch (err) {
        showMessage("Connection failed", "setup", true);
      }
    };
  }

  document.querySelectorAll(".accordion-item").forEach(section => {
    section.classList.remove("active");
  });

  const summBtn = document.getElementById("summMail");
  const replyBtn = document.getElementById("replyMail");
  const compBtn = document.getElementById("composeMail");
  const calOnlyBtn = document.getElementById("calOnly");
  const manualBtn = document.getElementById("manualEntry");
  const shortenBtn = document.getElementById("shortenReply");
  const formalizeBtn = document.getElementById("formalizeReply");

  const recordBtnReply = document.getElementById("recordBtnReply");
  const recordBtnCompose = document.getElementById("recordBtnCompose");

  if (summBtn) summBtn.onclick = actionSummarize;
  if (replyBtn) replyBtn.onclick = actionReply;
  if (compBtn) compBtn.onclick = actionCompose;
  if (calOnlyBtn) calOnlyBtn.onclick = actionCalendarOnly;
  if (shortenBtn) shortenBtn.onclick = () => modifyReply('shorten');
  if (formalizeBtn) formalizeBtn.onclick = () => modifyReply('formalize');

  if (recordBtnReply) {
    recordBtnReply.onclick = () => toggleVoiceRecording("replyPrompt", recordBtnReply);
  }
  if (recordBtnCompose) {
    recordBtnCompose.onclick = () => toggleVoiceRecording("composeIntent", recordBtnCompose);
  }

  if (manualBtn) {
    manualBtn.onclick = () => {
      calendarChecked = false;
      renderCalendarResult(null, true);
    };
  }

  const switchBtn = document.getElementById("switchAccountBtn");
  if (switchBtn) {
    switchBtn.onclick = () => {
      if (confirm("Are you sure you want to switch Google accounts?")) {
        chrome.runtime.sendMessage({ type: "SWITCH_GOOGLE_ACCOUNT" });
      }
    };
  }
    const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.onclick = handleLDAPLogout;
  }

  const syncWindowBtn = document.getElementById("syncWindowBtn");
  if (syncWindowBtn) {
    syncWindowBtn.onclick = () => runMailWindowSync({ force: true });
  }

  const openChatWindowBtn = document.getElementById("openChatWindowBtn");
  if (openChatWindowBtn) {
    openChatWindowBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: "OPEN_CHAT_WINDOW" }, (result) => {
        if (!result || !result.ok) {
          showMessage("Could not open the chat window.", "setup", true);
        }
      });
    };
  }
  refreshMailWindowStatus();

  if (typeof initChat === "function") initChat();
  document.querySelectorAll(".accordion-item").forEach(section => {
    const header = section.querySelector(".accordion-header");
    if (header) header.addEventListener("click", () => toggleAccordion(section));
  });

  renderCalendarResult(null);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GOOGLE_ACCOUNT_SWITCH_RESULT") {
    showMessage(msg.message || (msg.status === "success" ? "Google account switched successfully." : "Google account switch failed."), "calendar", msg.status !== "success");
    return;
  }

  if (msg.type === "CALENDAR_RESULT") {
    showMessage("", "calendar");
    const card = document.getElementById(msg.cardId);
    if (!card) return;
    const waitingArea = card.querySelector('.status-waiting') || card.querySelector(`[class^="action-container"]`);
    if (!waitingArea) return;

    if (msg.status === "success") {
      const isActuallyUpdated = cardEventIds[msg.cardId] ? true : false;
      if (msg.eventId) cardEventIds[msg.cardId] = msg.eventId;

      card.querySelectorAll('input, textarea').forEach(el => {
        el.disabled = true;
        el.style.opacity = "0.8";
      });

      waitingArea.innerHTML = `
        <div class="success-badge-container" style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; margin-top: 10px;">
          <span class="success-text-icon" style="color: #166534; font-weight: 600; font-size: 13px;">
            ✓ ${isActuallyUpdated ? 'Updated in Calendar' : 'Added to Calendar'}
          </span>
          <button class="edit-btn">Edit</button>
        </div>
      `;
      card.style.borderColor = "#bbf7d0";

      const editBtn = waitingArea.querySelector('.edit-btn');
      if (editBtn) {
        editBtn.onclick = () => {
          card.querySelectorAll('input, textarea').forEach(el => el.disabled = false);
          const idx = card.querySelector('input').id.split('-').pop();
          waitingArea.innerHTML = `
            <div class="edit-actions-group" style="display: flex; gap: 10px; margin-top: 10px;">
              <button class="primary-btn large-btn confirm-btn" style="flex: 2;" data-index="${idx}" data-card-id="${msg.cardId}">Confirm & Sync</button>
              <button class="back-btn">Back</button>
            </div>
          `;
          const backBtn = waitingArea.querySelector('.back-btn');
          if (backBtn) {
            backBtn.onclick = () => {
              chrome.runtime.onMessage.dispatch({ type: "CALENDAR_RESULT", status: "success", cardId: msg.cardId });
            };
          }
          attachConfirmListeners(waitingArea);
        };
      }
    } else {
      waitingArea.innerHTML = `
        <div style="text-align: center; padding: 10px; border: 1px solid #fee2e2; border-radius: 8px; background: #fff5f5;">
          <p style="color: #991b1b; font-size: 12px; margin-bottom: 5px;">❌ Failed: ${msg.message || "Error"}</p>
          <button class="instant-retry-btn" style="background:#000; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:600;">Try Again</button>
        </div>`;

      const retryBtn = waitingArea.querySelector('.instant-retry-btn');
      if (retryBtn) {
        retryBtn.onclick = () => {
          waitingArea.innerHTML = `<div class="status-waiting" style="text-align: center; padding: 10px;"><p style="color: #666; font-size: 13px;">Retrying...</p></div>`;
          const idx = card.querySelector('input').id.split('-').pop();
          const retryData = {
              title: document.getElementById(`edit-title-${idx}`).value,
              date: document.getElementById(`edit-date-${idx}`).value,
              startTime: document.getElementById(`edit-time-${idx}`).value,
              endTime: document.getElementById(`edit-endtime-${idx}`).value,
              description: document.getElementById(`edit-desc-${idx}`).value
          };
          chrome.runtime.sendMessage({ type: "ADD_CALENDAR_EVENT", eventData: retryData, cardId: msg.cardId });
        };
      }
    }
  }

});
