process.on("uncaughtException", (err) => {
console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
console.error("UNHANDLED REJECTION:", err);
});

const express = require("express");
const cors    = require("cors");
const dotenv  = require("dotenv");
dotenv.config();

const { admin, db } = require("./firebase");
const verifyToken   = require("./middleware/verifyToken");

const app = express();

const allowedOrigins = [
"https://duelix-app.web.app",
"http://localhost:4000",
"http://localhost:5173",
];

app.use(cors({
origin: function (origin, callback) {
if (!origin || allowedOrigins.includes(origin)) {
callback(null, true);
} else {
callback(new Error("CORS blocked"));
}
},
credentials:    true,
allowedHeaders: "*",
}));

app.use(express.json());

// ─────────────────────────────────────────
// CACHE CONTROL
// ─────────────────────────────────────────
app.use((_req, res, next) => {
res.set({
"Cache-Control":     "no-store, no-cache, must-revalidate, proxy-revalidate",
"Pragma":            "no-cache",
"Expires":           "0",
"Surrogate-Control": "no-store",
});
next();
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

const inc = (current, by = 1) => (Number(current) || 0) + by;

// ─────────────────────────────────────────
// REWARD DISTRIBUTION — 80 / 10 / 10
// ─────────────────────────────────────────
const pool         = (entryFee) => entryFee * 2;
const winnerReward = (entryFee) => Math.floor(pool(entryFee) * 0.80);
const loserReward  = (entryFee) => Math.floor(pool(entryFee) * 0.10);
const platformFee  = (entryFee) =>
pool(entryFee) - winnerReward(entryFee) - loserReward(entryFee);

function validateEntryFee(entryFee) {
if (
typeof entryFee !== "number" ||
!Number.isInteger(entryFee) ||
entryFee <= 0
) {
throw new Error("entryFee must be a positive integer");
}
}

function hasSubmittedResult(match) {
return match.submittedBy != null;
}

async function distributeReward(t, match, matchRef, confirmedWinner) {
const winner = winnerReward(match.entryFee);
const loser  = loserReward(match.entryFee);
const plat   = platformFee(match.entryFee);

const playerA_Ref = db.collection("users").doc(match.playerA);
const playerB_Ref = db.collection("users").doc(match.playerB);
const platformRef = db.collection("platform").doc("earnings");

const [playerA_Doc, playerB_Doc, platformDoc] = await Promise.all([
t.get(playerA_Ref),
t.get(playerB_Ref),
t.get(platformRef),
]);

if (!playerA_Doc.exists || !playerB_Doc.exists)
throw new Error("Player data not found");

if (confirmedWinner === "draw") {
t.update(playerA_Ref, {
coins:        inc(playerA_Doc.data().coins, match.entryFee),
draws:        inc(playerA_Doc.data().draws),
totalMatches: inc(playerA_Doc.data().totalMatches),
});
t.update(playerB_Ref, {
coins:        inc(playerB_Doc.data().coins, match.entryFee),
draws:        inc(playerB_Doc.data().draws),
totalMatches: inc(playerB_Doc.data().totalMatches),
});
} else {
const loserUid  =
confirmedWinner === match.playerA ? match.playerB : match.playerA;
const winnerRef = db.collection("users").doc(confirmedWinner);
const loserRef  = db.collection("users").doc(loserUid);
const winnerDoc =
confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
const loserDoc  =
loserUid === match.playerA ? playerA_Doc : playerB_Doc;

t.update(winnerRef, {
  coins:        inc(winnerDoc.data()?.coins        ?? 0, winner),
  wins:         inc(winnerDoc.data()?.wins         ?? 0),
  totalMatches: inc(winnerDoc.data()?.totalMatches ?? 0),
});
t.update(loserRef, {
  coins:        inc(loserDoc.data()?.coins        ?? 0, loser),
  losses:       inc(loserDoc.data()?.losses       ?? 0),
  totalMatches: inc(loserDoc.data()?.totalMatches ?? 0),
});
t.set(
  platformRef,
  {
    totalCoins:  inc(
      platformDoc.exists ? platformDoc.data().totalCoins : 0,
      plat
    ),
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
  },
  { merge: true }
);

}

t.update(matchRef, {
status:             "completed",
confirmedWinner,
rewarded:           true,
winnerReward:       confirmedWinner === "draw" ? 0 : winner,
loserReward:        confirmedWinner === "draw" ? 0 : loser,
platformFee:        confirmedWinner === "draw" ? 0 : plat,
confirmedAt:        admin.firestore.FieldValue.serverTimestamp(),
rematchRequestedBy: null,
rematchStatus:      null,
rematchRequestedAt: null,
});

return { winner, loser, plat, confirmedWinner };
}

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get("/",       (_req, res) => res.send("Duelix backend is live 🚀"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ═══════════════════════════════════════════════════════════════
// AUTH — legacy endpoints kept for backward compatibility.
// New users authenticate via Firebase Phone OTP (client-side).
// ═══════════════════════════════════════════════════════════════

app.post("/register", async (req, res) => {
const { phone, password, displayName } = req.body;
if (!phone || !password)
return res.status(400).json({ error: "Phone and password required" });

try {
const userRef = db.collection("users").doc(phone);
const userDoc = await userRef.get();
if (userDoc.exists)
return res.status(400).json({ error: "User already exists" });

await userRef.set({
  uid:          phone,
  phone,
  password,
  displayName:  displayName || "Player",
  coins:        20,
  wins:         0,
  losses:       0,
  draws:        0,
  totalMatches: 0,
  loginStreak:  0,
  lastLogin:    null,
  createdAt:    admin.firestore.FieldValue.serverTimestamp(),
});

res.json({ message: "Registered successfully" });

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/login", async (req, res) => {
const { phone, password } = req.body;
if (!phone || !password)
return res.status(400).json({ error: "Phone and password required" });

try {
const userDoc = await db.collection("users").doc(phone).get();
if (!userDoc.exists)
return res.status(404).json({ error: "User not found" });

const user = userDoc.data();
if (user.password !== password)
  return res.status(401).json({ error: "Wrong password" });

const token = await admin.auth().createCustomToken(phone);
res.json({ message: "Login successful", token, uid: phone });

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/reset-password-direct", async (req, res) => {
const { phone, newPassword } = req.body;
try {
const userRef = db.collection("users").doc(phone);
const userDoc = await userRef.get();
if (!userDoc.exists)
return res.status(404).json({ error: "User not found" });

await userRef.update({ password: newPassword });
res.json({ message: "Password reset successful" });

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// USER
// ═══════════════════════════════════════════════════════════════

app.get("/user/:uid", verifyToken, async (req, res) => {
try {
const doc = await db.collection("users").doc(req.params.uid).get();
if (!doc.exists) return res.status(404).json({ error: "User not found" });
res.json(doc.data());
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get("/user-exists/:uid", async (req, res) => {
try {
const doc = await db.collection("users").doc(req.params.uid).get();
res.json({ exists: doc.exists });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/update-name", verifyToken, async (req, res) => {
const { displayName } = req.body;
if (!displayName)
return res.status(400).json({ error: "displayName required" });
try {
await db.collection("users").doc(req.user.uid).update({ displayName });
res.json({ message: "Name updated" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/update-avatar", verifyToken, async (req, res) => {
const { avatar, isAsset } = req.body;
if (!avatar)
return res.status(400).json({ error: "avatar required" });

try {
await db.collection("users").doc(req.user.uid).update({
avatar,
avatarType: isAsset ? "asset" : "upload",
updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
});
res.json({ message: "Avatar updated successfully" });
} catch (err) {
console.error("Avatar update error:", err);
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// COINS
// ═══════════════════════════════════════════════════════════════

app.get("/coins/:uid", verifyToken, async (req, res) => {
try {
const doc = await db.collection("users").doc(req.params.uid).get();
res.json({ coins: doc.data()?.coins ?? 0 });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/add-coins", verifyToken, async (req, res) => {
const { amount } = req.body;
if (!amount || amount <= 0)
return res.status(400).json({ error: "Valid amount required" });
try {
const userRef = db.collection("users").doc(req.user.uid);
await db.runTransaction(async (t) => {
const doc = await t.get(userRef);
if (!doc.exists) throw new Error("User not found");
t.update(userRef, { coins: inc(doc.data().coins, amount) });
});
res.json({ message: "Coins added" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/reset-account", verifyToken, async (req, res) => {
const { coins } = req.body;
try {
await db.collection("users").doc(req.user.uid).update({
coins:        coins ?? 20,
wins:         0,
losses:       0,
draws:        0,
totalMatches: 0,
});
res.json({ message: "Account reset" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// DAILY REWARD
//
// ✅ UPDATED cycle — resets after Day 7:
//   Day 1 → 3 coins
//   Day 2 → 3 coins
//   Day 3 → 4 coins
//   Day 4 → 4 coins
//   Day 5 → 5 coins
//   Day 6 → 6 coins
//   Day 7 → 10 coins
//   Day 8+ → loops back to Day 1 (3 coins)
// ═══════════════════════════════════════════════════════════════

function getStreakReward(streak) {
// ((streak - 1) % 7) + 1  maps any streak to days 1–7 cyclically
const day = ((streak - 1) % 7) + 1;
if (day <= 2) return 3;   // Day 1, Day 2
if (day <= 4) return 4;   // Day 3, Day 4
if (day === 5) return 5;  // Day 5
if (day === 6) return 6;  // Day 6
return 10;                // Day 7
}

app.post("/claim-daily-reward", verifyToken, async (req, res) => {
const uid = req.user.uid;
let rewardData = {};

try {
await db.runTransaction(async (t) => {
const userRef = db.collection("users").doc(uid);
const userDoc = await t.get(userRef);
if (!userDoc.exists) throw new Error("User not found");

  const user      = userDoc.data();
  const now       = new Date();
  const lastLogin = user.lastLogin?.toDate?.() ?? null;

  if (lastLogin) {
    const sameDay =
      lastLogin.getFullYear() === now.getFullYear() &&
      lastLogin.getMonth()    === now.getMonth()    &&
      lastLogin.getDate()     === now.getDate();
    if (sameDay) throw new Error("Already claimed today");
  }

  let streak = user.loginStreak ?? 0;
  if (lastLogin) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isConsecutive =
      lastLogin.getFullYear() === yesterday.getFullYear() &&
      lastLogin.getMonth()    === yesterday.getMonth()    &&
      lastLogin.getDate()     === yesterday.getDate();
    streak = isConsecutive ? streak + 1 : 1;
  } else {
    streak = 1;
  }

  const coinsToAdd = getStreakReward(streak);

  t.update(userRef, {
    coins:       inc(user.coins, coinsToAdd),
    loginStreak: streak,
    lastLogin:   admin.firestore.FieldValue.serverTimestamp(),
  });

  rewardData = { coinsToAdd, streak };
});

res.json({
  message:    "Daily reward claimed",
  coinsAdded: rewardData.coinsToAdd,
  streak:     rewardData.streak,
});

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// MATCH SYSTEM
// ═══════════════════════════════════════════════════════════════

app.post("/matches/create", verifyToken, async (req, res) => {
const { game, entryFee } = req.body;
const uid = req.user.uid;

if (!game)
return res.status(400).json({ error: "game is required" });

try { validateEntryFee(entryFee); }
catch (err) { return res.status(400).json({ error: err.message }); }

try {
let matchId;

await db.runTransaction(async (t) => {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await t.get(userRef);
  if (!userDoc.exists) throw new Error("User not found");

  const coins = userDoc.data().coins ?? 0;
  if (coins < entryFee) throw new Error("Insufficient coins");

  const matchRef = db.collection("matches").doc();
  matchId = matchRef.id;

  t.update(userRef, { coins: coins - entryFee });

  t.set(matchRef, {
    id:                 matchId,
    playerA:            uid,
    playerB:            null,
    players:            [uid],
    game:               game.toUpperCase(),
    entryFee,
    status:             "waiting",
    matchType:          "private",
    result:             null,
    submittedBy:        null,
    submittedAt:        null,
    confirmedWinner:    null,
    rewarded:           false,
    createdAt:          admin.firestore.FieldValue.serverTimestamp(),
    startedAt:          null,
    matchStartedAt:     null,
    rematchRequestedBy: null,
    rematchStatus:      null,
    rematchRequestedAt: null,
    autoResolved:       false,
    autoCancelled:      false,
    cancelReason:       null,
  });
});

res.status(201).json({
  matchId,
  status:       "waiting",
  playerA:      uid,
  playerB:      null,
  game,
  entryFee,
  winnerReward: winnerReward(entryFee),
  loserReward:  loserReward(entryFee),
  platformFee:  platformFee(entryFee),
});

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.get("/matches", verifyToken, async (req, res) => {
try {
const [waitingSnap, activeSnap] = await Promise.all([
db.collection("matches")
.where("status", "==", "waiting")
.orderBy("createdAt", "desc")
.get(),
db.collection("matches")
.where("status", "==", "active")
.orderBy("startedAt", "desc")
.get(),
]);

const matches = [
  ...waitingSnap.docs.map((d) => d.data()),
  ...activeSnap.docs.map((d) => d.data()),
].filter((m) => m.id && m.playerA && m.game);

res.json(matches);

} catch (err) {
console.error("GET /matches error:", err);
res.status(500).json({ error: "Failed to load matches." });
}
});

app.post("/matches/join", verifyToken, async (req, res) => {
const { matchId } = req.body;
const uid = req.user.uid;

if (!matchId)
return res.status(400).json({ error: "matchId required" });

try {
let joinedMatch = null;

await db.runTransaction(async (t) => {
  const matchRef = db.collection("matches").doc(matchId);
  const userRef  = db.collection("users").doc(uid);
  const [matchDoc, userDoc] = await Promise.all([
    t.get(matchRef),
    t.get(userRef),
  ]);

  if (!matchDoc.exists) throw new Error("Match not found");
  if (!userDoc.exists)  throw new Error("User not found");

  const match = matchDoc.data();
  const coins = userDoc.data().coins ?? 0;

  if (match.status !== "waiting") throw new Error("Match no longer available");
  if (match.playerA === uid)      throw new Error("Cannot join your own match");
  if (match.playerB != null)      throw new Error("Match already has an opponent");
  if (coins < match.entryFee)     throw new Error("Insufficient coins");

  const now = admin.firestore.FieldValue.serverTimestamp();

  t.update(userRef, { coins: coins - match.entryFee });
  t.update(matchRef, {
    playerB:        uid,
    players:        admin.firestore.FieldValue.arrayUnion(uid),
    status:         "active",
    startedAt:      now,
    matchStartedAt: now,
  });

  joinedMatch = {
    matchId:      match.id,
    playerA:      match.playerA,
    playerB:      uid,
    game:         match.game,
    entryFee:     match.entryFee,
    status:       "active",
    winnerReward: winnerReward(match.entryFee),
    loserReward:  loserReward(match.entryFee),
  };
});

res.json({ message: "Joined match successfully", match: joinedMatch });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.post("/matches/cancel", verifyToken, async (req, res) => {
const { matchId } = req.body;
const uid = req.user.uid;

if (!matchId)
return res.status(400).json({ error: "matchId required" });

try {
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await t.get(matchRef);

  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.playerA !== uid)
    throw new Error("Only the match creator can cancel");
  if (match.playerB != null)
    throw new Error("Cannot cancel — opponent has already joined");
  if (match.status !== "waiting")
    throw new Error("Match cannot be cancelled at this stage");

  const userRef = db.collection("users").doc(uid);
  const userDoc = await t.get(userRef);
  if (!userDoc.exists) throw new Error("User not found");

  t.update(userRef, { coins: inc(userDoc.data().coins, match.entryFee) });
  t.update(matchRef, {
    status:      "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

res.json({ message: "Match cancelled — match ticket refunded" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// QUICK MATCH — Atomic find-or-create
//
// This is the server-controlled matchmaking endpoint. It runs
// entirely inside a Firestore transaction so two players can never
// grab the same waiting match at the same time.
//
// Flow:
//   1. Query for a waiting quick match with matching game + entryFee
//      where isPrivate == false and playerB == null.
//   2. If found → join it atomically (set playerB, status=active).
//   3. If not found → create a new waiting quick match.
//
// Required Firestore composite index:
//   Collection: matches
//   status      ASC
//   game        ASC
//   entryFee    ASC
//   isPrivate   ASC
//   playerB     ASC  (optional — server filters in-memory as fallback)
// ═══════════════════════════════════════════════════════════════
app.post("/matches/quick-match", verifyToken, async (req, res) => {
const { game, entryFee } = req.body;
const uid = req.user.uid;

if (!game)
return res.status(400).json({ error: "game is required" });

try { validateEntryFee(entryFee); }
catch (err) { return res.status(400).json({ error: err.message }); }

// game must always be stored in uppercase for consistent comparison
const gameUpper = game.toUpperCase();

try {
let matchId   = null;
let didCreate = false;

// ── Step 1: Look for an existing waiting quick match ──────────
// We query by status + game + entryFee + isPrivate.
// playerB filter is applied in-memory as a safety net because
// Firestore inequality filters on multiple fields require an index
// and null comparisons are not reliable across SDK versions.
const candidateSnap = await db
  .collection("matches")
  .where("status",    "==", "waiting")
  .where("game",      "==", gameUpper)
  .where("entryFee",  "==", entryFee)
  .where("isPrivate", "==", false)
  .orderBy("createdAt", "asc") // oldest first → fairest queue
  .limit(10)                   // fetch a small batch to filter in-memory
  .get();

// Filter in-memory: exclude own matches and full matches
const candidates = candidateSnap.docs.filter((doc) => {
  const d = doc.data();
  return d.playerA !== uid && d.playerB === null;
});

console.log(
  `[quick-match] uid=${uid} game=${gameUpper} fee=${entryFee} ` +
  `candidates=${candidates.length}`
);

if (candidates.length > 0) {
  // ── Step 2: JOIN an existing match inside a transaction ─────
  const targetDoc = candidates[0];
  matchId = targetDoc.id;

  await db.runTransaction(async (t) => {
    const matchRef = db.collection("matches").doc(matchId);
    const userRef  = db.collection("users").doc(uid);

    const [matchDoc, userDoc] = await Promise.all([
      t.get(matchRef),
      t.get(userRef),
    ]);

    if (!matchDoc.exists) throw new Error("Match no longer exists");
    if (!userDoc.exists)  throw new Error("User not found");

    const match = matchDoc.data();
    const coins = userDoc.data().coins ?? 0;

    // Re-validate inside transaction (prevents race condition)
    if (match.status    !== "waiting") throw new Error("Match no longer available");
    if (match.playerA   === uid)       throw new Error("Cannot join your own match");
    if (match.playerB   != null)       throw new Error("Match already taken — try again");
    if (match.isPrivate === true)      throw new Error("Cannot join a private match");
    if (coins < match.entryFee)        throw new Error("Insufficient coins");

    const now = admin.firestore.FieldValue.serverTimestamp();

    t.update(userRef, { coins: coins - match.entryFee });
    t.update(matchRef, {
      playerB:        uid,
      players:        admin.firestore.FieldValue.arrayUnion(uid),
      status:         "active",
      startedAt:      now,
      matchStartedAt: now,
    });
  });

  console.log(`[quick-match] JOINED existing match ${matchId} uid=${uid}`);

} else {
  // ── Step 3: CREATE a new waiting quick match ─────────────────
  didCreate = true;

  await db.runTransaction(async (t) => {
    const userRef  = db.collection("users").doc(uid);
    const matchRef = db.collection("matches").doc();
    matchId = matchRef.id;

    const userDoc = await t.get(userRef);
    if (!userDoc.exists) throw new Error("User not found");

    const coins = userDoc.data().coins ?? 0;
    if (coins < entryFee) throw new Error("Insufficient coins");

    t.update(userRef, { coins: coins - entryFee });

    t.set(matchRef, {
      id:                 matchId,
      playerA:            uid,
      playerB:            null,
      players:            [uid],
      game:               gameUpper,
      entryFee,
      status:             "waiting",
      matchType:          "quick",
      isPrivate:          false,
      result:             null,
      submittedBy:        null,
      submittedAt:        null,
      confirmedWinner:    null,
      rewarded:           false,
      createdAt:          admin.firestore.FieldValue.serverTimestamp(),
      startedAt:          null,
      matchStartedAt:     null,
      rematchRequestedBy: null,
      rematchStatus:      null,
      rematchRequestedAt: null,
      autoResolved:       false,
      autoCancelled:      false,
      cancelReason:       null,
    });
  });

  console.log(`[quick-match] CREATED new match ${matchId} uid=${uid}`);
}

res.status(didCreate ? 201 : 200).json({
  matchId,
  action:       didCreate ? "created" : "joined",
  status:       didCreate ? "waiting" : "active",
  winnerReward: winnerReward(entryFee),
  loserReward:  loserReward(entryFee),
});

} catch (err) {
console.error(`[quick-match] ERROR uid=${uid}:`, err.message);
res.status(400).json({ error: err.message });
}
});

app.post("/matches/submit-result", verifyToken, async (req, res) => {
const { matchId, myScore, opponentScore } = req.body;
const uid = req.user.uid;

if (!matchId || myScore === undefined || opponentScore === undefined)
return res.status(400).json({ error: "matchId, myScore, opponentScore required" });
if (typeof myScore !== "number" || typeof opponentScore !== "number")
return res.status(400).json({ error: "Scores must be numbers" });

try {
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await t.get(matchRef);

  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.playerA !== uid && match.playerB !== uid)
    throw new Error("You are not in this match");
  if (match.status !== "active")
    throw new Error("Match is not active");
  if (hasSubmittedResult(match))
    throw new Error("Result already submitted");

  const opponentUid =
    uid === match.playerA ? match.playerB : match.playerA;

  t.update(matchRef, {
    result: {
      myScore,
      opponentScore,
      scoreOf: {
        [uid]:         myScore,
        [opponentUid]: opponentScore,
      },
    },
    submittedBy: uid,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

res.json({ message: "Result submitted — waiting for opponent to confirm" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.post("/matches/confirm-result", verifyToken, async (req, res) => {
const { matchId } = req.body;
const uid = req.user.uid;

if (!matchId)
return res.status(400).json({ error: "matchId required" });

try {
let result = {};

await db.runTransaction(async (t) => {
  const matchRef = db.collection("matches").doc(matchId);
  const matchDoc = await t.get(matchRef);

  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.playerA !== uid && match.playerB !== uid)
    throw new Error("You are not in this match");
  if (match.status === "completed")
    throw new Error("Match already completed");
  if (match.status !== "active")
    throw new Error("Match is not active");
  if (!hasSubmittedResult(match))
    throw new Error("No result submitted yet");
  if (match.submittedBy === uid)
    throw new Error("You submitted — wait for opponent");

  const submitter      = match.submittedBy;
  const confirmer      = uid;
  const scoreOf        = match.result?.scoreOf ?? {};
  const submitterScore = scoreOf[submitter] ?? 0;
  const confirmerScore = scoreOf[confirmer] ?? 0;

  let confirmedWinner;
  if (submitterScore > confirmerScore)      confirmedWinner = submitter;
  else if (confirmerScore > submitterScore) confirmedWinner = confirmer;
  else                                      confirmedWinner = "draw";

  result = await distributeReward(t, match, matchRef, confirmedWinner);
});

res.json({ message: "Result confirmed", confirmedWinner: result.confirmedWinner });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.post("/matches/dispute", verifyToken, async (req, res) => {
const { matchId, reason } = req.body;
const uid = req.user.uid;

if (!matchId || !reason)
return res.status(400).json({ error: "matchId and reason required" });

try {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await matchRef.get();

if (!matchDoc.exists)
  return res.status(404).json({ error: "Match not found" });

const match = matchDoc.data();

if (match.playerA !== uid && match.playerB !== uid)
  return res.status(403).json({ error: "You are not in this match" });
if (match.status === "completed")
  return res.status(400).json({ error: "Match already completed" });

const batch = db.batch();
batch.set(db.collection("disputes").doc(), {
  matchId,
  reportedBy: uid,
  reason,
  matchData:  match,
  createdAt:  admin.firestore.FieldValue.serverTimestamp(),
});
batch.update(matchRef, {
  status:     "disputed",
  disputedAt: admin.firestore.FieldValue.serverTimestamp(),
  disputedBy: uid,
});
await batch.commit();

res.json({ message: "Dispute submitted — under review" });

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get("/matches/history", verifyToken, async (req, res) => {
const uid = req.user.uid;

try {
const [snapA, snapB] = await Promise.all([
db.collection("matches")
.where("playerA", "==", uid)
.where("status", "in", ["completed", "cancelled", "disputed"])
.orderBy("createdAt", "desc")
.limit(50)
.get(),
db.collection("matches")
.where("playerB", "==", uid)
.where("status", "in", ["completed", "cancelled", "disputed"])
.orderBy("createdAt", "desc")
.limit(50)
.get(),
]);

const history = [
  ...snapA.docs.map((d) => d.data()),
  ...snapB.docs.map((d) => d.data()),
]
  .sort((a, b) => {
    const aT = a.createdAt?._seconds ?? 0;
    const bT = b.createdAt?._seconds ?? 0;
    return bT - aT;
  })
  .slice(0, 50);

res.json(history);

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// TIMER EXPIRY
// ═══════════════════════════════════════════════════════════════

app.post("/matches/auto-resolve", verifyToken, async (req, res) => {
const { matchId } = req.body;
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
let result = {};

await db.runTransaction(async (t) => {
  const matchRef = db.collection("matches").doc(matchId);
  const matchDoc = await t.get(matchRef);
  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.status === "completed" || match.rewarded || match.autoResolved) {
    result = { confirmedWinner: match.confirmedWinner, alreadyResolved: true };
    return;
  }
  if (match.status === "cancelled") { result = { alreadyCancelled: true }; return; }
  if (match.status !== "active")
    throw new Error(`Cannot auto-resolve — status is "${match.status}"`);
  if (!hasSubmittedResult(match))
    throw new Error("No result submitted — use auto-cancel");

  const scoreOf        = match.result?.scoreOf ?? {};
  const submitter      = match.submittedBy;
  const other =
    submitter === match.playerA ? match.playerB : match.playerA;
  const submitterScore = scoreOf[submitter] ?? 0;
  const otherScore     = scoreOf[other]     ?? 0;

  let confirmedWinner;
  if (submitterScore > otherScore)      confirmedWinner = submitter;
  else if (otherScore > submitterScore) confirmedWinner = other;
  else                                  confirmedWinner = "draw";

  result = await distributeReward(t, match, matchRef, confirmedWinner);
  t.update(matchRef, { autoResolved: true });
});

if (result.alreadyResolved)
  return res.json({ message: "Already resolved", confirmedWinner: result.confirmedWinner });
if (result.alreadyCancelled)
  return res.json({ message: "Already cancelled" });

res.json({ message: "Auto-resolved", confirmedWinner: result.confirmedWinner });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.post("/matches/auto-cancel", verifyToken, async (req, res) => {
const { matchId } = req.body;
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
let alreadyDone = false;

await db.runTransaction(async (t) => {
  const matchRef = db.collection("matches").doc(matchId);
  const matchDoc = await t.get(matchRef);
  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.status === "cancelled" || match.status === "completed") {
    alreadyDone = true;
    return;
  }
  if (match.status !== "active")
    throw new Error(`Cannot auto-cancel — status is "${match.status}"`);
  if (hasSubmittedResult(match))
    throw new Error("Result submitted — use auto-resolve");

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const [playerA_Doc, playerB_Doc] = await Promise.all([
    t.get(playerA_Ref),
    t.get(playerB_Ref),
  ]);

  if (!playerA_Doc.exists || !playerB_Doc.exists)
    throw new Error("Player data not found");

  t.update(playerA_Ref, { coins: inc(playerA_Doc.data().coins, match.entryFee) });
  t.update(playerB_Ref, { coins: inc(playerB_Doc.data().coins, match.entryFee) });
  t.update(matchRef, {
    status:        "cancelled",
    cancelledAt:   admin.firestore.FieldValue.serverTimestamp(),
    autoCancelled: true,
    cancelReason:  "match_timer_expired_no_submission",
  });
});

if (alreadyDone) return res.json({ message: "No action needed" });
res.json({ message: "Auto-cancelled — both players refunded" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// REMATCH SYSTEM
// ═══════════════════════════════════════════════════════════════

app.post("/matches/rematch-request", verifyToken, async (req, res) => {
const { matchId } = req.body;
const uid = req.user.uid;
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const userRef  = db.collection("users").doc(uid);
const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

  if (!matchDoc.exists) throw new Error("Match not found");
  if (!userDoc.exists)  throw new Error("User not found");

  const match = matchDoc.data();
  if (match.playerA !== uid && match.playerB !== uid)
    throw new Error("You are not in this match");
  if (match.status !== "completed") throw new Error("Match not completed");
  if (match.rematchRequestedBy)     throw new Error("Rematch already requested");
  if ((userDoc.data().coins ?? 0) < match.entryFee)
    throw new Error("Insufficient coins for rematch");

  t.update(matchRef, {
    rematchRequestedBy: uid,
    rematchStatus:      "pending",
    rematchRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});
res.json({ message: "Rematch requested" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

app.post("/matches/rematch-respond", verifyToken, async (req, res) => {
const { matchId, accept } = req.body;
const uid = req.user.uid;

if (!matchId || accept === undefined)
return res.status(400).json({ error: "matchId and accept required" });

if (!accept) {
await db.collection("matches").doc(matchId).update({
rematchStatus:     "declined",
rematchDeclinedAt: admin.firestore.FieldValue.serverTimestamp(),
});
return res.json({ message: "Rematch declined" });
}

try {
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await t.get(matchRef);
if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();
  if (match.playerA !== uid && match.playerB !== uid)
    throw new Error("You are not in this match");
  if (match.rematchStatus !== "pending")
    throw new Error("No pending rematch");
  if (match.rematchRequestedBy === uid)
    throw new Error("Cannot accept own rematch request");

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const [playerA_Doc, playerB_Doc] = await Promise.all([
    t.get(playerA_Ref),
    t.get(playerB_Ref),
  ]);

  const coinsA = playerA_Doc.data()?.coins ?? 0;
  const coinsB = playerB_Doc.data()?.coins ?? 0;
  if (coinsA < match.entryFee) throw new Error("Player A insufficient coins");
  if (coinsB < match.entryFee) throw new Error("Player B insufficient coins");

  t.update(playerA_Ref, { coins: inc(coinsA, -match.entryFee) });
  t.update(playerB_Ref, { coins: inc(coinsB, -match.entryFee) });

  const now = admin.firestore.FieldValue.serverTimestamp();
  t.update(matchRef, {
    status:             "active",
    result:             null,
    submittedBy:        null,
    submittedAt:        null,
    confirmedWinner:    null,
    rewarded:           false,
    winnerReward:       0,
    loserReward:        0,
    platformFee:        0,
    confirmedAt:        null,
    disputedAt:         null,
    disputedBy:         null,
    autoResolved:       false,
    autoCancelled:      false,
    cancelReason:       null,
    rematchStatus:      "accepted",
    rematchStartedAt:   now,
    startedAt:          now,
    matchStartedAt:     now,
    players:            [match.playerA, match.playerB],
  });
});
res.json({ message: "Rematch accepted — match restarted" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────
app.get("/leaderboard", verifyToken, async (req, res) => {
try {
const snap = await db.collection("users").orderBy("wins", "desc").limit(20).get();
const leaderboard = snap.docs.map((doc, i) => {
const d = doc.data();
return {
rank:         i + 1,
uid:          d.uid,
displayName:  d.displayName ?? "Player",
wins:         d.wins        ?? 0,
losses:       d.losses      ?? 0,
totalMatches: d.totalMatches ?? 0,
avatar:       d.avatar      ?? null,
};
});
res.json(leaderboard);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// CHECK USERNAME AVAILABILITY
// ─────────────────────────────────────────
app.get("/check-username/:username", verifyToken, async (req, res) => {
const { username } = req.params;
try {
const snap = await db.collection("users")
.where("displayName", "==", username)
.limit(1)
.get();
res.json({ available: snap.empty });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
console.log(`🚀 Duelix backend running on port ${PORT}`);
});
server.on("error", (err) => console.error("❌ Server error:", err));