process.on("uncaughtException", (err) => {
  console.error(" UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error(" UNHANDLED REJECTION:", err);
});

const express    = require("express");
const cors       = require("cors");
const dotenv     = require("dotenv");
dotenv.config();

const { admin, db } = require("./firebase");
const verifyToken   = require("./middleware/verifyToken");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/** Safe integer increment — never NaN */
const inc = (current, by = 1) => (Number(current) || 0) + by;

/** 90/10 split — returns winner payout */
const winnerPayout = (entryFee) => Math.floor(entryFee * 2 * 0.9);
const platformCut  = (entryFee) => Math.floor(entryFee * 2 * 0.1);

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────

app.get("/", (_req, res) => res.send("Duelix backend is live "));
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

    // ⚠️  TODO: hash password before storing (bcrypt recommended)
    await userRef.set({
      uid:          phone,
      phone,
      password,                          // plain-text — hash this in production
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
    // ⚠️  TODO: compare hashed password (bcrypt.compare)
    if (user.password !== password)
      return res.status(401).json({ error: "Wrong password" });

    const token = await admin.auth().createCustomToken(phone);
    res.json({ message: "Login successful", token, uid: phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚠️  This endpoint has no auth — anyone who knows a phone number
//     can reset that account’s password. Add verifyToken + ownership
//     check before deploying to production.
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

// ═══════════════════════════════════════════════════════════════
// COINS (standalone utility endpoints)
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
// ═══════════════════════════════════════════════════════════════

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
const isYesterday =
lastLogin.getFullYear() === yesterday.getFullYear() &&
lastLogin.getMonth()    === yesterday.getMonth()    &&
lastLogin.getDate()     === yesterday.getDate();
streak = isYesterday ? streak + 1 : 1;
} else {
streak = 1;
}

const coinsToAdd = streak % 7 === 0 ? 50 : 10;

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
// Single-submission flow:
//   1. Creator creates match      → coins deducted immediately
//   2. Opponent joins match       → coins deducted immediately
//   3. ONE player submits result  → locked, other player notified
//   4. Other player confirms      → reward distributed
//      OR disputes               → match flagged for review
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// CREATE MATCH
// Deducts entry fee from creator atomically.
// ─────────────────────────────────────────
app.post("/matches/create", verifyToken, async (req, res) => {
const { game, entryFee } = req.body;
const uid = req.user.uid;

if (!game || !entryFee || entryFee <= 0)
return res.status(400).json({ error: "game and entryFee required" });

try {
let matchId;

await db.runTransaction(async (t) => {
const userRef = db.collection("users").doc(uid);
const userDoc = await t.get(userRef);
if (!userDoc.exists) throw new Error("User not found");

const coins = userDoc.data().coins ?? 0;
if (coins < entryFee)
throw new Error("Insufficient coins");

const matchRef = db.collection("matches").doc();
matchId = matchRef.id;

// Deduct entry fee
t.update(userRef, { coins: coins - entryFee });

// Create match document
t.set(matchRef, {
id:               matchId,
playerA:          uid,
playerB:          null,
game,
entryFee,
status:           "waiting",
// Single-submission fields
result:           null,
submittedBy:      null,
confirmedWinner:  null,
rewarded:         false,
createdAt:        admin.firestore.FieldValue.serverTimestamp(),
startedAt:        null,
});
});

res.json({ matchId });
} catch (err) {
res.status(400).json({ error: err.message });
}
});

// ─────────────────────────────────────────
// Returns waiting + active matches.
// Flutter filters client-side by game/status.
// ─────────────────────────────────────────
app.get("/matches", verifyToken, async (req, res) => {
  try {
    const [waitingSnap, activeSnap] = await Promise.all([
      db.collection("matches").where("status", "==", "waiting").get(),
      db.collection("matches").where("status", "==", "active").get(),
    ]);

    const matches = [
      ...waitingSnap.docs.map(d => d.data()),
      ...activeSnap.docs.map(d => d.data()),
    ];

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// JOIN MATCH
// Deducts entry fee from joiner atomically.
// Sets playerB, status → active, startedAt.
// ─────────────────────────────────────────
app.post("/matches/join", verifyToken, async (req, res) => {
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
      if (!userDoc.exists) throw new Error("User not found");

      const match = matchDoc.data();
      const coins = userDoc.data().coins ?? 0;

      if (match.status !== "waiting")    throw new Error("Match no longer available");
      if (match.playerA === uid)         throw new Error("Cannot join your own match");
      if (coins < match.entryFee)        throw new Error("Insufficient coins");

      // Deduct joiner's entry fee
      t.update(userRef, { coins: coins - match.entryFee });

      // Activate match
      t.update(matchRef, {
        playerB:   uid,
        status:    "active",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ message: "Joined match successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// CANCEL MATCH
// Only creator can cancel, only if no opponent.
// Refunds entry fee to creator.
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
      if (match.playerB)
        throw new Error("Cannot cancel — opponent has already joined");
      if (match.status !== "waiting")
        throw new Error("Match cannot be cancelled at this stage");

      const userRef = db.collection("users").doc(uid);
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      // Refund entry fee
      t.update(userRef, { coins: inc(userDoc.data().coins, match.entryFee) });

      // Mark cancelled
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
// SUBMIT RESULT (single submission — locked)
// Only one player submits. If already submitted,
// the endpoint rejects the second call.
// The other player must then confirm or dispute.
// ─────────────────────────────────────────
app.post("/matches/submit-result", verifyToken, async (req, res) => {
  const { matchId, myScore, opponentScore } = req.body;
  const uid = req.user.uid;

  if (!matchId || myScore === undefined || opponentScore === undefined)
    return res.status(400).json({ error: "matchId, myScore, opponentScore required" });

  if (myScore === opponentScore)
    return res.status(400).json({ error: "Scores cannot be equal" });

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
      if (match.submittedBy)
        throw new Error("Result already submitted — waiting for opponent to confirm");

      t.update(matchRef, {
        result: {
          myScore,
          opponentScore,
          // Store absolute scores keyed by player for backend confirm logic
          scoreOf: {
            [uid]: myScore,
            [uid === match.playerA ? match.playerB : match.playerA]: opponentScore,
          },
        },
        submittedBy:  uid,
        submittedAt:  admin.firestore.FieldValue.serverTimestamp(),
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
// Agrees with the submitted scores → reward paid.
// Any conflict → mark disputed instead.
//
// Flutter sends:
//   { matchId, myScore, opponentScore }
//   (mirrored from the submitter’s result)
//
// Backend validates the confirmer is not the submitter,
// then distributes reward atomically.
// ─────────────────────────────────────────
app.post("/matches/confirm-result", verifyToken, async (req, res) => {
  const { matchId, myScore, opponentScore } = req.body;
  const uid = req.user.uid;

  if (!matchId || myScore === undefined || opponentScore === undefined)
    return res.status(400).json({ error: "matchId, myScore, opponentScore required" });

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
      if (!match.submittedBy)
        throw new Error("No result has been submitted yet");
      if (match.submittedBy === uid)
        throw new Error("You submitted the result — wait for your opponent to confirm");

      // Determine winner from the original submission's absolute scores
      const submitter      = match.submittedBy;
      const confirmer      = uid;
      const submitterScore = match.result.scoreOf[submitter];
      const confirmerScore = match.result.scoreOf[confirmer];

      let confirmedWinner;
      if      (submitterScore > confirmerScore) confirmedWinner = submitter;
      else if (confirmerScore > submitterScore) confirmedWinner = confirmer;
      else                                      confirmedWinner = "draw";

      const playerA_Ref = db.collection("users").doc(match.playerA);
      const playerB_Ref = db.collection("users").doc(match.playerB);
      const [playerA_Doc, playerB_Doc] = await Promise.all([
        t.get(playerA_Ref),
        t.get(playerB_Ref),
      ]);

      if (!playerA_Doc.exists || !playerB_Doc.exists)
        throw new Error("Player data not found");

      const payout   = winnerPayout(match.entryFee);
      const platform = platformCut(match.entryFee);

      if (confirmedWinner === "draw") {
        // Refund both
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
        const loser       = confirmedWinner === match.playerA ? match.playerB : match.playerA;
        const winner_Ref   = db.collection("users").doc(confirmedWinner);
        const loser_Ref    = db.collection("users").doc(loser);
        const winner_Doc   = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
        const loser_Doc    = loser           === match.playerA ? playerA_Doc : playerB_Doc;

        // Pay winner
        t.update(winner_Ref, {
          coins:        inc(winner_Doc.data().coins, payout),
          wins:         inc(winner_Doc.data().wins),
          totalMatches: inc(winner_Doc.data().totalMatches),
        });

        // Update loser stats (no coins — already deducted on join)
        t.update(loser_Ref, {
          losses:       inc(loser_Doc.data().losses),
          totalMatches: inc(loser_Doc.data().totalMatches),
        });

        // Platform earnings
        const platformRef = db.collection("platform").doc("earnings");
        const platformDoc = await t.get(platformRef);
        t.set(platformRef, {
          totalCoins:  inc(platformDoc.exists ? platformDoc.data().totalCoins : 0, platform),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    // Finalise match
    t.update(matchRef, {
      status:          "completed",
      confirmedWinner,
      rewarded:        true,
      rewardPaid:      confirmedWinner === "draw" ? 0 : payout,
      platformFee:     confirmedWinner === "draw" ? 0 : platform,
      confirmedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DISPUTE
// Called by either player.
// Marks the match as disputed.
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

    // Write dispute log + update match atomically
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
// uid from token — not from URL param.
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
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Duelix backend running on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("❌ Server error:", err);
});