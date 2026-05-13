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
// REFERRAL CODE GENERATOR
// ─────────────────────────────────────────
function generateReferralCode() {
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let code = "DUEL-";
for (let i = 0; i < 6; i++) {
code += chars[Math.floor(Math.random() * chars.length)];
}
return code;
}

async function uniqueReferralCode() {
for (let attempt = 0; attempt < 10; attempt++) {
const code = generateReferralCode();
const snap = await db
.collection("users")
.where("referralCode", "==", code)
.limit(1)
.get();
if (snap.empty) return code;
}
return `DUEL-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

// ─────────────────────────────────────────
// MATCH REWARD DISTRIBUTION — 80 / 10 / 10
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

// ─────────────────────────────────────────
// TRUST SYSTEM HELPERS
//
// ── Base Trust Score Formula ──────────────
//   trust = 100
//     - (rageQuits        × 10)
//     - (fakeResults      × 20)
//     - (disputesLost     ×  8)
//     - (cancelledMatches ×  3)
//     - (reportsReceived  ×  2)
//   clamped to [0, 100]
//
// ── Clean Match Trust Reward ──────────────
//   Applied after a successful confirmed match (no dispute):
//     +0.5 — result submitted successfully
//     +1.0 — opponent confirms result
//     +0.5 — no dispute after completion
//   = +2.0 total trust score bonus
//   = +0.5 fair play rating bonus
//
//   Both values are clamped to [0, 100].
//
// ── Fair Play Rating Formula ──────────────
//   fairPlay = 100
//     - (fakeResults  × 20)
//     - (disputesLost × 10)
//     - (rageQuits    ×  5)
//   + cleanMatchBonus (stored as fairPlayBonus counter × 0.5)
//   clamped to [0, 100]
//
// ── Match Completion Rate ─────────────────
//   completedMatches / totalMatches × 100
//   (0 if no matches yet — never manually points-based)
// ─────────────────────────────────────────

const CLEAN_MATCH_TRUST_BONUS     = 2;   // +2 trust score per clean match
const CLEAN_MATCH_FAIRPLAY_BONUS  = 0.5; // +0.5 fair play per clean match

function computeTrustScore(data) {
const rageQuits        = Number(data.rageQuits)        || 0;
const fakeResults      = Number(data.fakeResults)      || 0;
const disputesLost     = Number(data.disputesLost)     || 0;
const cancelledMatches = Number(data.cancelledMatches) || 0;
const reportsReceived  = Number(data.reportsReceived)  || 0;
// cleanMatchBonus accumulates the +2 rewards from clean matches
const cleanMatchBonus  = Number(data.cleanMatchBonus)  || 0;

const raw = 100
- (rageQuits        * 10)
- (fakeResults      * 20)
- (disputesLost     *  8)
- (cancelledMatches *  3)
- (reportsReceived  *  2)
+ cleanMatchBonus;          // positive reward for clean play

return Math.max(0, Math.min(100, Math.round(raw)));
}

function computeCompletionRate(data) {
const total     = Number(data.totalMatches)     || 0;
const completed = Number(data.completedMatches) || 0;
// Formula: completedMatches / totalMatches × 100
// Returns 0 for new users with no matches.
if (total === 0) return 0;
return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function computeFairPlayRating(data) {
const fakeResults       = Number(data.fakeResults)       || 0;
const disputesLost      = Number(data.disputesLost)      || 0;
const rageQuits         = Number(data.rageQuits)         || 0;
// fairPlayBonus accumulates +0.5 rewards per clean match (stored as float)
const fairPlayBonus     = Number(data.fairPlayBonus)     || 0;

const base = 100
- (fakeResults  * 20)
- (disputesLost * 10)
- (rageQuits    *  5)
+ fairPlayBonus;            // positive reward for clean play

// Must never exceed 100
return Math.max(0, Math.min(100, Math.round(base)));
}

// Default trust fields written when creating a new user profile.
const DEFAULT_TRUST_FIELDS = {
trustScore:          80,
completedMatches:    0,
cancelledMatches:    0,
disputesLost:        0,
reportsReceived:     0,
fakeResults:         0,
rageQuits:           0,
fairPlayRating:      100,
matchCompletionRate: 0,
cleanMatchBonus:     0,    // accumulates +2 per clean match (added to trust)
fairPlayBonus:       0,    // accumulates +0.5 per clean match (added to fair play)
onlineStatus:        true,
friendRequests:      true,
};

/**

- Recalculates and writes trust fields for a user inside an
- existing transaction (t) or as a standalone operation.
- 
- @param {FirebaseFirestore.Transaction|null} t
- @param {DocumentReference} userRef
- @param {object} userData — current Firestore data snapshot
  */
  function applyTrustUpdate(t, userRef, userData) {
  const score      = computeTrustScore(userData);
  const completion = computeCompletionRate(userData);
  const fairPlay   = computeFairPlayRating(userData);

const fields = {
trustScore:          score,
matchCompletionRate: completion,
fairPlayRating:      fairPlay,
trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
};

if (t) {
t.update(userRef, fields);
} else {
userRef.update(fields);
}
}

/**

- Applies the clean match trust reward for a single player.
- Called after a confirmed match with no dispute.
- 
- Reward breakdown:
- +0.5 result submitted successfully
- +1.0 opponent confirms result
- +0.5 no dispute after completion
- ─────────────────────────────────
- +2.0 total trust bonus
- +0.5 fair play bonus
- 
- Stored as running totals in cleanMatchBonus / fairPlayBonus,
- then factored into computeTrustScore / computeFairPlayRating.
- Both final values are clamped to [0, 100] — fair play never exceeds 100.
- 
- @param {FirebaseFirestore.Transaction} t
- @param {DocumentReference} userRef
- @param {object} userData — current Firestore data snapshot
  */
  function applyCleanMatchReward(t, userRef, userData) {
  // Accumulate running totals
  const newCleanMatchBonus = (Number(userData.cleanMatchBonus) || 0) + CLEAN_MATCH_TRUST_BONUS;
  const newFairPlayBonus   = (Number(userData.fairPlayBonus)   || 0) + CLEAN_MATCH_FAIRPLAY_BONUS;

// Build updated data object for recomputing derived values
const updatedData = {
userData,
cleanMatchBonus: newCleanMatchBonus,
fairPlayBonus:   newFairPlayBonus,
};

// Recompute all trust fields with the updated bonuses
const score      = computeTrustScore(updatedData);
const completion = computeCompletionRate(updatedData);
const fairPlay   = computeFairPlayRating(updatedData);

t.update(userRef, {
cleanMatchBonus:     newCleanMatchBonus,
fairPlayBonus:       newFairPlayBonus,
trustScore:          score,          // clamped to [0, 100]
matchCompletionRate: completion,     // completedMatches / totalMatches × 100
fairPlayRating:      fairPlay,       // clamped to [0, 100] — never exceeds 100
trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
});
}

// ─────────────────────────────────────────
// DISPUTE VALIDATORS
// ─────────────────────────────────────────
const VALID_DISPUTE_REASONS = [
"Wrong Score",
"Opponent Quit",
"Fake Submission",
"Time Wasting",
"Abuse",
"Other Issue",
];

function validateDisputeReason(reason) {
if (!reason || typeof reason !== "string") {
throw new Error("reason is required");
}
const trimmed = reason.trim();
if (!VALID_DISPUTE_REASONS.includes(trimmed)) {
console.warn(`[dispute] Non-standard reason: "${trimmed}" — accepted`);
}
if (trimmed.length < 2 || trimmed.length > 200) {
throw new Error("reason must be between 2 and 200 characters");
}
return trimmed;
}

function validateDisputeNote(note) {
if (!note) return "";
const trimmed = String(note).trim();
if (trimmed.length > 500) {
throw new Error("note must be 500 characters or fewer");
}
const wordCount = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
if (wordCount > 20) {
throw new Error("note must be 20 words or fewer");
}
return trimmed;
}

// ─────────────────────────────────────────
// DISTRIBUTE MATCH REWARD
//
// Called after confirm-result, auto-resolve (clean path).
// Applies coin rewards, updates match counters, then applies
// the clean match trust reward (+2 trust, +0.5 fair play)
// to BOTH players.
// ─────────────────────────────────────────
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
// Draw — both refunded, completedMatches+1, clean match reward for both
const aUpdated = {
playerA_Doc: data(),
completedMatches: inc(playerA_Doc.data().completedMatches),
totalMatches:     inc(playerA_Doc.data().totalMatches),
};
const bUpdated = {
playerB_Doc: data(),
completedMatches: inc(playerB_Doc.data().completedMatches),
totalMatches:     inc(playerB_Doc.data().totalMatches),
};

t.update(playerA_Ref, {
  coins:            inc(playerA_Doc.data().coins, match.entryFee),
  draws:            inc(playerA_Doc.data().draws),
  totalMatches:     inc(playerA_Doc.data().totalMatches),
  completedMatches: inc(playerA_Doc.data().completedMatches),
});
t.update(playerB_Ref, {
  coins:            inc(playerB_Doc.data().coins, match.entryFee),
  draws:            inc(playerB_Doc.data().draws),
  totalMatches:     inc(playerB_Doc.data().totalMatches),
  completedMatches: inc(playerB_Doc.data().completedMatches),
});

// Clean match reward for both players (draw = clean match)
applyCleanMatchReward(t, playerA_Ref, aUpdated);
applyCleanMatchReward(t, playerB_Ref, bUpdated);

} else {
const loserUid  = confirmedWinner === match.playerA ? match.playerB : match.playerA;
const winnerRef = db.collection("users").doc(confirmedWinner);
const loserRef  = db.collection("users").doc(loserUid);
const winnerDoc = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
const loserDoc  = loserUid       === match.playerA ? playerA_Doc : playerB_Doc;

// Pre-compute updated data objects (with incremented counters)
// so the trust/fairplay formulas use the correct new totals
const winnerUpdated = {
  ...winnerDoc.data(),
  completedMatches: inc(winnerDoc.data()?.completedMatches ?? 0),
  totalMatches:     inc(winnerDoc.data()?.totalMatches     ?? 0),
};
const loserUpdated = {
  ...loserDoc.data(),
  completedMatches: inc(loserDoc.data()?.completedMatches ?? 0),
  totalMatches:     inc(loserDoc.data()?.totalMatches     ?? 0),
};

t.update(winnerRef, {
  coins:            inc(winnerDoc.data()?.coins        ?? 0, winner),
  wins:             inc(winnerDoc.data()?.wins         ?? 0),
  totalMatches:     inc(winnerDoc.data()?.totalMatches ?? 0),
  completedMatches: inc(winnerDoc.data()?.completedMatches ?? 0),
});
t.update(loserRef, {
  coins:            inc(loserDoc.data()?.coins        ?? 0, loser),
  losses:           inc(loserDoc.data()?.losses       ?? 0),
  totalMatches:     inc(loserDoc.data()?.totalMatches ?? 0),
  completedMatches: inc(loserDoc.data()?.completedMatches ?? 0),
});

// Clean match trust reward — applies to BOTH winner and loser
// (+2 trust score, +0.5 fair play, MCR recalculated from counters)
applyCleanMatchReward(t, winnerRef, winnerUpdated);
applyCleanMatchReward(t, loserRef,  loserUpdated);

t.set(platformRef, {
  totalCoins:  inc(platformDoc.exists ? platformDoc.data().totalCoins : 0, plat),
  lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

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
// TRUST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post("/trust/update", verifyToken, async (req, res) => {
const { uid } = req.body;
const targetUid = uid || req.user.uid;

try {
const userRef = db.collection("users").doc(targetUid);
const userDoc = await userRef.get();
if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

const data  = userDoc.data();
const score = computeTrustScore(data);

await userRef.set({
  trustScore:          score,
  matchCompletionRate: computeCompletionRate(data),
  fairPlayRating:      computeFairPlayRating(data),
  trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

console.log(`[trust/update] uid=${targetUid} score=${score}`);
res.json({ message: "Trust score updated", trustScore: score });

} catch (err) {
console.error("[trust/update]", err.message);
res.status(500).json({ error: err.message });
}
});

app.post("/trust/rage-quit", verifyToken, async (req, res) => {
const { uid } = req.body;
if (!uid) return res.status(400).json({ error: "uid required" });

try {
await db.runTransaction(async (t) => {
const userRef = db.collection("users").doc(uid);
const userDoc = await t.get(userRef);
if (!userDoc.exists) throw new Error("User not found");
const data        = userDoc.data();
const updatedData = { data, rageQuits: inc(data.rageQuits) };
t.update(userRef, { rageQuits: inc(data.rageQuits) });
applyTrustUpdate(t, userRef, updatedData);
});
console.log(`[trust/rage-quit] uid=${uid}`);
res.json({ message: "Rage quit recorded" });
} catch (err) {
console.error("[trust/rage-quit]", err.message);
res.status(500).json({ error: err.message });
}
});

app.post("/trust/dispute-penalty", verifyToken, async (req, res) => {
const { uid } = req.body;
if (!uid) return res.status(400).json({ error: "uid required" });

try {
await db.runTransaction(async (t) => {
const userRef = db.collection("users").doc(uid);
const userDoc = await t.get(userRef);
if (!userDoc.exists) throw new Error("User not found");
const data        = userDoc.data();
const updatedData = { data, disputesLost: inc(data.disputesLost) };
t.update(userRef, { disputesLost: inc(data.disputesLost) });
applyTrustUpdate(t, userRef, updatedData);
});
console.log(`[trust/dispute-penalty] uid=${uid}`);
res.json({ message: "Dispute penalty applied" });
} catch (err) {
console.error("[trust/dispute-penalty]", err.message);
res.status(500).json({ error: err.message });
}
});

app.post("/trust/fake-result", verifyToken, async (req, res) => {
const { uid } = req.body;
if (!uid) return res.status(400).json({ error: "uid required" });

try {
await db.runTransaction(async (t) => {
const userRef = db.collection("users").doc(uid);
const userDoc = await t.get(userRef);
if (!userDoc.exists) throw new Error("User not found");
const data        = userDoc.data();
const updatedData = { data, fakeResults: inc(data.fakeResults) };
t.update(userRef, { fakeResults: inc(data.fakeResults) });
applyTrustUpdate(t, userRef, updatedData);
});
console.log(`[trust/fake-result] uid=${uid}`);
res.json({ message: "Fake result penalty applied" });
} catch (err) {
console.error("[trust/fake-result]", err.message);
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// CREATE USER PROFILE
// ═══════════════════════════════════════════════════════════════
app.post("/users/create-profile", verifyToken, async (req, res) => {
const uid = req.user.uid;
const { displayName, phone, email } = req.body;

if (!displayName || !phone) {
return res.status(400).json({ error: "displayName and phone are required" });
}
if (!/^+\d{7,15}$/.test(phone)) {
return res.status(400).json({ error: "phone must be in E.164 format (e.g. +233244123456)" });
}
const name = displayName.trim();
if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) {
return res.status(400).json({ error: "displayName: 3–20 chars, letters/numbers/underscores/dots only" });
}

try {
const userRef      = db.collection("users").doc(uid);
const referralCode = await uniqueReferralCode();

await db.runTransaction(async (t) => {
  const snap = await t.get(userRef);
  if (snap.exists) return;

  const phoneSnap = await db.collection("users").where("phone", "==", phone).limit(1).get();
  if (!phoneSnap.empty) throw new Error("PHONE_TAKEN");

  const nameSnap = await db.collection("users").where("displayName", "==", name).limit(1).get();
  if (!nameSnap.empty) throw new Error("USERNAME_TAKEN");

  t.set(userRef, {
    uid,
    displayName:   name,
    phone,
    email:         email ?? "",
    coins:         20,
    wins:          0,
    losses:        0,
    draws:         0,
    totalMatches:  0,
    loginStreak:   0,
    lastLogin:     null,
    avatar:        "assets/avatars/avatar1.png",
    referralCode,
    referredBy:    null,
    referralCount: 0,
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    ...DEFAULT_TRUST_FIELDS,
  });
});

res.status(201).json({ message: "Profile created", uid, referralCode });

} catch (err) {
if (err.message === "PHONE_TAKEN")
return res.status(409).json({ error: "That phone number is already registered" });
if (err.message === "USERNAME_TAKEN")
return res.status(409).json({ error: "That username is already taken" });
console.error("[create-profile]", err.message);
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

// ═══════════════════════════════════════════════════════════════
// REFERRAL SYSTEM
// New user bonus: 5 coins | Referrer bonus: 5 coins
// ═══════════════════════════════════════════════════════════════
app.post("/apply-referral", verifyToken, async (req, res) => {
const currentUid = req.user.uid;
const { referralCode } = req.body;

if (!referralCode || typeof referralCode !== "string") {
return res.status(400).json({ error: "referralCode is required" });
}

const code = referralCode.trim().toUpperCase();

try {
const codeSnap = await db
.collection("users")
.where("referralCode", "==", code)
.limit(1)
.get();

if (codeSnap.empty) {
  return res.status(404).json({ error: "Referral code not found" });
}

const referrerUid = codeSnap.docs[0].id;
if (referrerUid === currentUid) {
  return res.status(400).json({ error: "You cannot use your own referral code" });
}

let bonusCoins = 0;

await db.runTransaction(async (t) => {
  const currentRef  = db.collection("users").doc(currentUid);
  const referrerRef = db.collection("users").doc(referrerUid);

  const [currentDoc, referrerDocT] = await Promise.all([
    t.get(currentRef),
    t.get(referrerRef),
  ]);

  if (!currentDoc.exists)   throw new Error("Your account was not found");
  if (!referrerDocT.exists) throw new Error("Referrer account not found");
  if (currentDoc.data().referredBy) throw new Error("ALREADY_REFERRED");

  bonusCoins = 5; // new user +5 (was 10)

  t.update(currentRef, {
    coins:      inc(currentDoc.data().coins, bonusCoins),
    referredBy: referrerUid,
  });
  t.update(referrerRef, {
    coins:         inc(referrerDocT.data().coins, 5), // referrer +5 (was 15)
    referralCount: inc(referrerDocT.data().referralCount ?? 0),
  });
});

console.log(`[apply-referral] uid=${currentUid} code=${code} newUserBonus=5 referrerBonus=5`);
res.json({ message: "Referral applied successfully", bonusCoins });

} catch (err) {
if (err.message === "ALREADY_REFERRED") {
return res.status(409).json({ error: "You have already used a referral code" });
}
console.error("[apply-referral]", err.message);
res.status(500).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// USER ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get("/user/:uid", verifyToken, async (req, res) => {
try {
const doc = await db.collection("users").doc(req.params.uid).get();
if (!doc.exists) return res.status(404).json({ error: "User not found" });

const data = doc.data();

// Migration: backfill trust fields + new bonus fields for old users
if (data.trustScore === undefined) {
  const trustFields = {
    trustScore:          80,
    completedMatches:    data.completedMatches ?? 0,
    cancelledMatches:    data.cancelledMatches ?? 0,
    disputesLost:        data.disputesLost     ?? 0,
    reportsReceived:     data.reportsReceived  ?? 0,
    fakeResults:         data.fakeResults      ?? 0,
    rageQuits:           data.rageQuits        ?? 0,
    fairPlayRating:      100,
    matchCompletionRate: 0,
    cleanMatchBonus:     0,
    fairPlayBonus:       0,
    onlineStatus:        data.onlineStatus   ?? true,
    friendRequests:      data.friendRequests ?? true,
  };
  db.collection("users").doc(req.params.uid)
    .set(trustFields, { merge: true })
    .catch(console.error);

  res.json({ ...data, ...trustFields });
} else {
  // Ensure bonus fields exist for users created before this update
  const needsPatch =
    data.cleanMatchBonus === undefined ||
    data.fairPlayBonus   === undefined;

  if (needsPatch) {
    const patch = {
      cleanMatchBonus: data.cleanMatchBonus ?? 0,
      fairPlayBonus:   data.fairPlayBonus   ?? 0,
    };
    db.collection("users").doc(req.params.uid)
      .set(patch, { merge: true })
      .catch(console.error);

    res.json({ ...data, ...patch });
  } else {
    res.json(data);
  }
}

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/update-name", verifyToken, async (req, res) => {
const { displayName } = req.body;
if (!displayName) return res.status(400).json({ error: "displayName required" });

const name = displayName.trim();
if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) {
return res.status(400).json({ error: "displayName: 3–20 chars, letters/numbers/underscores/dots only" });
}

try {
const snap = await db.collection("users").where("displayName", "==", name).limit(1).get();
if (!snap.empty && snap.docs[0].id !== req.user.uid) {
return res.status(409).json({ error: "That username is already taken" });
}
await db.collection("users").doc(req.user.uid).update({ displayName: name });
res.json({ message: "Username updated" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post("/update-avatar", verifyToken, async (req, res) => {
const { avatar, isAsset } = req.body;
if (!avatar) return res.status(400).json({ error: "avatar required" });

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

app.get("/check-username/:username", verifyToken, async (req, res) => {
try {
const snap = await db
.collection("users")
.where("displayName", "==", req.params.username)
.limit(1)
.get();
const available = snap.empty || snap.docs[0].id === req.user.uid;
res.json({ available });
} catch (err) {
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
// Day 1→1, Day 2→1, Day 3→2, Day 4→2, Day 5→3, Day 6→3, Day 7→5
// ═══════════════════════════════════════════════════════════════

function getStreakReward(streak) {
const day = ((streak - 1) % 7) + 1;
if (day === 1) return 1;
if (day === 2) return 1;
if (day === 3) return 2;
if (day === 4) return 2;
if (day === 5) return 3;
if (day === 6) return 3;
return 5; // Day 7
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

console.log(`[claim-daily-reward] uid=${uid} coins=${rewardData.coinsToAdd} streak=${rewardData.streak}`);
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

if (!game) return res.status(400).json({ error: "game is required" });
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
    isPrivate:          true,
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
db.collection("matches").where("status", "==", "waiting").orderBy("createdAt", "desc").get(),
db.collection("matches").where("status", "==", "active").orderBy("startedAt", "desc").get(),
]);
const matches = [
waitingSnap.docs.map((d) => d.data()),
activeSnap.docs.map((d) => d.data()),
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
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
let joinedMatch = null;
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const userRef  = db.collection("users").doc(uid);
const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

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
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await t.get(matchRef);
if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();
  if (match.playerA !== uid)      throw new Error("Only the match creator can cancel");
  if (match.playerB != null)      throw new Error("Cannot cancel — opponent has already joined");
  if (match.status !== "waiting") throw new Error("Match cannot be cancelled at this stage");

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
// QUICK MATCH
// ═══════════════════════════════════════════════════════════════
app.post("/matches/quick-match", verifyToken, async (req, res) => {
const { game, entryFee } = req.body;
const uid = req.user.uid;

if (!game) return res.status(400).json({ error: "game is required" });
try { validateEntryFee(entryFee); }
catch (err) { return res.status(400).json({ error: err.message }); }

const gameUpper = game.toUpperCase();

try {
let matchId   = null;
let didCreate = false;

const candidateSnap = await db
  .collection("matches")
  .where("status",    "==", "waiting")
  .where("game",      "==", gameUpper)
  .where("entryFee",  "==", entryFee)
  .where("isPrivate", "==", false)
  .orderBy("createdAt", "asc")
  .limit(10)
  .get();

const candidates = candidateSnap.docs.filter((doc) => {
  const d = doc.data();
  return d.playerA !== uid && d.playerB === null;
});

console.log(`[quick-match] uid=${uid} game=${gameUpper} fee=${entryFee} candidates=${candidates.length}`);

if (candidates.length > 0) {
  matchId = candidates[0].id;
  await db.runTransaction(async (t) => {
    const matchRef = db.collection("matches").doc(matchId);
    const userRef  = db.collection("users").doc(uid);
    const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

    if (!matchDoc.exists) throw new Error("Match no longer exists");
    if (!userDoc.exists)  throw new Error("User not found");

    const match = matchDoc.data();
    const coins = userDoc.data().coins ?? 0;

    if (match.status    !== "waiting") throw new Error("Match no longer available");
    if (match.playerA   === uid)       throw new Error("Cannot join your own match");
    if (match.playerB   != null)       throw new Error("Match already taken");
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
  console.log(`[quick-match] JOINED ${matchId} uid=${uid}`);

} else {
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
  console.log(`[quick-match] CREATED ${matchId} uid=${uid}`);
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
  if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
  if (match.status !== "active")  throw new Error("Match is not active");
  if (hasSubmittedResult(match))  throw new Error("Result already submitted");

  const opponentUid = uid === match.playerA ? match.playerB : match.playerA;
  t.update(matchRef, {
    result: {
      myScore,
      opponentScore,
      scoreOf: { [uid]: myScore, [opponentUid]: opponentScore },
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
if (!matchId) return res.status(400).json({ error: "matchId required" });

try {
let result = {};
await db.runTransaction(async (t) => {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await t.get(matchRef);
if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();
  if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
  if (match.status === "completed") throw new Error("Match already completed");
  if (match.status !== "active")   throw new Error("Match is not active");
  if (!hasSubmittedResult(match))  throw new Error("No result submitted yet");
  if (match.submittedBy === uid)   throw new Error("You submitted — wait for opponent");

  const submitter      = match.submittedBy;
  const confirmer      = uid;
  const scoreOf        = match.result?.scoreOf ?? {};
  const submitterScore = scoreOf[submitter] ?? 0;
  const confirmerScore = scoreOf[confirmer] ?? 0;

  let confirmedWinner;
  if (submitterScore > confirmerScore)      confirmedWinner = submitter;
  else if (confirmerScore > submitterScore) confirmedWinner = confirmer;
  else                                      confirmedWinner = "draw";

  // distributeReward applies clean match trust reward (+2 trust, +0.5 fairplay)
  // to both players as part of the confirmed clean completion
  result = await distributeReward(t, match, matchRef, confirmedWinner);
});
res.json({ message: "Result confirmed", confirmedWinner: result.confirmedWinner });

} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ═══════════════════════════════════════════════════════════════
// DISPUTE
// ═══════════════════════════════════════════════════════════════
app.post("/matches/dispute", verifyToken, async (req, res) => {
const uid = req.user.uid;
const { matchId, reason, note, evidenceImage } = req.body;

if (!matchId) return res.status(400).json({ error: "matchId is required" });

let validatedReason;
try { validatedReason = validateDisputeReason(reason); }
catch (err) { return res.status(400).json({ error: err.message }); }

let validatedNote = "";
if (note !== undefined && note !== null && note !== "") {
try { validatedNote = validateDisputeNote(note); }
catch (err) { return res.status(400).json({ error: err.message }); }
}

let validatedEvidence = "";
if (evidenceImage) {
if (typeof evidenceImage !== "string" || evidenceImage.length > 2000)
return res.status(400).json({ error: "evidenceImage must be a valid URL string" });
validatedEvidence = evidenceImage.trim();
}

try {
const matchRef = db.collection("matches").doc(matchId);
const matchDoc = await matchRef.get();
if (!matchDoc.exists) return res.status(404).json({ error: "Match not found" });

const match = matchDoc.data();
if (match.playerA !== uid && match.playerB !== uid)
  return res.status(403).json({ error: "You are not in this match" });
if (match.status === "disputed")
  return res.status(409).json({ error: "This match has already been disputed" });
if (match.status === "completed")
  return res.status(400).json({ error: "Match is already completed — cannot dispute" });
if (match.status === "cancelled")
  return res.status(400).json({ error: "Match is cancelled — cannot dispute" });

const now        = admin.firestore.FieldValue.serverTimestamp();
const batch      = db.batch();
const disputeRef = db.collection("disputes").doc();

batch.set(disputeRef, {
  id:             disputeRef.id,
  matchId,
  disputeReason:  validatedReason,
  disputeNote:    validatedNote,
  evidenceImage:  validatedEvidence,
  reportedBy:     uid,
  disputedBy:     uid,
  status:         "pending",
  resolvedBy:     null,
  resolvedAt:     null,
  resolutionNote: null,
  matchData: {
    playerA:     match.playerA,
    playerB:     match.playerB,
    game:        match.game,
    entryFee:    match.entryFee,
    submittedBy: match.submittedBy ?? null,
    result:      match.result      ?? null,
  },
  createdAt: now,
});

batch.update(matchRef, {
  status:     "disputed",
  disputedAt: now,
  disputedBy: uid,
  disputeId:  disputeRef.id,
});

await batch.commit();
console.log(`[dispute] matchId=${matchId} reason="${validatedReason}" uid=${uid}`);
res.json({ message: "Dispute submitted — under review", disputeId: disputeRef.id });

} catch (err) {
console.error("[dispute]", err.message);
res.status(500).json({ error: err.message });
}
});

app.get("/matches/history", verifyToken, async (req, res) => {
const uid = req.user.uid;
try {
const [snapA, snapB] = await Promise.all([
db.collection("matches").where("playerA", "==", uid).where("status", "in", ["completed", "cancelled", "disputed"]).orderBy("createdAt", "desc").limit(50).get(),
db.collection("matches").where("playerB", "==", uid).where("status", "in", ["completed", "cancelled", "disputed"]).orderBy("createdAt", "desc").limit(50).get(),
]);
const history = [
snapA.docs.map((d) => d.data()),
snapB.docs.map((d) => d.data()),
].sort((a, b) => (b.createdAt?._seconds ?? 0) - (a.createdAt?._seconds ?? 0)).slice(0, 50);
res.json(history);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// AUTO-RESOLVE
// Clean match path: applies trust reward.
// Rage quit detected for non-submitter: NO clean match reward.
// ─────────────────────────────────────────
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
    result = { confirmedWinner: match.confirmedWinner, alreadyResolved: true }; return;
  }
  if (match.status === "cancelled") { result = { alreadyCancelled: true }; return; }
  if (match.status !== "active")
    throw new Error(`Cannot auto-resolve — status is "${match.status}"`);
  if (!hasSubmittedResult(match))
    throw new Error("No result submitted — use auto-cancel");

  const scoreOf        = match.result?.scoreOf ?? {};
  const submitter      = match.submittedBy;
  const other          = submitter === match.playerA ? match.playerB : match.playerA;
  const submitterScore = scoreOf[submitter] ?? 0;
  const otherScore     = scoreOf[other]     ?? 0;

  let confirmedWinner;
  if (submitterScore > otherScore)      confirmedWinner = submitter;
  else if (otherScore > submitterScore) confirmedWinner = other;
  else                                  confirmedWinner = "draw";

  // Non-submitter = rage quit — penalty applied, NO clean match reward
  const nonSubmitterRef = db.collection("users").doc(other);
  const nonSubmitterDoc = await t.get(nonSubmitterRef);
  if (nonSubmitterDoc.exists) {
    const nsData = { ...nonSubmitterDoc.data(), rageQuits: inc(nonSubmitterDoc.data().rageQuits) };
    t.update(nonSubmitterRef, { rageQuits: inc(nonSubmitterDoc.data().rageQuits) });
    applyTrustUpdate(t, nonSubmitterRef, nsData);
  }

  // distributeReward will apply clean match reward to both players normally
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
  if (match.status === "cancelled" || match.status === "completed") { alreadyDone = true; return; }
  if (match.status !== "active")
    throw new Error(`Cannot auto-cancel — status is "${match.status}"`);
  if (hasSubmittedResult(match))
    throw new Error("Result submitted — use auto-resolve");

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);
  if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");

  t.update(playerA_Ref, { coins: inc(playerA_Doc.data().coins, match.entryFee) });
  t.update(playerB_Ref, { coins: inc(playerB_Doc.data().coins, match.entryFee) });

  // Both abandoned — rage quit penalty for both, NO clean match reward
  const aUpdated = { ...playerA_Doc.data(), rageQuits: inc(playerA_Doc.data().rageQuits) };
  const bUpdated = { ...playerB_Doc.data(), rageQuits: inc(playerB_Doc.data().rageQuits) };
  t.update(playerA_Ref, { rageQuits: inc(playerA_Doc.data().rageQuits) });
  t.update(playerB_Ref, { rageQuits: inc(playerB_Doc.data().rageQuits) });
  applyTrustUpdate(t, playerA_Ref, aUpdated);
  applyTrustUpdate(t, playerB_Ref, bUpdated);

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
  if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
  if (match.status !== "completed")  throw new Error("Match not completed");
  if (match.rematchRequestedBy)      throw new Error("Rematch already requested");
  if ((userDoc.data().coins ?? 0) < match.entryFee) throw new Error("Insufficient coins for rematch");

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
  if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
  if (match.rematchStatus !== "pending")   throw new Error("No pending rematch");
  if (match.rematchRequestedBy === uid)    throw new Error("Cannot accept own rematch request");

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);

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
    disputeId:          null,
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
// REPORT PLAYER
// ─────────────────────────────────────────
app.post("/report", verifyToken, async (req, res) => {
const { reportedUid, description } = req.body;
const reporterUid = req.user.uid;

if (!reportedUid || !description)
return res.status(400).json({ error: "reportedUid and description required" });
if (reportedUid === reporterUid)
return res.status(400).json({ error: "You cannot report yourself" });

try {
const reportRef = db.collection("reports").doc();
await reportRef.set({
id:          reportRef.id,
reporterUid,
reportedUid,
description: description.trim().substring(0, 500),
status:      "pending",
createdAt:   admin.firestore.FieldValue.serverTimestamp(),
});

db.collection("users").doc(reportedUid).get().then((doc) => {
  if (!doc.exists) return;
  const data    = doc.data();
  const updated = { ...data, reportsReceived: inc(data.reportsReceived) };
  doc.ref.update({ reportsReceived: inc(data.reportsReceived) });
  doc.ref.set({
    trustScore:          computeTrustScore(updated),
    matchCompletionRate: computeCompletionRate(updated),
    fairPlayRating:      computeFairPlayRating(updated),
    trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}).catch(console.error);

res.json({ message: "Report submitted" });

} catch (err) {
console.error("[report]", err.message);
res.status(500).json({ error: err.message });
}
});

app.get("/leaderboard", verifyToken, async (req, res) => {
try {
const snap = await db.collection("users").orderBy("wins", "desc").limit(20).get();
const leaderboard = snap.docs.map((doc, i) => {
const d = doc.data();
return {
rank:         i + 1,
uid:          d.uid,
displayName:  d.displayName  ?? "Player",
wins:         d.wins         ?? 0,
losses:       d.losses       ?? 0,
totalMatches: d.totalMatches ?? 0,
avatar:       d.avatar       ?? null,
trustScore:   d.trustScore   ?? 80,
};
});
res.json(leaderboard);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

const PORT   = process.env.PORT || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
console.log(`🚀 Duelix backend running on port ${PORT}`);
});
server.on("error", (err) => console.error("❌ Server error:", err));