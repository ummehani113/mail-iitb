let cwWindowId = null;

(function installPreviewFallback() {
  const isExtension =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.id &&
    chrome.storage &&
    chrome.storage.local;
  if (isExtension) return;

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem("cwPreviewStore") || "{}");
    } catch (err) {
      return {};
    }
  };
  const write = (obj) => {
    try {
      localStorage.setItem("cwPreviewStore", JSON.stringify({ ...read(), ...obj }));
    } catch (err) {
    }
  };

  window.chrome = {
    runtime: {
      id: "preview",
      sendMessage: (msg, callback) => {
        if (callback) {
          callback({
            ok: true,
            text:
              "This is a **UI preview** of the chat window.\n\n" +
              "In the extension I answer from your last *15 days* of mail — " +
              "deadlines, unread work, who replied — and mark sources you can click.",
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const all = read();
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            if (key in all) out[key] = all[key];
          });
          if (callback) callback(out);
        },
        set: (obj, callback) => {
          write(obj);
          if (callback) callback();
        },
        remove: (key, callback) => {
          const all = read();
          delete all[key];
          try {
            localStorage.setItem("cwPreviewStore", JSON.stringify(all));
          } catch (err) {
          }
          if (callback) callback();
        },
      },
    },
    windows: {
      getCurrent: async () => ({ id: null }),
      update: async () => ({}),
    },
    tabs: {
      query: async () => [],
      update: async () => ({}),
      create: async () => ({}),
    },
  };

  Object.defineProperty(window, "runMailWindowSync", {
    configurable: true,
    writable: true,
    value: async () => ({ ok: true, skipped: true, fetched: 0 }),
  });
})();

function cwStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function cwSetLayer(name) {
  document.body.dataset.layer = name;
  if (name === "chat") {
    const input = document.getElementById("chatInput");
    if (input) setTimeout(() => input.focus(), 260);
  }
}


window.refreshMailWindowStatus = async function refreshMailWindowStatus() {
  const el = document.getElementById("cw-sync-status");
  if (!el) return;

  try {
    const meta = await getMailWindowMeta();
    if (!meta || !meta.syncedAt) {
      el.textContent = "Not synced yet";
      return;
    }

    const start = String(meta.windowStart || "").slice(0, 10);
    const end = String(meta.windowEnd || "").slice(0, 10);
    const via = (meta.backendUsed || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const range = start && end ? ` · ${start} → ${end}` : "";
    const backend = via ? ` · ${via}` : "";
    el.textContent = `${meta.count || 0} mails${range}${backend}`;
    el.title = el.textContent;
  } catch (err) {
    el.textContent = "Not synced yet";
  }
};


const CW_WEBMAIL_MATCH = "https://webmail.iitb.ac.in/*";
const CW_LIST_URL = "https://webmail.iitb.ac.in/?_task=mail&_mbox=INBOX";

function cwMinimiseSelf() {
  if (!cwWindowId) return;
  try {
    const updating = chrome.windows.update(cwWindowId, { state: "minimized" });
    if (updating && typeof updating.catch === "function") updating.catch(() => {});
  } catch (err) {
  }
}

window.openWebmailMessage = async function openWebmailMessage(uid) {
  const numUid = Number(uid);

  if (!numUid || Number.isNaN(numUid)) {
    setChatStatus("That citation has no mail link (older chat message) — ask the question again to get clickable ones.");
    setTimeout(() => setChatStatus(""), 6000);
    return;
  }

  console.log("[IITB Citation] window opening uid", numUid);

  try {
    const tabs = await chrome.tabs.query({ url: CW_WEBMAIL_MATCH });
    const webmailTab =
      tabs.find((tab) => tab.active && !tab.hidden) || tabs.find((tab) => !tab.hidden) || tabs[0];

    if (webmailTab) {
      try {
        await chrome.windows.update(webmailTab.windowId, { focused: true });
      } catch (err) {
      }
      await chrome.tabs.update(webmailTab.id, { active: true });

      setChatStatus(`Opening mail #${numUid}…`);
      const result = await chrome.tabs
        .sendMessage(webmailTab.id, { type: "OPEN_MESSAGE", uid: numUid })
        .catch(() => null);
      console.log("[IITB Citation] content script says:", result);

      if (!(result && result.ok)) {
        await chrome.storage.local.set({
          pendingOpenUid: { uid: numUid, timestamp: Date.now() },
        });
        await chrome.tabs.update(webmailTab.id, { url: CW_LIST_URL });
      }
    } else {
      await chrome.storage.local.set({
        pendingOpenUid: { uid: numUid, timestamp: Date.now() },
      });

      let targetWindowId = null;
      try {
        const normalWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
        const host = normalWindows.find((win) => win.focused) || normalWindows[0];
        if (host) targetWindowId = host.id;
      } catch (err) {
        targetWindowId = null;
      }

      await chrome.tabs.create({
        url: CW_LIST_URL,
        ...(targetWindowId !== null ? { windowId: targetWindowId } : {}),
      });
    }

    setTimeout(cwMinimiseSelf, 250);
  } catch (err) {
    console.error("[IITB Citation] window open failed:", err);
    setChatStatus("Could not open that mail — is the webmail tab still open?");
    setTimeout(() => setChatStatus(""), 6000);
  }
};


if (typeof window.runMailWindowSync !== "function") {
  window.runMailWindowSync = async function runMailWindowSync(options = {}) {
    const force = options.force !== false;
    const result = await syncMailWindow({ force });
    if (result && result.ok && !result.skipped) refreshMailWindowStatus();
    return result;
  };
}


async function cwRunSync() {
  const btn = document.getElementById("cw-sync-btn");
  const el = document.getElementById("cw-sync-status");
  if (btn) btn.disabled = true;
  if (el) el.textContent = "Syncing 15 days…";

  try {
    const result = await runMailWindowSync({ force: true });
    if (result && result.ok) {
      await refreshMailWindowStatus();
    } else {
      const message = (result && result.error) || "Sync failed.";
      if (el) {
        el.textContent = message;
        el.title = message;
      }
    }
  } catch (err) {
    if (el) el.textContent = `Sync failed: ${err && err.message ? err.message : err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}


async function initChatWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    cwWindowId = win && win.id;
  } catch (err) {
    cwWindowId = null;
  }

  const stored = await cwStorage(["chatWindowSeen"]);
  cwSetLayer(stored.chatWindowSeen ? "chat" : "splash");

  document.getElementById("cw-get-started").addEventListener("click", () => {
    chrome.storage.local.set({ chatWindowSeen: true });
    cwSetLayer("chat");
  });

  document.getElementById("cw-avatar-btn").addEventListener("click", () => {
    cwSetLayer("splash");
  });

  document.getElementById("cw-sync-btn").addEventListener("click", cwRunSync);

  document.getElementById("cw-minimize-btn").addEventListener("click", cwMinimiseSelf);

  document.getElementById("cw-close-btn").addEventListener("click", () => window.close());

  if (typeof initChat === "function") initChat();

  refreshMailWindowStatus();
}

document.addEventListener("DOMContentLoaded", initChatWindow);
