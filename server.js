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

app.use(cors({
origin: "*",
methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options('*', cors());

app.use(express.json());

// ─────────────────────────────────────────
// CACHE CONTROL MIDDLEWARE
// ✅ FIX 5: Prevents any proxy, CDN, or HTTP client from caching
//    responses. Every request to this backend gets fresh data
//    from Firestore. Applied globally to all routes.
// ─────────────────────────────────────────
app.use((_req, res, next) => {
res.set({
"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
"Pragma":        "no-cache",
"Expires":       "0",
"Surrogate-Control": "no-store",
});
next();
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/** Safe integer increment — never NaN */
const inc = (current, by = 1) => (Number(current) || 0) + by;

/** 90/10 split */
const winnerPayout = (entryFee) => Math.floor(entryFee * 2 * 0.9);
const platformCut  = (entryFee) => Math.floor(entryFee * 2 * 0.1);

/**

- ✅ FIX 3: Validates entryFee is a positive integer.
- Floats like 49.9 would cause coin arithmetic inconsistency.
  */
  function validateEntryFee(entryFee) {
  if (typeof entryFee !== "number" || !Number.isInteger(entryFee) || entryFee <= 0) {
  throw new Error("entryFee must be a positive integer");
  }
  }

/**

- ✅ FIX 2 & 4: Checks whether a result has been submitted.
- Uses nullish check (null OR undefined) so missing fields
- don’t accidentally allow a second submission.
  */
  function hasSubmittedResult(match) {
  return match.submittedBy != null; // covers both null and undefined
  }

/**

- Core reward distribution — shared by confirm-result and auto-resolve.
- All reads happen before any writes (Firestore transaction requirement).
- ✅ FIX 7: Clears rematch fields on completion so ticker/rematch UI resets.
  */
  async function distributeReward(t, match, matchRef, confirmedWinner) {
  const payout   = winnerPayout(match.entryFee);
  const platform = platformCut(match.entryFee);

const playerA_Ref = db.collection("users").doc(match.playerA);
const playerB_Ref = db.collection("users").doc(match.playerB);
const platformRef = db.collection("platform").doc("earnings");

// All reads first
const playerA_Doc = await t.get(playerA_Ref);
const playerB_Doc = await t.get(playerB_Ref);
const platformDoc = await t.get(platformRef);

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
const loser     = confirmedWinner === match.playerA ? match.playerB : match.playerA;
const winnerRef = db.collection("users").doc(confirmedWinner);
const loserRef  = db.collection("users").doc(loser);
const winnerDoc = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
const loserDoc  = loser === match.playerA ? playerA_Doc : playerB_Doc;

t.update(winnerRef, {
  coins:        inc(winnerDoc.data()?.coins ?? 0, payout),
  wins:         inc(winnerDoc.data()?.wins ?? 0),
  totalMatches: inc(winnerDoc.data()?.totalMatches ?? 0),
});
t.update(loserRef, {
  losses:       inc(loserDoc.data()?.losses ?? 0),
  totalMatches: inc(loserDoc.data()?.totalMatches ?? 0),
});

t.set(platformRef, {
  totalCoins:  inc(platformDoc.exists ? platformDoc.data().totalCoins : 0, platform),
  lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

}

// Mark match completed and clear rematch fields for next round
t.update(matchRef, {
status:             "completed",
confirmedWinner,
rewarded:           true,
rewardPaid:         confirmedWinner === "draw" ? 0 : payout,
platformFee:        confirmedWinner === "draw" ? 0 : platform,
confirmedAt:        admin.firestore.FieldValue.serverTimestamp(),
rematchRequestedBy: null,
rematchStatus:      null,
rematchRequestedAt: null,
});

return { payout, platform, confirmedWinner };
}

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get("/", (_req, res) => res.send("Duelix backend is live 🚀"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ═══════════════════════════════════════════════════════════════
// AUTH
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

// ⚠️ TODO: hash password before storing (bcrypt recommended)
await userRef.set({
  uid:          phone,
  phone,
  password,                         // plain-text — hash in production
  displayName:  displayName || "Player",
  coins:        100,
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
// ⚠️ TODO: compare hashed password (bcrypt.compare)
if (user.password !== password)
  return res.status(401).json({ error: "Wrong password" });

const token = await admin.auth().createCustomToken(phone);
res.json({ message: "Login successful", token, uid: phone });

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ⚠️ No auth — add verifyToken + ownership check before production
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
coins:        coins ?? 100,
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
// Streak-based coin reward — matches frontend reward table:
//   Day 1–2 → 5 coins | Day 3–4 → 6 coins | Day 5 → 7 coins
//   Day 6   → 8 coins | Day 7   → 20 coins (then resets)
// ═══════════════════════════════════════════════════════════════

function getStreakReward(streak) {
const day = ((streak - 1) % 7) + 1;
if (day <= 2) return 5;
if (day <= 4) return 6;
if (day === 5) return 7;
if (day === 6) return 8;
return 20; // day 7
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
// Flow:
//   1. Create match   → creator’s coins deducted atomically
//   2. Join match     → joiner’s coins deducted atomically, match → active
//   3. Submit result  → one player submits scores
//   4. Confirm result → other player confirms → reward paid
//      OR dispute     → match flagged for review
//      OR auto-resolve → confirm timer (3 min) expired with submission
//      OR auto-cancel  → match timer (20 min) expired with NO submission
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// CREATE MATCH
// ✅ FIX 1 & 3: Fully atomic — coin deduction and match document
//    creation happen in the same transaction. If either fails,
//    both are rolled back. No partial state possible.
// ─────────────────────────────────────────
app.post("/matches/create", verifyToken, async (req, res) => {
const { game, entryFee } = req.body;
const uid = req.user.uid;

if (!game)
return res.status(400).json({ error: "game is required" });

// ✅ FIX 3: Validate entryFee is a positive integer before any DB work
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

  // ✅ FIX 3: Create matchRef first so matchId is set before any writes.
  //    Firestore doc() generates the ID client-side — no async needed.
  const matchRef = db.collection("matches").doc();
  matchId = matchRef.id;

  // Both writes happen atomically — if match creation fails, no deduction
  t.update(userRef, { coins: coins - entryFee });

  t.set(matchRef, {
    id:                 matchId,
    playerA:            uid,
    playerB:            null,
    game,
    entryFee,           // always a positive integer — validated above
    status:             "waiting",
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

// ✅ FIX 1: Return full match data so Flutter can immediately
//    display the match in "My Matches" without a second fetch.
res.status(201).json({
  matchId,
  status:   "waiting",
  playerA:  uid,
  playerB:  null,
  game,
  entryFee,
});

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// GET MATCHES
// ✅ FIX 1 & 4 & 5: Returns all waiting and active matches in a
//    single response. Cache-Control headers (applied globally above)
//    ensure every call fetches fresh data from Firestore.
//    Filters out matches missing required fields to prevent
//    UI inconsistency from partially-written documents.
// ─────────────────────────────────────────
app.get("/matches", verifyToken, async (req, res) => {
try {
const [waitingSnap, activeSnap] = await Promise.all([
db.collection("matches")
.where("status", "==", "waiting")
.orderBy("createdAt", "desc")   // newest first — consistent ordering
.get(),
db.collection("matches")
.where("status", "==", "active")
.orderBy("startedAt", "desc")
.get(),
]);

const matches = [
  ...waitingSnap.docs.map(d => d.data()),
  ...activeSnap.docs.map(d => d.data()),
].filter(m =>
  // ✅ FIX 4: Drop incomplete documents — a match without an id,
  //    playerA, or game is a partial write that shouldn't be shown.
  m.id && m.playerA && m.game
);

res.json(matches);

} catch (err) {
// ✅ FIX 8: Structured error — never a silent 200 with empty body
console.error("GET /matches error:", err);
res.status(500).json({ error: "Failed to load matches. Please try again." });
}
});

// ─────────────────────────────────────────
// JOIN MATCH
// ✅ FIX 2: Assigns playerB and sets status → "active" atomically
//    with coin deduction. Both operations are in one transaction
//    so the match is never in an inconsistent "active" state with
//    no opponent, or an "opponent assigned" state with no coin deduction.
// ─────────────────────────────────────────
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

  // ✅ FIX 2: All guards before any writes
  if (match.status !== "waiting")  throw new Error("Match no longer available");
  if (match.playerA === uid)       throw new Error("Cannot join your own match");
  if (match.playerB != null)       throw new Error("Match already has an opponent");
  if (coins < match.entryFee)      throw new Error("Insufficient coins");

  const now = admin.firestore.FieldValue.serverTimestamp();

  // Atomic: deduct coins + assign playerB + activate match
  t.update(userRef, { coins: coins - match.entryFee });
  t.update(matchRef, {
    playerB:        uid,
    status:         "active",      // ✅ FIX 2: Goes active immediately
    startedAt:      now,
    matchStartedAt: now,
  });

  // Capture for response — serverTimestamp not readable until after commit,
  // so we approximate with current time for the immediate response
  joinedMatch = {
    matchId:  match.id,
    playerA:  match.playerA,
    playerB:  uid,
    game:     match.game,
    entryFee: match.entryFee,
    status:   "active",
  };
});

// ✅ FIX 1: Return match data so Flutter knows the full match state
//    immediately without a second API call
res.json({ message: "Joined match successfully", match: joinedMatch });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// CANCEL MATCH (waiting state only)
// Creator cancels before anyone joins.
// For active match timer expiry with no submission, use /matches/auto-cancel.
// ─────────────────────────────────────────
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

  // Refund creator atomically
  t.update(userRef, { coins: inc(userDoc.data().coins, match.entryFee) });
  t.update(matchRef, {
    status:      "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

res.json({ message: "Match cancelled — entry fee refunded" });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// SUBMIT RESULT
// ✅ FIX 2: Uses hasSubmittedResult() which correctly handles
//    both null and undefined submittedBy field values.
//    Result is immediately available for the opponent to confirm.
// ─────────────────────────────────────────
app.post("/matches/submit-result", verifyToken, async (req, res) => {
const { matchId, myScore, opponentScore } = req.body;
const uid = req.user.uid;

if (!matchId || myScore === undefined || opponentScore === undefined)
return res.status(400).json({ error: "matchId, myScore, opponentScore required" });

if (typeof myScore !== "number" || typeof opponentScore !== "number")
return res.status(400).json({ error: "myScore and opponentScore must be numbers" });

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

  // ✅ FIX 2: hasSubmittedResult covers null AND undefined
  if (hasSubmittedResult(match))
    throw new Error("Result already submitted — waiting for opponent to confirm");

  // Build scoreOf so confirm-result can read both players' scores
  const opponentUid = uid === match.playerA ? match.playerB : match.playerA;

  t.update(matchRef, {
    result: {
      myScore,
      opponentScore,
      scoreOf: {
        [uid]:        myScore,
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

// ─────────────────────────────────────────
// CONFIRM RESULT
// Called by the player who did NOT submit.
// ─────────────────────────────────────────
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
    throw new Error("No result has been submitted yet");
  if (match.submittedBy === uid)
    throw new Error("You submitted the result — wait for your opponent");

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

// ─────────────────────────────────────────
// DISPUTE
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// MATCH HISTORY
// ─────────────────────────────────────────
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
  ...snapA.docs.map(d => d.data()),
  ...snapB.docs.map(d => d.data()),
].sort((a, b) => {
  const aT = a.createdAt?._seconds ?? 0;
  const bT = b.createdAt?._seconds ?? 0;
  return bT - aT;
}).slice(0, 50);

res.json(history);

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// TIMER EXPIRY LOGIC
//
// Flutter checks submittedBy when the 20-minute match timer hits zero:
//
//   submittedBy !== null  →  POST /matches/auto-resolve
//     A result exists. Pay winner from submitted scores.
//     (also called when the 3-minute confirm timer expires)
//
//   submittedBy === null  →  POST /matches/auto-cancel
//     No result submitted. Refund both players in full.
//
// Both endpoints are fully idempotent — safe to call more than once.
// ✅ FIX 7: No ticker-related Firestore listeners. These endpoints
//    are only triggered by Flutter timers, not scheduled jobs.
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// AUTO RESOLVE
// ─────────────────────────────────────────
app.post("/matches/auto-resolve", verifyToken, async (req, res) => {
const { matchId } = req.body;

if (!matchId)
return res.status(400).json({ error: "matchId required" });

try {
let result = {};

await db.runTransaction(async (t) => {
  const matchRef = db.collection("matches").doc(matchId);
  const matchDoc = await t.get(matchRef);

  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  // Idempotency guard — read state BEFORE writing anything
  if (match.status === "completed" || match.rewarded === true || match.autoResolved === true) {
    result = { confirmedWinner: match.confirmedWinner, alreadyResolved: true };
    return;
  }

  if (match.status === "cancelled") {
    result = { alreadyCancelled: true };
    return;
  }

  if (match.status !== "active")
    throw new Error(`Cannot auto-resolve — match status is "${match.status}"`);

  if (!hasSubmittedResult(match))
    throw new Error("No result submitted — call auto-cancel for matches with no submission");

  const scoreOf        = match.result?.scoreOf ?? {};
  const submitter      = match.submittedBy;
  const other          = submitter === match.playerA ? match.playerB : match.playerA;
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
  return res.json({ message: "Match already resolved", confirmedWinner: result.confirmedWinner });
if (result.alreadyCancelled)
  return res.json({ message: "Match already cancelled" });

res.json({ message: "Match auto-resolved", confirmedWinner: result.confirmedWinner });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// AUTO CANCEL
// Called when the 20-minute match timer expires AND submittedBy === null.
// Refunds both players’ entry fees in full. Fully idempotent.
// ─────────────────────────────────────────
app.post("/matches/auto-cancel", verifyToken, async (req, res) => {
const { matchId } = req.body;

if (!matchId)
return res.status(400).json({ error: "matchId required" });

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
    throw new Error(`Cannot auto-cancel — match status is "${match.status}"`);

  if (hasSubmittedResult(match))
    throw new Error("A result was submitted — use auto-resolve instead of auto-cancel");

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

if (alreadyDone)
  return res.json({ message: "Match already cancelled or completed — no action taken" });

res.json({ message: "Match auto-cancelled — both players refunded" });

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

if (!matchId)
return res.status(400).json({ error: "matchId required" });

try {
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

  if (match.playerA !== uid && match.playerB !== uid)
    throw new Error("You are not in this match");
  if (match.status !== "completed")
    throw new Error("Match is not completed");
  if (match.rematchRequestedBy)
    throw new Error("Rematch already requested");
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
    throw new Error("No pending rematch request");
  if (match.rematchRequestedBy === uid)
    throw new Error("Cannot accept your own rematch request");

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const [playerA_Doc, playerB_Doc] = await Promise.all([
    t.get(playerA_Ref),
    t.get(playerB_Ref),
  ]);

  const coinsA = playerA_Doc.data()?.coins ?? 0;
  const coinsB = playerB_Doc.data()?.coins ?? 0;

  if (coinsA < match.entryFee) throw new Error("Player A has insufficient coins");
  if (coinsB < match.entryFee) throw new Error("Player B has insufficient coins");

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
    rewardPaid:         0,
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
const snap = await db.collection("users")
.orderBy("wins", "desc")
.limit(20)
.get();

const leaderboard = snap.docs.map((doc, i) => {
  const d = doc.data();
  return {
    rank:         i + 1,
    uid:          d.uid,
    displayName:  d.displayName ?? "Player",
    wins:         d.wins ?? 0,
    losses:       d.losses ?? 0,
    totalMatches: d.totalMatches ?? 0,
    avatar:       d.avatar ?? null,
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

res.json({ available: snap.empty });a

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

server.on("error", (err) => {
console.error("❌ Server error:", err);
});