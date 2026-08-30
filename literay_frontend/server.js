require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cookieSession = require('cookie-session');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store');
const { verifyGoogleIdToken, requireAuth, GOOGLE_CLIENT_ID } = require('./lib/auth');

const app = express();
const port = Number(process.env.PORT) || 3000;
const backendUrl = process.env.BACKEND_URL;
const appName = process.env.AGENT_APP_NAME || 'literay_agent';

if (!GOOGLE_CLIENT_ID) {
  console.warn('[Auth] GOOGLE_CLIENT_ID is not set — Google login will fail until it is configured in .env');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set — using an insecure default. Set this before deploying.');
}

app.use(express.json());
app.use(cookieSession({
  name: 'literay_session',
  keys: [process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me'],
  maxAge: 30 * 24 * 60 * 60 * 1000, 
  sameSite: 'lax'
}));

app.use(express.static(__dirname, { index: false }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } 
});

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
    store.upsertUser(user);
    req.session.user = user;
    return res.json({ user });
  } catch (error) {
    console.error('[Auth] Google token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid Google credential.' });
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

// Shared by every route that spawns a script from literay_backend/literay_agent/
// (ingest, delete, ...) so the venv-fallback logic only lives in one place.
const LITERAY_AGENT_DIR = path.join(__dirname, '../literay_backend/literay_agent');
function resolvePythonCmd() {
  const pythonExecutable = path.join(__dirname, '../.venv/Scripts/python.exe');
  return fs.existsSync(pythonExecutable) ? pythonExecutable : 'python';
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

    return res.json({ message: text });
  } catch (error) {
    console.error('Backend request failed:', error);
    return res.status(502).json({ error: 'The assistant backend could not be reached.' });
  }
});

// ===================== CHAT SESSION HISTORY =====================

app.get('/api/v1/sessions', requireAuth, (req, res) => {
  const sessions = store.listSessions(req.session.user.id)
    .map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, messageCount: s.messages.length }))
    .reverse(); 
  res.json({ sessions });
});

app.get('/api/v1/sessions/:id', requireAuth, (req, res) => {
  const session = store.getSession(req.session.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  res.json(session);
});

// ✅ 1. แก้ให้เซฟ document_id ลงระบบประวัติ
app.post('/api/v1/sessions', requireAuth, (req, res) => {
  const { session_id: sessionId, messages, title, document_id } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages (non-empty array) is required.' });
  }
  const firstUserMessage = messages.find(m => m.role === 'user')?.text || 'Untitled chat';
  const saved = store.saveSession(req.session.user.id, {
    id: sessionId || crypto.randomUUID(),
    title: title || firstUserMessage.slice(0, 60),
    createdAt: new Date().toISOString(),
    messages,
    document_id: document_id // ผูกรหัสเอกสารไว้กับประวัติแชท
  });
  res.json({ ok: true, session: saved });
});

// ✅ 2. เพิ่ม API ให้ลบประวัติแชทได้
app.delete('/api/v1/sessions/:id', requireAuth, (req, res) => {
  if(store.deleteSession) {
    store.deleteSession(req.session.user.id, req.params.id);
  }
  res.json({ ok: true });
});

// ✅ 2. เพิ่ม API ให้ลบเอกสารได้
// เดิม endpoint นี้ลบแค่ใน local store (data/db.json) — เอกสารหายจาก sidebar แต่ยังอยู่จริง
// ใน GCS/Firestore/Vertex AI Search และยังตอบคำถามผ่าน chat ได้ถ้ามีคนรู้ document_id เดิม
// ตอนนี้ spawn delete_document.py ไปลบที่ต้นทางก่อน (แบบเดียวกับที่ /upload spawn
// ingest_document.py) แล้วค่อยเคลียร์ local store ตาม exit code — ไม่ต้องมี service
// ฝั่ง Python รันตลอดเวลาเพิ่มขึ้นมาอีกตัว
app.delete('/api/v1/documents/:id', requireAuth, (req, res) => {
  const documentId = req.params.id;
  const userId = req.session.user.id;

  const pythonScriptPath = path.join(LITERAY_AGENT_DIR, 'delete_document.py');
  const pyCmd = resolvePythonCmd();

  const child = spawn(pyCmd, [pythonScriptPath, documentId, '--user-id', userId]);

  let stdoutTail = '';
  let stderrTail = '';
  child.stdout.on('data', (chunk) => { stdoutTail += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderrTail += chunk.toString(); });

  child.on('close', (code) => {
    // exit codes per delete_document.py's docstring:
    //   0 = deleted (or was already gone at the source) -> safe to clear locally
    //   2 = exists but belongs to a different user_id    -> do NOT clear locally
    //   3 = owned by this user but a step failed partway -> do NOT clear locally,
    //       Firestore record was deliberately left in place for a retry
    if (code === 0) {
      if (store.deleteDocument) store.deleteDocument(userId, documentId);
      return res.json({ ok: true });
    }
    if (code === 2) {
      console.warn(`[Delete] ownership check failed for ${documentId} / user ${userId}`);
      return res.status(403).json({ error: 'This document does not belong to you.' });
    }
    console.error(`[Delete] delete_document.py failed (exit ${code}) for ${documentId}:\n${stderrTail || stdoutTail}`);
    return res.status(502).json({ error: 'Could not delete the document from storage/search. Please try again.' });
  });

  child.on('error', (err) => {
    console.error('[Delete] could not start delete process:', err);
    res.status(502).json({ error: 'Could not start the delete process.' });
  });
});

// ดึง JSON ออกจากข้อความที่ Gemini ตอบกลับมา — ทนทานกว่าการ strip ```json``` เฉย ๆ
// เพราะบางครั้งโมเดลแถมคำอธิบายก่อน/หลังก้อน JSON มาด้วย แม้จะสั่งว่า "raw JSON only" แล้วก็ตาม
function extractJsonPayload(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // ลอง fallback: ดึงเฉพาะก้อน { ... } แรกสุดที่เจอในข้อความ
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

app.get('/api/v1/documents', requireAuth, (req, res) => {
  res.json({ documents: store.listDocuments(req.session.user.id) });
});

// ✅ 3. Progress คำนวณจากผลควิซจริงที่ผู้ใช้เคยตอบ (เก็บไว้ผ่าน POST /quiz-answer ด้านล่าง)
// ไม่ต้องพึ่ง agent เดาอีกต่อไป — เร็วกว่าเดิมมากและตัวเลขตรงกับพฤติกรรมจริงของผู้ใช้
app.get('/api/v1/documents/:id/progress', requireAuth, (req, res) => {
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const summary = store.getProgressSummary(userId, documentId);
  res.json(summary);
});

// ✅ "Ask the assistant to review your understanding" — ทางเลือกที่ 3 ที่คุยกันไว้:
// เก็บระบบคะแนนจากควิซไว้เหมือนเดิมทุกอย่าง (endpoint ด้านบนไม่ถูกแตะเลย) แล้วเพิ่ม
// endpoint แยกต่างหากนี้ ให้ agent อ่านประวัติแชทที่ล็อกกับเอกสารนี้ + สรุปผลควิซ
// แล้วเขียนความเห็นเชิงคุณภาพกลับมา — เรียกเฉพาะตอนผู้ใช้กดปุ่มเอง ไม่เรียกอัตโนมัติ
// ตอนเปิดหน้า Progress เพื่อไม่ให้เสีย LLM call ทุกครั้งที่แค่ดูคะแนน
app.post('/api/v1/documents/:id/review', requireAuth, async (req, res) => {
  if (!backendUrl) {
    return res.status(500).json({ error: 'BACKEND_URL is not configured.' });
  }
  const documentId = req.params.id;
  const userId = req.session.user.id;
  const trimmedBackendUrl = backendUrl.replace(/\/$/, '');

  const sessions = store.listSessions(userId).filter(s => s.document_id === documentId);
  if (!sessions.length) {
    return res.status(404).json({
      error: 'No conversation history found for this document yet — chat with the assistant about it first, then come back and ask for a review.'
    });
  }

  // รวมข้อความจากทุกแชทที่เคยล็อกกับเอกสารนี้ เรียงตามลำดับเวลาที่บันทึกไว้ —
  // จำกัดความยาวรวมไว้กันบานปลายถ้ามีคนคุยกับเอกสารเดียวกันมาหลายสัปดาห์
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

  const quizResults = store.getQuizResults(userId, documentId);
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

// (เดิมมี POST /quiz-result ที่รับ boolean `correct` มาจาก client ตรง ๆ แล้วเชื่อทันที —
// ถอดออกเพราะไม่มีการตรวจสอบใด ๆ เลยว่าคำตอบถูกจริงไหม ใครก็ยิง correct:true เข้ามาได้
// ตลอด ตอนนี้ /quiz-answer ด้านล่างเป็นคนตัดสินถูก/ผิดจากเฉลยที่ server เก็บไว้เอง
// และเรียก store.addQuizResult ให้เสร็จในตัวแทน)

// ✅ 4. สร้าง Quiz เนื้อหาจริงจาก Backend
app.get('/api/v1/documents/:id/quiz', requireAuth, async (req, res) => {
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

    // เก็บชุดคำถาม+เฉลยไว้ที่ server เท่านั้น ผูกกับ quizId แบบสุ่มใหม่ทุกครั้ง
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

// ✅ ตรวจคำตอบควิซที่ server ฝั่งเดียว — client ส่งมาแค่ index ที่เลือก ไม่มีทางรู้ล่วงหน้า
// ว่าข้อไหนถูก เพราะเฉลยไม่เคยถูกส่งออกไปเลยตั้งแต่ /quiz ด้านบน
app.post('/api/v1/documents/:id/quiz-answer', requireAuth, (req, res) => {
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

  store.addQuizResult(userId, {
    documentId,
    questionId: `${quizId}-${questionIndex}`,
    question: question.question,
    clauseName: question.clauseName || 'General',
    correct
  });

  res.json({ correct, correctIndex: question.correctIndex });
});

// ===================== QUIZ SESSIONS (server-side answer key) =====================
// เก็บชุดคำถาม+เฉลยไว้ที่ server เท่านั้น ไม่ส่ง correctIndex ออกไปที่ browser เด็ดขาด —
// ก่อนหน้านี้ /documents/:id/quiz ส่ง correctIndex ไปพร้อมคำถามตั้งแต่แรก ทำให้เปิด
// Network tab ดูเฉลยได้ก่อนตอบ. ตอนนี้เปลี่ยนเป็น: เก็บชุดคำถามไว้ในนี้ ผูกกับ quizId,
// แล้วให้ /quiz-answer เป็นคนตัดสินถูก/ผิดแทน client
const quizSessions = new Map();
const QUIZ_SESSION_TTL_MS = 60 * 60 * 1000; // 1 ชั่วโมงก็เกินพอสำหรับทำควิซหนึ่งรอบ

function sanitizeQuizForClient(questions) {
  // ตัด correctIndex ออกก่อนส่งให้ browser — เหลือแค่สิ่งที่ต้องใช้แสดงผล
  return questions.map(q => ({
    question: q.question,
    options: q.options,
    clauseName: q.clauseName || 'General'
  }));
}

// ===================== UPLOAD =====================

const uploadJobs = new Map();

const PROGRESS_MARKERS = [
  { pattern: /^\[1\/4\]/, percent: 10, step: 'Uploading to cloud storage' },
  { pattern: /^\s*->\s*gs:\/\//, percent: 20, step: 'Uploaded to cloud storage' },
  { pattern: /^\[2\/4\]/, percent: 30, step: 'Recording document metadata' },
  { pattern: /^\[3\/4\]/, percent: 45, step: 'Submitting to the search index' },
  { pattern: /Import started/, percent: 55, step: 'Import accepted by Vertex AI Search' },
  { pattern: /^\[4\/4\]/, percent: 60, step: 'Indexing — this can take a minute' },
  { pattern: /->\s*indexing complete/, percent: 95, step: 'Indexing complete' }
];

const DOC_ID_PATTERN = /document_id\s*=\s*([a-f0-9-]{36})/i;

function updateJob(jobId, patch) {
  const current = uploadJobs.get(jobId) || {};
  uploadJobs.set(jobId, { ...current, ...patch });
}

app.post('/api/v1/upload', requireAuth, upload.single('document'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const userId = req.session.user.id;
  const filePath = req.file.path;
  const jobId = crypto.randomUUID();

  const pythonScriptPath = path.join(LITERAY_AGENT_DIR, 'ingest_document.py');
  const pyCmd = resolvePythonCmd();

  updateJob(jobId, {
    status: 'running',
    percent: 2,
    step: 'Starting…',
    filename: req.file.originalname,
    size: req.file.size,
    document_id: null,
    error: null
  });

  res.status(202).json({ job_id: jobId });

  console.log(`[Upload] ${req.file.originalname} — starting ingest (job ${jobId})`);

  const child = spawn(pyCmd, [pythonScriptPath, filePath, '--user-id', userId]);

  let stdoutTail = '';
  let stderrTail = '';

  const handleChunk = (chunk) => {
    stdoutTail += chunk.toString();
    const lines = stdoutTail.split('\n');
    stdoutTail = lines.pop(); 

    for (const line of lines) {
      const docMatch = line.match(DOC_ID_PATTERN);
      if (docMatch && !uploadJobs.get(jobId)?.document_id) {
        updateJob(jobId, { document_id: docMatch[1] });
      }

      const marker = PROGRESS_MARKERS.find(m => m.pattern.test(line));
      if (marker) {
        updateJob(jobId, { percent: marker.percent, step: marker.step });
      }

      if (/->\s*completed with per-document errors|->\s*import failed/i.test(line)) {
        updateJob(jobId, { status: 'error', error: line.trim() });
      }
      if (/still indexing after/i.test(line)) {
        updateJob(jobId, { status: 'pending_timeout', step: 'Still indexing — check back shortly', percent: 90 });
      }
    }
  };

  child.stdout.on('data', handleChunk);
  child.stderr.on('data', (chunk) => { stderrTail += chunk.toString(); });

  child.on('close', (code) => {
    fs.unlink(filePath, () => {}); 

    const job = uploadJobs.get(jobId) || {};
    if (job.status === 'error' || job.status === 'pending_timeout') {
      console.log(`[Ingest] job ${jobId} ended as ${job.status}`);
      return;
    }

    if (code === 0 && job.document_id) {
      updateJob(jobId, { status: 'done', percent: 100, step: 'Indexed and ready' });
      console.log(`[Ingest] job ${jobId} done — document_id=${job.document_id}`);
      store.addDocument(userId, {
        id: job.document_id,
        filename: job.filename,
        size: job.size,
        uploadedAt: new Date().toISOString(),
        status: 'indexed'
      });
    } else {
      const message = stderrTail.trim().split('\n').slice(-1)[0] || 'Ingestion failed with no error output.';
      updateJob(jobId, { status: 'error', error: message });
      console.error(`[Ingest] job ${jobId} failed (exit ${code}): ${message}`);
    }
  });

  child.on('error', (err) => {
    fs.unlink(filePath, () => {});
    updateJob(jobId, { status: 'error', error: `Could not start ingest process: ${err.message}` });
  });

  setTimeout(() => uploadJobs.delete(jobId), 60 * 60 * 1000); 
});

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
});