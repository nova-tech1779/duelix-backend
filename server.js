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
  return "DUEL-" + Date.now().toString(36).toUpperCase().slice(-6);
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

function validateScore(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(label + " must be a non-negative integer");
  }
}

function hasSubmittedResult(match) {
  return match.submittedBy != null;
}

// ─────────────────────────────────────────
// TRUST SYSTEM
// ─────────────────────────────────────────

const CLEAN_MATCH_TRUST_BONUS    = 2;
const CLEAN_MATCH_FAIRPLAY_BONUS = 0.5;

function computeTrustScore(data) {
  const rageQuits        = Number(data.rageQuits)        || 0;
  const fakeResults      = Number(data.fakeResults)      || 0;
  const disputesLost     = Number(data.disputesLost)     || 0;
  const cancelledMatches = Number(data.cancelledMatches) || 0;
  const reportsReceived  = Number(data.reportsReceived)  || 0;
  const cleanMatchBonus  = Number(data.cleanMatchBonus)  || 0;

  const raw = 80
    - (rageQuits        * 10)
    - (fakeResults      * 20)
    - (disputesLost     *  8)
    - (cancelledMatches *  3)
    - (reportsReceived  *  2)
    + cleanMatchBonus;

  return Math.max(0, Math.min(100, Math.round(raw)));
}

function computeCompletionRate(data) {
  const total     = Number(data.totalMatches)     || 0;
  const completed = Number(data.completedMatches) || 0;
  if (total === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function computeFairPlayRating(data) {
  const fakeResults   = Number(data.fakeResults)   || 0;
  const disputesLost  = Number(data.disputesLost)  || 0;
  const rageQuits     = Number(data.rageQuits)     || 0;
  const fairPlayBonus = Number(data.fairPlayBonus) || 0;

  const base = 100
    - (fakeResults  * 20)
    - (disputesLost * 10)
    - (rageQuits    *  5)
    + fairPlayBonus;

  return Math.max(0, Math.min(100, Math.round(base)));
}

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
  cleanMatchBonus:     0,
  fairPlayBonus:       0,
  onlineStatus:        true,
  friendRequests:      true,
};

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
    userRef.update(fields).catch((err) => {
      console.error("[applyTrustUpdate standalone]", err.message);
    });
  }
}

function applyCleanMatchReward(t, userRef, userData) {
  const newCleanMatchBonus = (Number(userData.cleanMatchBonus) || 0) + CLEAN_MATCH_TRUST_BONUS;
  const newFairPlayBonus   = (Number(userData.fairPlayBonus)   || 0) + CLEAN_MATCH_FAIRPLAY_BONUS;

  const updatedData = Object.assign({}, userData, {
    cleanMatchBonus: newCleanMatchBonus,
    fairPlayBonus:   newFairPlayBonus,
  });

  const score      = computeTrustScore(updatedData);
  const completion = computeCompletionRate(updatedData);
  const fairPlay   = computeFairPlayRating(updatedData);

  t.update(userRef, {
    cleanMatchBonus:     newCleanMatchBonus,
    fairPlayBonus:       newFairPlayBonus,
    trustScore:          score,
    matchCompletionRate: completion,
    fairPlayRating:      fairPlay,
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
    console.warn("[dispute] Non-standard reason: \"" + trimmed + "\" -- accepted");
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

// ═══════════════════════════════════════════════════════════════
// FCM PUSH HELPER
// ═══════════════════════════════════════════════════════════════
async function sendPushNotification(userId, title, body, data) {
  if (!userId || typeof userId !== "string") return;

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken || typeof fcmToken !== "string") return;

    const safeData = {};
    if (data && typeof data === "object") {
      Object.keys(data).forEach((k) => {
        const v = data[k];
        if (v != null) safeData[k] = String(v);
      });
    }
    safeData.type         = safeData.type || "general";
    safeData.click_action = "FLUTTER_NOTIFICATION_CLICK";

    const message = {
      token: fcmToken,
      notification: {
        title: String(title || ""),
        body:  String(body  || ""),
      },
      data: safeData,
      android: {
        priority: "high",
        notification: {
          sound:        "default",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1,
          },
        },
      },
      webpush: {
        notification: {
          icon:    "/icons/icon-192x192.png",
          badge:   "/icons/badge-72x72.png",
          vibrate: [200, 100, 200],
        },
        fcm_options: {
          link: "https://duelix-app.web.app",
        },
      },
    };

    await admin.messaging().send(message);
    console.log("[sendPush] sent uid=" + userId);

  } catch (err) {
    const staleErrors = [
      "messaging/registration-token-not-registered",
      "messaging/invalid-registration-token",
    ];
    const code = err.errorInfo && err.errorInfo.code ? err.errorInfo.code : "";
    if (staleErrors.includes(code)) {
      console.warn("[sendPush] stale token cleared for uid=" + userId);
      db.collection("users").doc(userId)
        .update({ fcmToken: admin.firestore.FieldValue.delete() })
        .catch((e) => console.error("[sendPush] token cleanup error:", e.message));
    } else {
      console.error("[sendPush] uid=" + userId + " err=" + err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════

function notificationFilterTag(type) {
  const matchTypes = [
    "match_found", "match_joined", "match_created", "match_cancelled",
    "match_refunded", "match_result_submitted", "match_result_confirmed",
    "match_won", "match_lost", "match_draw", "match_auto_resolved",
    "match_auto_cancelled", "match_dispute_opened", "match_dispute_resolved",
    "rematch_requested", "rematch_accepted", "rematch_declined", "match_result",
  ];
  const rewardTypes = [
    "coins_added", "daily_reward", "reward_payout",
    "purchase_successful", "redeem_successful", "reward",
  ];
  const socialTypes   = ["friend_request", "friend_accepted", "chat_message"];
  const referralTypes = ["referral"];
  if (matchTypes.includes(type))    return "match";
  if (rewardTypes.includes(type))   return "reward";
  if (socialTypes.includes(type))   return "social";
  if (referralTypes.includes(type)) return "referral";
  return "system";
}

async function createNotification(userId, type, title, message, meta) {
  if (!userId || typeof userId !== "string") return;
  const safeMeta = (meta && typeof meta === "object") ? meta : {};
  try {
    const ref = db.collection("notifications").doc();
    await ref.set({
      id:        ref.id,
      userId,
      type,
      filterTag: notificationFilterTag(type),
      title,
      message,
      isRead:    false,
      pushSent:  false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta:      safeMeta,
    });
  } catch (err) {
    console.error("[createNotification] type=" + type + " uid=" + userId + " err=" + err.message);
  }
}

async function notifyUser(userId, type, title, message, meta) {
  await createNotification(userId, type, title, message, meta || {});
  const pushData = Object.assign({}, (meta && typeof meta === "object") ? meta : {}, { type });
  await sendPushNotification(userId, title, message, pushData);
}

async function notifyPushOnly(userId, title, body, data) {
  if (!userId || typeof userId !== "string") return;
  await sendPushNotification(userId, title, body, data || {});
}

async function notifyMultipleUsers(userIds, type, title, message, meta) {
  if (!Array.isArray(userIds)) return;
  await Promise.all(
    userIds
      .filter((uid) => uid && typeof uid === "string")
      .map((uid) => notifyUser(uid, type, title, message, meta || {}))
  );
}

function notifyMatchCreated(userId, matchId, game, entryFee) {
  return notifyUser(
    userId,
    "match_created",
    "Match created! ⚔️",
    "Your " + game + " match (entry: " + entryFee + " coins) is live and waiting for an opponent.",
    { matchId: matchId, game: game, entryFee: entryFee }
  );
}

function notifyMatchJoined(playerAUid, playerBUid, matchId, game) {
  return notifyMultipleUsers(
    [playerAUid, playerBUid],
    "match_joined",
    "Match started! 🎮",
    "Your " + game + " match has started. Good luck!",
    { matchId: matchId, game: game }
  );
}

function notifyResultSubmitted(opponentUid, matchId) {
  return notifyUser(
    opponentUid,
    "match_result_submitted",
    "Result submitted ⏳",
    "Your opponent submitted a result. Confirm within 3 minutes or the match will be auto-resolved.",
    { matchId: matchId }
  );
}

function notifyMatchWon(userId, matchId, coinsWon) {
  return notifyUser(
    userId,
    "match_won",
    "Victory! 🏆",
    "You won your match. +" + coinsWon + " coins added to your account.",
    { matchId: matchId, coinsWon: coinsWon }
  );
}

function notifyMatchLost(userId, matchId, coinsBack) {
  return notifyUser(
    userId,
    "match_lost",
    "Match over 😔",
    "You lost this match. You received " + coinsBack + " coins back. Keep going!",
    { matchId: matchId, coinsBack: coinsBack }
  );
}

function notifyMatchDraw(userId, matchId, coinsBack) {
  return notifyUser(
    userId,
    "match_draw",
    "It's a draw! 🤝",
    "Match ended in a draw. Your entry fee of " + coinsBack + " coins has been refunded.",
    { matchId: matchId, coinsBack: coinsBack }
  );
}

function notifyMatchCancelled(userId, matchId, refund) {
  return notifyUser(
    userId,
    "match_cancelled",
    "Match cancelled ❌",
    "Your match was cancelled. " + refund + " coins have been refunded.",
    { matchId: matchId, refund: refund }
  );
}

function notifyAutoCancelled(userId, matchId, refund) {
  return notifyUser(
    userId,
    "match_auto_cancelled",
    "Match auto-cancelled ⚡",
    "Your match expired with no result submitted. " + refund + " coins refunded.",
    { matchId: matchId, refund: refund }
  );
}

function notifyAutoResolved(userId, matchId, outcome) {
  return notifyUser(
    userId,
    "match_auto_resolved",
    "Match auto-resolved ⚡",
    "Your match was resolved automatically. Outcome: " + outcome + ".",
    { matchId: matchId, outcome: outcome }
  );
}

function notifyDisputeOpened(userId, matchId) {
  return notifyUser(
    userId,
    "match_dispute_opened",
    "Dispute opened ⚠️",
    "A dispute has been raised for your match. Our review team will investigate shortly.",
    { matchId: matchId }
  );
}

function notifyDisputeResolved(userId, matchId, outcome) {
  return notifyUser(
    userId,
    "match_dispute_resolved",
    "Dispute resolved 🛡️",
    "Your match dispute has been resolved. Outcome: " + outcome + ".",
    { matchId: matchId, outcome: outcome }
  );
}

function notifyRematchRequested(opponentUid, matchId) {
  return notifyUser(
    opponentUid,
    "rematch_requested",
    "Rematch requested 🔄",
    "Your opponent wants a rematch. Accept or decline in the match room.",
    { matchId: matchId }
  );
}

function notifyRematchAccepted(userId, matchId) {
  return notifyUser(
    userId,
    "rematch_accepted",
    "Rematch accepted 🎮",
    "Your rematch has started. Good luck!",
    { matchId: matchId }
  );
}

function notifyRematchDeclined(userId, matchId) {
  return notifyUser(
    userId,
    "rematch_declined",
    "Rematch declined 🚫",
    "Your opponent declined the rematch request.",
    { matchId: matchId }
  );
}

function notifyDailyReward(userId, coins, streak) {
  return notifyUser(
    userId,
    "daily_reward",
    "Daily reward claimed! 💰",
    "You claimed " + coins + " coins. You are on a " + streak + " day streak -- keep it up!",
    { coins: coins, streak: streak }
  );
}

function notifyReferralBonus(userId, bonusCoins, referrerName) {
  return notifyUser(
    userId,
    "referral",
    "Referral bonus unlocked! 🎁",
    "You used " + referrerName + "'s referral code and earned +" + bonusCoins + " bonus coins. Welcome to Duelix!",
    { bonusCoins: bonusCoins, referrerName: referrerName, event: "new_user_bonus" }
  );
}

function notifyReferrerReward(referrerUid, rewardCoins, newUserName) {
  return notifyUser(
    referrerUid,
    "referral",
    "Someone used your code! 🎉",
    newUserName + " just signed up with your referral code. You earned +" + rewardCoins + " coins!",
    { rewardCoins: rewardCoins, newUserName: newUserName, event: "referrer_reward" }
  );
}

function notifyChatMessage(recipientUid, senderName, matchId, preview) {
  const safePreview = typeof preview === "string" && preview.length > 0
    ? (preview.length > 60 ? preview.substring(0, 57) + "..." : preview)
    : "Sent you a message";
  return notifyPushOnly(
    recipientUid,
    senderName + " 💬",
    safePreview,
    { matchId: matchId, senderName: senderName, type: "chat_message" }
  );
}

function notifyRoomTimer(userId, matchId, alertType) {
  const titles = {
    "5min":    "5 minutes remaining ⏱️",
    "1min":    "1 minute remaining! ⏱️",
    "expired": "Match room expired ⚡",
  };
  const messages = {
    "5min":    "Your match room expires in 5 minutes. Submit your result now.",
    "1min":    "Last chance! Submit your result before the match room expires.",
    "expired": "Your match room has expired and has been auto-resolved by the system.",
  };
  return notifyPushOnly(
    userId,
    titles[alertType]   || "Match timer alert",
    messages[alertType] || "",
    { matchId: matchId, timerAlert: alertType, type: "room_timer" }
  );
}

// ─────────────────────────────────────────
// REWARD DISTRIBUTION — CONFIRM-RESULT PATH
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

  if (!playerA_Doc.exists || !playerB_Doc.exists) {
    throw new Error("Player data not found");
  }

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const aUpdated = Object.assign({}, playerA_Data, {
      completedMatches: inc(playerA_Data.completedMatches),
      totalMatches:     inc(playerA_Data.totalMatches),
    });
    const bUpdated = Object.assign({}, playerB_Data, {
      completedMatches: inc(playerB_Data.completedMatches),
      totalMatches:     inc(playerB_Data.totalMatches),
    });

    t.update(playerA_Ref, {
      coins:            inc(playerA_Data.coins, match.entryFee),
      draws:            inc(playerA_Data.draws),
      totalMatches:     inc(playerA_Data.totalMatches),
      completedMatches: inc(playerA_Data.completedMatches),
    });
    t.update(playerB_Ref, {
      coins:            inc(playerB_Data.coins, match.entryFee),
      draws:            inc(playerB_Data.draws),
      totalMatches:     inc(playerB_Data.totalMatches),
      completedMatches: inc(playerB_Data.completedMatches),
    });

    applyCleanMatchReward(t, playerA_Ref, aUpdated);
    applyCleanMatchReward(t, playerB_Ref, bUpdated);

  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();

    const winnerUpdated = Object.assign({}, winnerData, {
      completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0),
      totalMatches:     inc(winnerData.totalMatches     != null ? winnerData.totalMatches     : 0),
    });
    const loserUpdated = Object.assign({}, loserData, {
      completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0),
      totalMatches:     inc(loserData.totalMatches     != null ? loserData.totalMatches     : 0),
    });

    t.update(winnerRef, {
      coins:            inc(winnerData.coins            != null ? winnerData.coins            : 0, winner),
      wins:             inc(winnerData.wins             != null ? winnerData.wins             : 0),
      totalMatches:     inc(winnerData.totalMatches     != null ? winnerData.totalMatches     : 0),
      completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0),
    });
    t.update(loserRef, {
      coins:            inc(loserData.coins            != null ? loserData.coins            : 0, loser),
      losses:           inc(loserData.losses           != null ? loserData.losses           : 0),
      totalMatches:     inc(loserData.totalMatches     != null ? loserData.totalMatches     : 0),
      completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0),
    });

    applyCleanMatchReward(t, winnerRef, winnerUpdated);
    applyCleanMatchReward(t, loserRef,  loserUpdated);

    const platformCoins = platformDoc.exists
      ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0)
      : 0;
    t.set(platformRef, {
      totalCoins:  inc(platformCoins, plat),
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
// REWARD DISTRIBUTION — AUTO-RESOLVE PATH
// ─────────────────────────────────────────
async function distributeRewardAutoResolve(t, match, matchRef, confirmedWinner, nonSubmitterUid) {
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

  if (!playerA_Doc.exists || !playerB_Doc.exists) {
    throw new Error("Player data not found");
  }

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const aUpdated = Object.assign({}, playerA_Data, {
      completedMatches: inc(playerA_Data.completedMatches),
      totalMatches:     inc(playerA_Data.totalMatches),
    });
    const bUpdated = Object.assign({}, playerB_Data, {
      completedMatches: inc(playerB_Data.completedMatches),
      totalMatches:     inc(playerB_Data.totalMatches),
    });

    t.update(playerA_Ref, {
      coins:            inc(playerA_Data.coins, match.entryFee),
      draws:            inc(playerA_Data.draws),
      totalMatches:     inc(playerA_Data.totalMatches),
      completedMatches: inc(playerA_Data.completedMatches),
    });
    t.update(playerB_Ref, {
      coins:            inc(playerB_Data.coins, match.entryFee),
      draws:            inc(playerB_Data.draws),
      totalMatches:     inc(playerB_Data.totalMatches),
      completedMatches: inc(playerB_Data.completedMatches),
    });

    applyCleanMatchReward(t, playerA_Ref, aUpdated);
    applyCleanMatchReward(t, playerB_Ref, bUpdated);

  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();

    const winnerUpdated = Object.assign({}, winnerData, {
      completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0),
      totalMatches:     inc(winnerData.totalMatches     != null ? winnerData.totalMatches     : 0),
    });
    const loserUpdated = Object.assign({}, loserData, {
      completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0),
      totalMatches:     inc(loserData.totalMatches     != null ? loserData.totalMatches     : 0),
    });

    t.update(winnerRef, {
      coins:            inc(winnerData.coins            != null ? winnerData.coins            : 0, winner),
      wins:             inc(winnerData.wins             != null ? winnerData.wins             : 0),
      totalMatches:     inc(winnerData.totalMatches     != null ? winnerData.totalMatches     : 0),
      completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0),
    });
    t.update(loserRef, {
      coins:            inc(loserData.coins            != null ? loserData.coins            : 0, loser),
      losses:           inc(loserData.losses           != null ? loserData.losses           : 0),
      totalMatches:     inc(loserData.totalMatches     != null ? loserData.totalMatches     : 0),
      completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0),
    });

    if (confirmedWinner !== nonSubmitterUid) {
      applyCleanMatchReward(t, winnerRef, winnerUpdated);
    }
    if (loserUid !== nonSubmitterUid) {
      applyCleanMatchReward(t, loserRef, loserUpdated);
    }

    const platformCoins = platformDoc.exists
      ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0)
      : 0;
    t.set(platformRef, {
      totalCoins:  inc(platformCoins, plat),
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
app.get("/",       (_req, res) => res.send("Duelix backend is live"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ═══════════════════════════════════════════════════════════════
// SAVE FCM TOKEN
// ═══════════════════════════════════════════════════════════════
app.post("/save-fcm-token", verifyToken, async (req, res) => {
  const uid       = req.user.uid;
  const { token } = req.body;

  if (!token || typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "token is required" });
  }

  const safeToken = token.trim();

  try {
    await db.collection("users").doc(uid).update({
      fcmToken:          safeToken,
      fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[save-fcm-token] saved uid=" + uid);
    return res.json({ message: "FCM token saved" });
  } catch (err) {
    console.error("[save-fcm-token]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TRUST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post("/trust/update", verifyToken, async (req, res) => {
  const { uid }   = req.body;
  const targetUid = uid || req.user.uid;

  try {
    const userRef = db.collection("users").doc(targetUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const data  = userDoc.data();
    const score = computeTrustScore(data);

    await userRef.set({
      trustScore:          score,
      matchCompletionRate: computeCompletionRate(data),
      fairPlayRating:      computeFairPlayRating(data),
      trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log("[trust/update] uid=" + targetUid + " score=" + score);
    return res.json({ message: "Trust score updated", trustScore: score });
  } catch (err) {
    console.error("[trust/update]", err.message);
    return res.status(500).json({ error: err.message });
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
      const updatedData = Object.assign({}, data, { rageQuits: inc(data.rageQuits) });
      t.update(userRef, { rageQuits: inc(data.rageQuits) });
      applyTrustUpdate(t, userRef, updatedData);
    });
    console.log("[trust/rage-quit] uid=" + uid);
    return res.json({ message: "Rage quit recorded" });
  } catch (err) {
    console.error("[trust/rage-quit]", err.message);
    return res.status(500).json({ error: err.message });
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
      const updatedData = Object.assign({}, data, { disputesLost: inc(data.disputesLost) });
      t.update(userRef, { disputesLost: inc(data.disputesLost) });
      applyTrustUpdate(t, userRef, updatedData);
    });
    console.log("[trust/dispute-penalty] uid=" + uid);
    return res.json({ message: "Dispute penalty applied" });
  } catch (err) {
    console.error("[trust/dispute-penalty]", err.message);
    return res.status(500).json({ error: err.message });
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
      const updatedData = Object.assign({}, data, { fakeResults: inc(data.fakeResults) });
      t.update(userRef, { fakeResults: inc(data.fakeResults) });
      applyTrustUpdate(t, userRef, updatedData);
    });
    console.log("[trust/fake-result] uid=" + uid);
    return res.json({ message: "Fake result penalty applied" });
  } catch (err) {
    console.error("[trust/fake-result]", err.message);
    return res.status(500).json({ error: err.message });
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
  if (!/^\+\d{7,15}$/.test(phone)) {
    return res.status(400).json({ error: "phone must be in E.164 format (e.g. +233244123456)" });
  }
  const name = displayName.trim();
  if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) {
    return res.status(400).json({ error: "displayName: 3-20 chars, letters/numbers/underscores/dots only" });
  }

  try {
    const userRef      = db.collection("users").doc(uid);
    const referralCode = await uniqueReferralCode();

    const phoneSnap = await db.collection("users").where("phone", "==", phone).limit(1).get();
    if (!phoneSnap.empty && phoneSnap.docs[0].id !== uid) {
      return res.status(409).json({ error: "That phone number is already registered" });
    }
    const nameSnap = await db.collection("users").where("displayName", "==", name).limit(1).get();
    if (!nameSnap.empty && nameSnap.docs[0].id !== uid) {
      return res.status(409).json({ error: "That username is already taken" });
    }

    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (snap.exists) return;

      t.set(userRef, Object.assign({
        uid,
        displayName:   name,
        phone,
        email:         email != null ? email : "",
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
        fcmToken:      null,
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      }, DEFAULT_TRUST_FIELDS));
    });

    notifyUser(
      uid,
      "system",
      "Welcome to Duelix! 🎮",
      "Your account is ready. You have been given 20 coins to start. Good luck!",
      {}
    ).catch(() => {});

    return res.status(201).json({ message: "Profile created", uid, referralCode });
  } catch (err) {
    console.error("[create-profile]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// USER EXISTS CHECK
// ─────────────────────────────────────────
app.get("/user-exists/:uid", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.uid).get();
    return res.json({ exists: doc.exists });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// REFERRAL SYSTEM
// ═══════════════════════════════════════════════════════════════
app.post("/apply-referral", verifyToken, async (req, res) => {
  const currentUid      = req.user.uid;
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

    let bonusCoins   = 0;
    let referrerName = "A friend";
    let newUserName  = "A new player";

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

      bonusCoins   = 5;
      referrerName = referrerDocT.data().displayName || "A friend";
      newUserName  = currentDoc.data().displayName   || "A new player";

      t.update(currentRef, {
        coins:      inc(currentDoc.data().coins, bonusCoins),
        referredBy: referrerUid,
      });
      t.update(referrerRef, {
        coins:         inc(referrerDocT.data().coins, 5),
        referralCount: inc(referrerDocT.data().referralCount != null ? referrerDocT.data().referralCount : 0),
      });
    });

    notifyReferralBonus(currentUid, bonusCoins, referrerName).catch(() => {});
    notifyReferrerReward(referrerUid, 5, newUserName).catch(() => {});

    console.log("[apply-referral] uid=" + currentUid + " code=" + code + " newUserBonus=5 referrerBonus=5");
    return res.json({ message: "Referral applied successfully", bonusCoins });
  } catch (err) {
    if (err.message === "ALREADY_REFERRED") {
      return res.status(409).json({ error: "You have already used a referral code" });
    }
    console.error("[apply-referral]", err.message);
    return res.status(500).json({ error: err.message });
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

    if (data.trustScore === undefined) {
      const trustFields = {
        trustScore:          80,
        completedMatches:    data.completedMatches != null ? data.completedMatches : 0,
        cancelledMatches:    data.cancelledMatches != null ? data.cancelledMatches : 0,
        disputesLost:        data.disputesLost     != null ? data.disputesLost     : 0,
        reportsReceived:     data.reportsReceived  != null ? data.reportsReceived  : 0,
        fakeResults:         data.fakeResults      != null ? data.fakeResults      : 0,
        rageQuits:           data.rageQuits        != null ? data.rageQuits        : 0,
        fairPlayRating:      100,
        matchCompletionRate: 0,
        cleanMatchBonus:     0,
        fairPlayBonus:       0,
        onlineStatus:        data.onlineStatus   != null ? data.onlineStatus   : true,
        friendRequests:      data.friendRequests != null ? data.friendRequests : true,
      };
      db.collection("users").doc(req.params.uid)
        .set(trustFields, { merge: true })
        .catch((e) => console.error("[user migration]", e.message));
      return res.json(Object.assign({}, data, trustFields));
    }

    const needsPatch =
      data.cleanMatchBonus === undefined ||
      data.fairPlayBonus   === undefined;

    if (needsPatch) {
      const patch = {
        cleanMatchBonus: data.cleanMatchBonus != null ? data.cleanMatchBonus : 0,
        fairPlayBonus:   data.fairPlayBonus   != null ? data.fairPlayBonus   : 0,
      };
      db.collection("users").doc(req.params.uid)
        .set(patch, { merge: true })
        .catch((e) => console.error("[user patch]", e.message));
      return res.json(Object.assign({}, data, patch));
    }

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/update-name", verifyToken, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });

  const name = displayName.trim();
  if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) {
    return res.status(400).json({ error: "displayName: 3-20 chars, letters/numbers/underscores/dots only" });
  }

  try {
    const snap = await db
      .collection("users")
      .where("displayName", "==", name)
      .limit(1)
      .get();

    if (!snap.empty && snap.docs[0].id !== req.user.uid) {
      return res.status(409).json({ error: "That username is already taken" });
    }

    await db.collection("users").doc(req.user.uid).update({ displayName: name });
    return res.json({ message: "Username updated" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    return res.json({ message: "Avatar updated successfully" });
  } catch (err) {
    console.error("Avatar update error:", err.message);
    return res.status(500).json({ error: err.message });
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
    return res.json({ available });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// COINS
// ═══════════════════════════════════════════════════════════════

app.get("/coins/:uid", verifyToken, async (req, res) => {
  try {
    const doc   = await db.collection("users").doc(req.params.uid).get();
    const coins = doc.exists && doc.data().coins != null ? doc.data().coins : 0;
    return res.json({ coins });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/add-coins", verifyToken, async (req, res) => {
  const { amount } = req.body;
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return res.status(400).json({ error: "amount must be a positive integer" });
  }

  try {
    const userRef = db.collection("users").doc(req.user.uid);
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("User not found");
      t.update(userRef, { coins: inc(doc.data().coins, amount) });
    });
    return res.json({ message: "Coins added" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/reset-account", verifyToken, async (req, res) => {
  const { coins }  = req.body;
  const resetCoins = (coins != null && Number.isInteger(coins) && coins >= 0 && coins <= 100000)
    ? coins
    : 20;
  try {
    await db.collection("users").doc(req.user.uid).update({
      coins:        resetCoins,
      wins:         0,
      losses:       0,
      draws:        0,
      totalMatches: 0,
    });
    return res.json({ message: "Account reset" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DAILY REWARD
// ═══════════════════════════════════════════════════════════════

function getStreakReward(streak) {
  const day = ((streak - 1) % 7) + 1;
  if (day === 1) return 1;
  if (day === 2) return 1;
  if (day === 3) return 2;
  if (day === 4) return 2;
  if (day === 5) return 3;
  if (day === 6) return 3;
  return 5;
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
      const lastLogin = user.lastLogin && user.lastLogin.toDate ? user.lastLogin.toDate() : null;

      if (lastLogin) {
        const sameDay =
          lastLogin.getFullYear() === now.getFullYear() &&
          lastLogin.getMonth()    === now.getMonth()    &&
          lastLogin.getDate()     === now.getDate();
        if (sameDay) throw new Error("Already claimed today");
      }

      let streak = user.loginStreak != null ? user.loginStreak : 0;
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

    notifyDailyReward(uid, rewardData.coinsToAdd, rewardData.streak).catch(() => {});

    console.log("[claim-daily-reward] uid=" + uid + " coins=" + rewardData.coinsToAdd + " streak=" + rewardData.streak);
    return res.json({
      message:    "Daily reward claimed",
      coinsAdded: rewardData.coinsToAdd,
      streak:     rewardData.streak,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MATCH SYSTEM
// ═══════════════════════════════════════════════════════════════

app.post("/matches/create", verifyToken, async (req, res) => {
  const { game, entryFee } = req.body;
  const uid = req.user.uid;

  if (!game || typeof game !== "string" || !game.trim()) {
    return res.status(400).json({ error: "game is required" });
  }
  try { validateEntryFee(entryFee); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const gameUpper = game.trim().toUpperCase();

  try {
    let matchId;
    await db.runTransaction(async (t) => {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const coins = userDoc.data().coins != null ? userDoc.data().coins : 0;
      if (coins < entryFee) throw new Error("Insufficient coins");

      const matchRef = db.collection("matches").doc();
      matchId = matchRef.id;

      t.update(userRef, { coins: coins - entryFee });
      t.set(matchRef, {
        id:                 matchId,
        playerA:            uid,
        playerB:            null,
        players:            [uid],
        game:               gameUpper,
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

    notifyMatchCreated(uid, matchId, gameUpper, entryFee).catch(() => {});

    return res.status(201).json({
      matchId,
      status:       "waiting",
      playerA:      uid,
      playerB:      null,
      game:         gameUpper,
      entryFee,
      winnerReward: winnerReward(entryFee),
      loserReward:  loserReward(entryFee),
      platformFee:  platformFee(entryFee),
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/matches", verifyToken, async (req, res) => {
  try {
    const [waitingSnap, activeSnap] = await Promise.all([
      db.collection("matches").where("status", "==", "waiting").orderBy("createdAt", "desc").get(),
      db.collection("matches").where("status", "==", "active").orderBy("startedAt", "desc").get(),
    ]);
    const matches = [
      ...waitingSnap.docs.map((d) => d.data()),
      ...activeSnap.docs.map((d) => d.data()),
    ].filter((m) => m.id && m.playerA && m.game);
    return res.json(matches);
  } catch (err) {
    console.error("GET /matches error:", err.message);
    return res.status(500).json({ error: "Failed to load matches." });
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
      const coins = userDoc.data().coins != null ? userDoc.data().coins : 0;

      if (match.status !== "waiting") throw new Error("Match no longer available");
      if (match.playerA === uid)      throw new Error("Cannot join your own match");
      if (match.playerB != null)      throw new Error("Match already has an opponent");
      if (coins < match.entryFee)     throw new Error("Insufficient coins");

      const now = admin.firestore.FieldValue.serverTimestamp();
      t.update(userRef,  { coins: coins - match.entryFee });
      t.update(matchRef, {
        playerB:        uid,
        players:        admin.firestore.FieldValue.arrayUnion(uid),
        status:         "active",
        startedAt:      now,
        matchStartedAt: now,
      });

      joinedMatch = {
        matchId:      matchId,
        playerA:      match.playerA,
        playerB:      uid,
        game:         match.game,
        entryFee:     match.entryFee,
        status:       "active",
        winnerReward: winnerReward(match.entryFee),
        loserReward:  loserReward(match.entryFee),
      };
    });

    notifyMatchJoined(joinedMatch.playerA, uid, matchId, joinedMatch.game).catch(() => {});

    return res.json({ message: "Joined match successfully", match: joinedMatch });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/cancel", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid = req.user.uid;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  try {
    let entryFeeRefunded = 0;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const userRef  = db.collection("users").doc(uid);

      const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

      if (!matchDoc.exists) throw new Error("Match not found");
      if (!userDoc.exists)  throw new Error("User not found");

      const match = matchDoc.data();
      if (match.playerA !== uid)      throw new Error("Only the match creator can cancel");
      if (match.playerB != null)      throw new Error("Cannot cancel -- opponent has already joined");
      if (match.status !== "waiting") throw new Error("Match cannot be cancelled at this stage");

      entryFeeRefunded = match.entryFee;

      t.update(userRef,  { coins: inc(userDoc.data().coins, match.entryFee) });
      t.update(matchRef, {
        status:      "cancelled",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    notifyMatchCancelled(uid, matchId, entryFeeRefunded).catch(() => {});

    return res.json({ message: "Match cancelled -- match ticket refunded" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// QUICK MATCH
// ═══════════════════════════════════════════════════════════════
app.post("/matches/quick-match", verifyToken, async (req, res) => {
  const { game, entryFee } = req.body;
  const uid = req.user.uid;

  if (!game || typeof game !== "string" || !game.trim()) {
    return res.status(400).json({ error: "game is required" });
  }
  try { validateEntryFee(entryFee); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  const gameUpper = game.trim().toUpperCase();

  try {
    let matchId    = null;
    let didCreate  = false;
    let playerAUid = null;

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

    console.log("[quick-match] uid=" + uid + " game=" + gameUpper + " fee=" + entryFee + " candidates=" + candidates.length);

    if (candidates.length > 0) {
      matchId = candidates[0].id;
      await db.runTransaction(async (t) => {
        const matchRef = db.collection("matches").doc(matchId);
        const userRef  = db.collection("users").doc(uid);

        const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

        if (!matchDoc.exists) throw new Error("Match no longer exists");
        if (!userDoc.exists)  throw new Error("User not found");

        const match = matchDoc.data();
        const coins = userDoc.data().coins != null ? userDoc.data().coins : 0;

        if (match.status    !== "waiting") throw new Error("Match no longer available");
        if (match.playerA   === uid)       throw new Error("Cannot join your own match");
        if (match.playerB   != null)       throw new Error("Match already taken");
        if (match.isPrivate === true)      throw new Error("Cannot join a private match");
        if (coins < match.entryFee)        throw new Error("Insufficient coins");

        playerAUid = match.playerA;

        const now = admin.firestore.FieldValue.serverTimestamp();
        t.update(userRef,  { coins: coins - match.entryFee });
        t.update(matchRef, {
          playerB:        uid,
          players:        admin.firestore.FieldValue.arrayUnion(uid),
          status:         "active",
          startedAt:      now,
          matchStartedAt: now,
        });
      });

      if (playerAUid) {
        notifyMatchJoined(playerAUid, uid, matchId, gameUpper).catch(() => {});
      }
      console.log("[quick-match] JOINED " + matchId + " uid=" + uid);

    } else {
      didCreate  = true;
      playerAUid = uid;
      await db.runTransaction(async (t) => {
        const userRef  = db.collection("users").doc(uid);
        const matchRef = db.collection("matches").doc();
        matchId = matchRef.id;

        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error("User not found");

        const coins = userDoc.data().coins != null ? userDoc.data().coins : 0;
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

      notifyMatchCreated(uid, matchId, gameUpper, entryFee).catch(() => {});
      console.log("[quick-match] CREATED " + matchId + " uid=" + uid);
    }

    return res.status(didCreate ? 201 : 200).json({
      matchId,
      action:       didCreate ? "created" : "joined",
      status:       didCreate ? "waiting" : "active",
      winnerReward: winnerReward(entryFee),
      loserReward:  loserReward(entryFee),
    });
  } catch (err) {
    console.error("[quick-match] ERROR uid=" + uid + ":", err.message);
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/submit-result", verifyToken, async (req, res) => {
  const { matchId, myScore, opponentScore } = req.body;
  const uid = req.user.uid;

  if (!matchId || myScore === undefined || opponentScore === undefined) {
    return res.status(400).json({ error: "matchId, myScore, opponentScore required" });
  }
  try {
    validateScore(myScore,       "myScore");
    validateScore(opponentScore, "opponentScore");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    let opponentUid = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.status !== "active") throw new Error("Match is not active");
      if (hasSubmittedResult(match)) throw new Error("Result already submitted");

      opponentUid = uid === match.playerA ? match.playerB : match.playerA;
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

    if (opponentUid) {
      notifyResultSubmitted(opponentUid, matchId).catch(() => {});
    }

    return res.json({ message: "Result submitted -- waiting for opponent to confirm" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/confirm-result", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid = req.user.uid;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  try {
    let result        = {};
    let matchSnapshot = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      matchSnapshot = match;
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.status === "completed") throw new Error("Match already completed");
      if (match.status !== "active")    throw new Error("Match is not active");
      if (!hasSubmittedResult(match))   throw new Error("No result submitted yet");
      if (match.submittedBy === uid)    throw new Error("You submitted -- wait for opponent");

      const submitter      = match.submittedBy;
      const confirmer      = uid;
      const scoreOf        = match.result && match.result.scoreOf ? match.result.scoreOf : {};
      const submitterScore = scoreOf[submitter] != null ? scoreOf[submitter] : 0;
      const confirmerScore = scoreOf[confirmer] != null ? scoreOf[confirmer] : 0;

      let confirmedWinner;
      if (submitterScore > confirmerScore)      confirmedWinner = submitter;
      else if (confirmerScore > submitterScore) confirmedWinner = confirmer;
      else                                      confirmedWinner = "draw";

      result = await distributeReward(t, match, matchRef, confirmedWinner);
    });

    if (matchSnapshot) {
      const w  = result.confirmedWinner;
      const wR = result.winner;
      const lR = result.loser;
      const ef = matchSnapshot.entryFee;

      if (w === "draw") {
        notifyMatchDraw(matchSnapshot.playerA, matchId, ef).catch(() => {});
        notifyMatchDraw(matchSnapshot.playerB, matchId, ef).catch(() => {});
      } else {
        const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA;
        notifyMatchWon(w,         matchId, wR).catch(() => {});
        notifyMatchLost(loserUid, matchId, lR).catch(() => {});
      }
    }

    return res.json({ message: "Result confirmed", confirmedWinner: result.confirmedWinner });
  } catch (err) {
    return res.status(400).json({ error: err.message });
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
    if (typeof evidenceImage !== "string" || evidenceImage.length > 2000) {
      return res.status(400).json({ error: "evidenceImage must be a valid URL string" });
    }
    validatedEvidence = evidenceImage.trim();
  }

  try {
    let disputeId   = null;
    let opponentUid = null;

    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("NOT_IN_MATCH");
      if (match.status === "disputed")  throw new Error("ALREADY_DISPUTED");
      if (match.status === "completed") throw new Error("ALREADY_COMPLETED");
      if (match.status === "cancelled") throw new Error("ALREADY_CANCELLED");

      opponentUid = match.playerA === uid ? match.playerB : match.playerA;

      const disputeRef = db.collection("disputes").doc();
      disputeId = disputeRef.id;
      const now = admin.firestore.FieldValue.serverTimestamp();

      t.set(disputeRef, {
        id:             disputeId,
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
          submittedBy: match.submittedBy != null ? match.submittedBy : null,
          result:      match.result      != null ? match.result      : null,
        },
        createdAt: now,
      });

      t.update(matchRef, {
        status:     "disputed",
        disputedAt: now,
        disputedBy: uid,
        disputeId:  disputeId,
      });
    });

    notifyDisputeOpened(uid, matchId).catch(() => {});
    if (opponentUid) {
      notifyDisputeOpened(opponentUid, matchId).catch(() => {});
    }

    console.log("[dispute] matchId=" + matchId + " reason=\"" + validatedReason + "\" uid=" + uid);
    return res.json({ message: "Dispute submitted -- under review", disputeId });
  } catch (err) {
    if (err.message === "NOT_IN_MATCH")      return res.status(403).json({ error: "You are not in this match" });
    if (err.message === "ALREADY_DISPUTED")  return res.status(409).json({ error: "This match has already been disputed" });
    if (err.message === "ALREADY_COMPLETED") return res.status(400).json({ error: "Match is already completed -- cannot dispute" });
    if (err.message === "ALREADY_CANCELLED") return res.status(400).json({ error: "Match is cancelled -- cannot dispute" });
    if (err.message === "Match not found")   return res.status(404).json({ error: "Match not found" });
    console.error("[dispute]", err.message);
    return res.status(500).json({ error: err.message });
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
      ...snapA.docs.map((d) => d.data()),
      ...snapB.docs.map((d) => d.data()),
    ].sort((a, b) => {
      const bSec = b.createdAt && b.createdAt._seconds ? b.createdAt._seconds : 0;
      const aSec = a.createdAt && a.createdAt._seconds ? a.createdAt._seconds : 0;
      return bSec - aSec;
    }).slice(0, 50);
    return res.json(history);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// AUTO-RESOLVE
// ─────────────────────────────────────────
app.post("/matches/auto-resolve", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  try {
    let result        = {};
    let matchSnapshot = null;

    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.status === "completed" || match.rewarded || match.autoResolved) {
        result = { confirmedWinner: match.confirmedWinner, alreadyResolved: true };
        return;
      }
      if (match.status === "cancelled") {
        result = { alreadyCancelled: true };
        return;
      }
      if (match.status !== "active") {
        throw new Error("Cannot auto-resolve -- status is \"" + match.status + "\"");
      }
      if (!hasSubmittedResult(match)) {
        throw new Error("No result submitted -- use auto-cancel");
      }

      matchSnapshot = match;

      const scoreOf        = match.result && match.result.scoreOf ? match.result.scoreOf : {};
      const submitter      = match.submittedBy;
      const other          = submitter === match.playerA ? match.playerB : match.playerA;
      const submitterScore = scoreOf[submitter] != null ? scoreOf[submitter] : 0;
      const otherScore     = scoreOf[other]     != null ? scoreOf[other]     : 0;

      let confirmedWinner;
      if (submitterScore > otherScore)      confirmedWinner = submitter;
      else if (otherScore > submitterScore) confirmedWinner = other;
      else                                  confirmedWinner = "draw";

      const nonSubmitterRef = db.collection("users").doc(other);
      const nonSubmitterDoc = await t.get(nonSubmitterRef);
      if (nonSubmitterDoc.exists) {
        const nsData = Object.assign({}, nonSubmitterDoc.data(), {
          rageQuits: inc(nonSubmitterDoc.data().rageQuits),
        });
        t.update(nonSubmitterRef, { rageQuits: inc(nonSubmitterDoc.data().rageQuits) });
        applyTrustUpdate(t, nonSubmitterRef, nsData);
      }

      result = await distributeRewardAutoResolve(t, match, matchRef, confirmedWinner, other);
      t.update(matchRef, { autoResolved: true });
    });

    if (matchSnapshot && !result.alreadyResolved && !result.alreadyCancelled) {
      const w  = result.confirmedWinner;
      const wR = result.winner;
      const lR = result.loser;
      const ef = matchSnapshot.entryFee;

      notifyAutoResolved(matchSnapshot.playerA, matchId, w).catch(() => {});
      notifyAutoResolved(matchSnapshot.playerB, matchId, w).catch(() => {});

      if (w === "draw") {
        notifyMatchDraw(matchSnapshot.playerA, matchId, ef).catch(() => {});
        notifyMatchDraw(matchSnapshot.playerB, matchId, ef).catch(() => {});
      } else {
        const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA;
        notifyMatchWon(w,         matchId, wR).catch(() => {});
        notifyMatchLost(loserUid, matchId, lR).catch(() => {});
      }
    }

    if (result.alreadyResolved) {
      return res.json({ message: "Already resolved", confirmedWinner: result.confirmedWinner });
    }
    if (result.alreadyCancelled) {
      return res.json({ message: "Already cancelled" });
    }
    return res.json({ message: "Auto-resolved", confirmedWinner: result.confirmedWinner });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/auto-cancel", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  try {
    let alreadyDone   = false;
    let matchSnapshot = null;

    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.status === "cancelled" || match.status === "completed") {
        alreadyDone = true;
        return;
      }
      if (match.status !== "active") {
        throw new Error("Cannot auto-cancel -- status is \"" + match.status + "\"");
      }
      if (hasSubmittedResult(match)) {
        throw new Error("Result submitted -- use auto-resolve");
      }

      matchSnapshot = match;

      const playerA_Ref = db.collection("users").doc(match.playerA);
      const playerB_Ref = db.collection("users").doc(match.playerB);

      const [playerA_Doc, playerB_Doc] = await Promise.all([
        t.get(playerA_Ref),
        t.get(playerB_Ref),
      ]);
      if (!playerA_Doc.exists || !playerB_Doc.exists) {
        throw new Error("Player data not found");
      }

      const playerA_Data = playerA_Doc.data();
      const playerB_Data = playerB_Doc.data();

      t.update(playerA_Ref, { coins: inc(playerA_Data.coins, match.entryFee) });
      t.update(playerB_Ref, { coins: inc(playerB_Data.coins, match.entryFee) });

      const aUpdated = Object.assign({}, playerA_Data, { rageQuits: inc(playerA_Data.rageQuits) });
      const bUpdated = Object.assign({}, playerB_Data, { rageQuits: inc(playerB_Data.rageQuits) });
      t.update(playerA_Ref, { rageQuits: inc(playerA_Data.rageQuits) });
      t.update(playerB_Ref, { rageQuits: inc(playerB_Data.rageQuits) });
      applyTrustUpdate(t, playerA_Ref, aUpdated);
      applyTrustUpdate(t, playerB_Ref, bUpdated);

      t.update(matchRef, {
        status:        "cancelled",
        cancelledAt:   admin.firestore.FieldValue.serverTimestamp(),
        autoCancelled: true,
        cancelReason:  "match_timer_expired_no_submission",
      });
    });

    if (!alreadyDone && matchSnapshot) {
      notifyAutoCancelled(matchSnapshot.playerA, matchId, matchSnapshot.entryFee).catch(() => {});
      notifyAutoCancelled(matchSnapshot.playerB, matchId, matchSnapshot.entryFee).catch(() => {});
    }

    if (alreadyDone) return res.json({ message: "No action needed" });
    return res.json({ message: "Auto-cancelled -- both players refunded" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/rematch-request", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid = req.user.uid;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  try {
    let opponentUid = null;
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
      const userCoins = userDoc.data().coins != null ? userDoc.data().coins : 0;
      if (userCoins < match.entryFee)    throw new Error("Insufficient coins for rematch");

      opponentUid = match.playerA === uid ? match.playerB : match.playerA;

      t.update(matchRef, {
        rematchRequestedBy: uid,
        rematchStatus:      "pending",
        rematchRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    if (opponentUid) {
      notifyRematchRequested(opponentUid, matchId).catch(() => {});
    }

    return res.json({ message: "Rematch requested" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/rematch-respond", verifyToken, async (req, res) => {
  const { matchId, accept } = req.body;
  const uid = req.user.uid;
  if (!matchId || accept === undefined) {
    return res.status(400).json({ error: "matchId and accept required" });
  }

  if (!accept) {
    try {
      const matchDoc = await db.collection("matches").doc(matchId).get();
      const rematchRequester = matchDoc.exists && matchDoc.data().rematchRequestedBy
        ? matchDoc.data().rematchRequestedBy
        : null;

      await db.collection("matches").doc(matchId).update({
        rematchStatus:     "declined",
        rematchDeclinedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (rematchRequester) {
        notifyRematchDeclined(rematchRequester, matchId).catch(() => {});
      }

      return res.json({ message: "Rematch declined" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    let playerAUid = null;
    let playerBUid = null;

    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");

      const match = matchDoc.data();
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.rematchStatus !== "pending")  throw new Error("No pending rematch");
      if (match.rematchRequestedBy === uid)   throw new Error("Cannot accept own rematch request");

      playerAUid = match.playerA;
      playerBUid = match.playerB;

      const playerA_Ref = db.collection("users").doc(match.playerA);
      const playerB_Ref = db.collection("users").doc(match.playerB);

      const [playerA_Doc, playerB_Doc] = await Promise.all([
        t.get(playerA_Ref),
        t.get(playerB_Ref),
      ]);

      const coinsA = playerA_Doc.exists && playerA_Doc.data().coins != null ? playerA_Doc.data().coins : 0;
      const coinsB = playerB_Doc.exists && playerB_Doc.data().coins != null ? playerB_Doc.data().coins : 0;
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

    if (playerAUid) notifyRematchAccepted(playerAUid, matchId).catch(() => {});
    if (playerBUid) notifyRematchAccepted(playerBUid, matchId).catch(() => {});

    return res.json({ message: "Rematch accepted -- match restarted" });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MATCH ROOM CHAT
// ═══════════════════════════════════════════════════════════════

app.post("/matches/chat/send", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { matchId, message } = req.body;

  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const safeText = message.trim().substring(0, 300);

  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = matchDoc.data();
    if (match.playerA !== uid && match.playerB !== uid) {
      return res.status(403).json({ error: "You are not in this match" });
    }

    const recipientUid = match.playerA === uid ? match.playerB : match.playerA;

    const senderDoc  = await db.collection("users").doc(uid).get();
    const senderName = senderDoc.exists && senderDoc.data().displayName
      ? senderDoc.data().displayName
      : "Opponent";

    const chatRef = db
      .collection("matches")
      .doc(matchId)
      .collection("chat")
      .doc();

    await chatRef.set({
      id:        chatRef.id,
      matchId,
      senderId:  uid,
      senderName,
      message:   safeText,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (recipientUid) {
      notifyChatMessage(recipientUid, senderName, matchId, safeText).catch(() => {});
    }

    return res.status(201).json({ message: "Message sent", messageId: chatRef.id });
  } catch (err) {
    console.error("[chat/send]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/matches/chat/:matchId", verifyToken, async (req, res) => {
  const uid     = req.user.uid;
  const matchId = req.params.matchId;

  if (!matchId || typeof matchId !== "string") {
    return res.status(400).json({ error: "matchId is required" });
  }

  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = matchDoc.data();
    if (match.playerA !== uid && match.playerB !== uid) {
      return res.status(403).json({ error: "You are not in this match" });
    }

    const chatSnap = await db
      .collection("matches")
      .doc(matchId)
      .collection("chat")
      .orderBy("createdAt", "asc")
      .limit(50)
      .get();

    const messages = chatSnap.docs.map((d) => d.data());
    return res.json(messages);
  } catch (err) {
    console.error("[chat/get]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// REPORT PLAYER
// ─────────────────────────────────────────
app.post("/report", verifyToken, async (req, res) => {
  const { reportedUid, description } = req.body;
  const reporterUid = req.user.uid;

  if (!reportedUid || !description) {
    return res.status(400).json({ error: "reportedUid and description required" });
  }
  if (reportedUid === reporterUid) {
    return res.status(400).json({ error: "You cannot report yourself" });
  }

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
      const updated = Object.assign({}, data, { reportsReceived: inc(data.reportsReceived) });
      doc.ref.update({ reportsReceived: inc(data.reportsReceived) }).catch((e) => {
        console.error("[report increment]", e.message);
      });
      doc.ref.set({
        trustScore:          computeTrustScore(updated),
        matchCompletionRate: computeCompletionRate(updated),
        fairPlayRating:      computeFairPlayRating(updated),
        trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch((e) => {
        console.error("[report trust update]", e.message);
      });
    }).catch((e) => console.error("[report user fetch]", e.message));

    return res.json({ message: "Report submitted" });
  } catch (err) {
    console.error("[report]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/leaderboard", verifyToken, async (req, res) => {
  try {
    const snap = await db.collection("users").orderBy("wins", "desc").limit(20).get();
    const leaderboard = snap.docs.map((doc, i) => {
      const d = doc.data();
      return {
        rank:         i + 1,
        uid:          d.uid          != null ? d.uid          : doc.id,
        displayName:  d.displayName  != null ? d.displayName  : "Player",
        wins:         d.wins         != null ? d.wins         : 0,
        losses:       d.losses       != null ? d.losses       : 0,
        totalMatches: d.totalMatches != null ? d.totalMatches : 0,
        avatar:       d.avatar       != null ? d.avatar       : null,
        trustScore:   d.trustScore   != null ? d.trustScore   : 80,
      };
    });
    return res.json(leaderboard);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// ADMIN — TRUST MIGRATION
// ─────────────────────────────────────────
app.post("/admin/migrate-trust", verifyToken, async (req, res) => {
  let migrated = 0;
  let skipped  = 0;
  let errors   = 0;

  try {
    const query = db.collection("users").limit(100);
    let lastDoc = null;
    let hasMore = true;

    while (hasMore) {
      const snap = lastDoc
        ? await query.startAfter(lastDoc).get()
        : await query.get();

      if (snap.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();

      snap.docs.forEach((doc) => {
        try {
          const data = doc.data();
          batch.set(doc.ref, {
            trustScore:          computeTrustScore(data),
            fairPlayRating:      computeFairPlayRating(data),
            matchCompletionRate: computeCompletionRate(data),
            trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          migrated++;
        } catch (e) {
          console.error("[migrate-trust] error on uid=" + doc.id + ":", e.message);
          errors++;
        }
      });

      await batch.commit();
      lastDoc = snap.docs[snap.docs.length - 1];
      hasMore = snap.docs.length === 100;
    }

    console.log("[migrate-trust] done -- migrated=" + migrated + " skipped=" + skipped + " errors=" + errors);
    return res.json({ message: "Trust migration complete", migrated, skipped, errors });
  } catch (err) {
    console.error("[migrate-trust] fatal:", err.message);
    return res.status(500).json({ error: err.message, migrated, skipped, errors });
  }
});

// ─────────────────────────────────────────
// ROOM TIMER NOTIFICATIONS
// ─────────────────────────────────────────
app.post("/matches/timer-alert", verifyToken, async (req, res) => {
  const { matchId, alertType } = req.body;

  if (!matchId || typeof matchId !== "string") {
    return res.status(400).json({ error: "matchId is required" });
  }
  const validAlerts = ["5min", "1min", "expired"];
  if (!alertType || !validAlerts.includes(alertType)) {
    return res.status(400).json({ error: "alertType must be 5min, 1min, or expired" });
  }

  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = matchDoc.data();
    if (match.status !== "active") {
      return res.json({ message: "Match not active -- no alert sent" });
    }

    const uids = [match.playerA, match.playerB].filter(Boolean);

    await Promise.all(
      uids.map((uid) => notifyRoomTimer(uid, matchId, alertType).catch(() => {}))
    );

    return res.json({ message: "Timer alert sent", alertType, matchId });
  } catch (err) {
    console.error("[timer-alert]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION TRIGGER ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post("/notifications/trigger", verifyToken, async (req, res) => {
  const { userId, type, title, message, meta } = req.body;

  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return res.status(400).json({ error: "userId is required" });
  }
  if (!type || typeof type !== "string" || !type.trim()) {
    return res.status(400).json({ error: "type is required" });
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const safeMeta      = (meta && typeof meta === "object" && !Array.isArray(meta)) ? meta : {};
  const pushOnlyTypes = ["chat_message", "room_timer"];
  const isPushOnly    = pushOnlyTypes.includes(type.trim());

  try {
    if (!isPushOnly) {
      await createNotification(userId, type, title, message, safeMeta);
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.notificationsEnabled === true && userData.fcmToken) {
        const pushData = Object.assign({}, safeMeta, { type });
        await sendPushNotification(userId, title, message, pushData);
      }
    }

    return res.json({ message: "Notification triggered", pushOnly: isPushOnly });
  } catch (err) {
    console.error("[notifications/trigger]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// UPDATE NOTIFICATION PREFERENCES
// ─────────────────────────────────────────
app.post("/update-notification-prefs", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { notificationPromptShown, notificationsEnabled } = req.body;

  if (
    typeof notificationPromptShown !== "boolean" ||
    typeof notificationsEnabled    !== "boolean"
  ) {
    return res.status(400).json({ error: "Both fields must be boolean" });
  }

  try {
    const update = {
      notificationPromptShown,
      notificationsEnabled,
      notificationPrefsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!notificationsEnabled) {
      update.fcmToken = admin.firestore.FieldValue.delete();
    }

    await db.collection("users").doc(uid).update(update);
    console.log("[update-notification-prefs] uid=" + uid + " enabled=" + notificationsEnabled);
    return res.json({ message: "Notification preferences saved" });
  } catch (err) {
    console.error("[update-notification-prefs]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DELETE FCM TOKEN
// ─────────────────────────────────────────
app.delete("/save-fcm-token", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    await db.collection("users").doc(uid).update({
      fcmToken:          admin.firestore.FieldValue.delete(),
      fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[delete-fcm-token] uid=" + uid);
    return res.json({ message: "FCM token removed" });
  } catch (err) {
    console.error("[delete-fcm-token]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// SERVER STARTUP
// ─────────────────────────────────────────
const PORT   = process.env.PORT || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Duelix backend running on port " + PORT);
});
server.on("error", (err) => {
  console.error("Server error:", err.message);
  process.exit(1);
});
