function cleanMailBody(text) {
  if (!text) return "";
  return text
    .replace(/=+/g, "")
    .replace(/If you reply to mails received.*?\n/gi, "")
    .replace(/please take care.*?\n/gi, "")
    .replace(/NOT\*\*/gi, "")
    .replace(/To unsubscribe.*?\n/gi, "")
    .replace(/Your subscribed address.*?\n/gi, "")
    .replace(/automated message.*?\n/gi, "")
    .replace(/do not reply.*?\n/gi, "")
    .replace(/PLEASE READ BELOW.*?\n/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


chrome.storage.local.get(['pendingCompose'], (result) => {
  if (result.pendingCompose) {
    const { subject, body, timestamp } = result.pendingCompose;
    if (Date.now() - timestamp < 30000) {
      handleNewComposeInjection(subject, body);
    }
    chrome.storage.local.remove('pendingCompose');
  }
});

function handleNewComposeInjection(subject, body) {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;

    const subjectField = document.getElementById('compose-subject') ||
                         document.querySelector('input[name="_subject"]');

    const bodyIframe = document.getElementById('composebody_ifr') ||
                       document.getElementById('_message_ifr');

    const bodyTextarea = document.getElementById('composebody') ||
                         document.querySelector('textarea[name="_message"]');

    if (subjectField && subject) {
      subjectField.value = subject;
    }

    if (bodyIframe || bodyTextarea) {
      if (bodyIframe) {
        try {
          const doc = bodyIframe.contentDocument || bodyIframe.contentWindow.document;
          if (doc && doc.body) {
             const htmlBody = (body || "").replace(/\n/g, '<br>');

             if (subject === null) {
                doc.body.innerHTML = htmlBody + "<br><br>" + doc.body.innerHTML;
             } else {
                doc.body.innerHTML = htmlBody;
             }

             console.log("IITB Assistant: Fields injected into Iframe.");
             clearInterval(timer);
          }
        } catch (e) {
          console.error("Iframe access blocked", e);
        }
      } else if (bodyTextarea) {
        if (subject === null) {
            bodyTextarea.value = (body || "") + "\n\n" + bodyTextarea.value;
        } else {
            bodyTextarea.value = body || "";
        }
        console.log("IITB Assistant: Fields injected into Textarea.");
        clearInterval(timer);
      }
    }

    if (attempts > 60) {
      clearInterval(timer);
      console.warn("IITB Assistant: Timeout waiting for compose fields.");
    }
  }, 500);
}

async function injectNewCompose(subject, body) {
  const isReply = (subject === null);

  if (isReply) {
    const replyBtn =
        document.querySelector('a.button.reply[title="Reply to sender"]') ||
        document.querySelector('a.button.reply') ||
        document.getElementById('rcmbtn124') ||
        document.querySelector('.toolbar a.reply');

    if (replyBtn) {
        chrome.storage.local.set({
            pendingCompose: { subject: null, body: body, timestamp: Date.now() }
        }, () => {
            replyBtn.click();
        });
    } else {
        handleNewComposeInjection(null, body);
    }
  } else {
    const composeBtn = document.getElementById('rcmbtn107') ||
                        document.querySelector('a.compose[title="Create a new message"]') ||
                        document.querySelector('a.compose');

    if (composeBtn) {
      chrome.storage.local.set({
        pendingCompose: { subject, body, timestamp: Date.now() }
      }, () => {
        composeBtn.click();
      });
    } else {
      console.log("IITB Assistant: No compose button found, checking if fields already exist...");
      handleNewComposeInjection(subject, body);
    }
  }
}

function tryExtractMailBody() {
  let body = "";

  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const f of iframes) {
    try {
      const doc = f.contentDocument;
      if (!doc || !doc.body) continue;

      const text = doc.body.innerText?.trim() || "";
      if (text.length > body.length) body = text;
    } catch {}
  }

  if (!body) {
    const bodyEl = document.querySelector(
      "#message-content, .message-body, .preview-pane, .mail-body, article"
    );
    if (bodyEl) {
      const clone = bodyEl.cloneNode(true);
      clone.querySelectorAll("script, style, iframe").forEach(n => n.remove());
      body = clone.innerText.trim();
    }
  }

  return body ? cleanMailBody(body) : null;
}


function waitForMailBody(maxAttempts = 10, interval = 300) {
  return new Promise(resolve => {
    let attempts = 0;

    const timer = setInterval(() => {
      const body = tryExtractMailBody();
      attempts++;

      if (body) {
        clearInterval(timer);
        resolve(body);
      } else if (attempts >= maxAttempts) {
        clearInterval(timer);
        resolve(null);
      }
    }, interval);
  });
}


function findReplyButton(root = document) {
  return root.querySelector(
    'a.reply[title="Reply to sender"], a.reply#rcmbtn124'
  );
}

function findReplyEditor(root = document) {
  return (
    root.querySelector('textarea#composebody') ||
    root.querySelector('textarea[name="_message"]') ||
    root.querySelector('textarea[name="body"]') ||
    root.querySelector('textarea')
  );
}

function fillReplyEditor(replyText) {
  const replyBtn =
    document.querySelector('a.button.reply[title="Reply to sender"]') ||
    document.querySelector('a.button.reply') ||
    document.getElementById('rcmbtn124') ||
    document.querySelector('.toolbar a.reply');

  if (!replyBtn) {
    console.error("IITB Assistant: Reply button not found.");
    return;
  }

  replyBtn.click();

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const editor = document.querySelector('textarea#composebody') ||
                   document.querySelector('textarea[name="_message"]');

    if (editor) {
      editor.value = replyText + "\n\n" + editor.value;
      clearInterval(timer);
    }
    if (attempts >= 20) clearInterval(timer);
  }, 500);
}


chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req?.type === "GET_OPENED_MAIL") {
    waitForMailBody().then(body => {
      if (!body) {
        sendResponse({ ok: false, error: "No opened mail detected" });
        return;
      }

      sendResponse({
        ok: true,
        mail: { body }
      });
    });

    return true;
  }

  if (req?.type === "FILL_REPLY") {
    fillReplyEditor(req.replyText);
    sendResponse({ ok: true });
  }

  if (req?.type === "COMPOSE_NEW_MAIL") {
    injectNewCompose(req.subject, req.body);
    sendResponse({ ok: true });
  }

  return true;
});


function teammate_tryExtractMailBody() {
  let body = "";
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const f of iframes) {
    try {
      const doc = f.contentDocument;
      if (!doc || !doc.body) continue;
      const text = doc.body.innerText?.trim() || "";
      if (text.length > body.length) body = text;
    } catch {}
  }
  return body;
}


let hasOpenedOnce = false;

document.addEventListener('click', (e) => {
    if (hasOpenedOnce) return;

    const isMailItem = e.target.closest('tr[id^="rcmrow"]') ||
                        e.target.closest('.message-list-item') ||
                        e.target.closest('.messagelist tr');

    if (isMailItem) {
        console.log("IITB Assistant: First mail detected. Opening Side Panel...");
        hasOpenedOnce = true;
        chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" });
    }
});
