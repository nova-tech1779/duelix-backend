process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load env FIRST
dotenv.config();

const { admin, db } = require("./firebase");
const verifyToken = require("./middleware/verifyToken");

const app = express();

// ✅ CORS for web support
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ===============================
// 🔥 HEALTH CHECK
// ===============================

app.get("/health", (req, res) => {
  res.json({ status: "Duelix backend is running" });
});

// ===============================
// 🔥 ROOT ROUTE (IMPORTANT FOR RAILWAY)
// ===============================
app.get("/", (req, res) => {
  res.send("Duelix backend is live 🚀");
});

// ===============================
// 🔥 AUTH SYSTEM
// ===============================

app.post("/register", async (req, res) => {
  const { phone, password, displayName } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: "Phone and password required" });
  }

  try {
    const userRef = db.collection("users").doc(phone);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      return res.status(400).json({ error: "User already exists" });
    }

    await userRef.set({
      uid: phone,
      phone,
      password,
      displayName: displayName || "Player",
      coins: 100,
      wins: 0,
      losses: 0,
      draws: 0,
      totalMatches: 0,
      loginStreak: 0,
      lastLogin: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Registered successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/login", async (req, res) => {
  const { phone, password } = req.body;

  try {
    const userRef = db.collection("users").doc(phone);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = userDoc.data();

    if (user.password !== password) {
      return res.status(400).json({ error: "Wrong password" });
    }

    const token = await admin.auth().createCustomToken(phone);

    res.json({
      message: "Login successful",
      token,
      uid: phone,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/reset-password-direct", async (req, res) => {
  const { phone, newPassword } = req.body;

  try {
    const userRef = db.collection("users").doc(phone);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(400).json({ error: "User not found" });
    }

    await userRef.update({ password: newPassword });
    res.json({ message: "Password reset successful" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 🔥 USER SYSTEM
// ===============================

app.get("/user/:uid", verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(userDoc.data());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/user-exists/:uid", async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();
    res.json({ exists: userDoc.exists });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/update-name", verifyToken, async (req, res) => {
  const { displayName } = req.body;

  try {
    await db.collection("users").doc(req.user.uid).update({ displayName });
    res.json({ message: "Name updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 🔥 COIN SYSTEM
// ===============================

app.get("/coins/:uid", verifyToken, async (req, res) => {
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();
    res.json({ coins: userDoc.data()?.coins ?? 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/deduct-entry", verifyToken, async (req, res) => {
  const { amount } = req.body;
  const uid = req.user.uid;

  try {
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const currentCoins = userDoc.data().coins;
      if (currentCoins < amount) throw new Error("Insufficient coins");

      t.update(userRef, { coins: currentCoins - amount });
    });

    res.json({ message: "Coins deducted" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/add-coins", verifyToken, async (req, res) => {
  const { amount } = req.body;
  const uid = req.user.uid;

  try {
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const currentCoins = userDoc.data().coins;
      t.update(userRef, { coins: currentCoins + amount });
    });

    res.json({ message: "Coins added" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/reset-account", verifyToken, async (req, res) => {
  const { coins } = req.body;
  const uid = req.user.uid;

  try {
    await db.collection("users").doc(uid).update({
      coins: coins ?? 100,
      wins: 0,
      losses: 0,
      draws: 0,
      totalMatches: 0,
    });

    res.json({ message: "Account reset" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 🔥 DAILY REWARD SYSTEM
// ===============================

app.post("/claim-daily-reward", verifyToken, async (req, res) => {
  const uid = req.user.uid;

  try {
    const userRef = db.collection("users").doc(uid);
    let rewardData = {};

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const user = userDoc.data();
      const now = new Date();
      const lastLogin = user.lastLogin?.toDate?.() ?? null;

      if (lastLogin) {
        const isSameDay =
          lastLogin.getFullYear() === now.getFullYear() &&
          lastLogin.getMonth() === now.getMonth() &&
          lastLogin.getDate() === now.getDate();

        if (isSameDay) throw new Error("Already claimed today");
      }

      let streak = user.loginStreak ?? 0;

      if (lastLogin) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);

        const isYesterday =
          lastLogin.getFullYear() === yesterday.getFullYear() &&
          lastLogin.getMonth() === yesterday.getMonth() &&
          lastLogin.getDate() === yesterday.getDate();

        streak = isYesterday ? streak + 1 : 1;
      } else {
        streak = 1;
      }

      const coinsToAdd = streak % 7 === 0 ? 50 : 10;
      const currentCoins = user.coins ?? 0;

      t.update(userRef, {
        coins: currentCoins + coinsToAdd,
        loginStreak: streak,
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });

      rewardData = { coinsToAdd, streak };
    });

    res.json({
      message: "Daily reward claimed",
      coinsAdded: rewardData.coinsToAdd,
      streak: rewardData.streak,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ===============================
// 🔥 MATCH SYSTEM
// ===============================

app.post("/create-match", verifyToken, async (req, res) => {
  const { game, entryFee } = req.body;
  const uid = req.user.uid;

  try {
    const matchRef = db.collection("matches").doc();

    await matchRef.set({
      id: matchRef.id,
      playerA: uid,
      playerB: null,
      game,
      entryFee,
      status: "waiting",
      rewarded: false,
      resultA: null,
      resultB: null,
      confirmedWinner: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ matchId: matchRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/matches", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("matches")
      .where("status", "==", "waiting")
      .get();

    const matches = snapshot.docs.map(doc => doc.data());
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/join-match", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid = req.user.uid;

  try {
    const matchRef = db.collection("matches").doc(matchId);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.status !== "waiting") throw new Error("Match already started");
      if (match.playerA === uid) throw new Error("Cannot join your own match");

      t.update(matchRef, {
        playerB: uid,
        status: "active",
      });
    });

    res.json({ message: "Joined match successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ===============================
// 🔥 RESULT SYSTEM
// ===============================

app.post("/submit-result", verifyToken, async (req, res) => {
  const { matchId, myScore, opponentScore } = req.body;
  const uid = req.user.uid;

  try {
    const matchRef = db.collection("matches").doc(matchId);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();

      if (match.playerA !== uid && match.playerB !== uid) {
        throw new Error("You are not in this match");
      }

      if (match.status === "completed" || match.status === "disputed") {
        throw new Error("Match already finished");
      }

      const isPlayerA = match.playerA === uid;
      const submissionField = isPlayerA ? "resultA" : "resultB";

      t.update(matchRef, {
        [submissionField]: { myScore, opponentScore },
      });

      const otherResult = isPlayerA ? match.resultB : match.resultA;

      if (otherResult) {
        const scoresMatch =
          myScore === otherResult.opponentScore &&
          opponentScore === otherResult.myScore;

        if (scoresMatch) {
          let confirmedWinner;

          if (myScore > opponentScore) {
            confirmedWinner = uid;
          } else if (opponentScore > myScore) {
            confirmedWinner = isPlayerA ? match.playerB : match.playerA;
          } else {
            confirmedWinner = "draw";
          }

          const playerARef = db.collection("users").doc(match.playerA);
          const playerBRef = db.collection("users").doc(match.playerB);
          const playerADoc = await t.get(playerARef);
          const playerBDoc = await t.get(playerBRef);

          if (confirmedWinner === "draw") {
            t.update(playerARef, {
              draws: (playerADoc.data().draws ?? 0) + 1,
              totalMatches: (playerADoc.data().totalMatches ?? 0) + 1,
            });
            t.update(playerBRef, {
              draws: (playerBDoc.data().draws ?? 0) + 1,
              totalMatches: (playerBDoc.data().totalMatches ?? 0) + 1,
            });
          } else {
            const loser = confirmedWinner === match.playerA
              ? match.playerB
              : match.playerA;

            const winnerRef = db.collection("users").doc(confirmedWinner);
            const loserRef = db.collection("users").doc(loser);
            const winnerDoc = confirmedWinner === match.playerA
              ? playerADoc : playerBDoc;
            const loserDoc = loser === match.playerA
              ? playerADoc : playerBDoc;

            t.update(winnerRef, {
              wins: (winnerDoc.data().wins ?? 0) + 1,
              totalMatches: (winnerDoc.data().totalMatches ?? 0) + 1,
            });
            t.update(loserRef, {
              losses: (loserDoc.data().losses ?? 0) + 1,
              totalMatches: (loserDoc.data().totalMatches ?? 0) + 1,
            });
          }

          t.update(matchRef, {
            status: "completed",
            confirmedWinner,
          });

        } else {
          t.update(matchRef, { status: "disputed" });
        }
      }
    });

    res.json({ message: "Result submitted" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ===============================
// 🔥 REWARD WINNER (90/10 SPLIT)
// ===============================

app.post("/reward-winner", verifyToken, async (req, res) => {
  const { matchId } = req.body;

  try {
    const matchRef = db.collection("matches").doc(matchId);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.rewarded) throw new Error("Already rewarded");
      if (!match.confirmedWinner) throw new Error("No confirmed winner yet");

      const totalPot = match.entryFee * 2;
      const platformFee = Math.floor(totalPot * 0.10);
      const reward = totalPot - platformFee;

      if (match.confirmedWinner === "draw") {
        const playerARef = db.collection("users").doc(match.playerA);
        const playerBRef = db.collection("users").doc(match.playerB);
        const playerADoc = await t.get(playerARef);
        const playerBDoc = await t.get(playerBRef);

        t.update(playerARef, {
          coins: (playerADoc.data().coins ?? 0) + match.entryFee,
        });
        t.update(playerBRef, {
          coins: (playerBDoc.data().coins ?? 0) + match.entryFee,
        });
      } else {
        const winnerRef = db.collection("users").doc(match.confirmedWinner);
        const winnerDoc = await t.get(winnerRef);

        t.update(winnerRef, {
          coins: (winnerDoc.data().coins ?? 0) + reward,
        });

        const platformRef = db.collection("platform").doc("earnings");
        const platformDoc = await t.get(platformRef);
        const currentEarnings = platformDoc.exists
          ? platformDoc.data().totalCoins ?? 0
          : 0;

        t.set(platformRef, {
          totalCoins: currentEarnings + platformFee,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      t.update(matchRef, {
        rewarded: true,
        platformFee,
        rewardPaid: reward,
      });
    });

    res.json({ message: "Winner rewarded" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ===============================
// 🔥 DISPUTE SYSTEM
// ===============================

app.post("/dispute", verifyToken, async (req, res) => {
  const { matchId, reason } = req.body;

  try {
    await db.collection("disputes").add({
      matchId,
      reportedBy: req.user.uid,
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("matches").doc(matchId).update({
      status: "disputed",
    });

    res.json({ message: "Dispute submitted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 🔥 MATCH HISTORY
// ===============================

app.get("/match-history/:uid", verifyToken, async (req, res) => {
  const uid = req.params.uid;

  try {
    const snapshotA = await db.collection("matches")
      .where("playerA", "==", uid)
      .where("status", "==", "completed")
      .get();

    const snapshotB = await db.collection("matches")
      .where("playerB", "==", uid)
      .where("status", "==", "completed")
      .get();

    const history = [
      ...snapshotA.docs.map(doc => doc.data()),
      ...snapshotB.docs.map(doc => doc.data()),
    ].sort((a, b) => {
      const aTime = a.createdAt?._seconds ?? 0;
      const bTime = b.createdAt?._seconds ?? 0;
      return bTime - aTime;
    });

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
const PORT = process.env.PORT;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Duelix backend running on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("❌ Server error:", err);
});