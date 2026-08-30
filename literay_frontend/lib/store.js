// ===== lib/store.js =====
// เก็บข้อมูลแบบไฟล์ JSON เดียว (data/db.json) — พอสำหรับ demo/hackathon
// ไม่ต้องตั้ง DB เพิ่ม แต่ข้อมูลอยู่ถาวรข้าม restart ต่างจาก in-memory Map เดิม
// โครงสร้าง:
// {
//   users:     { [googleSub]: { id, email, name, picture } },
//   documents: { [userId]: [ { id, filename, size, uploadedAt, status } ] },
//   sessions:  { [userId]: [ { id, title, createdAt, messages: [{role, text, ts}] } ] }
// }

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function emptyDB() {
  return { users: {}, documents: {}, sessions: {}, quizResults: {} };
}

function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyDB(), ...parsed };
  } catch (err) {
    return emptyDB();
  }
}

function writeDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

// ---------- users ----------
function upsertUser(user) {
  const db = readDB();
  db.users[user.id] = user;
  writeDB(db);
  return user;
}

// ---------- documents ----------
function listDocuments(userId) {
  const db = readDB();
  return db.documents[userId] || [];
}

function addDocument(userId, doc) {
  const db = readDB();
  if (!db.documents[userId]) db.documents[userId] = [];
  db.documents[userId].unshift(doc);
  writeDB(db);
  return doc;
}

function deleteDocument(userId, documentId) {
  const db = readDB();
  if (db.documents[userId]) {
    db.documents[userId] = db.documents[userId].filter(d => d.id !== documentId);
    writeDB(db);
  }
}

// ---------- chat sessions / history ----------
function listSessions(userId) {
  const db = readDB();
  return db.sessions[userId] || [];
}

function getSession(userId, sessionId) {
  const db = readDB();
  return (db.sessions[userId] || []).find(s => s.id === sessionId) || null;
}

function saveSession(userId, session) {
  const db = readDB();
  if (!db.sessions[userId]) db.sessions[userId] = [];
  const existingIndex = db.sessions[userId].findIndex(s => s.id === session.id);
  if (existingIndex >= 0) {
    db.sessions[userId][existingIndex] = session;
  } else {
    db.sessions[userId].push(session);
  }
  writeDB(db);
  return session;
}

function deleteSession(userId, sessionId) {
  const db = readDB();
  if (db.sessions[userId]) {
    db.sessions[userId] = db.sessions[userId].filter(s => s.id !== sessionId);
    writeDB(db);
  }
}

// ---------- quiz results (ใช้คำนวณหน้า Progress จากพฤติกรรมจริงของผู้ใช้) ----------

// บันทึกผลตอบคำถามควิซ 1 ข้อ
// result: { documentId, questionId, question, clauseName, correct }
function addQuizResult(userId, result) {
  const db = readDB();
  if (!db.quizResults[userId]) db.quizResults[userId] = [];
  db.quizResults[userId].push({
    documentId: result.documentId,
    questionId: result.questionId || null,
    question: result.question || null,
    clauseName: result.clauseName || 'General',
    correct: !!result.correct,
    answeredAt: new Date().toISOString()
  });
  writeDB(db);
}

// ดึงผลตอบทั้งหมดของ user (กรองตาม documentId ได้ถ้าระบุ)
function getQuizResults(userId, documentId) {
  const db = readDB();
  const all = db.quizResults[userId] || [];
  return documentId ? all.filter(r => r.documentId === documentId) : all;
}

// สรุปผลสำหรับหน้า Progress: { correct, total, weakClauses: [{name, ratio}] }
// weakClauses เรียงจาก clause ที่ตอบผิดบ่อยที่สุดไปน้อยที่สุด เอาแค่ top 5
function getProgressSummary(userId, documentId) {
  const results = getQuizResults(userId, documentId);
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
  readDB,
  writeDB,
  upsertUser,
  listDocuments,
  addDocument,
  deleteDocument,
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  addQuizResult,
  getQuizResults,
  getProgressSummary
};