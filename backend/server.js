const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
require('dotenv').config();

// Firebase Admin
const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
  }),
});
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const app = express();
const origins = process.env.ALLOWED_ORIGINS;
app.use(cors({ origin: origins === '*' ? '*' : origins?.split(',') || '*' }));
app.use(express.json({ limit: '5mb' }));

// ── In-memory session store ────────────────────────────────────────────────
const activeSessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, { createdAt: Date.now() });
  return token;
}

function verifySession(token) {
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

// ── Middleware ─────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.body?.token;
  if (!token || !verifySession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// [OPT] Єдиний middleware для Firebase Auth — прибирає ~8 рядків дублювання в кожному роуті
async function requireAuth(req, res, next) {
  const idToken = req.headers['authorization']?.split('Bearer ')[1];
  if (!idToken) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Невірний пароль' });
  }
  const token = createSession();
  res.json({ success: true, token });
});

app.post('/api/admin/verify', (req, res) => {
  const { token } = req.body;
  res.json({ valid: verifySession(token || '') });
});

app.post('/api/admin/logout', (req, res) => {
  const { token } = req.body;
  activeSessions.delete(token);
  res.json({ success: true });
});

// ── Firebase config ────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
  });
});

// ── Topics helpers ─────────────────────────────────────────────────────────
// [OPT] Винесено повторну логіку map слів в окрему функцію
function sanitizeTopicWords(words) {
  return words.map(w => {
    const uk = (w.ukrainian || '').trim();
    const clean = {
      german:    (w.german    || '').trim(),
      ukrainian: uk ? uk.charAt(0).toUpperCase() + uk.slice(1) : uk,
      article:   (w.article   || '').trim(),
    };
    if (w.forms    && typeof w.forms    === 'object') clean.forms    = w.forms;
    if (w.ukForms  && typeof w.ukForms  === 'object') clean.ukForms  = w.ukForms;
    return clean;
  });
}

// ── Topics (public read) ───────────────────────────────────────────────────
app.get('/api/topics', async (req, res) => {
  try {
    const snapshot = await db.collection('topics').orderBy('order', 'asc').get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch {
    // fallback if 'order' index doesn't exist yet
    try {
      const snapshot = await db.collection('topics').orderBy('createdAt', 'desc').get();
      res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/topics/:id', async (req, res) => {
  try {
    const doc = await db.collection('topics').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Topics (admin write) ───────────────────────────────────────────────────
app.post('/api/topics', requireAdmin, async (req, res) => {
  try {
    const { name, nameUk, description, category, words, order, emoji } = req.body;
    if (!name || !nameUk || !Array.isArray(words) || words.length < 2) {
      return res.status(400).json({ error: 'Невірні дані: потрібна назва та мінімум 2 слова' });
    }
    // Use provided order, or put at end by default
    let topicOrder = (typeof order === 'number') ? order : null;
    if (topicOrder === null) {
      const snap = await db.collection('topics').orderBy('order', 'asc').get().catch(() => null);
      topicOrder = snap ? snap.size : 0;
    }
    const ref = await db.collection('topics').add({
      name, nameUk,
      description: description || '',
      category: category === 'verbs' ? 'verbs' : 'nouns',
      words: sanitizeTopicWords(words),
      emoji: emoji || '',
      order: topicOrder,
      createdAt: FV.serverTimestamp(),
    });
    const doc = await ref.get();
    // Кешуємо TTS для нових слів у фоні
    warmTtsForWords(sanitizeTopicWords(words));
    res.status(201).json({ id: ref.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reorder topics ────────────────────────────────────────────────────────
app.put('/api/topics/reorder', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body; // array of topic ids in new order
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
    const batch = db.batch();
    ids.forEach((id, i) => {
      batch.update(db.collection('topics').doc(id), { order: i });
    });
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/topics/:id', requireAdmin, async (req, res) => {
  try {
    const { name, nameUk, description, category, words, emoji } = req.body;
    if (!name || !nameUk || !Array.isArray(words) || words.length < 2) {
      return res.status(400).json({ error: 'Невірні дані' });
    }
    await db.collection('topics').doc(req.params.id).update({
      name, nameUk,
      description: description || '',
      category: category === 'verbs' ? 'verbs' : 'nouns',
      words: sanitizeTopicWords(words),
      emoji: emoji || '',
      updatedAt: FV.serverTimestamp(),
    });
    const doc = await db.collection('topics').doc(req.params.id).get();
    // Кешуємо TTS для оновлених слів у фоні
    warmTtsForWords(sanitizeTopicWords(words));
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TTS cleanup helper ─────────────────────────────────────────────────────
function deleteTtsFiles(words = []) {
  words.forEach(w => {
    const text = w.article ? `${w.article} ${w.german}` : w.german;
    ttsCache.delete(ttsKey(text));
  });
}

app.delete('/api/topics/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('topics').doc(req.params.id).get();
    if (doc.exists) deleteTtsFiles(doc.data().words || []);
    await db.collection('topics').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scenes helpers ─────────────────────────────────────────────────────────
// [OPT] Винесено повторну логіку map слів сцени
function sanitizeSceneWords(words) {
  return words.map((w, i) => {
    let article = (w.article || '').trim();
    let german  = (w.german  || '').trim();
    // Auto-extract article from german if not provided separately (e.g. "das Brot" → article:"das", german:"Brot")
    if (!article && german) {
      const m = german.match(/^(der|die|das|ein|eine)\s+(.+)$/i);
      if (m) { article = m[1]; german = m[2]; }
    }
    return {
      number:    w.number ?? i + 1,
      article,
      german,
      ukrainian: (w.ukrainian || '').trim(),
    };
  });
}

// ── Scenes (public read) ───────────────────────────────────────────────────
app.get('/api/scenes', async (req, res) => {
  try {
    const snapshot = await db.collection('scenes').orderBy('createdAt', 'desc').get();
    const scenes = snapshot.docs.map(doc => {
      const d = doc.data();
      return {
        id:           doc.id,
        name:         d.name,
        nameUk:       d.nameUk,
        emoji:        d.emoji || '',
        wordCount:    (d.words || []).length,
        // words без картинок — потрібні для пошуку/фільтрації на фронті
        words:        (d.words || []).map(w => ({ number: w.number, article: w.article, german: w.german, ukrainian: w.ukrainian })),
        hasImageGame:   !!d.imageGame,
        hasImageAnswer: !!d.imageAnswer,
      };
    });
    res.json(scenes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenes/:id', async (req, res) => {
  try {
    const doc = await db.collection('scenes').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scenes (admin write) ───────────────────────────────────────────────────
app.post('/api/scenes', requireAdmin, async (req, res) => {
  try {
    const { name, nameUk, emoji, imageGame, imageAnswer, words } = req.body;
    if (!name || !nameUk || !Array.isArray(words) || words.length < 1) {
      return res.status(400).json({ error: 'Невірні дані' });
    }
    const ref = await db.collection('scenes').add({
      name, nameUk,
      emoji:       emoji       || '',
      imageGame:   imageGame   || '',
      imageAnswer: imageAnswer || '',
      words: sanitizeSceneWords(words),
      createdAt: FV.serverTimestamp(),
    });
    const doc = await ref.get();
    const d = doc.data();
    warmTtsForWords(sanitizeSceneWords(words));
    res.status(201).json({ id: ref.id, name: d.name, nameUk: d.nameUk, wordCount: d.words?.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scenes/:id', requireAdmin, async (req, res) => {
  try {
    const { name, nameUk, emoji, imageGame, imageAnswer, words } = req.body;
    if (!name || !nameUk || !Array.isArray(words) || words.length < 1) {
      return res.status(400).json({ error: 'Невірні дані' });
    }
    await db.collection('scenes').doc(req.params.id).update({
      name, nameUk,
      emoji:       emoji       || '',
      imageGame:   imageGame   || '',
      imageAnswer: imageAnswer || '',
      words: sanitizeSceneWords(words),
      updatedAt: FV.serverTimestamp(),
    });
    warmTtsForWords(sanitizeSceneWords(words));
    res.json({ id: req.params.id, name, nameUk, wordCount: words.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/scenes/:id', requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('scenes').doc(req.params.id).get();
    if (doc.exists) deleteTtsFiles(doc.data().words || []);
    await db.collection('scenes').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bot difficulty (admin only) ────────────────────────────────────────────
app.get('/api/bot-difficulty', requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('bot').get();
    const data = doc.exists ? doc.data() : {};
    res.json({
      difficulty:  data.difficulty  ?? botDifficulty,
      botWaitTime: data.botWaitTime ?? BOT_WAIT_TIME,
      botSettings: data.botSettings ?? BOT_SETTINGS,
    });
  } catch {
    res.json({ difficulty: botDifficulty, botWaitTime: BOT_WAIT_TIME, botSettings: BOT_SETTINGS });
  }
});

app.post('/api/bot-difficulty', requireAdmin, async (req, res) => {
  const { difficulty, botWaitTime, botSettings } = req.body;
  if (![1, 2, 3].includes(Number(difficulty))) {
    return res.status(400).json({ error: 'Difficulty must be 1, 2 or 3' });
  }
  botDifficulty = Number(difficulty);
  if (typeof botWaitTime === 'number' && botWaitTime >= 5000) BOT_WAIT_TIME = botWaitTime;
  if (botSettings) BOT_SETTINGS = { ...BOT_SETTINGS, ...botSettings };
  try {
    await db.collection('settings').doc('bot').set({
      difficulty:  botDifficulty,
      botWaitTime: BOT_WAIT_TIME,
      botSettings: BOT_SETTINGS,
    });
    res.json({ success: true });
  } catch {
    // [FIX] Раніше повертало помилку, але зміни вже застосовані в памʼяті — відповідь узгоджена
    res.status(500).json({ error: 'Firestore save failed' });
  }
});

// ── User Profile ───────────────────────────────────────────────────────────
app.post('/api/users/init', requireAuth, async (req, res) => {
  const { uid, email, name } = req.user;
  const displayName = name || email?.split('@')[0] || 'Гравець';
  const ref = db.collection('users').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) {
    // Generate unique 6-char friend code
    let code, exists = true;
    while (exists) {
      code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const snap = await db.collection('users').where('friendCode', '==', code).limit(1).get();
      exists = !snap.empty;
    }
    await ref.set({
      uid, email,
      displayName,
      friendCode: code,
      stats: { played: 0, won: 0, winStreak: 0, bestStreak: 0 },
      createdAt: FV.serverTimestamp(),
    });
    const newDoc = await ref.get();
    return res.json({ created: true, ...newDoc.data() });
  }
  res.json({ created: false, ...doc.data() });
});

app.post('/api/users/reset-stats', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.user.uid).update({
      stats: { played: 0, won: 0, winStreak: 0, bestStreak: 0 },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/me', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const batch = db.batch();
    const friendsSnap = await db.collection('users').doc(uid).collection('friends').get();
    for (const f of friendsSnap.docs) {
      batch.delete(db.collection('users').doc(f.data().uid).collection('friends').doc(uid));
    }
    batch.delete(db.collection('users').doc(uid));
    await batch.commit();

    const [reqSnap1, reqSnap2, invSnap1, invSnap2] = await Promise.all([
      db.collection('friendRequests').where('fromUid', '==', uid).get(),
      db.collection('friendRequests').where('toUid',   '==', uid).get(),
      db.collection('duelInvites').where('fromUid',    '==', uid).get(),
      db.collection('duelInvites').where('toUid',      '==', uid).get(),
    ]);
    const delBatch = db.batch();
    [...reqSnap1.docs, ...reqSnap2.docs, ...invSnap1.docs, ...invSnap2.docs]
      .forEach(d => delBatch.delete(d.ref));
    await delBatch.commit();
    await admin.auth().deleteUser(uid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/me', requireAuth, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Profile not found' });
    res.json(doc.data());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/me', requireAuth, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: "Ім'я не може бути порожнім" });
  }
  const trimmed = displayName.trim().substring(0, 30);
  try {
    const uid = req.user.uid;
    await db.collection('users').doc(uid).update({ displayName: trimmed });
    await admin.auth().updateUser(uid, { displayName: trimmed });
    res.json({ success: true, displayName: trimmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/search', requireAuth, async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const snap = await db.collection('users')
      .where('friendCode', '==', code.toUpperCase()).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Користувача не знайдено' });
    const d = snap.docs[0].data();
    res.json({ uid: d.uid, displayName: d.displayName, friendCode: d.friendCode, stats: d.stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Friend requests ────────────────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, async (req, res) => {
  const { toUid } = req.body;
  const fromUid = req.user.uid;
  if (fromUid === toUid) return res.status(400).json({ error: 'Cannot add yourself' });
  try {
    const [existing, reqDoc] = await Promise.all([
      db.collection('users').doc(toUid).collection('friends').doc(fromUid).get(),
      db.collection('friendRequests').doc(`${fromUid}_${toUid}`).get(),
    ]);
    if (existing.exists) return res.status(400).json({ error: 'Already friends' });
    if (reqDoc.exists)   return res.status(400).json({ error: 'Request already sent' });

    const fromDoc = await db.collection('users').doc(fromUid).get();
    const fromData = fromDoc.data();
    await db.collection('friendRequests').doc(`${fromUid}_${toUid}`).set({
      fromUid, toUid,
      fromName: fromData.displayName,
      fromCode: fromData.friendCode,
      status: 'pending',
      createdAt: FV.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('friendRequests')
      .where('toUid', '==', req.user.uid).where('status', '==', 'pending').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/friends/respond', requireAuth, async (req, res) => {
  const { requestId, accept } = req.body;
  try {
    const reqDoc = await db.collection('friendRequests').doc(requestId).get();
    if (!reqDoc.exists || reqDoc.data().toUid !== req.user.uid)
      return res.status(403).json({ error: 'Forbidden' });

    const { fromUid, toUid, fromName } = reqDoc.data();
    if (accept) {
      const toDoc  = await db.collection('users').doc(toUid).get();
      const toData = toDoc.data();
      const batch  = db.batch();
      batch.set(
        db.collection('users').doc(toUid).collection('friends').doc(fromUid),
        { uid: fromUid, displayName: fromName, addedAt: FV.serverTimestamp() }
      );
      batch.set(
        db.collection('users').doc(fromUid).collection('friends').doc(toUid),
        { uid: toUid, displayName: toData.displayName, addedAt: FV.serverTimestamp() }
      );
      await batch.commit();
    }
    await db.collection('friendRequests').doc(requestId).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const snap    = await db.collection('users').doc(req.user.uid).collection('friends').get();
    const friends = snap.docs.map(d => d.data());
    const enriched = await Promise.all(friends.map(async f => {
      const uDoc = await db.collection('users').doc(f.uid).get();
      return uDoc.exists ? { ...f, stats: uDoc.data().stats, friendCode: uDoc.data().friendCode } : f;
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/friends/:uid', requireAuth, async (req, res) => {
  try {
    const myUid    = req.user.uid;
    const theirUid = req.params.uid;
    const batch    = db.batch();
    batch.delete(db.collection('users').doc(myUid).collection('friends').doc(theirUid));
    batch.delete(db.collection('users').doc(theirUid).collection('friends').doc(myUid));
    await batch.commit();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Duel invites ───────────────────────────────────────────────────────────
// [FIX] friendRooms Map оголошено, але ніколи не використовувався — видалено

app.post('/api/duel/private-room', requireAuth, (req, res) => {
  // [OPT] Просто генеруємо код — не потрібен async/await для цього
  const roomCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // [FIX] crypto замість Math.random для безпечнішого коду
  res.json({ roomCode });
});

app.post('/api/duel/invite', requireAuth, async (req, res) => {
  const { toUid, topicId, roomCode } = req.body; // [FIX] roomCode витягувався двічі з req.body
  const fromUid = req.user.uid;
  try {
    const fromDoc  = await db.collection('users').doc(fromUid).get();
    const inviteId = crypto.randomBytes(8).toString('hex');
    await db.collection('duelInvites').doc(inviteId).set({
      fromUid, toUid, topicId,
      roomCode: roomCode || null,
      fromName: fromDoc.data()?.displayName || 'Гравець',
      status:   'pending',
      createdAt: FV.serverTimestamp(),
    });
    res.json({ success: true, inviteId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/duel/invites', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('duelInvites')
      .where('toUid', '==', req.user.uid).where('status', '==', 'pending').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/duel/invite-status/:inviteId', requireAuth, async (req, res) => {
  try {
    const doc = await db.collection('duelInvites').doc(req.params.inviteId).get();
    if (!doc.exists) return res.status(404).json({ status: 'not_found' });
    res.json({ status: doc.data().status || 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/duel/invites', requireAuth, async (req, res) => {
  const { inviteId, action } = req.body;
  try {
    const doc = await db.collection('duelInvites').doc(inviteId).get();
    if (!doc.exists) return res.json({ success: true });

    const data = doc.data();
    if (data.toUid !== req.user.uid && data.fromUid !== req.user.uid)
      return res.status(403).json({ error: 'Forbidden' });

    const invRef = db.collection('duelInvites').doc(inviteId);
    if (data.toUid === req.user.uid) {
      if (action === 'accept') {
        await invRef.update({ status: 'accepted' });
        setTimeout(() => invRef.delete().catch(() => {}), 60_000);
      } else {
        await invRef.update({ status: 'declined' });
        setTimeout(() => invRef.delete().catch(() => {}), 30_000);
      }
    } else {
      await invRef.delete();
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats update ───────────────────────────────────────────────────────────
// [FIX] topicUpdate оголошено але ніколи не використовувалось — winner оновлення
// хардкодило topicId без перевірки. Виправлено — обидва блоки умовні.
async function updateDuelStats(winnerUid, loserUid, topicId) {
  if (!winnerUid || !loserUid) return;

  // Read current winner stats to calculate new streak
  const winRef  = db.collection('users').doc(winnerUid);
  const losRef  = db.collection('users').doc(loserUid);
  const winDoc  = await winRef.get();
  const winData = winDoc.exists ? winDoc.data() : {};
  const newStreak     = (winData.stats?.winStreak || 0) + 1;
  const newBestStreak = Math.max(winData.stats?.bestStreak || 0, newStreak);

  const batch = db.batch();
  const winUpdate = {
    'stats.played':     FV.increment(1),
    'stats.won':        FV.increment(1),
    'stats.winStreak':  newStreak,
    'stats.bestStreak': newBestStreak,
  };
  const losUpdate = {
    'stats.played':    FV.increment(1),
    'stats.winStreak': 0, // reset streak on loss
  };
  if (topicId) {
    winUpdate[`stats.topics.${topicId}.played`] = FV.increment(1);
    winUpdate[`stats.topics.${topicId}.won`]    = FV.increment(1);
    losUpdate[`stats.topics.${topicId}.played`] = FV.increment(1);
  }
  batch.update(winRef, winUpdate);
  batch.update(losRef, losUpdate);
  await batch.commit();
}

// ── TTS — in-memory кеш + прогрів при старті ──────────────────────────────
const ttsCache = new Map(); // text → Buffer

function ttsKey(text) { return text.trim().toLowerCase(); }

async function fetchFromGoogle(text) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=de&client=tw-ob`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
  });
  if (!res.ok) throw new Error(`Google TTS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function warmTtsForWords(words = []) {
  for (const w of words) {
    const text = w.article ? `${w.article} ${w.german}` : w.german;
    const key = ttsKey(text);
    if (ttsCache.has(key)) continue;
    try {
      const buf = await fetchFromGoogle(text);
      ttsCache.set(key, buf);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn(`TTS warmup failed: "${text}" —`, e.message);
    }
  }
}

async function warmTtsCache() {
  try {
    const [topicsSnap, scenesSnap] = await Promise.all([
      db.collection('topics').get(),
      db.collection('scenes').get(),
    ]);

    const texts = new Set();
    topicsSnap.docs.forEach(doc => {
      (doc.data().words || []).forEach(w => {
        if (w.german) texts.add(w.article ? `${w.article} ${w.german}` : w.german);
      });
    });
    scenesSnap.docs.forEach(doc => {
      (doc.data().words || []).forEach(w => {
        if (w.german) texts.add(w.article ? `${w.article} ${w.german}` : w.german);
      });
    });

    console.log(`🔊 TTS warmup: ${texts.size} слів...`);
    let done = 0, failed = 0;

    for (const text of texts) {
      const key = ttsKey(text);
      if (ttsCache.has(key)) { done++; continue; }
      try {
        const buf = await fetchFromGoogle(text);
        ttsCache.set(key, buf);
        done++;
        // невелика пауза щоб не спамити Google
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        failed++;
        console.warn(`TTS warmup failed: "${text}" —`, e.message);
      }
    }
    console.log(`✅ TTS warmup завершено: ${done} OK, ${failed} помилок`);
  } catch (e) {
    console.error('TTS warmup error:', e.message);
  }
}

app.get('/api/tts', async (req, res) => {
  const text = req.query.q;
  if (!text || text.length > 200) return res.status(400).end();

  const key = ttsKey(text);

  // 1. З кешу
  if (ttsCache.has(key)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.end(ttsCache.get(key));
  }

  // 2. З Google (нове слово додане після старту)
  try {
    const buf = await fetchFromGoogle(text);
    ttsCache.set(key, buf);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.end(buf);
  } catch (e) {
    console.error('TTS fetch error:', e.message);
    res.status(502).end();
  }
});

// ── AI Prompts (admin read/write) ─────────────────────────────────────────
const DEFAULT_PROMPTS = {
  nouns: `Ти — експерт з німецької та української граматики. Для кожного іменника поверни точні відмінкові форми.
Відповідай ТІЛЬКИ валідним JSON масивом — без пояснень, без markdown, без \`\`\`.

Формат кожного елемента:
{"german":"Frau","forms":{"nom_sg":"die Frau","akk_sg":"die Frau","dat_sg":"der Frau","gen_sg":"der Frau","nom_pl":"die Frauen","akk_pl":"die Frauen","dat_pl":"den Frauen","gen_pl":"der Frauen"},"ukForms":{"nom_sg":"Жінка","akk_sg":"Жінку","dat_sg":"Жінці","gen_sg":"Жінки","nom_pl":"Жінки","akk_pl":"Жінок","dat_pl":"Жінкам","gen_pl":"Жінок"}}

Правила:
- forms: ЗАВЖДИ включай правильний артикль у кожну форму (der/die/das/den/dem/des)
- forms: для слів без множини — поля nom_pl, akk_pl, dat_pl, gen_pl залиш порожніми рядками ""
- forms: для слів тільки у множині — поля nom_sg, akk_sg, dat_sg, gen_sg залиш порожніми рядками ""
- ukForms: правильно відмінюй УКРАЇНСЬКЕ слово (Називний/Знахідний/Давальний/Родовий в однині та множині)
- ukForms: якщо немає множини — поля pl залиш порожніми рядками ""
- Для неправильних іменників (das Herz, der Name тощо) — використовуй точні форми
- НЕ додавай жодного тексту поза JSON масивом

Слова:`,

  verbs: `Ти — експерт з німецької граматики. Для кожного дієслова поверни точні форми відмінювання.
Відповідай ТІЛЬКИ валідним JSON масивом — без пояснень, без markdown, без \`\`\`.

Формат кожного елемента:
{"german":"kaufen","forms":{"pras_ich":"kaufe","pras_du":"kaufst","pras_er":"kauft","pras_wir":"kaufen","pras_ihr":"kauft","pras_sie":"kaufen","prat_ich":"kaufte","prat_du":"kauftest","prat_er":"kaufte","prat_wir":"kauften","prat_ihr":"kauftet","prat_sie":"kauften","fut_ich":"werde kaufen","fut_du":"wirst kaufen","fut_er":"wird kaufen","fut_wir":"werden kaufen","fut_ihr":"werdet kaufen","fut_sie":"werden kaufen","partizip2":"gekauft","hilfsverb":"haben"},"ukForms":{"pras_ich":"купую","pras_du":"купуєш","pras_er":"купує","pras_wir":"купуємо","pras_ihr":"купуєте","pras_sie":"купують","prat_ich":"купував","prat_du":"купував","prat_er":"купував","prat_wir":"купували","prat_ihr":"купували","prat_sie":"купували","fut_ich":"буду купувати","fut_du":"будеш купувати","fut_er":"буде купувати","fut_wir":"будемо купувати","fut_ihr":"будете купувати","fut_sie":"будуть купувати","partizip2":"куплений"}}

Правила:
- pras: Präsens — для неправильних дієслів обов'язково зміни корінь (fahren→fährt, laufen→läuft, sein→bin/bist/ist тощо)
- prat: Präteritum — для неправильних дієслів використовуй ТОЧНИЙ сильний Präteritum (gehen→ging, fahren→fuhr, sein→war)
- fut: Futur I — werde/wirst/wird/werden/werdet/werden + інфінітив
- partizip2: точний Partizip II (з ge- або без, з haben/sein)
- hilfsverb: "haben" або "sein" (sein для дієслів руху та зміни стану)
- ukForms.prat: минулий час українською з чоловічим родом (купував, йшов, був)
- ukForms.partizip2: пасивний дієприкметник (куплений, зроблений) або форма перфекта (пішов, прийшов)
- НЕ додавай жодного тексту поза JSON масивом

Слова:`,
};

app.get('/api/prompts', requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('prompts').get();
    const data = doc.exists ? doc.data() : {};
    res.json({
      nouns: data.nouns ?? DEFAULT_PROMPTS.nouns,
      verbs: data.verbs ?? DEFAULT_PROMPTS.verbs,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prompts', requireAdmin, async (req, res) => {
  const { nouns, verbs } = req.body;
  if (typeof nouns !== 'string' || typeof verbs !== 'string') {
    return res.status(400).json({ error: 'nouns and verbs required' });
  }
  try {
    await db.collection('settings').doc('prompts').set({ nouns, verbs });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generate word forms via Gemini AI ─────────────────────────────────────
app.post('/api/generate-forms', requireAdmin, async (req, res) => {
  const { topicId } = req.body;
  if (!topicId) return res.status(400).json({ error: 'topicId required' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    // 1. Load topic
    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) return res.status(404).json({ error: 'Topic not found' });
    const topic = topicDoc.data();
    const isVerbs = topic.category === 'verbs';
    const words = topic.words || [];

    // 2. Load prompt
    const promptsDoc = await db.collection('settings').doc('prompts').get();
    const promptsData = promptsDoc.exists ? promptsDoc.data() : {};
    const systemPrompt = (isVerbs ? promptsData.verbs : promptsData.nouns)
      ?? (isVerbs ? DEFAULT_PROMPTS.verbs : DEFAULT_PROMPTS.nouns);

    // 3. Build word list
    const wordList = words.map(w =>
      isVerbs ? w.german : (w.article ? `${w.article} ${w.german}` : w.german)
    ).join('\n');

    // 4. Call Groq API
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Згенеруй форми для цих слів:\n${wordList}` },
        ],
        temperature: 0.1,
        max_tokens: 8192,
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      return res.status(502).json({ error: `Groq API error: ${err}` });
    }

    const aiData = await aiRes.json();
    const rawText = aiData.choices?.[0]?.message?.content || '';

    // 5. Parse JSON
    let formsArray;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      formsArray = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: 'AI returned invalid JSON', raw: rawText.slice(0, 500) });
    }

    // 6. Merge forms into words by matching german field
    const formsMap = {};
    formsArray.forEach(item => {
      if (item.german && item.forms) {
        formsMap[item.german.toLowerCase()] = { forms: item.forms, ukForms: item.ukForms || null };
      }
    });

    const updatedWords = words.map(w => {
      const matched = formsMap[w.german.toLowerCase()];
      return {
        ...w,
        forms:   matched?.forms   || w.forms   || null,
        ukForms: matched?.ukForms || w.ukForms || null,
      };
    });

    // 7. Save back to Firestore
    await db.collection('topics').doc(topicId).update({
      words: updatedWords,
      formsGeneratedAt: FV.serverTimestamp(),
    });

    res.json({ success: true, count: formsArray.length, words: updatedWords });
  } catch (e) {
    console.error('generate-forms error:', e);
    res.status(500).json({ error: e.message });
  }
});


// ── Save word forms only (no full topic update) ───────────────────────────
app.post('/api/topics/:id/forms', requireAdmin, async (req, res) => {
  try {
    const { words } = req.body;
    if (!Array.isArray(words)) return res.status(400).json({ error: 'words required' });
    await db.collection('topics').doc(req.params.id).update({
      words,
      formsUpdatedAt: FV.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Wiktionary helpers ─────────────────────────────────────────────────────
async function fetchWiktionary(word) {
  const url = 'https://de.wiktionary.org/w/api.php?action=query&titles=' + encodeURIComponent(word) + '&prop=revisions&rvprop=content&format=json&formatversion=2';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Herrin-LearningApp/1.0 (educational)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  const page = data && data.query && data.query.pages && data.query.pages[0];
  if (!page || page.missing) return null;
  return (page.revisions && page.revisions[0] && page.revisions[0].content) || null;
}

// Parse a wikitext template block line by line — more reliable than regex
function getWikiField(block, key) {
  const lines = block.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const fieldName = trimmed.slice(1, eqIdx).trim();
    if (fieldName === key) {
      const val = trimmed.slice(eqIdx + 1).trim();
      // Strip wiki markup: <tags>, [[links|display]], ''bold''
      return val
        .replace(/<[^>]+>/g, '')
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
        .replace(/'{2,}/g, '')
        .trim() || null;
    }
  }
  return null;
}

function parseWiktionaryArticle(wikitext) {
  const m = wikitext.match(/\{\{Deutsch Substantiv Übersicht([\s\S]*?)\}\}/);
  if (!m) return null;
  const block = m[1];
  const g = getWikiField(block, 'Genus') || getWikiField(block, 'Genus 1');
  const articleMap = { m: 'der', f: 'die', n: 'das', Maskulinum: 'der', Femininum: 'die', Neutrum: 'das' };
  return {
    article: articleMap[g] || null,
    nom_sg:  getWikiField(block, 'Nominativ Singular')  || getWikiField(block, 'Nominativ Singular 1'),
    nom_pl:  getWikiField(block, 'Nominativ Plural')    || getWikiField(block, 'Nominativ Plural 1'),
    gen_sg:  getWikiField(block, 'Genitiv Singular')    || getWikiField(block, 'Genitiv Singular 1'),
    gen_pl:  getWikiField(block, 'Genitiv Plural')      || getWikiField(block, 'Genitiv Plural 1'),
    dat_sg:  getWikiField(block, 'Dativ Singular')      || getWikiField(block, 'Dativ Singular 1'),
    dat_pl:  getWikiField(block, 'Dativ Plural')        || getWikiField(block, 'Dativ Plural 1'),
    akk_sg:  getWikiField(block, 'Akkusativ Singular')  || getWikiField(block, 'Akkusativ Singular 1'),
    akk_pl:  getWikiField(block, 'Akkusativ Plural')    || getWikiField(block, 'Akkusativ Plural 1'),
  };
}

function parseWiktionaryVerb(wikitext) {
  const m = wikitext.match(/\{\{Deutsch Verb Übersicht([\s\S]*?)\}\}/);
  if (!m) return null;
  const block = m[1];
  const pras_ich = getWikiField(block, 'Präsens_ich');
  const pras_wir = getWikiField(block, 'Präsens_wir') || (pras_ich ? pras_ich.replace(/e$/, 'en') : null);
  const hilfs = getWikiField(block, 'Hilfsverb') || '';
  return {
    pras_ich,
    pras_du:   getWikiField(block, 'Präsens_du'),
    pras_er:   getWikiField(block, 'Präsens_er'),
    pras_wir,
    pras_ihr:  getWikiField(block, 'Präsens_ihr'),
    pras_sie:  getWikiField(block, 'Präsens_sie') || pras_wir,
    prat_ich:  getWikiField(block, 'Präteritum_ich'),
    partizip2: getWikiField(block, 'Partizip II'),
    hilfsverb: hilfs.includes('sein') ? 'sein' : 'haben',
  };
}

// ── Auto-generate words for topic ─────────────────────────────────────────
app.post('/api/generate-words', requireAdmin, async (req, res) => {
  const { topicNameUk, topicNameDe, category, count, existingWords } = req.body;
  if (!topicNameUk) return res.status(400).json({ error: 'topicNameUk required' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const isVerbs = category === 'verbs';
  const n = Math.min(Math.max(parseInt(count) || 15, 1), 50);

  try {
    // Load ALL existing words from DB for dedup; pass only similar-topic words to AI prompt
    const allTopicsSnap = await db.collection('topics').get();
    const allExistingGerman = new Set();
    const allExistingUkrainian = new Set();
    const topicNameLower = (topicNameUk + ' ' + (topicNameDe || '')).toLowerCase();
    const similarWordsGerman = new Set();
    allTopicsSnap.docs.forEach(doc => {
      const d = doc.data();
      const docName = ((d.name || '') + ' ' + (d.nameUk || '')).toLowerCase();
      const isSimilar = topicNameLower.split(/\s+/).some(w => w.length > 3 && docName.includes(w))
                     || docName.split(/\s+/).some(w => w.length > 3 && topicNameLower.includes(w));
      (d.words || []).forEach(w => {
        if (w.german)    allExistingGerman.add(w.german.toLowerCase());
        if (w.ukrainian) allExistingUkrainian.add(w.ukrainian.toLowerCase());
        if (isSimilar && w.german) similarWordsGerman.add(w.german.toLowerCase());
      });
    });
    (existingWords || []).forEach(w => {
      if (w.german)    { allExistingGerman.add(w.german.toLowerCase()); similarWordsGerman.add(w.german.toLowerCase()); }
      if (w.ukrainian) allExistingUkrainian.add(w.ukrainian.toLowerCase());
    });
    const existingList = similarWordsGerman.size > 0
      ? [...similarWordsGerman].join(', ')
      : [...allExistingGerman].slice(0, 100).join(', ') || 'немає';

    // Step 1: Groq generates {ukrainian, german, article} — 4x buffer so dedup still leaves enough
    const bufferN = Math.min(n * 4, 80);
    const prompt = isVerbs
      ? `Ти — вчитель німецької мови для початківців. Для теми "${topicNameUk}" (${topicNameDe || ''}) згенеруй рівно ${bufferN} простих дієслів рівня A1-B1.
КРИТИЧНО: ukrainian і german — ТОЧНІ переклади одне одного. Якщо перекласти german назад — має вийти саме ukrainian.
МОВА: ukrainian — тільки ЛІТЕРАТУРНА УКРАЇНСЬКА, не російська, не суржик.
Використовуй тільки найбільш вживане стандартне слово, не складні композити.
Ці слова вже є в словнику — НЕ включай: ${existingList}
Відповідай ТІЛЬКИ валідним JSON масивом без пояснень, без markdown:
[{"ukrainian":"йти","german":"gehen","article":""},{"ukrainian":"їхати","german":"fahren","article":""},...]
Правила: інфінітив і українською і німецькою, article завжди "", без дублікатів, рівно ${bufferN} слів.`
      : `Ти — вчитель німецької мови для початківців. Для теми "${topicNameUk}" (${topicNameDe || ''}) згенеруй рівно ${bufferN} простих іменників рівня A1-B1.
КРИТИЧНО: ukrainian і german — ТОЧНІ переклади одне одного. Якщо перекласти german назад — має вийти саме ukrainian. Приклад: рейс → Flug (не Fahrt!), вокзал → Bahnhof (не Bahnhofshalle).
МОВА: ukrainian — тільки ЛІТЕРАТУРНА УКРАЇНСЬКА. Категорично НЕ можна: російські слова, суржик, кальки з рос. Правильно: "намисто" (не "ожерелье"), "сережки" (не "серьги"), "каблучка/кільце" (не "кольцо"), "браслет" якщо немає кращого укр слова, "аксесуар" (не "аксессуар").
Тільки найбільш вживане стандартне слово — не синоніми, не рідкісні варіанти, не складні композити. Рівень A1-B1.
Ці слова вже є в словнику — НЕ включай: ${existingList}
Відповідай ТІЛЬКИ валідним JSON масивом без пояснень, без markdown:
[{"ukrainian":"кільце","german":"Ring","article":"der"},{"ukrainian":"намисто","german":"Halskette","article":"die"},...]
Правила: german — ТІЛЬКИ однина Nominativ Singular (не множина!), з великої літери. Неправильно: "Ohrringe","Manschettenknöpfe" — правильно: "Ohrring","Manschettenknopf". ukrainian — теж однина. article обов'язково der/die/das, без дублікатів, рівно ${bufferN} слів.`;
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 4096,
      }),
    });
    if (!aiRes.ok) return res.status(502).json({ error: 'Groq error: ' + await aiRes.text() });
    const aiData = await aiRes.json();
    const rawText = aiData.choices?.[0]?.message?.content || '';
    let aiWords;
    try {
      aiWords = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      if (!Array.isArray(aiWords)) throw new Error('not array');
    } catch {
      return res.status(502).json({ error: 'Groq returned invalid JSON', raw: rawText.slice(0, 300) });
    }

    // Hard dedup: remove any words AI generated that already exist in DB (belt-and-suspenders)
    const deduped = aiWords.filter(w => {
      const g = (w.german   || '').toLowerCase();
      const u = (w.ukrainian || '').toLowerCase();
      return g && u && !allExistingGerman.has(g) && !allExistingUkrainian.has(u);
    });
    // Also remove duplicate german words within the AI batch itself
    const seenGerman = new Set();
    const dedupedUniq = deduped.filter(w => {
      const g = w.german.toLowerCase();
      if (seenGerman.has(g)) return false;
      seenGerman.add(g);
      return true;
    });
    const trimmed = dedupedUniq.slice(0, n);

    // Step 2: Verify/correct articles via verbformen.de DIRECT word page (static HTML, reliable).
    const verified = [];
    for (const w of trimmed) {
      const ukWord    = (w.ukrainian || '').trim();
      const germanWord = (w.german   || '').trim();
      const aiArticle = (w.article   || '').trim().toLowerCase();
      if (!ukWord || !germanWord) continue;

      if (isVerbs) {
        // Verbs have no article — trust AI
        verified.push({ article: '', german: germanWord, ukrainian: ukWord, source: 'ai' });
        continue;
      }

      // For nouns: verify word and article via Wiktionary
      try {
        const wikitext = await fetchWiktionary(germanWord);
        if (wikitext) {
          const parsed = parseWiktionaryArticle(wikitext);
          const finalGerman  = (parsed && parsed.nom_sg) ? parsed.nom_sg : germanWord;
          const article      = parsed && parsed.article ? parsed.article : null;
          const finalArticle = article || aiArticle;
          verified.push({ article: finalArticle, german: finalGerman, ukrainian: ukWord, source: article ? 'wiktionary' : 'ai' });
        } else {
        }
      } catch(e) {
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const found    = verified.filter(w => w.german);
    const notFound = verified.filter(w => !w.german).map(w => w.ukrainian);

    res.json({ success: true, words: found, notFound, total: n, parsed: found.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Parse word forms via Wiktionary ──────────────────────────────────────
app.post('/api/parse-verbformen', requireAdmin, async (req, res) => {
  const { words, category } = req.body;
  if (!Array.isArray(words) || !words.length) return res.status(400).json({ error: 'words required' });

  const isVerbs = category === 'verbs';
  const results = [];
  const errors  = [];

  for (const word of words) {
    const germanWord = word.german || word;
    try {
      const wikitext = await fetchWiktionary(germanWord);
      if (!wikitext) { errors.push({ word: germanWord, error: 'Не знайдено у Wiktionary' }); continue; }

      if (isVerbs) {
        const parsed = parseWiktionaryVerb(wikitext);
        if (!parsed || Object.values(parsed).filter(Boolean).length < 3) {
          errors.push({ word: germanWord, error: 'Не вдалось розпарсити форми' }); continue;
        }
        results.push({ german: germanWord, forms: parsed, ukForms: {} });
      } else {
        const parsed = parseWiktionaryArticle(wikitext);
        if (!parsed || !parsed.nom_sg) {
          errors.push({ word: germanWord, error: 'Не вдалось розпарсити відмінки' }); continue;
        }
        const forms = {
          nom_sg: parsed.nom_sg, nom_pl: parsed.nom_pl,
          gen_sg: parsed.gen_sg, gen_pl: parsed.gen_pl,
          dat_sg: parsed.dat_sg, dat_pl: parsed.dat_pl,
          akk_sg: parsed.akk_sg, akk_pl: parsed.akk_pl,
        };
        results.push({ german: germanWord, forms, ukForms: {} });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      errors.push({ word: germanWord, error: e.message });
    }
  }

  res.json({ success: true, results, errors, total: words.length, parsed: results.length });
});


// ── Verify existing words via Wiktionary ──────────────────────────────────
app.post('/api/verify-words', requireAdmin, async (req, res) => {
  const { words } = req.body;
  if (!Array.isArray(words) || !words.length) return res.status(400).json({ error: 'words required' });

  const results = [];
  for (const w of words) {
    const germanWord = (w.german || '').trim();
    const aiArticle  = (w.article || '').trim().toLowerCase();
    if (!germanWord) { results.push({ ...w, status: 'skipped' }); continue; }

    try {
      const wikitext = await fetchWiktionary(germanWord);
      if (wikitext) {
        const parsed      = parseWiktionaryArticle(wikitext);
        const finalGerman  = (parsed && parsed.nom_sg) ? parsed.nom_sg : germanWord;
        const article      = parsed && parsed.article ? parsed.article : null;
        const finalArticle = article || aiArticle;
        const wordChanged    = finalGerman !== germanWord;
        const articleChanged = article && article !== aiArticle;
        results.push({
          ...w,
          german:  finalGerman,
          article: finalArticle,
          source:  article ? 'wiktionary' : 'ai',
          wordChanged,
          articleChanged,
          originalGerman:  wordChanged    ? germanWord  : undefined,
          originalArticle: articleChanged ? aiArticle   : undefined,
        });
      } else {
        results.push({ ...w, source: 'not_found', notFound: true });
      }
    } catch(e) {
      results.push({ ...w, source: 'error', error: e.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ success: true, results });
});

// ── Generate word forms via Wiktionary ────────────────────────────────────
app.post('/api/generate-forms-wiktionary', requireAdmin, async (req, res) => {
  const { topicId } = req.body;
  if (!topicId) return res.status(400).json({ error: 'topicId required' });

  const GROQ_KEY = process.env.GROQ_API_KEY;

  try {
    const topicDoc = await db.collection('topics').doc(topicId).get();
    if (!topicDoc.exists) return res.status(404).json({ error: 'Topic not found' });
    const topic = topicDoc.data();
    const isVerbs = topic.category === 'verbs';
    const words = topic.words || [];

    const updatedWords = [];
    const results = []; // detailed per-word results for UI

    for (const w of words) {
      const germanWord = (w.german || '').trim();
      const ukrainian  = (w.ukrainian || '').trim();
      if (!germanWord) { updatedWords.push(w); continue; }

      let forms = null;
      let ukForms = null;
      let source = 'not_found';

      // Step 1: Get German forms from Wiktionary
      try {
        const wikitext = await fetchWiktionary(germanWord);
        if (wikitext) {
          if (isVerbs) {
            const parsed = parseWiktionaryVerb(wikitext);
            if (parsed && parsed.pras_ich) {
              // Build prat forms from prat_ich
              const prat_ich = parsed.prat_ich || '';
              const prat_wir = prat_ich.endsWith('te') ? prat_ich + 'n' : prat_ich ? prat_ich + 'en' : '';
              forms = {
                pras_ich: parsed.pras_ich,
                pras_du:  parsed.pras_du,
                pras_er:  parsed.pras_er,
                pras_wir: parsed.pras_wir,
                pras_ihr: parsed.pras_ihr,
                pras_sie: parsed.pras_sie || parsed.pras_wir,
                prat_ich,
                prat_du:  prat_ich ? prat_ich + 'st' : '',
                prat_er:  prat_ich,
                prat_wir,
                prat_ihr: prat_ich ? prat_ich + 't' : '',
                prat_sie: prat_wir,
                fut_ich:  `werde ${germanWord}`,
                fut_du:   `wirst ${germanWord}`,
                fut_er:   `wird ${germanWord}`,
                fut_wir:  `werden ${germanWord}`,
                fut_ihr:  `werdet ${germanWord}`,
                fut_sie:  `werden ${germanWord}`,
                partizip2: parsed.partizip2 || '',
                hilfsverb: parsed.hilfsverb || 'haben',
              };
              source = 'wiktionary';
            }
          } else {
            const parsed = parseWiktionaryArticle(wikitext);
            if (parsed && parsed.article) {
              const art = parsed.article;
              const artAkk = art === 'die' ? 'die' : 'den';
              const artDat = art === 'die' ? 'der' : 'dem';
              const artGen = art === 'die' ? 'der' : 'des';
              forms = {
                nom_sg: `${art} ${parsed.nom_sg || germanWord}`,
                akk_sg: `${artAkk} ${parsed.akk_sg || parsed.nom_sg || germanWord}`,
                dat_sg: `${artDat} ${parsed.dat_sg || parsed.nom_sg || germanWord}`,
                gen_sg: `${artGen} ${parsed.gen_sg || parsed.nom_sg || germanWord}`,
                nom_pl: parsed.nom_pl ? `die ${parsed.nom_pl}` : '',
                akk_pl: parsed.akk_pl ? `die ${parsed.akk_pl}` : (parsed.nom_pl ? `die ${parsed.nom_pl}` : ''),
                dat_pl: parsed.dat_pl ? `den ${parsed.dat_pl}` : (parsed.nom_pl ? `den ${parsed.nom_pl}` : ''),
                gen_pl: parsed.gen_pl ? `der ${parsed.gen_pl}` : (parsed.nom_pl ? `der ${parsed.nom_pl}` : ''),
              };
              source = 'wiktionary';
            }
          }
        }
      } catch(e) { source = 'error'; }

      // Step 2: Generate ukForms via Groq (only if we have German forms and Groq key)
      if (forms && GROQ_KEY) {
        try {
          const ukPrompt = isVerbs
            ? `Для дієслова "${germanWord}" (${ukrainian}) згенеруй ТІЛЬКИ українські переклади для кожної форми.
Відповідай ТІЛЬКИ валідним JSON без пояснень:
{"pras_ich":"${ukrainian}ю","pras_du":"${ukrainian}єш","pras_er":"${ukrainian}є","pras_wir":"${ukrainian}ємо","pras_ihr":"${ukrainian}єте","pras_sie":"${ukrainian}ють","prat_ich":"${ukrainian}в","prat_du":"${ukrainian}в","prat_er":"${ukrainian}в","prat_wir":"${ukrainian}ли","prat_ihr":"${ukrainian}ли","prat_sie":"${ukrainian}ли","fut_ich":"буду ${ukrainian}ти","fut_du":"будеш ${ukrainian}ти","fut_er":"буде ${ukrainian}ти","fut_wir":"будемо ${ukrainian}ти","fut_ihr":"будете ${ukrainian}ти","fut_sie":"будуть ${ukrainian}ти","partizip2":"${ukrainian}ний"}
Правила: точний переклад кожної форми українською, минулий час чоловічий рід.`
            : `Для іменника "${germanWord}" (${ukrainian}) згенеруй ТІЛЬКИ українські переклади відмінків.
Відповідай ТІЛЬКИ валідним JSON без пояснень:
{"nom_sg":"${ukrainian}","akk_sg":"...","dat_sg":"...","gen_sg":"...","nom_pl":"...","akk_pl":"...","dat_pl":"...","gen_pl":"..."}
Правила: правильне відмінювання українського слова "${ukrainian}" по відмінках (Н/З/Д/Р в однині та множині).`;

          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: ukPrompt }],
              temperature: 0.1,
              max_tokens: 500,
            }),
          });
          if (groqRes.ok) {
            const groqData = await groqRes.json();
            const raw = groqData.choices?.[0]?.message?.content || '';
            ukForms = JSON.parse(raw.replace(/```json|```/g, '').trim());
          }
        } catch(e) { ukForms = null; }
      }

      const updated = { ...w, forms: forms || w.forms || null, ukForms: ukForms || w.ukForms || null };
      if (source === 'wiktionary') updated.article = updated.article || w.article;
      updatedWords.push(updated);
      results.push({ german: germanWord, ukrainian, source, hasForms: !!forms, hasUkForms: !!ukForms });
      await new Promise(r => setTimeout(r, 2500)); // ~24 req/min, stays under Groq 30 RPM limit
    }

    await db.collection('topics').doc(topicId).update({
      words: updatedWords,
      formsGeneratedAt: FV.serverTimestamp(),
    });

    const stats = {
      found:    results.filter(r => r.source === 'wiktionary').length,
      notFound: results.filter(r => r.source === 'not_found').length,
      errors:   results.filter(r => r.source === 'error').length,
      withUk:   results.filter(r => r.hasUkForms).length,
    };

    res.json({ success: true, stats, results, words: updatedWords });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/duel' });

// ── Online tracker ─────────────────────────────────────────────────────────
const PING_TTL = 60 * 1000;
const onlineSessions = new Map();

app.get('/api/ping', (req, res) => {
  const sid = req.query.sid;
  if (sid && typeof sid === 'string' && sid.length < 64) {
    onlineSessions.set(sid, Date.now());
  }
  res.json({ ok: true });
});

app.get('/api/online-count', requireAdmin, (req, res) => {
  const now = Date.now();
  let count = 0;
  for (const [sid, ts] of onlineSessions) {
    if (now - ts > PING_TTL) { onlineSessions.delete(sid); continue; }
    if (sid.startsWith('u_')) count++;
  }
  res.json({ online: count });
});

setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of onlineSessions) {
    if (now - ts > PING_TTL) onlineSessions.delete(sid);
  }
}, 2 * 60 * 1000);

// ── Duel Game ──────────────────────────────────────────────────────────────
const ROUNDS        = 10;
const QUESTION_TIME = 10_000;
let BOT_WAIT_TIME   = 28_000;
let botDifficulty   = 2;

async function loadBotSettings() {
  try {
    const doc = await db.collection('settings').doc('bot').get();
    if (!doc.exists) return;
    const d = doc.data();
    if ([1, 2, 3].includes(d.difficulty))     botDifficulty = d.difficulty;
    if (typeof d.botWaitTime === 'number')    BOT_WAIT_TIME = d.botWaitTime;
    if (d.botSettings) BOT_SETTINGS = { ...BOT_SETTINGS, ...d.botSettings };
  } catch {}
}
loadBotSettings();

const BOT_NAMES = [
  "ivan1994","_daria","Sergiy.K","roma-777","MaksSym","pixelCat","нічний_вітер",
  "andrii_l","оля","kira.sun","den4ik","wild_fox","артем","vladyslav9",
  "silent.wave","t0mas","оля_к","dimka","ghostSignal","marko__",
  "оксана","nazar.dev","m1sha","сонях","fire.panda","roma_l",
  "alexstorm","оля88","kirill","blue_owl","andrew_ua","marta.s",
  "нік","denys777","nightRunner","taras.pro","оля-оля","ivan_k",
  "sunnySmile","vasyl.dev","оля_22","cyberleaf","bogdan_x",
  "fox.moon","оля123","maks.k","shadowbit","roman.ua","оля_ua",
  "andrii777","pixel.fox","valera","оля.l","serhii.dev","оля_k",
  "mystic.pine","denys.l","оля.love","neon.rabbit","оля_fox",
  "yura","cosmoCat","andriy_m","оля_dev","stormy_leaf",
  "valerius","оля.ok","luckybyte","оля.byte","stepan",
  "оля.dev","astroline","danylo","оля777","nikita.k",
  "sky.dragon","оля.k","rustyfox","оля.pro","yarik",
  "оля.ua","ghost_leaf","vova","оля.star","kirilo",
  "forest.wind","оля_l","pixelstorm","оля.cat","taras_l",
  "nightbyte","оля.dev2","оляfox","silverleaf","andriy.k",
  "moonpanda","оля.fox","zenbyte","оля.byte2","volodya",
  "wildcat.ua","оля_m","dimon","оля.p","darkorbit",
  "оля.wave","tanya","foxbyte","оля.byte3","artem.l",
  "pixelrabbit","оля.light","valik","оля_fox2","neonleaf",
  "оля_kat","yaroslav","оля_fire","nightcat","оля.byte4",
  "bogdan.dev","оля.star2","ghostcat","оля_moon","max.dev",
  "оля_luna","shadowfox","оля_leaf","sunbyte","оля.k2",
  "cosmofox","оля.sun","blueleaf","оля.wind","wildbyte",
  "оля.pixel","astrofox","оля.wave2","darkleaf","оля.star3",
  "silverbyte","оля.moon2","pixelwolf","оля_dev3","neonwolf",
  "forestfox","оля_fire2","moonleaf","оля_byte5","ghostwolf",
  "Левченко","Ігор Петренко","Марина Савчук","@roman_dobko","Владислав М.",
  "@taras_zoria","Назар Литвин","@oksana_taran","Сергій Бойко","kateryna_lev",
  "@denys_kh","Андрій Гнатюк","Ірина Федорчук","@mykola_step","Олег Романюк",
  "Yulia Horbach","@artem_syd","Максим Дорош","Оксана Бабенко","@pavlo_khm",
  "Petro Vovk","@ivan_hav","Тарас Мельничук","Леся Кравець","@dmytro_yar",
  "Volodymyr Holub","@sofia_lyn","Роман Савка","Юлія Дяченко","@andrii_vel",
  "Nadiya Kozak","@bohdan_pry","Олексій Середа","Марко Бондар","@iryna_pol",
  "Serhii Klym","@vasyl_dud","Анастасія Черненко","Денис Книш","@oleksandra_v",
  "Taras Pavlyk","@nazar_bryn","Світлана Рябко","Ihor Matvii","@katia_dov",
  "Viktor Kucher","@olena_kor","Петро Рудик","Мирослав Федишин","@roman_kup",
  "Halyna Viter","@daria_sol","Віктор Шпак","Olha Savytska","@maksym_kor",
  "Andrii Bilous","@yurii_tur","Богдан Савенко","Tetiana Koval","@serhii_pry",
  "Ілля Боровик","@natalia_gry","Rostyslav Duda","@oksana_bel","Mykhailo Lys",
  "@vlad_tym","Yaroslav Pavlo","Марія Шимко","@oleksii_vor","Stanislav Hon",
  "@viktor_shy","Олена Гуменюк","Taras Senyk","@nazar_yur","Petro Lytvyn",
  "@sofiia_khm","Roman Danylko","@vasyl_kry","Ірина Ткач","Dmytro Soltys",
  "@marko_hol","Oleksandr Karp","@svitlana_zak","Bohdan Vasyk","@yulia_luk",
];

let BOT_SETTINGS = {
  1: { minMs: 4000, maxMs: 9000, accuracy: 0.45 },
  2: { minMs: 2000, maxMs: 6000, accuracy: 0.70 },
  3: { minMs:  800, maxMs: 3000, accuracy: 0.92 },
};

function getBotDelay(difficulty) {
  return BOT_SETTINGS[difficulty] || BOT_SETTINGS[2];
}

const waitingPlayers = new Map();
const activeRooms    = new Map();
const privateWaiting = new Map();

function generateRoomId() {
  return crypto.randomBytes(6).toString('hex');
}

function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildOptions(words, correctIdx) {
  const correct = words[correctIdx];
  if (!correct || !correct.ukrainian) return null;

  const pool = words.filter((_, i) => i !== correctIdx).filter(w => w && w.ukrainian);
  let distractors = shuffleArr([...pool]);
  while (distractors.length < 3 && pool.length > 0) {
    distractors = [...distractors, ...shuffleArr([...pool])];
  }
  const options = shuffleArr([correct, ...distractors.slice(0, 3)]);
  return { options: options.map(w => w.ukrainian), correctOption: correct.ukrainian };
}

function sendToRoom(room, msg) {
  const data = JSON.stringify(msg);
  [room.p1, room.p2].forEach(p => {
    if (p && !p.isBot && p.ws && p.ws.readyState === 1) p.ws.send(data);
  });
}

// [OPT] Винесено повторювані блоки advanceRound в окрему функцію
function advanceRound(room, winner) {
  room.answered.add('__resolved__');
  clearTimeout(room.questionTimer);
  sendToRoom(room, {
    type:          'round_result',
    winner:        winner ? winner.name : null,
    correctOption: room.correctOption,
    scores:        { p1: room.p1.score, p2: room.p2.score },
    names:         { p1: room.p1.name,  p2: room.p2.name },
  });
  room.round++;
  setTimeout(() => sendQuestion(room), 2000);
}

function sendQuestion(room) {
  if (room.round >= room.words.length) { endGame(room); return; }

  const wordIdx = room.round % room.words.length;
  const word    = room.words[wordIdx];
  const built   = buildOptions(room.words, wordIdx);
  if (!built) { endGame(room); return; }

  const { options, correctOption } = built;
  room.currentWord   = word;
  room.correctOption = correctOption;
  room.answered      = new Set();
  room.questionSentAt = Date.now();

  sendToRoom(room, {
    type:    'question',
    round:   room.round + 1,
    total:   room.words.length,
    german:  word.article ? `${word.article} ${word.german}` : word.german,
    options,
    scores: { p1: room.p1.score, p2: room.p2.score },
    names:  { p1: room.p1.name,  p2: room.p2.name },
  });

  // Auto-advance after timeout
  room.questionTimer = setTimeout(() => {
    if (!room.answered.has('__resolved__')) {
      advanceRound(room, null);
    }
  }, QUESTION_TIME);

  // Bot answer logic
  const botPlayer = room.p1.isBot ? room.p1 : (room.p2.isBot ? room.p2 : null);
  if (!botPlayer) return;

  const { minMs, maxMs, accuracy } = getBotDelay(room.botDifficulty || 2);
  const delay = minMs + Math.random() * (maxMs - minMs);
  // Зберігаємо snapshot раунду — щоб таймер не спрацював на наступному питанні
  const thisRound = room.round;

  setTimeout(() => {
    // Якщо раунд вже змінився або вже є переможець — ігноруємо
    if (room.round !== thisRound) return;
    if (room.answered.has('__resolved__')) return;

    const isCorrect    = Math.random() < accuracy;
    const chosenOption = isCorrect
      ? correctOption
      : options[Math.floor(Math.random() * options.length)];

    room.answered.add(botPlayer.name);

    if (isCorrect) {
      botPlayer.score++;
      advanceRound(room, botPlayer);
    } else if (room.answered.size >= 2) {
      advanceRound(room, null);
    }
    void chosenOption;
  }, delay);
}

function endGame(room) {
  const { p1, p2 } = room;
  let winner = null;
  if      (p1.score > p2.score) winner = p1.name;
  else if (p2.score > p1.score) winner = p2.name;

  sendToRoom(room, {
    type:   'game_over',
    scores: { p1: p1.score, p2: p2.score },
    names:  { p1: p1.name,  p2: p2.name },
    winner,
  });

  if (!p1.isBot && !p2.isBot && p1.uid && p2.uid) {
    const tid = room.topicId || null;
    if (winner === p1.name) {
      updateDuelStats(p1.uid, p2.uid, tid).catch(() => {});
    } else if (winner === p2.name) {
      updateDuelStats(p2.uid, p1.uid, tid).catch(() => {});
    } else {
      // Draw — increment played for both
      const batch = db.batch();
      [p1.uid, p2.uid].forEach(uid => {
        const upd = { 'stats.played': FV.increment(1) };
        if (tid) upd[`stats.topics.${tid}.played`] = FV.increment(1);
        batch.update(db.collection('users').doc(uid), upd);
      });
      batch.commit().catch(() => {});
    }
  }

  activeRooms.delete(room.id);
}

// [OPT] Загальна функція завантаження слів теми — прибирає дублювання в join/join_private/bot
async function loadTopicWords(topicId) {
  const snap = await db.collection('topics').doc(topicId).get();
  if (!snap.exists) throw new Error('topic_not_found');
  const allWords = (snap.data().words || []).filter(w => w && w.ukrainian && w.german);
  if (allWords.length < 2) throw new Error('not_enough_words');
  return shuffleArr(allWords);
}

wss.on('connection', (ws) => {
  let player = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN PRIVATE ROOM ─────────────────────────────────
    if (msg.type === 'join_private') {
      const { topicId, name, roomCode, isHost } = msg;
      if (!topicId || !name || !roomCode) return;
      player = { ws, name: name.trim() || 'Гравець', score: 0, topicId, uid: msg.uid || null };

      if (isHost) {
        privateWaiting.set(roomCode, player);
        player.roomCode    = roomCode;
        player.privateTimer = setTimeout(async () => {
          if (privateWaiting.get(roomCode) !== player) return;
          privateWaiting.delete(roomCode);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'waiting_timeout', message: 'Суперник не прийняв запрошення.' }));
          }
          try {
            const snap = await db.collection('duelInvites')
              .where('roomCode', '==', roomCode).where('status', '==', 'pending').get();
            snap.forEach(doc => doc.ref.delete());
          } catch {}
        }, 30_000);
        ws.send(JSON.stringify({ type: 'waiting', message: 'Очікуємо суперника…' }));

      } else {
        const host = privateWaiting.get(roomCode);
        if (!host) {
          ws.send(JSON.stringify({ type: 'error', message: 'Кімнату не знайдено або час вийшов' }));
          return;
        }
        privateWaiting.delete(roomCode);
        if (host.privateTimer) { clearTimeout(host.privateTimer); host.privateTimer = null; }

        let words;
        try {
          words = await loadTopicWords(topicId);
        } catch (e) {
          const msg = e.message === 'topic_not_found' ? 'Тему не знайдено'
                    : e.message === 'not_enough_words' ? 'Недостатньо слів'
                    : 'Помилка бази даних';
          ws.send(JSON.stringify({ type: 'error', message: msg }));
          return;
        }

        const roomId = generateRoomId();
        const room   = {
          id: roomId, p1: host, p2: player, words, topicId,
          round: 0, answered: new Set(), currentWord: null, correctOption: null, questionTimer: null,
        };
        activeRooms.set(roomId, room);
        host.roomId   = roomId;
        player.roomId = roomId;

        [host, player].forEach((p, i) => {
          p.ws.send(JSON.stringify({
            type:         'matched',
            roomId,
            yourName:     p.name,
            opponentName: i === 0 ? player.name : host.name,
            playerIndex:  i === 0 ? 'p1' : 'p2',
          }));
        });
        setTimeout(() => sendQuestion(room), 1500);
      }
      return;
    }

    // ── JOIN ───────────────────────────────────────────────
    if (msg.type === 'join') {
      const { topicId, name } = msg;
      if (!topicId || !name) return;
      player = { ws, name: name.trim() || 'Гравець', score: 0, topicId, uid: msg.uid || null };

      if (waitingPlayers.has(topicId)) {
        const opponent = waitingPlayers.get(topicId);
        waitingPlayers.delete(topicId);
        if (opponent.botTimer) { clearTimeout(opponent.botTimer); opponent.botTimer = null; }

        let words;
        try {
          words = await loadTopicWords(topicId);
        } catch (e) {
          const errMsg = e.message === 'topic_not_found' ? 'Тему не знайдено' : 'Недостатньо слів у темі (мінімум 2)';
          ws.send(JSON.stringify({ type: 'error', message: errMsg }));
          return;
        }

        const roomId = generateRoomId();
        const room   = {
          id: roomId, p1: opponent, p2: player, words, topicId,
          round: 0, answered: new Set(), currentWord: null, correctOption: null, questionTimer: null,
        };
        activeRooms.set(roomId, room);
        opponent.roomId = roomId;
        player.roomId   = roomId;

        [opponent, player].forEach((p, i) => {
          p.ws.send(JSON.stringify({
            type:         'matched',
            roomId,
            yourName:     p.name,
            opponentName: i === 0 ? player.name : opponent.name,
            playerIndex:  i === 0 ? 'p1' : 'p2',
          }));
        });
        setTimeout(() => sendQuestion(room), 1500);

      } else {
        player.joinedAt = Date.now();
        waitingPlayers.set(topicId, player);
        ws.send(JSON.stringify({ type: 'waiting', message: 'Очікуємо суперника…' }));

        player.botTimer = setTimeout(async () => {
          if (!waitingPlayers.has(topicId) || waitingPlayers.get(topicId) !== player) return;
          waitingPlayers.delete(topicId);

          let words;
          try {
            words = await loadTopicWords(topicId);
          } catch { return; }

          const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
          const bot     = { ws: null, name: botName, score: 0, topicId, isBot: true };
          const roomId  = generateRoomId();
          const room    = {
            id: roomId, p1: player, p2: bot, words, topicId,
            round: 0, answered: new Set(), currentWord: null, correctOption: null,
            questionTimer: null, botDifficulty,
          };
          activeRooms.set(roomId, room);
          player.roomId = roomId;

          player.ws.send(JSON.stringify({
            type:         'matched',
            roomId,
            yourName:     player.name,
            opponentName: botName,
            playerIndex:  'p1',
          }));
          setTimeout(() => sendQuestion(room), 1500);
        }, BOT_WAIT_TIME);
      }
    }

    // ── ANSWER ─────────────────────────────────────────────
    if (msg.type === 'answer') {
      if (!player?.roomId) return;
      const room = activeRooms.get(player.roomId);
      if (!room || room.answered.has(player.name) || room.answered.has('__resolved__')) return;

      const isCorrect = msg.option === room.correctOption;
      const isP1      = room.p1.ws === ws;
      const me        = isP1 ? room.p1 : room.p2;

      room.answered.add(player.name);

      if (isCorrect) {
        me.score++;
        advanceRound(room, me);
      } else {
        ws.send(JSON.stringify({ type: 'wrong_answer', correctOption: room.correctOption }));
        // Both answered wrong → advance
        if (room.answered.size >= 2) advanceRound(room, null);
      }
    }

    // ── LEAVE ──────────────────────────────────────────────
    if (msg.type === 'leave') cleanup();
  });

  function cleanup() {
    if (!player) return;
    if (player.topicId && waitingPlayers.get(player.topicId) === player) {
      if (player.botTimer) clearTimeout(player.botTimer);
      waitingPlayers.delete(player.topicId);
    }
    if (player.roomCode && privateWaiting.get(player.roomCode) === player) {
      if (player.privateTimer) clearTimeout(player.privateTimer);
      privateWaiting.delete(player.roomCode);
    }
    if (player.roomId) {
      const room = activeRooms.get(player.roomId);
      if (room) {
        clearTimeout(room.questionTimer);
        const opponent = room.p1.ws === ws ? room.p2 : room.p1;
        if (opponent && !opponent.isBot && opponent.ws?.readyState === 1) {
          opponent.ws.send(JSON.stringify({ type: 'opponent_left' }));
        }
        activeRooms.delete(player.roomId);
      }
    }
    player = null;
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ── Cleanup stale rooms every 30 min ──────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  activeRooms.forEach((room, id) => {
    if (now - (room.questionSentAt || 0) > 30 * 60 * 1000) {
      clearTimeout(room.questionTimer);
      activeRooms.delete(id);
    }
  });
  waitingPlayers.forEach((p, topicId) => {
    if (now - (p.joinedAt || 0) > 3 * 60 * 1000) {
      waitingPlayers.delete(topicId);
      if (p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({
          type:    'waiting_timeout',
          message: 'Суперника не знайдено. Спробуй ще раз.',
        }));
      }
    }
  });
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n🚀 Backend running on http://localhost:${PORT}`);
  console.log(`   WebSocket duel: ws://localhost:${PORT}/ws/duel`);
  console.log(`   Firestore project: ${process.env.FIREBASE_PROJECT_ID}\n`);
  // Прогріваємо TTS кеш після старту (не блокує сервер)
  warmTtsCache();
});