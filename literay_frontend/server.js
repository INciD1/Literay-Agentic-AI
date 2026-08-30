require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store');
const { verifyGoogleIdToken, requireAuth, GOOGLE_CLIENT_ID } = require('./lib/auth');

const app = express();
const port = Number(process.env.PORT) || 3000;
const backendUrl = process.env.BACKEND_URL;
const appName = process.env.AGENT_APP_NAME || 'literay_agent';

// The upload/document-management service (upload_server.py) — a SEPARATE
// Cloud Run service from the chat agent (backendUrl above). Both run as
// independent containers; this server never spawns a Python process
// directly anymore (that only worked when everything shared one machine's
// filesystem/venv, which breaks the moment these deploy as separate
// containers with no shared filesystem).
const uploadServiceUrl = process.env.UPLOAD_SERVICE_URL;

if (!GOOGLE_CLIENT_ID) {
  console.warn('[Auth] GOOGLE_CLIENT_ID is not set — Google login will fail until it is configured in .env');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set — using an insecure default. Set this before deploying.');
}
if (!uploadServiceUrl) {
  console.warn('[Upload] UPLOAD_SERVICE_URL is not set — upload/delete/status endpoints will fail until it is configured.');
}

// Required behind Cloud Run's HTTPS proxy — without this, secure cookies
// (see cookie-session below) may not be set/read correctly.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieSession({
  name: 'literay_session',
  keys: [process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
}));

app.use(express.static(__dirname, { index: false }));

// ===================== AUTH =====================

app.get('/api/auth/config', (req, res) => {
  res.json({ clientId: GOOGLE_CLIENT_ID || null });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  return res.status(401).json({ user: null });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'credential is required.' });
  }
  try {
    const user = await verifyGoogleIdToken(credential);
    await store.upsertUser(user);
    req.session.user = user;
    return res.json({ user });
  } catch (error) {
    console.error('[Auth] request failed:', error.message);
    return res.status(401).json({ error: 'Invalid Google credential, or the user store is unreachable.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ===================== PAGES =====================

app.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===================== UTILS =====================

// Scans the raw /run event array for get_document_metadata's tool RESULT
// (not the model's prose) — this is what powers the "agent remembers you"
// indicator in the UI. Reading the actual tool output is more reliable
// than trying to detect "remembered from before" phrasing in free text,
// which the model isn't guaranteed to word consistently.
function extractMemorySignal(payload) {
  if (!Array.isArray(payload)) return { usedMemory: false, weakSpots: [] };

  let usedMemory = false;
  let weakSpots = [];

  for (const event of payload) {
    const parts = event?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const fr = part?.functionResponse || part?.function_response;
      if (!fr || fr.name !== 'get_document_metadata') continue;
      usedMemory = true;
      const response = fr.response || {};
      const result = response.result !== undefined ? response.result : response;
      if (result?.status === 'success' && Array.isArray(result.weak_spots)) {
        weakSpots = result.weak_spots.filter(Boolean);
      }
    }
  }

  return { usedMemory, weakSpots };
}

function extractMessage(payload) {
  if (typeof payload === 'string') return payload;

  if (Array.isArray(payload)) {
    for (let i = payload.length - 1; i >= 0; i--) {
      const event = payload[i];
      const parts = event?.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.map(p => p?.text).filter(Boolean).join('\n');
      if (text && event?.content?.role !== 'user') return text;
    }
    const finalEvent = payload.find(event => event?.is_final_response);
    if (finalEvent) return extractMessage(finalEvent);
    return undefined;
  }

  if (!payload || typeof payload !== 'object') return undefined;

  const directMessage = payload.message || payload.text || payload.response ||
    payload.output || payload.data?.message || payload.data?.text;
  if (typeof directMessage === 'string') return directMessage;

  const parts = payload.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map(part => part?.text).filter(Boolean).join('');
    if (text) return text;
  }
  return undefined;
}

async function ensureSession(baseUrl, userId, sessionId) {
  const url = `${baseUrl}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.ok) return;
    const text = await res.text().catch(() => '');
    if ((res.status === 400 || res.status === 409) && /already exists/i.test(text)) return;
    console.warn(`[ADK] could not pre-create session (${res.status}): ${text || '(no body)'}`);
  } catch (err) {
    console.warn(`[ADK] session pre-create request failed: ${err.message}`);
  }
}

function requireUploadServiceUrl(res) {
  if (!uploadServiceUrl) {
    res.status(500).json({ error: 'UPLOAD_SERVICE_URL is not configured.' });
    return false;
  }
  return true;
}

// ===================== CHAT =====================

app.post('/api/v1/chat', requireAuth, async (req, res) => {
  if (!backendUrl) {
    return res.status(500).json({ error: 'BACKEND_URL is not configured.' });
  }

  const { message, session_id: sessionId, document_id: documentId } = req.body;
  const userId = req.session.user.id;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  const trimmedBackendUrl = backendUrl.replace(/\/$/, '');
  const finalSessionId = sessionId || 'demo_session';
  const userMessage = message.trim();

  const groundedMessage = documentId
    ? `[Context: Answer strictly using the document with document_id="${documentId}". If the answer is not found in that document, say so explicitly — do not use any other document.]\n\nQuestion: ${userMessage}`
    : userMessage;

  try {
    await ensureSession(trimmedBackendUrl, userId, finalSessionId);

    const response = await fetch(`${trimmedBackendUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        app_name: appName,
        user_id: userId,
        session_id: finalSessionId,
        document_id: documentId || undefined,
        message: groundedMessage,
        new_message: {
          role: 'user',
          parts: [{ text: groundedMessage }]
        }
      })
    });

    const rawText = await response.text();
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({
        error: 'Backend returned a non-JSON response.',
        error_preview: rawText.slice(0, 500)
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Backend request failed.', details: payload });
    }

    const text = extractMessage(payload);
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(502).json({
        error: 'Backend response did not contain a recognizable message.',
        details: payload
      });
    }

    const { usedMemory, weakSpots } = extractMemorySignal(payload);
    return res.json({ message: text, usedMemory, weakSpots });
  } catch (error) {
    console.error('Backend request failed:', error);
    return res.status(502).json({ error: 'The assistant backend could not be reached.' });
  }
});

// ===================== CHAT SESSION HISTORY =====================

app.get('/api/v1/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = (await store.listSessions(req.session.user.id))
      .map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, messageCount: s.messages.length }))
      .reverse();
    res.json({ sessions });
  } catch (err) {
    console.error('[Sessions] list failed:', err);
    res.status(500).json({ error: 'Could not load conversation history.' });
  }
});

app.get('/api/v1/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await store.getSession(req.session.user.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    res.json(session);
  } catch (err) {
    console.error('[Sessions] get failed:', err);
    res.status(500).json({ error: 'Could not load this conversation.' });
  }
});

app.post('/api/v1/sessions', requireAuth, async (req, res) => {
  const { session_id: sessionId, messages, title, document_id } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages (non-empty array) is required.' });
  }
  const firstUserMessage = messages.find(m => m.role === 'user')?.text || 'Untitled chat';
  try {
    const saved = await store.saveSession(req.session.user.id, {
      id: sessionId || crypto.randomUUID(),
      title: title || firstUserMessage.slice(0, 60),
      createdAt: new Date().toISOString(),
      messages,
      document_id: document_id
    });
    res.json({ ok: true, session: saved });
  } catch (err) {
    console.error('[Sessions] save failed:', err);
    res.status(500).json({ error: 'Could not save this conversation.' });
  }
});

app.delete('/api/v1/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (store.deleteSession) {
      await store.deleteSession(req.session.user.id, req.params.id);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Sessions] delete failed:', err);
    res.status(500).json({ error: 'Could not delete this conversation.' });
  }
});

// Was missing entirely — app.js has called this since the History modal
// was built, but nothing on the server ever answered it, so every rename
// attempt silently failed with a 404.
app.patch('/api/v1/sessions/:id', requireAuth, async (req, res) => {
  const { title } = req.body;
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required.' });
  }
  try {
    const updated = await store.renameSession(req.session.user.id, req.params.id, title.trim());
    if (!updated) return res.status(404).json({ error: 'Session not found.' });
    res.json({ ok: true, session: updated });
  } catch (err) {
    console.error('[Sessions] rename failed:', err);
    res.status(500).json({ error: 'Could not rename this conversation.' });
  }
});

// ✅ Delete a document — now an HTTP call to upload_server.py's
// DELETE /documents/:id instead of spawning delete_document.py. Same
// status-code semantics: 200-ish (via {status:'deleted'|'not_found'}) means
// safe to clear locally, 403 means forbidden (don't clear), 502 means
// partial failure server-side (don't clear, Firestore record was left in
// place deliberately for a retry).
app.delete('/api/v1/documents/:id', requireAuth, async (req, res) => {
  if (!requireUploadServiceUrl(res)) return;
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const trimmedUploadUrl = uploadServiceUrl.replace(/\/$/, '');

  try {
    const response = await fetch(
      `${trimmedUploadUrl}/documents/${encodeURIComponent(documentId)}?user_id=${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );

    if (response.status === 403) {
      console.warn(`[Delete] ownership check failed for ${documentId} / user ${userId}`);
      return res.status(403).json({ error: 'This document does not belong to you.' });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[Delete] upload service returned ${response.status} for ${documentId}: ${body}`);
      return res.status(502).json({ error: 'Could not delete the document from storage/search. Please try again.' });
    }

    // 200 with status "deleted" or "not_found" — either way it's gone at
    // the source, safe to clear the local record too.
    if (store.deleteDocument) await store.deleteDocument(userId, documentId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Delete] could not reach upload service:', err);
    return res.status(502).json({ error: 'Could not reach the delete service.' });
  }
});

// ดึง JSON ออกจากข้อความที่ Gemini ตอบกลับมา
function extractJsonPayload(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

// ===================== DOCUMENTS & QUIZ & PROGRESS =====================

app.get('/api/v1/documents', requireAuth, async (req, res) => {
  try {
    const documents = await store.listDocuments(req.session.user.id);
    res.json({ documents });
  } catch (err) {
    console.error('[Documents] list failed:', err);
    res.status(500).json({ error: 'Could not load your documents.' });
  }
});

app.get('/api/v1/documents/:id/progress', requireAuth, async (req, res) => {
  const documentId = req.params.id;
  const userId = req.session.user.id;
  try {
    const summary = await store.getProgressSummary(userId, documentId);
    res.json(summary);
  } catch (err) {
    console.error('[Progress] failed:', err);
    res.status(500).json({ error: 'Could not load progress for this document.' });
  }
});

app.post('/api/v1/documents/:id/review', requireAuth, async (req, res) => {
  if (!backendUrl) {
    return res.status(500).json({ error: 'BACKEND_URL is not configured.' });
  }
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const trimmedBackendUrl = backendUrl.replace(/\/$/, '');

  const sessions = (await store.listSessions(userId)).filter(s => s.document_id === documentId);
  if (!sessions.length) {
    return res.status(404).json({
      error: 'No conversation history found for this document yet — chat with the assistant about it first, then come back and ask for a review.'
    });
  }

  const MAX_TRANSCRIPT_CHARS = 12000;
  let transcript = '';
  outer:
  for (const session of sessions) {
    for (const m of session.messages) {
      const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}\n`;
      if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) break outer;
      transcript += line;
    }
  }

  const quizResults = await store.getQuizResults(userId, documentId);
  const quizSummaryLine = quizResults.length
    ? `The user has answered ${quizResults.length} quiz question(s) about this document, getting ${quizResults.filter(r => r.correct).length} correct.`
    : 'The user has not taken any quizzes on this document yet.';

  const prompt = `[Context: The following is a conversation history between a user and an AI assistant discussing the document with document_id="${documentId}". Do not answer as if the user is asking you a new question — act as an evaluator instead.]

Conversation history:
${transcript}

${quizSummaryLine}

Based on the conversation above, write a short (3-5 sentence) qualitative assessment of how well this user understands this document. Mention specific clauses or topics they seem to understand well, and specific ones where they seemed confused or asked clarifying questions repeatedly. Do not repeat the raw conversation back — synthesize it. Respond in plain prose, no markdown headers.`;

  const reviewSessionId = crypto.randomUUID();
  try {
    await ensureSession(trimmedBackendUrl, userId, reviewSessionId);
    const response = await fetch(`${trimmedBackendUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        app_name: appName,
        user_id: userId,
        session_id: reviewSessionId,
        document_id: documentId,
        message: prompt,
        new_message: { role: 'user', parts: [{ text: prompt }] }
      })
    });

    const rawText = await response.text();
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({ error: 'Backend returned a non-JSON response.', error_preview: rawText.slice(0, 500) });
    }
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Backend request failed.', details: payload });
    }

    const text = extractMessage(payload);
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(502).json({ error: 'The assistant did not return a review.', details: payload });
    }
    return res.json({ review: text.trim() });
  } catch (err) {
    console.error('Review generation failed:', err);
    return res.status(502).json({ error: 'Could not reach the assistant to generate a review.' });
  }
});

app.get('/api/v1/documents/:id/quiz', requireAuth, async (req, res) => {
  if (!backendUrl) {
    return res.status(500).json({ error: 'BACKEND_URL is not configured.' });
  }
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const sessionId = crypto.randomUUID();
  const trimmedBackendUrl = backendUrl.replace(/\/$/, '');

  const prompt = `[Context: Answer strictly using the document_id="${documentId}"]\nGenerate a 3-question multiple choice quiz based on the key points of this document.\nEach question should test understanding of one specific clause or section — give that clause a short human-readable name (e.g. "Arbitration", "Termination", "Payment terms").\nRespond ONLY with a raw JSON object in this exact format (no markdown or backticks):\n{"questions": [{"question": "...", "options": ["A","B","C","D"], "correctIndex": 0, "clauseName": "Short clause name"}]}`;

  try {
    await ensureSession(trimmedBackendUrl, userId, sessionId);
    const response = await fetch(`${trimmedBackendUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        app_name: appName, user_id: userId, session_id: sessionId, document_id: documentId,
        message: prompt, new_message: { role: 'user', parts: [{ text: prompt }] }
      })
    });

    const payload = JSON.parse(await response.text());
    const text = extractMessage(payload);
    const parsed = extractJsonPayload(text);

    if (!parsed || !Array.isArray(parsed.questions) || !parsed.questions.length) {
      console.error(`[Quiz] Could not parse agent response as JSON for document ${documentId}. Raw text was:\n${text}`);
      return res.status(502).json({
        error: 'The assistant did not return valid quiz data. Please try again.',
        raw_preview: typeof text === 'string' ? text.slice(0, 300) : null
      });
    }

    const quizId = crypto.randomUUID();
    quizSessions.set(quizId, {
      userId,
      documentId,
      questions: parsed.questions,
      createdAt: Date.now()
    });
    setTimeout(() => quizSessions.delete(quizId), QUIZ_SESSION_TTL_MS);

    res.json({ quizId, questions: sanitizeQuizForClient(parsed.questions) });
  } catch (err) {
    console.error('Quiz Error:', err);
    res.status(500).json({ error: 'Failed to generate real quiz from agent', details: err.message });
  }
});

app.post('/api/v1/documents/:id/quiz-answer', requireAuth, async (req, res) => {
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const { quizId, questionIndex, selectedIndex } = req.body;

  if (typeof quizId !== 'string' || !Number.isInteger(questionIndex) || !Number.isInteger(selectedIndex)) {
    return res.status(400).json({ error: 'quizId, questionIndex, and selectedIndex are required.' });
  }

  const session = quizSessions.get(quizId);
  if (!session || session.userId !== userId || session.documentId !== documentId) {
    return res.status(404).json({ error: 'Quiz session not found or expired. Please generate a new quiz.' });
  }

  const question = session.questions[questionIndex];
  if (!question) {
    return res.status(400).json({ error: 'Invalid questionIndex for this quiz.' });
  }

  const correct = selectedIndex === question.correctIndex;

  try {
    await store.addQuizResult(userId, {
      documentId,
      questionId: `${quizId}-${questionIndex}`,
      question: question.question,
      clauseName: question.clauseName || 'General',
      correct
    });
  } catch (err) {
    console.error('[Quiz] failed to record result:', err);
    // Don't fail the response over this — the user still gets their
    // correct/incorrect feedback even if the progress-tracking write failed.
  }

  res.json({ correct, correctIndex: question.correctIndex });
});

// ===================== QUIZ SESSIONS (server-side answer key) =====================
const quizSessions = new Map();
const QUIZ_SESSION_TTL_MS = 60 * 60 * 1000;

function sanitizeQuizForClient(questions) {
  return questions.map(q => ({
    question: q.question,
    options: q.options,
    clauseName: q.clauseName || 'General'
  }));
}

// ===================== UPLOAD =====================
// Now a thin proxy to upload_server.py instead of spawning ingest_document.py
// directly — see the module docstring above for why.

const uploadJobs = new Map(); // jobId -> { status, percent, step, document_id, filename, error }
const uploadMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post('/api/v1/upload', requireAuth, uploadMulter.single('document'), async (req, res) => {
  if (!requireUploadServiceUrl(res)) return;
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const userId = req.session.user.id;
  const jobId = crypto.randomUUID();
  const trimmedUploadUrl = uploadServiceUrl.replace(/\/$/, '');

  uploadJobs.set(jobId, {
    status: 'running',
    percent: 10,
    step: 'Uploading to the ingest service…',
    filename: req.file.originalname,
    size: req.file.size,
    document_id: null,
    error: null
  });

  // Respond immediately with the job id — the actual ingest call (which can
  // take a while: GCS upload + Firestore write + kicking off the Vertex AI
  // Search import) happens in the background below, tracked via polling
  // exactly like the old spawn-based flow did.
  res.status(202).json({ job_id: jobId });

  try {
    const forwardForm = new FormData();
    forwardForm.append('user_id', userId);
    forwardForm.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname
    );

    const ingestRes = await fetch(`${trimmedUploadUrl}/ingest`, { method: 'POST', body: forwardForm });
    if (!ingestRes.ok) {
      const body = await ingestRes.text().catch(() => '');
      throw new Error(`upload service returned ${ingestRes.status}: ${body}`);
    }
    const { document_id: documentId } = await ingestRes.json();

    uploadJobs.set(jobId, {
      ...uploadJobs.get(jobId),
      percent: 55,
      step: 'Submitted to the search index — indexing…',
      document_id: documentId
    });

    pollUploadServiceStatus(jobId, documentId, userId, trimmedUploadUrl);
  } catch (err) {
    console.error(`[Upload] job ${jobId} failed to reach upload service:`, err);
    uploadJobs.set(jobId, {
      ...uploadJobs.get(jobId),
      status: 'error',
      error: `Could not reach the upload service: ${err.message}`
    });
  }
});

async function pollUploadServiceStatus(jobId, documentId, userId, trimmedUploadUrl, attempt = 0) {
  const MAX_ATTEMPTS = 30;
  const job = uploadJobs.get(jobId);
  if (!job) return; // job expired/cleaned up

  try {
    const res = await fetch(`${trimmedUploadUrl}/status/${encodeURIComponent(documentId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.indexing_status === 'indexed') {
        uploadJobs.set(jobId, { ...job, status: 'done', percent: 100, step: 'Indexed and ready' });
        // No need to call store.addDocument here — upload_server.py already
        // wrote the Firestore `documents` record during /ingest, and
        // store.listDocuments now reads that collection directly (see
        // the Firestore-backed store.js).
        return;
      }
      uploadJobs.set(jobId, { ...job, percent: Math.min(55 + attempt * 3, 90), step: 'Still indexing…' });
    }
  } catch (err) {
    console.warn(`[Upload] status poll failed for job ${jobId}:`, err.message);
  }

  if (attempt >= MAX_ATTEMPTS) {
    uploadJobs.set(jobId, {
      ...uploadJobs.get(jobId),
      status: 'pending_timeout',
      step: 'Still indexing — check back shortly'
    });
    return;
  }
  setTimeout(() => pollUploadServiceStatus(jobId, documentId, userId, trimmedUploadUrl, attempt + 1), 4000);
}

app.get('/api/v1/upload-status/:jobId', requireAuth, (req, res) => {
  const job = uploadJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Unknown or expired job id.' });
  }
  return res.json(job);
});

app.listen(port, () => {
  console.log(`Frontend running at http://localhost:${port}`);
  console.log(`  -> chat backend: ${backendUrl || '(not set)'}  (app_name=${appName})`);
  console.log(`  -> upload service: ${uploadServiceUrl || '(not set)'}`);
});