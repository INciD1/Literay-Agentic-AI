// ============================================================================
// Backend connection config
// ============================================================================
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const CHAT_BACKEND_URL = IS_LOCAL
  ? "http://localhost:8000"
  : "https://REPLACE-WITH-adk-agent-service.a.run.app";

const UPLOAD_BACKEND_URL = IS_LOCAL
  ? "http://localhost:8001"
  : "https://REPLACE-WITH-upload-service.a.run.app";

const APP_NAME = "literay_agent";

// Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID
// -> Web application. Add http://localhost:5500 (and your hosted origin
// later) under "Authorized JavaScript origins" or sign-in fails silently.
const GOOGLE_CLIENT_ID = "799447425682-vdt9130tcr9mknqh3c39fvv3pqhoi30k.apps.googleusercontent.com";

let USER_ID = null; // set after sign-in — persisted so memory stays tied to the same user
let sessionId = null;
let activeDocumentId = null;
const knownDocuments = []; // { id, filename } — documents successfully indexed this session

function registerDocument(documentId, filename) {
  knownDocuments.push({ id: documentId, filename });
  activeDocumentId = documentId;
  renderDocList();
  updateChatHeader();
}

function renderDocList() {
  const list = document.getElementById("doc-list");
  if (!list) return;
  list.innerHTML = "";
  knownDocuments.forEach((doc) => {
    const item = document.createElement("div");
    item.className = "doc-item" + (doc.id === activeDocumentId ? " active" : "");
    item.innerHTML = `<div class="doc-name"></div><span class="status-pill status-done">indexed</span>`;
    item.querySelector(".doc-name").textContent = doc.filename;
    item.addEventListener("click", () => {
      activeDocumentId = doc.id;
      renderDocList();
      updateChatHeader();
      document.querySelector('.nav-item[data-view="chat"]')?.click();
    });
    list.appendChild(item);
  });
}

function updateChatHeader() {
  const doc = knownDocuments.find((d) => d.id === activeDocumentId);
  const titleEl = document.querySelector(".chat-header .doc-title");
  const subEl = document.querySelector(".chat-header .doc-sub");
  if (doc && titleEl) titleEl.textContent = doc.filename;
  if (doc && subEl) subEl.textContent = "Grounded via Vertex Search RAG · document ready";
}

// ============================================================================
// Auth — Google Identity Services (client-side only for this demo; there is
// no backend token verification yet).
// ============================================================================
function decodeJwtPayload(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(base64))));
}

function applySignedInUser(profile) {
  USER_ID = profile.sub;
  localStorage.setItem("literay_user_profile", JSON.stringify(profile));

  document.getElementById("user-name").textContent = profile.name || profile.email || "Signed in";
  const uidEl = document.getElementById("user-uid");
  if (uidEl) uidEl.textContent = USER_ID.slice(0, 8);
  const avatarEl = document.getElementById("user-avatar");
  if (avatarEl) {
    avatarEl.innerHTML = profile.picture
      ? `<img src="${profile.picture}" alt="">`
      : "";
    if (!profile.picture) avatarEl.textContent = (profile.name || "?")[0].toUpperCase();
  }

  document.getElementById("auth-screen").hidden = true;
  document.getElementById("app-root").hidden = false;
  createSession().catch((err) => {
    console.error("Could not create initial session — is the backend running?", err);
    appendErrorCard("Couldn't connect to the backend. Make sure `adk api_server` is running.");
  });
}

function handleGoogleCredential(response) {
  try {
    applySignedInUser(decodeJwtPayload(response.credential));
  } catch (err) {
    console.error("Failed to decode Google credential", err);
  }
}

function initAuth() {
  const saved = localStorage.getItem("literay_user_profile");
  if (saved) {
    try {
      applySignedInUser(JSON.parse(saved));
      return;
    } catch (err) {
      localStorage.removeItem("literay_user_profile");
    }
  }

  if (window.google && !GOOGLE_CLIENT_ID.startsWith("REPLACE-WITH")) {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
    google.accounts.id.renderButton(document.getElementById("google-signin-slot"), {
      theme: "outline",
      size: "large",
      width: 320,
      text: "continue_with",
    });
  } else {
    console.warn("GOOGLE_CLIENT_ID not configured or Google script not loaded yet.");
    const fallback = document.getElementById("auth-fallback-btn");
    if (fallback) {
      fallback.hidden = false;
      fallback.disabled = true;
      fallback.style.opacity = "0.5";
      fallback.style.cursor = "not-allowed";
      fallback.textContent = "Google Sign-In not configured yet";
    }
  }
}

document.getElementById("user-chip-btn")?.addEventListener("click", () => {
  if (!confirm("Sign out?")) return;
  localStorage.removeItem("literay_user_profile");
  location.reload();
});

// Google's script loads async — retry init briefly if it's not ready yet.
function waitForGoogleThenInit(attempt = 0) {
  if (window.google?.accounts?.id || attempt > 20) {
    initAuth();
  } else {
    setTimeout(() => waitForGoogleThenInit(attempt + 1), 150);
  }
}
waitForGoogleThenInit();

// ============================================================================
// Mobile drawer navigation
// ============================================================================
const sidebarEl = document.getElementById("sidebar");
const rightPanelEl = document.getElementById("right-panel");
const scrimEl = document.getElementById("scrim");

function closeDrawers() {
  sidebarEl?.classList.remove("open");
  rightPanelEl?.classList.remove("open");
  scrimEl?.classList.remove("show");
}
function openDrawer(el) {
  closeDrawers();
  el?.classList.add("open");
  scrimEl?.classList.add("show");
}
document.getElementById("hamburger-left")?.addEventListener("click", () => openDrawer(sidebarEl));
document.getElementById("hamburger-right")?.addEventListener("click", () => openDrawer(rightPanelEl));
scrimEl?.addEventListener("click", closeDrawers);

function syncRightHamburger() {
  const btn = document.getElementById("hamburger-right");
  if (btn) btn.style.display = window.innerWidth <= 1000 ? "flex" : "none";
}
syncRightHamburger();
window.addEventListener("resize", syncRightHamburger);

// ============================================================================
// Session creation
// ============================================================================
async function createSession() {
  const newSessionId = `session_${Date.now()}`;
  const res = await fetch(
    `${CHAT_BACKEND_URL}/apps/${APP_NAME}/users/${USER_ID}/sessions/${newSessionId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  sessionId = newSessionId;
  const idEl = document.querySelector(".session-id");
  if (idEl) idEl.textContent = sessionId;
  return sessionId;
}

// ============================================================================
// Parsing /run events into what the UI needs (citations/memory come from the
// tool RESULTS directly, not the model's prose; quiz is a parsed fenced block)
// ============================================================================
function extractFunctionResponsePayload(part) {
  const fr = part.functionResponse || part.function_response;
  if (!fr) return null;
  const response = fr.response || {};
  const payload = response.result !== undefined ? response.result : response;
  return { name: fr.name, payload };
}

function parseAgentEvents(events) {
  const citations = [];
  let weakSpots = [];

  for (const e of events) {
    const parts = (e.content && e.content.parts) || [];
    for (const p of parts) {
      const fr = extractFunctionResponsePayload(p);
      if (!fr) continue;
      if (fr.name === "search_document" && fr.payload?.status === "success" && Array.isArray(fr.payload.clauses)) {
        citations.push(...fr.payload.clauses.filter(Boolean));
      }
      if (fr.name === "get_document_metadata" && fr.payload?.status === "success" && Array.isArray(fr.payload.weak_spots)) {
        weakSpots = fr.payload.weak_spots.filter(Boolean);
      }
    }
  }

  const textEvents = events.filter((e) => e.content?.parts?.some((p) => p.text));
  const last = textEvents[textEvents.length - 1];
  let rawText = last
    ? last.content.parts.map((p) => p.text).filter(Boolean).join("\n")
    : "(no response text — check the backend logs)";

  let quiz = null;
  const quizMatch = rawText.match(/```quiz\s*([\s\S]*?)```/);
  if (quizMatch) {
    try {
      const parsed = JSON.parse(quizMatch[1].trim());
      if (parsed.question && Array.isArray(parsed.options)) quiz = parsed;
    } catch (err) {
      console.warn("Failed to parse quiz block:", err, quizMatch[1]);
    }
    rawText = rawText.replace(quizMatch[0], "").trim();
  }

  return { replyText: rawText, quiz, citations: [...new Set(citations)], weakSpots };
}

async function sendMessageToAgent(text) {
  if (!sessionId) await createSession();

  // Silently attach the active document's real document_id so the user
  // never has to know or type a UUID — the visible chat bubble still shows
  // their original text (see appendUserBubble), only the backend call
  // carries this extra context.
  const augmentedText = activeDocumentId
    ? `[Active document_id: ${activeDocumentId}] ${text}`
    : text;

  const res = await fetch(`${CHAT_BACKEND_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_name: APP_NAME,
      user_id: USER_ID,
      session_id: sessionId,
      new_message: { role: "user", parts: [{ text: augmentedText }] },
    }),
  });
  if (!res.ok) throw new Error(`Agent request failed: ${res.status}`);
  return parseAgentEvents(await res.json());
}

// ============================================================================
// Rendering
// ============================================================================
function scrollToBottom() {
  const scroll = document.getElementById("chat-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function appendUserBubble(text) {
  const scroll = document.getElementById("chat-scroll");
  const row = document.createElement("div");
  row.className = "msg-row user";
  row.innerHTML = `<div class="msg-avatar">${(USER_ID || "?")[0].toUpperCase()}</div><div class="bubble"></div>`;
  row.querySelector(".bubble").textContent = text;
  scroll.appendChild(row);
  scrollToBottom();
}

function appendThinkingRow() {
  const scroll = document.getElementById("chat-scroll");
  const row = document.createElement("div");
  row.className = "thinking-row";
  row.id = "active-thinking-row";
  row.innerHTML = `<div class="thinking-chip">Thinking<span class="tdots"><span>•</span><span>•</span><span>•</span></span></div>`;
  scroll.appendChild(row);
  scrollToBottom();
}
function removeThinkingRow() {
  document.getElementById("active-thinking-row")?.remove();
}

function buildCitationCardsHTML(citations) {
  return citations.slice(0, 3).map(() => `
      <div class="citation-card">
        <div class="label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
          Cited from the document
        </div>
        <div class="quote"></div>
      </div>`).join("");
}
function buildMemoryBadgeHTML(weakSpots) {
  if (!weakSpots.length) return "";
  return `
    <div class="memory-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>
      <span><b>Remembered from before:</b> <span class="mem-text"></span></span>
    </div>`;
}

function renderMarkdown(text) {
  // Agent replies are Markdown (headings, bold, lists). Parse to HTML, then
  // sanitize — this is model-generated text, not raw third-party input, but
  // sanitizing is cheap insurance against any stray HTML/script content.
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text));
  }
  // Fallback if the CDN scripts failed to load — at least don't break.
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function appendAgentBubble({ replyText, citations, weakSpots }) {
  const scroll = document.getElementById("chat-scroll");
  const row = document.createElement("div");
  row.className = "msg-row agent";
  row.innerHTML = `
    <div class="msg-avatar">A</div>
    <div><div class="bubble">
      <div class="reply-text markdown-body"></div>
      ${buildCitationCardsHTML(citations)}
      ${buildMemoryBadgeHTML(weakSpots)}
    </div></div>`;
  row.querySelector(".reply-text").innerHTML = renderMarkdown(replyText);
  row.querySelectorAll(".citation-card .quote").forEach((el, i) => { el.textContent = `"${citations[i]}"`; });
  const memText = row.querySelector(".memory-badge .mem-text");
  if (memText) memText.textContent = weakSpots.join(" ");
  scroll.appendChild(row);
  scrollToBottom();
}

function appendQuizCard(quiz, onAnswer) {
  const scroll = document.getElementById("chat-scroll");
  const card = document.createElement("div");
  card.className = "quiz-card";
  card.innerHTML = `
    <div class="quiz-head">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
      Comprehension check
    </div>
    <div class="quiz-body"><div class="quiz-q"></div><div class="quiz-options"></div></div>`;
  card.querySelector(".quiz-q").textContent = quiz.question;
  const optionsEl = card.querySelector(".quiz-options");
  quiz.options.forEach((optionText) => {
    const btn = document.createElement("button");
    btn.className = "quiz-opt";
    btn.type = "button";
    btn.textContent = optionText;
    btn.addEventListener("click", () => {
      if (card.dataset.answered) return;
      card.dataset.answered = "true";
      optionsEl.querySelectorAll(".quiz-opt").forEach((o) => (o.disabled = true));
      btn.style.borderColor = "var(--blue)";
      onAnswer(optionText);
    });
    optionsEl.appendChild(btn);
  });
  scroll.appendChild(card);
  scrollToBottom();
}

function appendErrorCard(message) {
  const scroll = document.getElementById("chat-scroll");
  const err = document.createElement("div");
  err.className = "error-card";
  err.innerHTML = `
    <div class="err-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>
      Couldn't reach the assistant
    </div>
    <div style="font-size:12.5px;color:var(--navy);"></div>`;
  err.querySelector("div:last-child").textContent = message;
  scroll.appendChild(err);
  scrollToBottom();
}

async function runTurn(text) {
  appendThinkingRow();
  try {
    const parsed = await sendMessageToAgent(text);
    removeThinkingRow();
    appendAgentBubble(parsed);
    if (parsed.quiz) {
      appendQuizCard(parsed.quiz, (chosenAnswer) => {
        appendUserBubble(chosenAnswer);
        runTurn(chosenAnswer);
      });
    }
  } catch (err) {
    removeThinkingRow();
    appendErrorCard("The server is responding slower than usual, or the backend isn't reachable. Try again — nothing about your document has been lost.");
    console.error(err);
  }
}

// ============================================================================
// Composer wiring
// ============================================================================
const composerInput = document.querySelector(".composer input[type=text]");
const sendBtn = document.querySelector(".composer .icon-btn:not(.ghost)");
const attachBtn = document.querySelector(".composer .icon-btn.ghost");

async function handleSend() {
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = "";
  composerInput.disabled = true;
  appendUserBubble(text);
  await runTurn(text);
  composerInput.disabled = false;
  composerInput.focus();
}
sendBtn?.addEventListener("click", handleSend);
composerInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSend(); });

document.querySelector(".session-block .btn-primary")?.addEventListener("click", async () => {
  document.getElementById("chat-scroll").innerHTML = "";
  await createSession();
});

// ============================================================================
// History
// ============================================================================
const historyBtn = document.querySelector(".session-block .btn-ghost");

async function fetchSessionList() {
  const res = await fetch(`${CHAT_BACKEND_URL}/apps/${APP_NAME}/users/${USER_ID}/sessions`);
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return res.json();
}
async function loadSessionMessages(targetSessionId) {
  const res = await fetch(`${CHAT_BACKEND_URL}/apps/${APP_NAME}/users/${USER_ID}/sessions/${targetSessionId}`);
  if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
  return (await res.json()).events || [];
}
function closeHistoryDropdown() {
  document.getElementById("history-dropdown")?.remove();
}
async function openHistoryDropdown() {
  closeHistoryDropdown();
  const dropdown = document.createElement("div");
  dropdown.id = "history-dropdown";
  dropdown.style.cssText = "background:var(--white);border:1px solid var(--border);border-radius:10px;margin-top:8px;padding:6px;max-height:220px;overflow-y:auto;font-size:12.5px;";
  dropdown.textContent = "Loading sessions...";
  historyBtn.closest(".session-block").appendChild(dropdown);
  try {
    const sessions = await fetchSessionList();
    dropdown.innerHTML = "";
    if (!sessions.length) { dropdown.textContent = "No past sessions yet."; return; }
    sessions.forEach((s) => {
      const id = s.id || s.sessionId || s.session_id;
      const row = document.createElement("button");
      row.className = "btn btn-ghost btn-block";
      row.style.cssText = "text-align:left;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;";
      row.textContent = id;
      row.addEventListener("click", async () => {
        sessionId = id;
        document.querySelector(".session-id").textContent = sessionId;
        document.getElementById("chat-scroll").innerHTML = "";
        try {
          const parsed = parseAgentEvents(await loadSessionMessages(id));
          if (parsed.replyText) appendAgentBubble(parsed);
        } catch (err) {
          appendErrorCard("Could not load that session's messages.");
          console.error(err);
        }
        closeHistoryDropdown();
      });
      dropdown.appendChild(row);
    });
  } catch (err) {
    dropdown.textContent = "Could not load session history.";
    console.error(err);
  }
}
historyBtn?.addEventListener("click", () => {
  if (document.getElementById("history-dropdown")) closeHistoryDropdown();
  else openHistoryDropdown();
});

// ============================================================================
// Upload wiring
// ============================================================================
const dropzone = document.querySelector(".dropzone");
const uploadWrap = document.querySelector(".upload-wrap");
let uploadItemCounter = 0;

function renderUploadProgressItem(filename) {
  const uploadItemId = `upload-item-${Date.now()}-${uploadItemCounter++}`;
  const item = document.createElement("div");
  item.className = "upload-item";
  item.id = uploadItemId;
  item.innerHTML = `
    <div style="flex:1;">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <div style="font-size:13px;font-weight:500;"></div>
        <div class="progress-pct" style="font-size:11px;color:var(--text-muted);font-family:'IBM Plex Mono',monospace;flex-shrink:0;">15%</div>
      </div>
      <div class="upload-status" style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">Uploading...</div>
      <div class="progress-track"><div class="progress-fill" style="width:15%;"></div></div>
    </div>
    <span class="status-pill status-processing">uploading</span>`;
  item.querySelector("div div").textContent = filename;
  uploadWrap.appendChild(item);
  return uploadItemId;
}

function setUploadProgress(uploadItemId, pct) {
  const item = document.getElementById(uploadItemId);
  const fillEl = item?.querySelector(".progress-fill");
  const pctEl = item?.querySelector(".progress-pct");
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
}

async function pollIndexingStatus(documentId, uploadItemId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!document.getElementById(uploadItemId)) return;
    try {
      const res = await fetch(`${UPLOAD_BACKEND_URL}/status/${documentId}`);
      if (!res.ok) continue;
      const data = await res.json();
      const freshItemEl = document.getElementById(uploadItemId);
      if (!freshItemEl) return;
      if (data.indexing_status === "indexed") {
        const statusEl = freshItemEl.querySelector(".upload-status");
        const pillEl = freshItemEl.querySelector(".status-pill");
        if (statusEl) statusEl.textContent = "Indexed and ready";
        if (pillEl) { pillEl.textContent = "indexed"; pillEl.className = "status-pill status-done"; }
        setUploadProgress(uploadItemId, 100);
        registerDocument(documentId, data.original_file_name || "Untitled document");
        return;
      }
      setUploadProgress(uploadItemId, Math.min(15 + attempt * 3, 90));
    } catch (err) {
      console.warn("status poll failed", err);
    }
  }
  document.getElementById(uploadItemId)?.querySelector(".upload-status")
    && (document.getElementById(uploadItemId).querySelector(".upload-status").textContent = "Still indexing — check back shortly, or verify in Console.");
}

async function uploadFile(file) {
  console.log("[uploadFile] starting", file.name, file.size, "bytes");
  const uploadItemId = renderUploadProgressItem(file.name);

  const setField = (selector, prop, value) => {
    const item = document.getElementById(uploadItemId);
    const el = item?.querySelector(selector);
    if (!el) { console.warn(`[uploadFile] missing "${selector}"`); return; }
    el[prop] = value;
  };

  const slowWarningTimer = setTimeout(() => {
    setField(".upload-status", "textContent", "Still uploading... this is taking longer than usual.");
  }, 15000);

  const formData = new FormData();
  formData.append("file", file);
  formData.append("user_id", USER_ID);

  try {
    const res = await fetch(`${UPLOAD_BACKEND_URL}/ingest`, { method: "POST", body: formData });
    clearTimeout(slowWarningTimer);
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
    const data = await res.json();
    console.log("[uploadFile] success, document_id =", data.document_id);
    setField(".upload-status", "textContent", "Processing — building the RAG index...");
    setField(".status-pill", "textContent", "processing");
    setUploadProgress(uploadItemId, 40);
    pollIndexingStatus(data.document_id, uploadItemId);
  } catch (err) {
    clearTimeout(slowWarningTimer);
    console.error("[uploadFile] failed:", err);
    setField(".upload-status", "textContent", `Upload failed: ${err.message}. Check upload_server.py is running on port 8001.`);
    setField(".status-pill", "textContent", "error");
  }
}

if (dropzone) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".pdf,.jpg,.jpeg,.png";
  fileInput.style.display = "none";
  dropzone.appendChild(fileInput);
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.style.borderColor = "var(--blue)"; });
  dropzone.addEventListener("dragleave", () => { dropzone.style.borderColor = "var(--sea)"; });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "var(--sea)";
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
}

if (attachBtn) {
  const chatFileInput = document.createElement("input");
  chatFileInput.type = "file";
  chatFileInput.accept = ".pdf,.jpg,.jpeg,.png";
  chatFileInput.style.display = "none";
  document.body.appendChild(chatFileInput);
  attachBtn.addEventListener("click", () => chatFileInput.click());
  chatFileInput.addEventListener("change", async () => {
    const file = chatFileInput.files[0];
    chatFileInput.value = "";
    if (!file) return;
    document.querySelector('.nav-item[data-view="upload"]')?.click();
    await uploadFile(file);
  });
}

// ============================================================================
// Progress view — reads the /progress/{user_id} summary built from
// quiz_log entries in Firestore.
// ============================================================================
async function loadProgressView() {
  const container = document.getElementById("progress-content");
  if (!container) return;
  container.textContent = "Loading...";
  try {
    const res = await fetch(`${UPLOAD_BACKEND_URL}/progress/${USER_ID}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const clauses = Object.entries(data.clauses || {});

    if (!clauses.length) {
      container.textContent = "No comprehension checks answered yet — answer a quiz question in the chat to see your progress here.";
      return;
    }

    container.innerHTML = "";
    clauses
      .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total) // weakest first
      .forEach(([clauseType, stats]) => {
        const pct = Math.round((stats.correct / stats.total) * 100);
        const color = pct >= 80 ? "var(--sage)" : pct >= 50 ? "var(--brass)" : "var(--terracotta)";
        const label = pct >= 80 ? "Strong" : pct >= 50 ? "Moderate" : "Weak";
        const labelColor = pct >= 80 ? "var(--sage-deep)" : pct >= 50 ? "var(--brass-deep)" : "var(--terracotta-deep)";

        const row = document.createElement("div");
        row.className = "clause-row";
        row.innerHTML = `
          <div class="clause-top">
            <span class="clause-name"></span>
            <span style="color:${labelColor};">${label} — ${stats.correct}/${stats.total} correct</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>`;
        row.querySelector(".clause-name").textContent = clauseType;
        container.appendChild(row);
      });
  } catch (err) {
    console.error("[loadProgressView] failed", err);
    container.textContent = "Couldn't load progress data. Check that upload_server.py is running.";
  }
}

// ===== view switching =====
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((i) => i.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    item.classList.add("active");
    document.getElementById("view-" + item.dataset.view).classList.add("active");
    closeDrawers();
    if (item.dataset.view === "progress") loadProgressView();
  });
});
