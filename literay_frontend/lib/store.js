// ===== lib/store.js =====
// Firestore-backed — replaces the local data/db.json file, which does not
// survive on Cloud Run (each container instance has its own ephemeral
// filesystem, and instances don't share state with each other).
//
// PROJECT_ID must match the same GCP project the Python backend uses
// (literay_backend/literay_agent/config.py's GOOGLE_CLOUD_PROJECT) — both
// sides read/write Firestore in the same project.
//
// Collections used here (all prefixed `frontend_` except `documents`,
// which is intentionally the SAME collection ingest_document.py /
// upload_server.py already write to — see listDocuments below):
//   frontend_users            one doc per Google user
//   frontend_sessions         one doc per saved chat session
//   frontend_quiz_results     one doc per answered quiz question
//
// Requires: npm install @google-cloud/firestore

const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'project-8f7bc805-c4fb-4824-a9e';
const db = new Firestore({ projectId: PROJECT_ID });

// ---------- users ----------
async function upsertUser(user) {
  await db.collection('frontend_users').doc(user.id).set(user, { merge: true });
  return user;
}

// ---------- documents ----------
// Deliberately reads the SAME `documents` collection that
// ingest_document.py / upload_server.py already write to during ingest —
// there is no separate frontend copy to keep in sync. That means
// addDocument() below is effectively a no-op/compat shim now: by the time
// the frontend would call it, the Python side has already written the
// record.
async function listDocuments(userId) {
  // Deliberately no .orderBy() here — combining it with .where() would need
  // a Firestore composite index provisioned in advance (index build can
  // take a few minutes and blocks every request until it's ready). Sorting
  // the handful of documents a single demo user has in JS instead avoids
  // that entirely, at negligible cost for this data size.
  const snapshot = await db.collection('documents')
    .where('user_id', '==', userId)
    .get();

  const documents = snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      filename: data.original_file_name,
      size: data.size || null,
      uploadedAt: data.upload_timestamp,
      status: data.indexing_status === 'indexed' ? 'indexed' : 'processing',
    };
  });

  documents.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return documents;
}

// Kept for interface compatibility with older call sites — normally
// unnecessary now (see comment above), but harmless if something still
// calls it directly.
async function addDocument(userId, doc) {
  await db.collection('documents').doc(doc.id).set({
    user_id: userId,
    original_file_name: doc.filename,
    size: doc.size || null,
    upload_timestamp: doc.uploadedAt || new Date().toISOString(),
    indexing_status: doc.status === 'indexed' ? 'indexed' : 'pending',
  }, { merge: true });
  return doc;
}

// Only clears the shared Firestore record as a fallback — the primary
// delete path (Vertex AI Search + GCS + Firestore, in that order) lives in
// upload_server.py's DELETE /documents/:id, called over HTTP from
// server.js. This function existing here too just means "delete" stays
// correct even if this is ever called directly for some other reason.
async function deleteDocument(userId, documentId) {
  const ref = db.collection('documents').doc(documentId);
  const doc = await ref.get();
  if (doc.exists && doc.data().user_id === userId) {
    await ref.delete();
  }
}

// ---------- chat sessions / history ----------
function sessionDocId(userId, sessionId) {
  // Composite doc id keeps the collection flat (no subcollections needed)
  // while still letting us query "all sessions for user X" cheaply.
  return `${userId}__${sessionId}`;
}

async function listSessions(userId) {
  // Same reasoning as listDocuments above — sort in JS, skip the composite index.
  const snapshot = await db.collection('frontend_sessions')
    .where('userId', '==', userId)
    .get();
  const sessions = snapshot.docs.map(doc => doc.data());
  sessions.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sessions;
}

async function getSession(userId, sessionId) {
  const doc = await db.collection('frontend_sessions').doc(sessionDocId(userId, sessionId)).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function saveSession(userId, session) {
  const record = { ...session, userId };
  await db.collection('frontend_sessions').doc(sessionDocId(userId, session.id)).set(record);
  return session;
}

async function deleteSession(userId, sessionId) {
  await db.collection('frontend_sessions').doc(sessionDocId(userId, sessionId)).delete();
}

async function renameSession(userId, sessionId, title) {
  const ref = db.collection('frontend_sessions').doc(sessionDocId(userId, sessionId));
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.update({ title });
  return { ...doc.data(), title };
}

// ---------- quiz results ----------
// result: { documentId, questionId, question, clauseName, correct }
async function addQuizResult(userId, result) {
  await db.collection('frontend_quiz_results').add({
    userId,
    documentId: result.documentId,
    questionId: result.questionId || null,
    question: result.question || null,
    clauseName: result.clauseName || 'General',
    correct: !!result.correct,
    answeredAt: new Date().toISOString()
  });
}

async function getQuizResults(userId, documentId) {
  let query = db.collection('frontend_quiz_results').where('userId', '==', userId);
  if (documentId) query = query.where('documentId', '==', documentId);
  const snapshot = await query.get();
  return snapshot.docs.map(doc => doc.data());
}

async function getProgressSummary(userId, documentId) {
  const results = await getQuizResults(userId, documentId);
  const total = results.length;
  const correct = results.filter(r => r.correct).length;

  const byClause = {};
  results.forEach(r => {
    const name = r.clauseName || 'General';
    if (!byClause[name]) byClause[name] = { wrong: 0, total: 0 };
    byClause[name].total += 1;
    if (!r.correct) byClause[name].wrong += 1;
  });

  const weakClauses = Object.entries(byClause)
    .map(([name, stat]) => ({ name, ratio: stat.total ? stat.wrong / stat.total : 0 }))
    .filter(c => c.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);

  return { correct, total, weakClauses };
}

module.exports = {
  upsertUser,
  listDocuments,
  addDocument,
  deleteDocument,
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  renameSession,
  addQuizResult,
  getQuizResults,
  getProgressSummary
};
