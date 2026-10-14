const CHAT_HISTORY_KEY = "chatHistory";
const CHAT_HISTORY_LIMIT = 40;
const CHAT_TURN_LIMIT = 1500;
const CHAT_TURNS_SENT = 6;

const CHAT_SUGGESTIONS = [
  "What's urgent in the last 3 days?",
  "Summarise today's mail",
  "Any deadlines coming up?",
  "What's still unread?",
  "Who emailed me this week?",
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

function formatChatText(text, uidById = {}) {
  let html = escapeChatHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[(E\d+)\]/g, (match, id) => {
    const uid = uidById[String(Number(id.slice(1)))];
    if (!uid) return match;
    return `<span class="chat-citation" data-uid="${uid}" title="Open this email">${id}</span>`;
  });
  return html;
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
  return renderChatBubble(entry.role === "user" ? "user" : "assistant", formatChatText(entry.text, uidById));
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
      const emails = await getMailWindowEmails();
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
  clear.className = "chat-suggestion";
  clear.textContent = "Clear chat";
  clear.onclick = async () => {
    await clearChatHistory();
    const messages = document.getElementById("chat-messages");
    if (messages) {
      messages.innerHTML =
        '<div class="chat-bubble chat-assistant">Chat cleared. Ask me anything about your mail.</div>';
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

async function openWebmailMessage(uid) {
  const numUid = Number(uid);

  if (!numUid || Number.isNaN(numUid)) {
    setChatStatus("That citation has no mail link (older chat message) — ask the question again to get clickable ones.");
    setTimeout(() => setChatStatus(""), 6000);
    return;
  }

  const listUrl = "https://webmail.iitb.ac.in/?_task=mail&_mbox=INBOX";
  console.log("[IITB Citation] opening uid", numUid);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    const onWebmail = !!(active && (active.url || "").includes("webmail.iitb.ac.in"));

    if (onWebmail) {
      setChatStatus(`Opening mail #${numUid}…`);

      const result = await chrome.tabs
        .sendMessage(active.id, { type: "OPEN_MESSAGE", uid: numUid })
        .catch(() => null);
      console.log("[IITB Citation] content script says:", result);
      if (result && result.ok) {
        setChatStatus("");
        return;
      }

      await chrome.storage.local.set({
        pendingOpenUid: { uid: numUid, timestamp: Date.now() },
      });
      await chrome.tabs.update(active.id, { url: listUrl });
      return;
    }

    await chrome.storage.local.set({
      pendingOpenUid: { uid: numUid, timestamp: Date.now() },
    });
    await chrome.tabs.create({ url: listUrl });
  } catch (err) {
    console.error("[IITB Citation] open failed:", err);
    chrome.storage.local.set({
      pendingOpenUid: { uid: numUid, timestamp: Date.now() },
    }, () => window.open(listUrl, "_blank"));
  }
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

    const meta = await getMailWindowMeta();
    if (!meta || !meta.syncedAt) {
      setChatStatus("First sync — pulling your last 15 days of mail…");
      const syncResult = await runMailWindowSync({ force: true });
      if (!syncResult || !syncResult.ok) {
        const message = (syncResult && syncResult.error) || "Could not sync your inbox window.";
        renderChatBubble("assistant", escapeChatHtml(message));
        setChatStatus("");
        return;
      }
    } else {
      runMailWindowSync({ force: false }).then((result) => {
        if (result && result.ok && !result.skipped) refreshMailWindowStatus();
      }).catch(() => {});
    }

    thinking = renderChatBubble("assistant", "Thinking…", { thinking: true });

    const context = await buildMailContext(question);
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
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    };

    const answer = await sendChatPayload(payload, model, context.uidById || {});

    if (thinking) thinking.remove();

    if (!answer.ok) {
      renderChatBubble("assistant", escapeChatHtml(`⚠️ ${answer.error}`));
      setChatStatus("");
      return;
    }

    const uids = collectChatCitations(answer.text, answer.uidById || {});
    renderChatBubble("assistant", formatChatText(answer.text, answer.uidById || {}));

    history.push({ role: "assistant", text: answer.text, uids });
    await saveChatHistory(history);

    const stats = context.stats || {};
    setChatStatus(
      `Context: ${stats.included || 0} of ${stats.total || 0} emails · ${stats.chars || 0} chars`
    );
  } catch (err) {
    if (thinking) thinking.remove();
    renderChatBubble("assistant", escapeChatHtml(`⚠️ ${err && err.message ? err.message : err}`));
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
