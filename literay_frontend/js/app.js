// ===================== STATE =====================
let currentUser = null;
let currentSessionId = crypto.randomUUID();
let currentSessionTitle = null; // null = ยังไม่ตั้งชื่อ (backend อาจตั้งชื่อ auto ให้)
let activeDocumentId = null;
let activeDocumentName = null;
let cachedDocuments = [];       // เก็บ list เอกสารล่าสุดไว้ใช้ lookup (เช่นตอนเปิดประวัติแชท)
let currentMessages = [];       // [{role: 'user'|'agent', text, ts}]
let isHistoryLocked = false;    // true เมื่อกำลังดูแชทเก่าที่ผูกกับเอกสารใดเอกสารหนึ่ง
let lastFailedMessage = null;   // เก็บข้อความล่าสุดที่ส่งไม่สำเร็จ ไว้ให้ปุ่ม "Try again" ใช้ resend
let saveDebounceTimer = null;

// ===== view switching =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('view-' + item.dataset.view).classList.add('active');

    if (item.dataset.view === 'progress') renderProgressDocList(cachedDocuments);
  });
});

// ===================== AUTH: user menu + logout =====================

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login';
      return;
    }
    const { user } = await res.json();
    currentUser = user;
    renderUser(user);
  } catch (err) {
    console.error('Failed to load current user:', err);
  }
}

function renderUser(user) {
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const avatarEl = document.getElementById('user-avatar');

  nameEl.textContent = user.name || user.email || 'Signed in';
  emailEl.textContent = user.email || '';

  if (user.picture) {
    avatarEl.innerHTML = `<img src="${user.picture}" alt="${user.name || ''}" referrerpolicy="no-referrer">`;
  } else {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    avatarEl.textContent = initial;
  }
}

const userMenuTrigger = document.getElementById('user-menu-trigger');
const userMenuDropdown = document.getElementById('user-menu-dropdown');
if (userMenuTrigger) {
  userMenuTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenuDropdown.classList.toggle('open');
  });
  document.addEventListener('click', () => userMenuDropdown.classList.remove('open'));
}

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  });
}

// ===================== DOCUMENTS (sidebar list) =====================

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setActiveDocument(doc) {
  if (isHistoryLocked) return; // กำลังดูประวัติแชทที่ล็อกเอกสารไว้ ห้ามสลับ
  activeDocumentId = doc ? doc.id : null;
  activeDocumentName = doc ? doc.filename : null;
  document.getElementById('active-doc-title').textContent = doc ? doc.filename : 'No document selected';
  document.getElementById('active-doc-sub').textContent = doc
    ? 'Document indexed · grounded via Vertex Search RAG'
    : 'Upload or select a document to ground answers in it';

  document.querySelectorAll('#document-list .doc-item').forEach(el => {
    el.classList.toggle('active', el.dataset.docId === activeDocumentId);
  });
}

// ล็อกไว้กับเอกสารเดิมตอนเปิดประวัติแชท (ข้อ 12) — ปลดล็อกเมื่อกด "+ New session"
function lockToDocument(docId, docName) {
  isHistoryLocked = true;
  activeDocumentId = docId || null;
  activeDocumentName = docName || null;
  document.getElementById('active-doc-title').textContent = docName || 'Unknown document';
  document.getElementById('active-doc-sub').textContent = docId
    ? 'Viewing a saved conversation · locked to this document'
    : 'Viewing a saved conversation (no document was linked)';
  document.getElementById('document-list').classList.add('locked');
  document.querySelectorAll('#document-list .doc-item').forEach(el => {
    el.classList.toggle('active', el.dataset.docId === docId);
  });
}

function unlockDocumentSelection() {
  isHistoryLocked = false;
  document.getElementById('document-list').classList.remove('locked');
}

// ===================== CUSTOM CONFIRM MODAL & TOAST =====================
// แทนที่ window.confirm() / alert() ของเบราว์เซอร์ที่ดูไม่เข้ากับดีไซน์แอป

function showConfirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Delete' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) { resolve(window.confirm(message || title)); return; } // fallback กันพัง

    modal.querySelector('#confirm-modal-title').textContent = title;
    modal.querySelector('#confirm-modal-message').textContent = message;
    const confirmBtn = modal.querySelector('#confirm-modal-confirm');
    const cancelBtn = modal.querySelector('#confirm-modal-cancel');
    confirmBtn.textContent = confirmLabel;

    function cleanup(result) {
      modal.classList.remove('open');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === modal) cleanup(false); }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKeydown);

    modal.classList.add('open');
  });
}

function showToast(message, type = 'error') {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `app-toast ${type} show`;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

(function injectConfirmAndToastStyles() {
  if (document.getElementById('confirm-toast-styles')) return;
  const style = document.createElement('style');
  style.id = 'confirm-toast-styles';
  style.textContent = `
    #confirm-modal-confirm {
      background: #c0392b;
      border-color: #c0392b;
      color: #fff;
    }
    #confirm-modal-confirm:hover { background: #a93226; }
    #app-toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%) translateY(12px);
      background: var(--navy, #2b2b2b);
      color: #fff;
      padding: 11px 20px;
      border-radius: 10px;
      font-size: 13.5px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 9999;
      max-width: 90vw;
    }
    #app-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    #app-toast.error { background: #c0392b; }
  `;
  document.head.appendChild(style);
})();

async function deleteDocument(doc, btnEl) {
  const ok = await showConfirmModal({
    title: 'Delete document?',
    message: `Delete "${doc.filename}"? This can't be undone.`,
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  btnEl.disabled = true;
  try {
    const res = await fetch(`/api/v1/documents/${doc.id}`, { method: 'DELETE' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Delete failed');
    if (activeDocumentId === doc.id) setActiveDocument(null);
    refreshDocumentList();
  } catch (err) {
    console.error('Failed to delete document:', err);
    showToast(err.message && err.message !== 'Delete failed' ? err.message : "Couldn't delete this document. Please try again.");
    btnEl.disabled = false;
  }
}

function renderDocumentList(documents) {
  cachedDocuments = documents || [];
  const list = document.getElementById('document-list');
  const emptyState = document.getElementById('document-list-empty');
  list.querySelectorAll('.doc-item').forEach(el => el.remove());

  if (!documents.length) {
    if (emptyState) emptyState.style.display = 'block';
    if (!isHistoryLocked) setActiveDocument(null);
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  documents.forEach(doc => {
    const el = document.createElement('div');
    el.className = 'doc-item';
    el.dataset.docId = doc.id;
    el.innerHTML = `
      <div class="doc-item-top">
        <div class="doc-name">${doc.filename}</div>
        <button class="doc-delete-btn" type="button" title="Delete document" aria-label="Delete document">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/></svg>
        </button>
      </div>
      <div class="doc-meta">Uploaded ${formatDate(doc.uploadedAt)}${doc.size ? ' · ' + formatBytes(doc.size) : ''}</div>
      <span class="status-pill status-${doc.status === 'indexed' ? 'done' : 'processing'}">${doc.status}</span>
    `;
    el.addEventListener('click', () => setActiveDocument(doc));
    el.querySelector('.doc-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDocument(doc, e.currentTarget);
    });
    list.appendChild(el);
  });

  if (!activeDocumentId && !isHistoryLocked) {
    setActiveDocument(documents[0]);
  }

  renderUploadedDocsList(documents);
}

// แสดงรายการเอกสารที่เคยอัพโหลดแล้วในหน้า "Upload document"
// (แยกจาก #upload-list ซึ่งใช้แสดง progress ของไฟล์ที่กำลังอัพโหลดสด ๆ เท่านั้น)
function renderUploadedDocsList(documents) {
  const list = document.getElementById('upload-existing-list');
  if (!list) return; // กัน error ถ้า index.html ยังไม่มี container นี้
  const emptyState = document.getElementById('upload-existing-empty');
  list.querySelectorAll('.doc-item').forEach(el => el.remove());

  if (!documents || !documents.length) {
    if (emptyState) emptyState.style.display = 'block';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  documents.forEach(doc => {
    const el = document.createElement('div');
    el.className = 'doc-item';
    el.dataset.docId = doc.id;
    el.innerHTML = `
      <div class="doc-item-top">
        <div class="doc-name">${doc.filename}</div>
        <button class="doc-delete-btn" type="button" title="Delete document" aria-label="Delete document">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/></svg>
        </button>
      </div>
      <div class="doc-meta">Uploaded ${formatDate(doc.uploadedAt)}${doc.size ? ' · ' + formatBytes(doc.size) : ''}</div>
      <span class="status-pill status-${doc.status === 'indexed' ? 'done' : 'processing'}">${doc.status}</span>
    `;
    // คลิกแล้วพาไปหน้า Chat พร้อมเลือกเอกสารนี้เป็น active document เลย
    el.addEventListener('click', () => {
      setActiveDocument(doc);
      document.querySelector('.nav-item[data-view="chat"]').click();
    });
    el.querySelector('.doc-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDocument(doc, e.currentTarget);
    });
    list.appendChild(el);
  });
}

async function refreshDocumentList() {
  try {
    const res = await fetch('/api/v1/documents');
    if (!res.ok) return;
    const { documents } = await res.json();
    renderDocumentList(documents);
  } catch (err) {
    console.error('Failed to load documents:', err);
  }
}

// ===================== CHAT =====================
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-btn');
const chatScroll = document.getElementById('chat-scroll');

// ตั้งค่า marked ครั้งเดียว: gfm เปิดตาราง/checklist, breaks ทำให้ขึ้นบรรทัดใหม่แบบ
// soft line break (\n เดี่ยวๆ) ก็ตัดบรรทัดจริงในหน้าจอ ไม่ต้องรอเว้นบรรทัดคู่แบบ markdown เป๊ะๆ
// ซึ่งเป็นสิ่งที่ผู้ใช้ทั่วไปคาดหวังในหน้าต่างแชท ไม่ใช่เอกสาร markdown ทางการ
if (window.marked) {
  marked.setOptions({ gfm: true, breaks: true });
}

function appendMessage(role, text, { record = true } = {}) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;
  const avatar = role === 'user' ? (currentUser?.name?.charAt(0).toUpperCase() || 'U') : 'A';
  row.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="bubble"></div>`;

  const bubble = row.querySelector('.bubble');
  if (role === 'agent' && window.marked && window.DOMPurify) {
    // ข้อความจาก agent เป็น markdown — แปลงเป็น HTML แล้ว sanitize ก่อนแสดงผล
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    // ถ้า CDN ของ marked/DOMPurify โหลดไม่สำเร็จ (เช่นเน็ตองค์กรบล็อก) ยังต้องอ่านออก —
    // เก็บการขึ้นบรรทัดใหม่ไว้แทนที่จะปล่อยให้ข้อความทั้งหมดอัดเป็นบรรทัดเดียว
    bubble.textContent = text;
    bubble.classList.add('bubble-plain');
  }

  chatScroll.appendChild(row);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  if (record) {
    currentMessages.push({ role, text, ts: new Date().toISOString() });
    scheduleAutoSave();
  }
}

// ===== typing indicator: จุดไข่ปลากระพริบระหว่างรอคำตอบจาก agent =====
function showTypingIndicator() {
  hideTypingIndicator(); // กันซ้อนกันถ้ามีอยู่แล้ว
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.id = 'typing-indicator-row';
  row.innerHTML = `
    <div class="msg-avatar">A</div>
    <div class="bubble typing-bubble">
      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
    </div>
  `;
  chatScroll.appendChild(row);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function hideTypingIndicator() {
  const el = document.getElementById('typing-indicator-row');
  if (el) el.remove();
}

// inject CSS สำหรับ animation ครั้งเดียว (เผื่อ css/styles.css ยังไม่มี rule นี้)
(function injectTypingIndicatorStyles() {
  if (document.getElementById('typing-indicator-styles')) return;
  const style = document.createElement('style');
  style.id = 'typing-indicator-styles';
  style.textContent = `
    .typing-bubble {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 12px 16px;
    }
    .typing-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--navy, #6b6b6b);
      opacity: 0.35;
      animation: typingBlink 1.3s infinite ease-in-out;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.18s; }
    .typing-dot:nth-child(3) { animation-delay: 0.36s; }
    @keyframes typingBlink {
      0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
      40% { opacity: 1; transform: translateY(-3px); }
    }
  `;
  document.head.appendChild(style);
})();

function showErrorCard(message) {
  const err = document.createElement('div');
  err.className = 'error-card';
  err.innerHTML = `
    <div class="err-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>
      Couldn't reach the assistant
    </div>
    <div style="font-size:12.5px;color:var(--navy);">${message}</div>
    <button class="btn btn-ghost retry-btn" style="align-self:flex-start;">Try again</button>
  `;
  err.querySelector('.retry-btn').addEventListener('click', () => {
    err.remove();
    if (lastFailedMessage) handleSend(lastFailedMessage);
  });
  chatScroll.appendChild(err);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function sendChatMessage(message) {
  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: currentSessionId,
      document_id: activeDocumentId,
      message
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'The assistant backend returned an error.');
  }
  return payload.message;
}

async function handleSend(retryMessage) {
  const message = retryMessage ?? chatInput?.value.trim();
  if (!message) return;

  if (!retryMessage) {
    appendMessage('user', message);
    chatInput.value = '';
    autoResizeInput();
  }

  if (sendButton) sendButton.disabled = true;
  showTypingIndicator();

  try {
    const reply = await sendChatMessage(message);
    lastFailedMessage = null;
    hideTypingIndicator();
    appendMessage('agent', reply);
  } catch (error) {
    console.error('Chat request failed:', error);
    lastFailedMessage = message;
    hideTypingIndicator();
    showErrorCard('The server is responding slower than usual, or is temporarily unreachable. Nothing about your document has been lost.');
  } finally {
    if (sendButton) sendButton.disabled = false;
  }
}

if (sendButton) sendButton.addEventListener('click', () => handleSend());

// ===== textarea: Enter = ส่ง, Shift+Enter = ขึ้นบรรทัดใหม่, auto-resize (ข้อ 7) =====
function autoResizeInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
}
if (chatInput) {
  chatInput.addEventListener('input', autoResizeInput);
  chatInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });
}

// ===================== AUTO-SAVE ที่คุยอยู่ (ข้อ 1) =====================
// เดิมต้องกด "+ New session" ถึงจะเซฟลง history — ตอนนี้ auto-save แบบ debounce
// ทุกครั้งที่มีข้อความใหม่ ผ่าน endpoint เดิม (ฝั่ง backend ต้อง "upsert" ตาม session_id
// ไม่ใช่สร้างแถวใหม่ซ้ำทุกครั้งที่เรียก — ถ้ายังไม่รองรับ ต้องแก้ backend ตรงนี้ด้วย)
function scheduleAutoSave() {
  if (isHistoryLocked) return; // กำลังดูของเก่าอยู่ ไม่ต้อง autosave ทับ
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveCurrentSession, 1500);
}

async function saveCurrentSession() {
  if (!currentMessages.length) return;
  try {
    await fetch('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        title: currentSessionTitle,
        document_id: activeDocumentId,
        messages: currentMessages
      })
    });
  } catch (err) {
    console.error('Auto-save failed:', err);
  }
}

// เผื่อผู้ใช้ปิดแท็บ/เบราว์เซอร์กะทันหัน ยิง save ครั้งสุดท้ายแบบไม่บล็อกหน้าเว็บ
window.addEventListener('pagehide', () => {
  if (!currentMessages.length || isHistoryLocked) return;
  const body = JSON.stringify({
    session_id: currentSessionId,
    title: currentSessionTitle,
    document_id: activeDocumentId,
    messages: currentMessages
  });
  navigator.sendBeacon?.('/api/v1/sessions', new Blob([body], { type: 'application/json' }));
});

// ===================== NEW SESSION =====================

function resetChatUI() {
  chatScroll.innerHTML = '';
  currentMessages = [];
  currentSessionId = crypto.randomUUID();
  currentSessionTitle = null;
  lastFailedMessage = null;
  document.getElementById('current-session-id').textContent = currentSessionId.slice(0, 8) + '…';
  unlockDocumentSelection();
}

const newSessionBtn = document.getElementById('new-session-btn');
if (newSessionBtn) {
  newSessionBtn.addEventListener('click', async () => {
    if (currentMessages.length > 0 && !isHistoryLocked) {
      newSessionBtn.disabled = true;
      newSessionBtn.textContent = 'Saving…';
      try {
        await saveCurrentSession();
      } finally {
        newSessionBtn.disabled = false;
        newSessionBtn.textContent = '+ New session';
      }
    }
    resetChatUI();
  });
}

// ===================== HISTORY MODAL =====================

const historyModal = document.getElementById('history-modal');
const historyBtn = document.getElementById('history-btn');
const historyCloseBtn = document.getElementById('history-close-btn');
const historyList = document.getElementById('history-list');

function openHistoryModal() {
  historyModal.classList.add('open');
  loadHistoryList();
}
function closeHistoryModal() {
  historyModal.classList.remove('open');
}
if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistoryModal);
if (historyModal) {
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) closeHistoryModal();
  });
}

async function renameSession(session, titleEl) {
  const newTitle = window.prompt('Rename this conversation:', session.title || '');
  if (newTitle === null || !newTitle.trim() || newTitle.trim() === session.title) return;
  try {
    const res = await fetch(`/api/v1/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() })
    });
    if (!res.ok) throw new Error('Rename failed');
    session.title = newTitle.trim();
    titleEl.textContent = session.title;
    if (session.id === currentSessionId) currentSessionTitle = session.title;
  } catch (err) {
    console.error('Failed to rename session:', err);
    showToast("Couldn't rename this conversation. Please try again.");
  }
}

async function deleteSession(session, rowEl) {
  const ok = await showConfirmModal({
    title: 'Delete conversation?',
    message: "Delete this conversation? This can't be undone.",
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    rowEl.remove();
    if (!historyList.querySelector('.history-item')) {
      historyList.innerHTML = '<div class="empty-state">No saved conversations yet — start chatting to save one here.</div>';
    }
  } catch (err) {
    console.error('Failed to delete session:', err);
    showToast("Couldn't delete this conversation. Please try again.");
  }
}

async function loadHistoryList() {
  historyList.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const res = await fetch('/api/v1/sessions');
    const { sessions } = await res.json();
    if (!sessions.length) {
      historyList.innerHTML = '<div class="empty-state">No saved conversations yet — start chatting to save one here.</div>';
      return;
    }
    historyList.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('div'); // div แทน button เพราะข้างในมีปุ่มซ้อนอีกที
      item.className = 'history-item';
      item.tabIndex = 0;
      item.innerHTML = `
        <div class="history-item-title">${session.title || 'Untitled conversation'}</div>
        <div class="history-item-meta">${formatDate(session.createdAt)} · ${session.messageCount} messages</div>
        <div class="history-item-actions">
          <button class="history-action-btn rename-btn" type="button" title="Rename" aria-label="Rename conversation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
          <button class="history-action-btn delete-btn" type="button" title="Delete" aria-label="Delete conversation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/></svg>
          </button>
        </div>
      `;
      item.addEventListener('click', () => loadSessionIntoChat(session.id));
      item.querySelector('.rename-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        renameSession(session, item.querySelector('.history-item-title'));
      });
      item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(session, item);
      });
      historyList.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load history:', err);
    historyList.innerHTML = '<div class="empty-state">Couldn\'t load history right now.</div>';
  }
}

async function loadSessionIntoChat(sessionId) {
  try {
    const res = await fetch(`/api/v1/sessions/${sessionId}`);
    if (!res.ok) throw new Error('Session not found.');
    const session = await res.json();

    chatScroll.innerHTML = '';
    currentMessages = [];
    session.messages.forEach(m => appendMessage(m.role, m.text, { record: false }));
    currentMessages = session.messages.slice();
    currentSessionId = session.id;
    currentSessionTitle = session.title || null;
    document.getElementById('current-session-id').textContent = currentSessionId.slice(0, 8) + '…';

    // ล็อกไว้กับเอกสารเดิมของแชทนี้ (ข้อ 12) — ต้องมี session.document_id / documentName
    // จาก backend ด้วย ถ้ายังไม่ส่งมา ต้องเพิ่มฟิลด์นี้ใน endpoint GET /api/v1/sessions/:id
    if (session.document_id) {
      const doc = cachedDocuments.find(d => d.id === session.document_id);
      lockToDocument(session.document_id, doc ? doc.filename : session.document_name || 'Linked document');
    } else {
      lockToDocument(null, null);
    }

    closeHistoryModal();
    document.querySelector('.nav-item[data-view="chat"]').click();
  } catch (err) {
    console.error('Failed to reopen session:', err);
  }
}

// ===================== PROGRESS VIEW (ข้อ 11) =====================
// ต้องมี backend endpoint: GET /api/v1/documents/:id/progress
// -> { scorePercent, correct, total, weakClauses: [{ name, ratio }] }

function renderProgressDocList(documents) {
  const container = document.getElementById('progress-doc-list');
  if (!documents || !documents.length) {
    container.innerHTML = '<div class="empty-state">No documents yet. Upload one to start tracking progress.</div>';
    return;
  }
  container.innerHTML = '';
  documents.forEach(doc => {
    const row = document.createElement('div');
    row.className = 'progress-doc-row';
    row.innerHTML = `
      <div class="progress-doc-head">
        <span>${doc.filename}</span>
        <span class="progress-doc-score">—</span>
      </div>
      <div class="progress-doc-detail"><div class="empty-state">Click to load progress…</div></div>
    `;
    row.addEventListener('click', () => toggleProgressDetail(row, doc));
    container.appendChild(row);
  });
}

// ----- ดึงสรุปคะแนน (ไม่ throw — คืน null เมื่อพลาด ให้ผู้เรียกตัดสินใจเอง) -----
async function fetchProgressSummary(documentId) {
  try {
    const res = await fetch(`/api/v1/documents/${documentId}/progress`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);
    return data;
  } catch (err) {
    console.error('Progress not available:', err);
    return null;
  }
}

// ----- วาดสรุปคะแนน + weak clauses ลงใน container (เรียกซ้ำได้ทุกครั้งที่มีข้อมูลใหม่) -----
function renderProgressSummary(el, data) {
  if (!data || !data.total) {
    el.innerHTML = '<div class="empty-state">No quiz results yet — generate a quiz below to start tracking your understanding of this document.</div>';
    return;
  }
  const percent = Math.round((data.correct / data.total) * 100);
  let html = `
    <div class="progress-score-line">
      <span class="progress-score-percent">${percent}%</span>
      <span class="progress-score-detail">${data.correct}/${data.total} correct across all attempts</span>
    </div>
  `;
  if (data.weakClauses && data.weakClauses.length) {
    html += data.weakClauses.map(c => `
      <div class="clause-row">
        <div class="clause-top"><span>${c.name}</span><span style="color:var(--terracotta-deep);">${Math.round(c.ratio * 100)}% missed</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(c.ratio * 100)}%;background:var(--terracotta);"></div></div>
      </div>
    `).join('');
  } else {
    html += '<div class="empty-state" style="margin-top:8px;">No weak areas found yet — keep practicing.</div>';
  }
  el.innerHTML = html;
}

async function toggleProgressDetail(row, doc) {
  const alreadyOpen = row.classList.contains('expanded');
  document.querySelectorAll('.progress-doc-row.expanded').forEach(r => r.classList.remove('expanded'));
  if (alreadyOpen) return;
  row.classList.add('expanded');

  const detail = row.querySelector('.progress-doc-detail');
  const scoreEl = row.querySelector('.progress-doc-score');
  if (row.dataset.loaded) return; // โหลดแล้วรอบก่อน ไม่ต้อง fetch ซ้ำ

  detail.innerHTML = `
    <div class="progress-summary-block"><div class="empty-state">Loading your progress…</div></div>
    <div class="progress-review-block">
      <button class="btn btn-ghost btn-block review-btn" type="button">Ask the assistant to review your understanding</button>
      <div class="review-area"></div>
    </div>
    <div class="progress-quiz-block">
      <button class="btn btn-primary quiz-generate-btn" type="button">Generate a quiz for this document</button>
      <div class="quiz-area"></div>
    </div>
  `;
  const summaryEl = detail.querySelector('.progress-summary-block');
  const quizAreaEl = detail.querySelector('.quiz-area');
  const generateBtn = detail.querySelector('.quiz-generate-btn');
  const reviewAreaEl = detail.querySelector('.review-area');
  const reviewBtn = detail.querySelector('.review-btn');

  const data = await fetchProgressSummary(doc.id);
  scoreEl.textContent = data && data.total ? `${data.correct}/${data.total} correct` : 'No quiz yet';
  renderProgressSummary(summaryEl, data);

  generateBtn.addEventListener('click', () => startQuiz(doc, quizAreaEl, summaryEl, scoreEl, generateBtn));
  reviewBtn.addEventListener('click', () => askForReview(doc, reviewAreaEl, reviewBtn));

  row.dataset.loaded = 'true';
}

// ----- ทางเลือกที่ 3 ที่คุยกันไว้: ไม่แตะระบบคะแนนจากควิซเลย เพิ่มปุ่มแยกต่างหาก
// ให้ agent อ่านประวัติแชทที่ล็อกกับเอกสารนี้ + สรุปผลควิซ แล้วเขียนความเห็นเชิงคุณภาพ
// กลับมา — เรียกเฉพาะตอนกดเอง ไม่เรียกอัตโนมัติทุกครั้งที่เปิดหน้า Progress -----
async function askForReview(doc, areaEl, btn) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading your conversation…';
  areaEl.innerHTML = '<div class="empty-state">The assistant is reviewing your chat history about this document — this can take a moment.</div>';

  try {
    const res = await fetch(`/api/v1/documents/${doc.id}/review`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not generate a review right now.');

    const box = document.createElement('div');
    box.className = 'review-result';
    const label = document.createElement('div');
    label.className = 'review-label';
    label.textContent = "Assistant's assessment";
    box.appendChild(label);

    const body = document.createElement('div');
    if (window.marked && window.DOMPurify) {
      body.innerHTML = DOMPurify.sanitize(marked.parse(data.review));
    } else {
      body.textContent = data.review;
    }
    box.appendChild(body);

    areaEl.innerHTML = '';
    areaEl.appendChild(box);
    btn.textContent = 'Ask again';
  } catch (err) {
    console.error('Review request failed:', err);
    areaEl.innerHTML = '';
    showToast(err.message || "Couldn't generate a review. Please try again.");
    btn.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
}

// ----- ขอชุดคำถามจาก agent (server จะเก็บเฉลยไว้ฝั่งตัวเองเท่านั้น ไม่ส่งมาที่ browser) -----
async function startQuiz(doc, quizAreaEl, summaryEl, scoreEl, btn) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating quiz…';
  quizAreaEl.innerHTML = '<div class="empty-state">The assistant is writing questions from this document — this can take a moment.</div>';

  try {
    const res = await fetch(`/api/v1/documents/${doc.id}/quiz`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not generate a quiz right now.');
    renderQuizCard(quizAreaEl, data.quizId, data.questions, doc, summaryEl, scoreEl);
    btn.textContent = 'Regenerate quiz';
  } catch (err) {
    console.error('Quiz generation failed:', err);
    quizAreaEl.innerHTML = '';
    showToast(err.message || "Couldn't generate a quiz. Please try again.");
    btn.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
}

// ----- วาดคำถามทั้งชุดเป็น quiz-card เดียว ให้ตอบได้ทีละข้อ พร้อมเฉลยทันทีต่อข้อ -----
function renderQuizCard(container, quizId, questions, doc, summaryEl, scoreEl) {
  const card = document.createElement('div');
  card.className = 'quiz-card quiz-standalone';
  card.innerHTML = `
    <div class="quiz-head">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      Quick check — ${questions.length} question${questions.length === 1 ? '' : 's'}
    </div>
    <div class="quiz-body"></div>
  `;
  const body = card.querySelector('.quiz-body');
  let answeredCount = 0;
  let correctCount = 0;

  questions.forEach((q, questionIndex) => {
    const block = document.createElement('div');
    block.className = 'quiz-question-block';
    block.innerHTML = `
      <div class="quiz-q">${questionIndex + 1}. ${q.question}</div>
      <div class="quiz-options"></div>
      <div class="quiz-feedback"></div>
    `;
    const optionsEl = block.querySelector('.quiz-options');
    const feedbackEl = block.querySelector('.quiz-feedback');

    q.options.forEach((optionText, optionIndex) => {
      const optBtn = document.createElement('button');
      optBtn.type = 'button';
      optBtn.className = 'quiz-opt';
      optBtn.textContent = optionText;
      optBtn.addEventListener('click', async () => {
        const allOpts = Array.from(optionsEl.querySelectorAll('.quiz-opt'));
        allOpts.forEach(b => { b.disabled = true; });

        try {
          const res = await fetch(`/api/v1/documents/${doc.id}/quiz-answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quizId, questionIndex, selectedIndex: optionIndex })
          });
          const result = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(result.error || 'Could not check this answer.');

          optBtn.classList.add(result.correct ? 'correct' : 'wrong');
          if (!result.correct && allOpts[result.correctIndex]) {
            allOpts[result.correctIndex].classList.add('correct');
          }
          feedbackEl.textContent = result.correct
            ? 'Correct!'
            : 'Not quite — the right answer is highlighted above.';
          feedbackEl.style.display = 'block';

          answeredCount += 1;
          if (result.correct) correctCount += 1;

          if (answeredCount === questions.length) {
            const note = document.createElement('div');
            note.className = 'quiz-complete-note';
            note.textContent = `Quiz complete — you got ${correctCount}/${questions.length} right this round. Updating your progress…`;
            container.appendChild(note);
            const updated = await fetchProgressSummary(doc.id);
            renderProgressSummary(summaryEl, updated);
            if (updated && updated.total) scoreEl.textContent = `${updated.correct}/${updated.total} correct`;
          }
        } catch (err) {
          console.error('Failed to submit quiz answer:', err);
          showToast(err.message || "Couldn't check this answer. Please try again.");
          allOpts.forEach(b => { b.disabled = false; });
        }
      });
      optionsEl.appendChild(optBtn);
    });

    body.appendChild(block);
  });

  container.innerHTML = '';
  container.appendChild(card);
}

// ===================== FILE UPLOAD (drag & drop + in-page progress) =====================

const dropzone = document.getElementById('upload-dropzone');
const uploadList = document.getElementById('upload-list');

if (dropzone && uploadList) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.style.display = 'none';
  fileInput.accept = '.pdf,.jpg,.jpeg,.png';
  document.body.appendChild(fileInput);

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) uploadFile(e.target.files[0]);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });

  function createUploadItem(filename) {
    const item = document.createElement('div');
    item.className = 'upload-item';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div class="upload-filename">${filename}</div>
        <div class="upload-step">Starting…</div>
        <div class="progress-track"><div class="progress-fill" style="width:2%;"></div></div>
      </div>
      <span class="status-pill status-processing">uploading</span>
    `;
    uploadList.prepend(item);
    return {
      el: item,
      setProgress(percent, step) {
        item.querySelector('.progress-fill').style.width = `${percent}%`;
        item.querySelector('.upload-step').textContent = step;
      },
      setStatus(status, label) {
        const pill = item.querySelector('.status-pill');
        pill.className = `status-pill status-${status}`;
        pill.textContent = label;
      }
    };
  }

  async function pollUploadStatus(jobId, ui) {
    try {
      const res = await fetch(`/api/v1/upload-status/${jobId}`);
      if (!res.ok) throw new Error('Job status not found.');
      const job = await res.json();

      ui.setProgress(job.percent ?? 0, job.step || '');

      if (job.status === 'done') {
        ui.setProgress(100, 'Indexed and ready');
        ui.setStatus('done', 'indexed');
        refreshDocumentList();
        return;
      }
      if (job.status === 'error') {
        ui.setStatus('error', 'failed');
        ui.setProgress(job.percent ?? 0, job.error || 'Something went wrong.');
        return;
      }
      if (job.status === 'pending_timeout') {
        ui.setStatus('processing', 'still indexing');
      }
      setTimeout(() => pollUploadStatus(jobId, ui), 1200);
    } catch (err) {
      console.error('Upload status poll failed:', err);
      ui.setStatus('error', 'failed');
      ui.setProgress(0, 'Lost connection while checking upload status.');
    }
  }

  async function uploadFile(file) {
    const ui = createUploadItem(file.name);

    const formData = new FormData();
    formData.append('document', file);

    try {
      const response = await fetch('/api/v1/upload', { method: 'POST', body: formData });
      const result = await response.json();

      if (response.status === 202 && result.job_id) {
        pollUploadStatus(result.job_id, ui);
      } else {
        ui.setStatus('error', 'failed');
        ui.setProgress(0, result.error || 'Upload was rejected by the server.');
      }
    } catch (error) {
      console.error('Upload error:', error);
      ui.setStatus('error', 'failed');
      ui.setProgress(0, 'Could not reach the server.');
    }
  }
}

// ===================== INIT =====================
resetChatUI();
loadCurrentUser();
refreshDocumentList();