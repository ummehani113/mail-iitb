const CHAT_HISTORY_KEY = "chatHistory";
const CHAT_HISTORY_LIMIT = 40;
const CHAT_TURN_LIMIT = 1500;
const CHAT_TURNS_SENT = 6;

const CHAT_SUGGESTIONS = [
  "Any deadlines in the next 7 days?",
  "Any quizzes, exams or submissions coming up?",
  "Did anyone ask me to reply or do something?",
  "Any mails from professors or TAs?",
  "What events or talks are happening this week?",
  "Any internship, job or application openings?",
];

let chatBusy = false;

function chatStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function escapeChatHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline formatting for one escaped line: **bold**, `code`, [E12] chips, and
// any leftover asterisks removed.
function formatChatInline(html, uidById) {
  let out = html;
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1$2"); // *italic* -> plain
  out = out.replace(/\*/g, "");
  out = out.replace(/\[(E\d+)\]/g, (match, id) => {
    const uid = uidById[String(Number(id.slice(1)))];
    if (!uid) return match;
    return `<span class="chat-citation" data-uid="${uid}" title="Open this email">${id}</span>`;
  });
  // "[E3][E5]" -> small gap between chips
  out = out.replace(/<\/span><span class="chat-citation"/g, '</span> <span class="chat-citation"');
  return out;
}

// Turns Gemini's markdown-ish reply into clean HTML: paragraphs, bullet and
// numbered lists, bold. Headings become bold lines. No stray asterisks.
function formatChatText(text, uidById = {}) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let list = null; // { type: "ul" | "ol", items: [] }

  const flushList = () => {
    if (!list) return;
    parts.push(`<${list.type} class="chat-list">${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const escaped = escapeChatHtml(line);
    const bullet = escaped.match(/^(?:[-*•‣▪]|–)\s+(.*)$/);
    const numbered = escaped.match(/^(\d{1,2})[.)]\s+(.*)$/);
    const heading = escaped.match(/^#{1,6}\s+(.*)$/);

    if (bullet) {
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(formatChatInline(bullet[1], uidById));
    } else if (numbered) {
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(formatChatInline(numbered[2], uidById));
    } else if (heading) {
      flushList();
      parts.push(`<p class="chat-heading"><strong>${formatChatInline(heading[1].replace(/\*\*/g, ""), uidById)}</strong></p>`);
    } else {
      flushList();
      parts.push(`<p>${formatChatInline(escaped, uidById)}</p>`);
    }
  }
  flushList();
  return parts.join("");
}

function collectChatCitations(text, uidById) {
  const found = {};
  const pattern = /\[(E\d+)\]/g;
  let match = pattern.exec(String(text || ""));
  while (match) {
    const key = String(Number(match[1].slice(1)));
    if (uidById[key]) found[key] = uidById[key];
    match = pattern.exec(String(text || ""));
  }
  return found;
}

async function loadChatHistory() {
  const stored = await chatStorage([CHAT_HISTORY_KEY]);
  const history = stored[CHAT_HISTORY_KEY];
  return Array.isArray(history) ? history : [];
}

async function saveChatHistory(history) {
  const trimmed = history.slice(-CHAT_HISTORY_LIMIT);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CHAT_HISTORY_KEY]: trimmed }, resolve);
  });
}

async function clearChatHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CHAT_HISTORY_KEY]: [] }, resolve);
  });
}

function setChatStatus(message) {
  const statusEl = document.getElementById("chat-status");
  if (statusEl) statusEl.textContent = message || "";
}

function renderChatBubble(role, html, options = {}) {
  const container = document.getElementById("chat-messages");
  if (!container) return null;

  const empty = container.querySelector(".chat-empty");
  if (empty) empty.remove();

  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-${role}${options.thinking ? " chat-thinking" : ""}`;
  bubble.innerHTML = html;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderChatMessage(entry) {
  const uidById = entry.uids || {};
  if (entry.role === "user") return renderChatBubble("user", escapeChatHtml(entry.text));
  const note = entry.note ? `<p class="chat-note">${escapeChatHtml(entry.note)}</p>` : "";
  return renderChatBubble("assistant", formatChatText(entry.text, uidById) + note);
}

async function renderChatHistory() {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const history = await loadChatHistory();
  if (!history.length) return;

  const needsMap = history.some(
    (entry) => entry.role === "assistant" && (!entry.uids || !Object.keys(entry.uids).length)
  );
  let fallbackMap = null;
  if (needsMap) {
    try {
      const emails = (await getMailWindowEmails()).filter((email) => !email.sensitive);
      fallbackMap = {};
      emails.forEach((email, index) => {
        fallbackMap[index + 1] = email.uid;
      });
    } catch (err) {
      fallbackMap = null;
    }
  }

  container.innerHTML = "";
  history.forEach((entry) => {
    if (
      fallbackMap &&
      entry.role === "assistant" &&
      (!entry.uids || !Object.keys(entry.uids).length)
    ) {
      entry.uids = fallbackMap;
    }
    renderChatMessage(entry);
  });
  container.scrollTop = container.scrollHeight;
}

function renderChatSuggestions() {
  const container = document.getElementById("chat-suggestions");
  if (!container) return;

  container.innerHTML = "";
  CHAT_SUGGESTIONS.forEach((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-suggestion";
    chip.textContent = text;
    chip.onclick = () => {
      const input = document.getElementById("chatInput");
      if (input) input.value = text;
      handleChatSend();
    };
    container.appendChild(chip);
  });

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "chat-suggestion chat-clear";
  clear.textContent = "Clear chat";
  clear.onclick = async () => {
    await clearChatHistory();
    const messages = document.getElementById("chat-messages");
    if (messages) {
      messages.innerHTML =
        '<div class="chat-bubble chat-assistant"><p>Chat cleared. Ask me anything about your mail.</p></div>';
    }
    setChatStatus("");
  };
  container.appendChild(clear);
}

function sendChatPayload(payload, model, uidById) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GEMINI_SUMMARY", payload, model }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || "Extension message failed." });
        return;
      }
      if (response && response.ok) resolve({ ok: true, text: response.text || "", uidById });
      else resolve({ ok: false, error: (response && response.error) || "No response from Gemini." });
    });
  });
}

function requestOpenMail(uid) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_MAIL", uid: Number(uid) }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from the extension." });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}

// Sync new mails and update the local search vectors (runs in the background
// worker; the panel opening, the Sync button and chat questions share one run).
function requestPrepareInbox(force = false, forChat = false) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "PREPARE_INBOX", force, forChat }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from the extension." });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}

// The question as a MiniLM vector, made on this laptop. null if the model is unavailable.
function requestQueryVector(text) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    try {
      chrome.runtime.sendMessage({ type: "EMBED_QUERY", text }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response || !response.ok) resolve(null);
        else resolve(response.vector);
      });
    } catch (err) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function formatSyncTime(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "earlier";
  return when.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

async function openWebmailMessage(uid) {
  const numUid = Number(uid);
  if (!numUid || Number.isNaN(numUid)) {
    setChatStatus("That citation has no mail link (older chat message). Ask again to get clickable ones.");
    setTimeout(() => setChatStatus(""), 6000);
    return;
  }

  setChatStatus("Opening mail…");
  const result = await requestOpenMail(numUid);
  setChatStatus(result.ok ? "" : result.error);
  if (!result.ok) setTimeout(() => setChatStatus(""), 6000);
}

async function handleChatSend() {
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSendBtn");
  const question = ((input && input.value) || "").trim().slice(0, 2000);

  if (!question || chatBusy) return;
  if (input) input.value = "";

  chatBusy = true;
  if (sendBtn) sendBtn.disabled = true;

  renderChatBubble("user", escapeChatHtml(question));

  let thinking = null;
  try {
    const history = await loadChatHistory();
    history.push({ role: "user", text: question });
    await saveChatHistory(history);

    // Fetch new mails first (only if the last sync is over 5 minutes old), so
    // the answer includes mail that just arrived.
    thinking = renderChatBubble("assistant", "<p>Checking for new mail…</p>", { thinking: true });
    const prep = await requestPrepareInbox(false, true);
    let note = "";
    if (!prep.ok) {
      const meta = await getMailWindowMeta();
      if (!meta || !meta.syncedAt) {
        if (thinking) thinking.remove();
        renderChatBubble("assistant", `<p>${escapeChatHtml(prep.error || "Could not sync your inbox.")}</p>`);
        return;
      }
      note = `Couldn't refresh, using mails synced at ${formatSyncTime(meta.syncedAt)}.`;
    }

    if (thinking) thinking.innerHTML = "<p>Thinking…</p>";

    const queryVector = await requestQueryVector(question);
    const context = await buildMailContext(question, { queryVector });
    const model = (await chatStorage(["selectedModel"])).selectedModel || "gemini-3.8-flash";

    const priorTurns = history.slice(0, -1).slice(-CHAT_TURNS_SENT);
    const contents = priorTurns.map((entry) => ({
      role: entry.role === "user" ? "user" : "model",
      parts: [{ text: String(entry.text).slice(0, CHAT_TURN_LIMIT) }],
    }));
    contents.push({ role: "user", parts: [{ text: question }] });

    const payload = {
      systemInstruction: { parts: [{ text: context.systemText }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    };

    const answer = await sendChatPayload(payload, model, context.uidById || {});

    if (thinking) thinking.remove();
    thinking = null;

    if (!answer.ok) {
      const hint = typeof geminiErrorHint === "function" ? geminiErrorHint(answer.error) : answer.error;
      renderChatBubble("assistant", `<p class="chat-error">${escapeChatHtml(hint)}</p>`);
      setChatStatus("");
      return;
    }

    const uids = collectChatCitations(answer.text, answer.uidById || {});
    const entry = { role: "assistant", text: answer.text, uids, note };
    renderChatMessage({ ...entry, uids: answer.uidById || {} });

    history.push(entry);
    await saveChatHistory(history);

    const stats = context.stats || {};
    const searchNote = !stats.usedVectors
      ? " (keyword search only)"
      : prep.partial
        ? " (still preparing older mails for search)"
        : "";
    setChatStatus(`Searched ${stats.total || 0} mails${searchNote}, read ${stats.included || 0} in full`);
  } catch (err) {
    if (thinking) thinking.remove();
    renderChatBubble("assistant", `<p class="chat-error">${escapeChatHtml(err && err.message ? err.message : err)}</p>`);
    setChatStatus("");
  } finally {
    chatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

function initChat() {
  renderChatSuggestions();
  renderChatHistory();

  const sendBtn = document.getElementById("chatSendBtn");
  const input = document.getElementById("chatInput");

  if (sendBtn) sendBtn.onclick = () => handleChatSend();
  if (input) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleChatSend();
      }
    });
  }

  const messages = document.getElementById("chat-messages");
  if (messages) {
    messages.addEventListener("click", (event) => {
      const chip = event.target.closest(".chat-citation");
      if (!chip) return;
      openWebmailMessage(Number(chip.dataset.uid));
    });
  }
}
