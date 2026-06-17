
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const dotenv  = require("dotenv");
dotenv.config();

const https         = require("https");
const { admin, db } = require("./firebase");
const verifyToken   = require("./middleware/verifyToken");

const app = express();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const allowedOrigins = [
  "https://duelix-app.web.app",
  "https://duelix.app",
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

app.use("/paystack/webhook", express.raw({ type: "application/json" }));
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

// =============================================================
// HELPERS
// =============================================================

const inc = (current, by = 1) => (Number(current) || 0) + by;

// =============================================================
// PHONE → COUNTRY / CURRENCY DETECTION
// =============================================================

/**
 * Ordered longest-prefix-first so more specific prefixes (e.g. +1868)
 * are matched before shorter ones (e.g. +1).
 * Add new countries here — no other code needs to change.
 */
const PHONE_COUNTRY_MAP = [
  // Africa
  { prefix: "+233", country: "Ghana",        currency: "GHS" },
  { prefix: "+234", country: "Nigeria",      currency: "NGN" },
  { prefix: "+254", country: "Kenya",        currency: "KES" },
  { prefix: "+256", country: "Uganda",       currency: "UGX" },
  { prefix: "+255", country: "Tanzania",     currency: "TZS" },
  { prefix: "+27",  country: "South Africa", currency: "ZAR" },
  { prefix: "+251", country: "Ethiopia",     currency: "ETB" },
  { prefix: "+250", country: "Rwanda",       currency: "RWF" },
  { prefix: "+237", country: "Cameroon",     currency: "XAF" },
  { prefix: "+260", country: "Zambia",       currency: "ZMW" },
  { prefix: "+263", country: "Zimbabwe",     currency: "ZWL" },
  { prefix: "+225", country: "Ivory Coast",  currency: "XOF" },
  { prefix: "+221", country: "Senegal",      currency: "XOF" },
  { prefix: "+212", country: "Morocco",      currency: "MAD" },
  { prefix: "+20",  country: "Egypt",        currency: "EGP" },
  // Europe
  { prefix: "+44",  country: "UK",           currency: "GBP" },
  { prefix: "+49",  country: "Germany",      currency: "EUR" },
  { prefix: "+33",  country: "France",       currency: "EUR" },
  // Americas
  { prefix: "+1",   country: "USA/Canada",   currency: "USD" },
  { prefix: "+55",  country: "Brazil",       currency: "BRL" },
  // Asia / Pacific
  { prefix: "+91",  country: "India",        currency: "INR" },
  { prefix: "+86",  country: "China",        currency: "CNY" },
  { prefix: "+61",  country: "Australia",    currency: "AUD" },
];

// Sort longest prefix first to avoid shorter prefixes shadowing longer ones
PHONE_COUNTRY_MAP.sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Detects country and currency from an E.164 phone number.
 * Returns { country, currency }.
 * Falls back to { country: "Unknown", currency: "Unknown" } with a console warning.
 */
function detectCountryFromPhone(phone) {
  if (!phone || typeof phone !== "string") {
    return { country: "Unknown", currency: "Unknown" };
  }
  const normalized = phone.trim();
  for (const entry of PHONE_COUNTRY_MAP) {
    if (normalized.startsWith(entry.prefix)) {
      return { country: entry.country, currency: entry.currency };
    }
  }
  console.warn("[detectCountryFromPhone] Unrecognised prefix for phone=" + normalized);
  return { country: "Unknown", currency: "Unknown" };
}

// =============================================================
// TRANSACTION RECORD HELPER
// =============================================================
async function createTransactionRecord(userId, type, amount, description, extra) {
  if (!userId || !type) return;
  try {
    const ref = db.collection("transactions").doc();
    await ref.set(Object.assign({
      id:          ref.id,
      userId,
      type,
      amount:      amount      || 0,
      description: description || "",
      status:      "completed",
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    }, extra || {}));
  } catch (err) {
    console.error("[createTransactionRecord]", err.message);
  }
}

// =============================================================
// REFERRAL CODE GENERATOR
// =============================================================
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

// =============================================================
// MATCH ECONOMY
// =============================================================
const pool              = (entryFee) => entryFee * 2;
const winnerReward      = (entryFee) => Math.floor(entryFee * 1.00);
const winnerRc          = (entryFee) => Math.floor(entryFee * 0.60);
const loserReward       = (entryFee) => Math.floor(entryFee * 0.10);
const platformFee       = (entryFee) =>
  pool(entryFee) - winnerReward(entryFee) - loserReward(entryFee);
const drawRefund        = (entryFee) => Math.floor(entryFee * 0.90);
const drawPlatformFee   = (entryFee) => (entryFee * 2) - (drawRefund(entryFee) * 2);
const bonusWinnerReward = (entryFee) => Math.floor(entryFee * 0.50);
const bonusDrawRefund   = (entryFee) => entryFee;

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

function validateWalletType(walletType) {
  if (walletType === "bonus") return "bonus";
  return "gameplay";
}

// =============================================================
// COIN PACKAGE CATALOGUE
// =============================================================
const COIN_PACKAGES = {
  "coins_50":   { coins: 50,   koboAmount: 500,   currency: "GHS", label: "Starter"  },
  "coins_105":  { coins: 105,  koboAmount: 1000,  currency: "GHS", label: "Basic"    },
  "coins_215":  { coins: 215,  koboAmount: 2000,  currency: "GHS", label: "Standard" },
  "coins_550":  { coins: 550,  koboAmount: 5000,  currency: "GHS", label: "Plus"     },
  "coins_1150": { coins: 1150, koboAmount: 10000, currency: "GHS", label: "Pro"      },
  "coins_2400": { coins: 2400, koboAmount: 20000, currency: "GHS", label: "Elite"    },
};

// =============================================================
// TRUST SYSTEM
// =============================================================

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
  rcBalance:           0,
};

function applyTrustUpdate(t, userRef, userData) {
  const fields = {
    trustScore:          computeTrustScore(userData),
    matchCompletionRate: computeCompletionRate(userData),
    fairPlayRating:      computeFairPlayRating(userData),
    trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  };
  if (t) {
    t.update(userRef, fields);
  } else {
    userRef.update(fields).catch((err) =>
      console.error("[applyTrustUpdate standalone]", err.message)
    );
  }
}

function applyCleanMatchReward(t, userRef, userData) {
  const newCleanMatchBonus =
    (Number(userData.cleanMatchBonus) || 0) + CLEAN_MATCH_TRUST_BONUS;
  const newFairPlayBonus =
    (Number(userData.fairPlayBonus) || 0) + CLEAN_MATCH_FAIRPLAY_BONUS;

  const updatedData = Object.assign({}, userData, {
    cleanMatchBonus: newCleanMatchBonus,
    fairPlayBonus:   newFairPlayBonus,
  });

  t.update(userRef, {
    cleanMatchBonus:     newCleanMatchBonus,
    fairPlayBonus:       newFairPlayBonus,
    trustScore:          computeTrustScore(updatedData),
    matchCompletionRate: computeCompletionRate(updatedData),
    fairPlayRating:      computeFairPlayRating(updatedData),
    trustUpdatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });
}

// =============================================================
// DISPUTE VALIDATORS
// =============================================================
const VALID_DISPUTE_REASONS = [
  "Wrong Score", "Opponent Quit", "Fake Submission",
  "Time Wasting", "Abuse", "Other Issue",
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
  if (trimmed.length > 500) throw new Error("note must be 500 characters or fewer");
  if (trimmed.split(/\s+/).length > 20) throw new Error("note must be 20 words or fewer");
  return trimmed;
}

// =============================================================
// ANTI-FRAUD HELPERS
// =============================================================

async function recordDeviceFingerprint(uid, deviceId, installId, ipAddress) {
  if (!uid) return;
  try {
    await db.collection("device_fingerprints").doc().set({
      uid,
      deviceId:   deviceId  || null,
      installId:  installId || null,
      ipAddress:  ipAddress || null,
      recordedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[recordDeviceFingerprint]", err.message);
  }
}

async function countAccountsByDevice(deviceId, installId) {
  if (!deviceId && !installId) return 0;
  try {
    const queries = [];
    if (deviceId) {
      queries.push(
        db.collection("device_fingerprints")
          .where("deviceId", "==", deviceId).limit(5).get()
      );
    }
    if (installId) {
      queries.push(
        db.collection("device_fingerprints")
          .where("installId", "==", installId).limit(5).get()
      );
    }
    const snaps = await Promise.all(queries);
    const uids  = new Set();
    snaps.forEach((snap) =>
      snap.docs.forEach((doc) => uids.add(doc.data().uid))
    );
    return uids.size;
  } catch (err) {
    console.error("[countAccountsByDevice]", err.message);
    return 0;
  }
}

async function isIpAbusive(ipAddress) {
  if (!ipAddress) return false;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snap   = await db.collection("device_fingerprints")
      .where("ipAddress", "==", ipAddress)
      .orderBy("recordedAt", "desc")
      .limit(10)
      .get();
    const recent = snap.docs.filter((doc) => {
      const ts = doc.data().recordedAt;
      return ts && ts.toDate && ts.toDate() > cutoff;
    });
    return recent.length >= 5;
  } catch (err) {
    console.error("[isIpAbusive]", err.message);
    return false;
  }
}

async function detectSuspiciousActivity(uid, context) {
  try {
    await db.collection("security_logs").doc().set({
      uid, context,
      flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("users").doc(uid).set(
      { suspiciousFlag: true, suspiciousFlagReason: context },
      { merge: true }
    );
    console.warn("[security] Suspicious uid=" + uid + " context=" + context);
  } catch (err) {
    console.error("[detectSuspiciousActivity]", err.message);
  }
}

async function tryGrantReferralReward(uid) {
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return;

    const user = userDoc.data();
    if (!user.referredBy || user.referralRewardGranted) return;

    const referrerUid = user.referredBy;

    const deviceSnap = await db.collection("device_fingerprints")
      .where("uid", "==", referrerUid).limit(3).get();
    const referrerDevices = new Set(
      deviceSnap.docs.map((d) => d.data().deviceId).filter(Boolean)
    );
    const userDeviceSnap = await db.collection("device_fingerprints")
      .where("uid", "==", uid).limit(3).get();
    userDeviceSnap.docs.forEach((d) => {
      if (d.data().deviceId && referrerDevices.has(d.data().deviceId)) {
        detectSuspiciousActivity(uid, "referral_same_device referrer=" + referrerUid)
          .catch(() => {});
      }
    });

    await db.runTransaction(async (t) => {
      const userRef     = db.collection("users").doc(uid);
      const referrerRef = db.collection("users").doc(referrerUid);

      const [freshUser, referrerDoc] = await Promise.all([
        t.get(userRef), t.get(referrerRef),
      ]);

      if (!freshUser.exists)   throw new Error("User not found");
      if (!referrerDoc.exists) throw new Error("Referrer not found");
      if (freshUser.data().referralRewardGranted) return;

      t.update(userRef, {
        coins:                 inc(freshUser.data().coins, 5),
        referralRewardGranted: true,
      });
      t.update(referrerRef, {
        coins: inc(referrerDoc.data().coins, 5),
      });
    });

    notifyReferralBonus(uid, 5, userDoc.data().referredByName || "A friend")
      .catch(() => {});
    notifyReferrerReward(referrerUid, 5, user.displayName || "A new player")
      .catch(() => {});

    createTransactionRecord(
      uid, "referral_reward", 5,
      "Referral bonus: used a referral code",
      { referrerUid, event: "new_user_bonus" }
    ).catch(() => {});
    createTransactionRecord(
      referrerUid, "referral_reward", 5,
      "Referral reward: " + (user.displayName || "A new player") + " made first purchase",
      { referredUid: uid, event: "referrer_reward" }
    ).catch(() => {});

    console.log("[referral] reward granted uid=" + uid + " referrer=" + referrerUid);
  } catch (err) {
    console.error("[tryGrantReferralReward]", err.message);
  }
}

// =============================================================
// LIVE ACTIVITY HELPERS
// =============================================================

function todayUtc() {
  return new Date().toISOString().split("T")[0];
}

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

async function countOnlinePlayers() {
  try {
    const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS);
    const snap = await db.collection("users")
      .where("lastSeen", ">=", admin.firestore.Timestamp.fromDate(cutoff))
      .limit(1000)
      .get();
    return snap.size;
  } catch (err) {
    console.error("[countOnlinePlayers]", err.message);
    return 0;
  }
}

async function refreshOnlinePlayersCount() {
  try {
    const onlineCount = await countOnlinePlayers();
    const ref = db.collection("platform").doc("live_activity");
    await ref.set({
      onlinePlayers:          onlineCount,
      onlinePlayersUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error("[refreshOnlinePlayersCount]", err.message);
  }
}

async function updateLiveActivity(winnerUsername, entryFee, isDraw) {
  try {
    const ref   = db.collection("platform").doc("live_activity");
    const today = todayUtc();
    const snap  = await ref.get();

    if (!snap.exists) {
      const winners = (!isDraw && winnerUsername)
        ? [{ username: winnerUsername, entryFee: entryFee || 0, timestamp: new Date().toISOString() }]
        : [];
      await ref.set({
        matchesPlayedToday: 1,
        onlinePlayers:      0,
        recentWinners:      winners,
        lastResetDate:      today,
        updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    const data         = snap.data();
    const lastReset    = data.lastResetDate || "";
    const needsReset   = lastReset !== today;
    const currentCount = needsReset ? 0 : (Number(data.matchesPlayedToday) || 0);
    const currentWinners = needsReset ? [] : (Array.isArray(data.recentWinners) ? data.recentWinners : []);

    let updatedWinners = currentWinners;
    if (!isDraw && winnerUsername) {
      const newEntry = { username: winnerUsername, entryFee: entryFee || 0, timestamp: new Date().toISOString() };
      updatedWinners = [newEntry, ...currentWinners].slice(0, 3);
    }

    await ref.set({
      matchesPlayedToday: currentCount + 1,
      recentWinners:      updatedWinners,
      lastResetDate:      today,
      updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error("[updateLiveActivity]", err.message);
  }
}

async function touchLastSeen(uid) {
  if (!uid) return;
  try {
    await db.collection("users").doc(uid).set(
      { lastSeen: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    console.error("[touchLastSeen] uid=" + uid + " err=" + err.message);
  }
}

// =============================================================
// MATCH ROOM PRESENCE SYSTEM
// =============================================================

const PRESENCE_STALE_MS            = 15 * 1000;
const PRESENCE_CLEANUP_INTERVAL_MS = 10 * 1000;

async function getPresenceRole(matchId, uid) {
  const matchDoc = await db.collection("matches").doc(matchId).get();
  if (!matchDoc.exists) throw new Error("Match not found");
  const match = matchDoc.data();
  if (match.playerA === uid) return { role: "A", match };
  if (match.playerB === uid) return { role: "B", match };
  throw new Error("You are not in this match");
}

function isHeartbeatFresh(heartbeatTimestamp) {
  if (!heartbeatTimestamp) return false;
  const ms = heartbeatTimestamp._seconds
    ? heartbeatTimestamp._seconds * 1000
    : heartbeatTimestamp.toMillis
      ? heartbeatTimestamp.toMillis()
      : 0;
  return (Date.now() - ms) <= PRESENCE_STALE_MS;
}

async function cleanupStalePresence() {
  try {
    const snap = await db.collection("matches")
      .where("status", "in", ["waiting", "active"])
      .limit(200)
      .get();

    if (snap.empty) return;

    const now   = Date.now();
    const batch = db.batch();
    let writes  = 0;

    snap.docs.forEach((doc) => {
      const d       = doc.data();
      const updates = {};

      if (d.playerAInMatchRoom === true) {
        const hb = d.playerAHeartbeat;
        if (!hb) {
          updates.playerAInMatchRoom = false;
        } else {
          const ms = hb._seconds ? hb._seconds * 1000 : hb.toMillis ? hb.toMillis() : 0;
          if ((now - ms) > PRESENCE_STALE_MS) updates.playerAInMatchRoom = false;
        }
      }

      if (d.playerBInMatchRoom === true) {
        const hb = d.playerBHeartbeat;
        if (!hb) {
          updates.playerBInMatchRoom = false;
        } else {
          const ms = hb._seconds ? hb._seconds * 1000 : hb.toMillis ? hb.toMillis() : 0;
          if ((now - ms) > PRESENCE_STALE_MS) updates.playerBInMatchRoom = false;
        }
      }

      if (Object.keys(updates).length > 0) {
        batch.update(doc.ref, updates);
        writes++;
      }
    });

    if (writes > 0) {
      await batch.commit();
      console.log("[presence-cleanup] Marked " + writes + " stale player(s) offline");
    }
  } catch (err) {
    console.error("[presence-cleanup] Error:", err.message);
  }
}

function startPresenceCleanupLoop() {
  console.log(
    "[presence-cleanup] Starting (interval=" + PRESENCE_CLEANUP_INTERVAL_MS +
    "ms, stale=" + PRESENCE_STALE_MS + "ms)"
  );
  setInterval(() => { cleanupStalePresence(); }, PRESENCE_CLEANUP_INTERVAL_MS);
}

// =============================================================
// INVITE LINK HELPERS
// =============================================================

const INVITE_EXPIRY_MS = 30 * 60 * 1000;

async function validateInviteMatch(matchId) {
  const matchDoc = await db.collection("matches").doc(matchId).get();
  if (!matchDoc.exists) throw new Error("Match not found");

  const match = matchDoc.data();

  if (match.status === "cancelled") throw new Error("This match has been cancelled");
  if (match.status === "completed") throw new Error("This match has already been completed");
  if (match.status !== "waiting")   throw new Error("This match is no longer accepting players");
  if (match.playerB != null)        throw new Error("This match is already full");

  const createdAt = match.createdAt;
  if (createdAt) {
    const createdMs = createdAt._seconds
      ? createdAt._seconds * 1000
      : createdAt.toMillis ? createdAt.toMillis() : 0;
    if (createdMs > 0 && (Date.now() - createdMs) > INVITE_EXPIRY_MS) {
      throw new Error("This invite link has expired");
    }
  }

  return match;
}

// =============================================================
// PAYSTACK -- INITIALIZE TRANSACTION
// =============================================================
function initializePaystackTransaction(email, amountInPesewas, currency, reference, metadata) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET_KEY) {
      return reject(new Error("PAYSTACK_SECRET_KEY is not configured on the server."));
    }
    const body = JSON.stringify({
      email, amount: amountInPesewas, currency, reference,
      metadata: metadata || {},
      callback_url: "https://duelix-app.web.app/payment-callback",
    });
    const options = {
      hostname: "api.paystack.co", port: 443, path: "/transaction/initialize", method: "POST",
      headers: {
        "Authorization":  "Bearer " + PAYSTACK_SECRET_KEY,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.status) return reject(new Error("Paystack init failed: " + (parsed.message || "unknown error")));
          resolve(parsed.data);
        } catch (e) { reject(new Error("Failed to parse Paystack init response: " + e.message)); }
      });
    });
    req.on("error", (e) => reject(new Error("Paystack network error: " + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Paystack initialization timed out.")); });
    req.write(body);
    req.end();
  });
}

// =============================================================
// PAYSTACK -- VERIFY TRANSACTION
// =============================================================
function verifyPaystackTransaction(reference) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET_KEY) {
      return reject(new Error("PAYSTACK_SECRET_KEY is not configured on the server."));
    }
    const options = {
      hostname: "api.paystack.co", port: 443,
      path: "/transaction/verify/" + encodeURIComponent(reference),
      method: "GET",
      headers: { "Authorization": "Bearer " + PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.status) return reject(new Error("Paystack verification failed: " + (parsed.message || "unknown error")));
          if (!parsed.data) return reject(new Error("Paystack verification returned no data for ref=" + reference));
          resolve(parsed.data);
        } catch (e) { reject(new Error("Failed to parse Paystack response: " + e.message)); }
      });
    });
    req.on("error", (e) => reject(new Error("Paystack network error: " + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Paystack verification timed out.")); });
    req.end();
  });
}

// =============================================================
// SHARED COIN-CREDIT LOGIC
// =============================================================
async function creditCoinsForReference(safeRef, uid, pkg, paystackEmail) {
  const dupSnap = await db
    .collection("coin_purchases")
    .where("reference", "==", safeRef)
    .limit(1)
    .get();
  if (!dupSnap.empty) throw new Error("ALREADY_CREDITED");

  let newCoinBalance  = 0;
  let newRcBalance    = 0;
  let isFirstPurchase = false;

  await db.runTransaction(async (t) => {
    const userRef    = db.collection("users").doc(uid);
    const pendingRef = db.collection("pending_purchases").doc(safeRef);

    const userDoc    = await t.get(userRef);
    if (!userDoc.exists) throw new Error("User not found for uid=" + uid);
    const pendingDoc = await t.get(pendingRef);

    const userData         = userDoc.data();
    const currentCoins     = userData.coins     != null ? Number(userData.coins)     : 0;
    const currentRc        = userData.rcBalance != null ? Number(userData.rcBalance) : 0;
    const safeCurrentCoins = Math.max(0, currentCoins);

    newCoinBalance  = safeCurrentCoins + pkg.coins;
    newRcBalance    = currentRc;
    isFirstPurchase = !userData.firstPurchaseDone;

    const purchaseRef = db.collection("coin_purchases").doc();

    t.update(userRef, {
      coins:             newCoinBalance,
      firstPurchaseDone: true,
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    });

    t.set(purchaseRef, {
      id:             purchaseRef.id,
      userId:         uid,
      packageId:      pkg.id     || "",
      packageLabel:   pkg.label  || "",
      coinsAdded:     pkg.coins,
      newCoinBalance: newCoinBalance,
      reference:      safeRef,
      amountCharged:  pkg.amountCharged   || 0,
      currency:       pkg.chargedCurrency || pkg.currency || "",
      status:         "completed",
      paystackEmail:  paystackEmail || null,
      source:         pkg.source || "verify",
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    if (pendingDoc.exists) {
      t.update(pendingRef, {
        status:      "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedBy: pkg.source || "verify",
      });
    }
  });

  return { newCoinBalance, newRcBalance, isFirstPurchase };
}

// =============================================================
// FCM PUSH HELPER
// =============================================================
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

    await admin.messaging().send({
      token:        fcmToken,
      notification: { title: String(title || ""), body: String(body || "") },
      data:         safeData,
      android: {
        priority: "high",
        notification: { sound: "default", click_action: "FLUTTER_NOTIFICATION_CLICK" },
      },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
      webpush: {
        notification: {
          icon:    "/icons/icon-192x192.png",
          badge:   "/icons/badge-72x72.png",
          vibrate: [200, 100, 200],
        },
        fcm_options: { link: "https://duelix-app.web.app" },
      },
    });
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
        .catch((e) => console.error("[sendPush] token cleanup:", e.message));
    } else {
      console.error("[sendPush] uid=" + userId + " err=" + err.message);
    }
  }
}

// =============================================================
// NOTIFICATION SYSTEM
// =============================================================

function notificationFilterTag(type) {
  const matchTypes = [
    "match_found", "match_joined", "match_started", "match_created",
    "match_cancelled", "match_refunded", "match_result_submitted",
    "match_result_confirmed", "match_won", "match_lost", "match_draw",
    "match_auto_resolved", "match_auto_cancelled", "match_dispute_opened",
    "match_dispute_resolved", "rematch_requested", "rematch_accepted",
    "rematch_declined", "match_result",
    "bonus_match_won", "bonus_match_lost", "bonus_match_draw",
    "match_invite_joined",
  ];
  const rewardTypes = [
    "coins_added", "reward_payout", "coin_purchase",
    "purchase_successful", "redeem_successful", "rc_earned",
    "redemption_requested", "redemption_approved", "redemption_rejected",
    "reward", "rc_converted",
  ];
  const socialTypes   = ["friend_request", "friend_accepted", "chat_message"];
  const referralTypes = ["referral", "referral_reward"];
  if (matchTypes.includes(type))    return "match";
  if (rewardTypes.includes(type))   return "reward";
  if (socialTypes.includes(type))   return "social";
  if (referralTypes.includes(type)) return "referral";
  return "system";
}

async function createNotification(userId, type, title, message, meta) {
  if (!userId || typeof userId !== "string") return;
  const safeMeta = meta && typeof meta === "object" ? meta : {};
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
  const pushData = Object.assign({}, meta && typeof meta === "object" ? meta : {}, { type });
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

// -- Typed notification helpers --

function notifyMatchCreated(userId, matchId, game, entryFee, walletType) {
  const walletLabel = walletType === "bonus" ? "Bonus" : "Gameplay";
  return notifyUser(
    userId, "match_created", "Match Created!",
    "Your " + game + " match (entry: " + entryFee + " " + walletLabel + " Coins) is live. Share your code!",
    { matchId, game, entryFee, walletType: walletType || "gameplay" }
  );
}

function notifyMatchJoined(playerAUid, playerBUid, matchId, game) {
  return notifyMultipleUsers(
    [playerAUid, playerBUid], "match_joined", "Match Joined!",
    "You successfully joined a " + game + " match. Good luck!",
    { matchId, game }
  );
}

function notifyMatchStarted(playerAUid, playerBUid, matchId, game) {
  return notifyMultipleUsers(
    [playerAUid, playerBUid], "match_started", "Match Started!",
    "Your " + game + " match has started. Play and submit your result.",
    { matchId, game }
  );
}

function notifyInviteJoined(hostUid, joinerUsername, matchId, game) {
  return notifyUser(
    hostUid, "match_invite_joined", "🎮 Opponent Joined via Invite!",
    joinerUsername + " joined your " + game + " match via your invite link. Match is ready!",
    { matchId, game, joinerUsername }
  );
}

function notifyResultSubmitted(opponentUid, matchId) {
  return notifyUser(
    opponentUid, "match_result_submitted", "Result Submitted",
    "Your opponent submitted the match result. Please confirm or dispute within 3 minutes.",
    { matchId }
  );
}

function notifyResultConfirmed(userId, matchId) {
  return notifyUser(
    userId, "match_result_confirmed", "Result Confirmed",
    "Match result confirmed successfully. Rewards have been distributed.",
    { matchId }
  );
}

function notifyMatchWon(userId, matchId, coinsWon, rcEarned) {
  const rcPart = rcEarned > 0 ? " + +" + rcEarned + " RC" : "";
  return notifyUser(
    userId, "match_won", "Victory! You Won!",
    "Congratulations! You won the match. +" + coinsWon + " Coins" + rcPart + " added.",
    { matchId, coinsWon, rcEarned: rcEarned || 0 }
  );
}

function notifyBonusMatchWon(userId, matchId, coinsWon) {
  return notifyUser(
    userId, "bonus_match_won", "Bonus Match Won!",
    "You won the Bonus Match! +" + coinsWon + " Gameplay Coins added. No RC on bonus matches.",
    { matchId, coinsWon, walletType: "bonus" }
  );
}

function notifyBonusMatchLost(userId, matchId) {
  return notifyUser(
    userId, "bonus_match_lost", "Bonus Match Over",
    "You lost the Bonus Match. No refund on bonus matches. Keep practicing!",
    { matchId, walletType: "bonus" }
  );
}

function notifyBonusMatchDraw(userId, matchId, refundAmount) {
  return notifyUser(
    userId, "bonus_match_draw", "Bonus Match Draw!",
    "The Bonus Match ended in a draw. +" + refundAmount + " Bonus Coins refunded. No RC on bonus matches.",
    { matchId, refundAmount, walletType: "bonus" }
  );
}

function notifyMatchLost(userId, matchId, coinsBack) {
  return notifyUser(
    userId, "match_lost", "Match Over",
    "You lost the match. +" + coinsBack + " coins returned. Keep going!",
    { matchId, coinsBack }
  );
}

function notifyMatchDraw(userId, matchId, coinsBack) {
  return notifyUser(
    userId, "match_draw", "It's a Draw!",
    "Match ended in a draw. +" + coinsBack + " coins refunded. No RC on draws.",
    { matchId, coinsBack }
  );
}

function notifyMatchCancelled(userId, matchId, refund) {
  return notifyUser(
    userId, "match_cancelled", "Match Cancelled",
    "Your match was cancelled. " + refund + " coins have been refunded.",
    { matchId, refund }
  );
}

function notifyAutoCancelled(userId, matchId, refund) {
  return notifyUser(
    userId, "match_auto_cancelled", "Match Auto-Cancelled",
    "Your match expired with no result submitted. " + refund + " coins refunded.",
    { matchId, refund }
  );
}

function notifyAutoResolved(userId, matchId, outcome) {
  return notifyUser(
    userId, "match_auto_resolved", "Match Auto-Resolved",
    "Your match was resolved automatically. Outcome: " + outcome + ".",
    { matchId, outcome }
  );
}

function notifyDisputeOpened(userId, matchId) {
  return notifyUser(
    userId, "match_dispute_opened", "Dispute Opened",
    "A dispute has been raised for your match. Our team will investigate shortly.",
    { matchId }
  );
}

function notifyDisputeResolved(userId, matchId, outcome) {
  return notifyUser(
    userId, "match_dispute_resolved", "Dispute Resolved",
    "Your match dispute has been resolved. Outcome: " + outcome + ".",
    { matchId, outcome }
  );
}

function notifyRematchRequested(opponentUid, matchId) {
  return notifyUser(
    opponentUid, "rematch_requested", "Rematch Requested",
    "Your opponent wants a rematch! Accept or decline in the match room.",
    { matchId }
  );
}

function notifyRematchAccepted(userId, matchId) {
  return notifyUser(
    userId, "rematch_accepted", "Rematch Accepted!",
    "Your rematch has started. Good luck!",
    { matchId }
  );
}

function notifyRematchDeclined(userId, matchId) {
  return notifyUser(
    userId, "rematch_declined", "Rematch Declined",
    "Your opponent declined the rematch request.",
    { matchId }
  );
}

function notifyReferralBonus(userId, bonusCoins, referrerName) {
  return notifyUser(
    userId, "referral_reward", "Referral Bonus Unlocked!",
    "You used " + referrerName + "'s referral code and earned +" +
      bonusCoins + " bonus coins after your first purchase!",
    { bonusCoins, referrerName, event: "new_user_bonus" }
  );
}

function notifyReferrerReward(referrerUid, rewardCoins, newUserName) {
  return notifyUser(
    referrerUid, "referral_reward", "Referral Reward Unlocked!",
    newUserName + " completed their first purchase using your referral code. +" +
      rewardCoins + " coins added!",
    { rewardCoins, newUserName, event: "referrer_reward" }
  );
}

function notifyCoinPurchase(userId, coinsAdded, newBalance, packageLabel) {
  return notifyUser(
    userId, "coin_purchase", "Coin Purchase Successful!",
    "Your purchase was successful. " + coinsAdded + " Coins (" +
      packageLabel + ") added to your account.",
    { coinsAdded, newBalance, packageLabel }
  );
}

function notifyRcEarned(userId, rcAmount, coinsWon, matchId) {
  return notifyUser(
    userId, "rc_earned", "RC Earned!",
    "You won the match and earned +" + coinsWon + " Coins + +" + rcAmount + " RC!",
    { rcAmount, coinsWon, matchId }
  );
}

function notifyRedemptionRequested(userId, rcAmount, usdValue) {
  return notifyUser(
    userId, "redemption_requested", "Redemption Request Submitted",
    "Your request to redeem " + rcAmount + " RC ($" +
      usdValue.toFixed(2) + ") has been received. Allow 1-3 business days.",
    { rcAmount, usdValue }
  );
}

function notifyRcConverted(userId, rcAmount, coinsAdded) {
  return notifyUser(
    userId, "rc_converted", "RC Converted to Coins!",
    "Successfully converted " + rcAmount + " RC into " + coinsAdded + " Gameplay Coins.",
    { rcAmount, coinsAdded }
  );
}

function notifyChatMessage(recipientUid, senderName, matchId, preview) {
  const safePreview =
    typeof preview === "string" && preview.length > 0
      ? preview.length > 60 ? preview.substring(0, 57) + "..." : preview
      : "Sent you a message";
  return notifyPushOnly(
    recipientUid,
    senderName + " sent a message",
    safePreview,
    { matchId, senderName, type: "chat_message" }
  );
}

function notifyRoomTimer(userId, matchId, alertType) {
  const titles   = { "5min": "5 Minutes Remaining", "1min": "1 Minute Remaining!", "expired": "Match Room Expired" };
  const messages = {
    "5min":    "Your match room expires in 5 minutes. Submit your result now!",
    "1min":    "Last chance! Submit your result before the match room expires.",
    "expired": "Your match room has expired and has been auto-resolved by the system.",
  };
  return notifyPushOnly(userId, titles[alertType] || "Match Timer Alert", messages[alertType] || "",
    { matchId, timerAlert: alertType, type: "room_timer" });
}

// =============================================================
// REWARD DISTRIBUTION -- GAMEPLAY CONFIRM-RESULT PATH
// =============================================================
async function distributeReward(t, match, matchRef, confirmedWinner) {
  const winner  = winnerReward(match.entryFee);
  const rc      = winnerRc(match.entryFee);
  const loser   = loserReward(match.entryFee);
  const plat    = platformFee(match.entryFee);
  const dRefund = drawRefund(match.entryFee);
  const dPlat   = drawPlatformFee(match.entryFee);

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const platformRef = db.collection("platform").doc("earnings");

  const [playerA_Doc, playerB_Doc, platformDoc] = await Promise.all([
    t.get(playerA_Ref), t.get(playerB_Ref), t.get(platformRef),
  ]);

  if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const aUpdated = Object.assign({}, playerA_Data, { completedMatches: inc(playerA_Data.completedMatches), totalMatches: inc(playerA_Data.totalMatches) });
    const bUpdated = Object.assign({}, playerB_Data, { completedMatches: inc(playerB_Data.completedMatches), totalMatches: inc(playerB_Data.totalMatches) });

    t.update(playerA_Ref, { coins: inc(playerA_Data.coins, dRefund), draws: inc(playerA_Data.draws), totalMatches: inc(playerA_Data.totalMatches), completedMatches: inc(playerA_Data.completedMatches) });
    t.update(playerB_Ref, { coins: inc(playerB_Data.coins, dRefund), draws: inc(playerB_Data.draws), totalMatches: inc(playerB_Data.totalMatches), completedMatches: inc(playerB_Data.completedMatches) });
    applyCleanMatchReward(t, playerA_Ref, aUpdated);
    applyCleanMatchReward(t, playerB_Ref, bUpdated);

    const platformCoins = platformDoc.exists ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0) : 0;
    t.set(platformRef, { totalCoins: inc(platformCoins, dPlat), lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    updateLiveActivity(null, match.entryFee, true).catch(() => {});
  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();

    const winnerUpdated = Object.assign({}, winnerData, { completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0) });
    const loserUpdated  = Object.assign({}, loserData,  { completedMatches: inc(loserData.completedMatches  != null ? loserData.completedMatches  : 0), totalMatches: inc(loserData.totalMatches  != null ? loserData.totalMatches  : 0) });

    t.update(winnerRef, { coins: inc(winnerData.coins != null ? winnerData.coins : 0, winner), wins: inc(winnerData.wins != null ? winnerData.wins : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0), completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0) });
    t.update(loserRef,  { coins: inc(loserData.coins  != null ? loserData.coins  : 0, loser),  losses: inc(loserData.losses != null ? loserData.losses : 0), totalMatches: inc(loserData.totalMatches != null ? loserData.totalMatches : 0), completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0) });

    if (rc > 0) t.update(winnerRef, { rcBalance: (Number(winnerData.rcBalance) || 0) + rc });

    applyCleanMatchReward(t, winnerRef, winnerUpdated);
    applyCleanMatchReward(t, loserRef,  loserUpdated);

    const platformCoins = platformDoc.exists ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0) : 0;
    t.set(platformRef, { totalCoins: inc(platformCoins, plat), lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    if (rc > 0) {
      createTransactionRecord(confirmedWinner, "rc_earned", rc, "RC earned for winning match " + match.id,
        { matchId: match.id, entryFee: match.entryFee, coinsWon: winner, walletType: "gameplay" }).catch(() => {});
    }
    updateLiveActivity(winnerData.displayName || "Player", match.entryFee, false).catch(() => {});
  }

  t.update(matchRef, {
    status: "completed", confirmedWinner, rewarded: true,
    winnerReward: confirmedWinner === "draw" ? 0 : winner,
    winnerRc:     confirmedWinner === "draw" ? 0 : rc,
    loserReward:  confirmedWinner === "draw" ? 0 : loser,
    walletType:   "gameplay",
    confirmedAt:  admin.firestore.FieldValue.serverTimestamp(),
    rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null,
  });

  return { winner, rc, loser, confirmedWinner };
}

// =============================================================
// REWARD DISTRIBUTION -- BONUS CONFIRM-RESULT PATH
// =============================================================
async function distributeBonusReward(t, match, matchRef, confirmedWinner) {
  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);

  const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);
  if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const refund = bonusDrawRefund(match.entryFee);
    t.update(playerA_Ref, { bonusCoins: inc(Number(playerA_Data.bonusCoins) || 0, refund), draws: inc(playerA_Data.draws), totalMatches: inc(playerA_Data.totalMatches), completedMatches: inc(playerA_Data.completedMatches) });
    t.update(playerB_Ref, { bonusCoins: inc(Number(playerB_Data.bonusCoins) || 0, refund), draws: inc(playerB_Data.draws), totalMatches: inc(playerB_Data.totalMatches), completedMatches: inc(playerB_Data.completedMatches) });
    updateLiveActivity(null, match.entryFee, true).catch(() => {});
  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();
    const bonusWin   = bonusWinnerReward(match.entryFee);

    t.update(winnerRef, { coins: inc(winnerData.coins != null ? winnerData.coins : 0, bonusWin), wins: inc(winnerData.wins != null ? winnerData.wins : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0), completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0) });
    t.update(loserRef,  { losses: inc(loserData.losses != null ? loserData.losses : 0), totalMatches: inc(loserData.totalMatches != null ? loserData.totalMatches : 0), completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0) });
    updateLiveActivity(winnerData.displayName || "Player", match.entryFee, false).catch(() => {});
  }

  const bonusWin = confirmedWinner === "draw" ? 0 : bonusWinnerReward(match.entryFee);
  const refund   = confirmedWinner === "draw" ? bonusDrawRefund(match.entryFee) : 0;

  t.update(matchRef, {
    status: "completed", confirmedWinner, rewarded: true,
    winnerReward: bonusWin, winnerRc: 0, loserReward: 0, bonusDrawRefund: refund,
    walletType: "bonus", confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null,
  });

  return { winner: bonusWin, rc: 0, loser: 0, bonusDrawRefund: refund, confirmedWinner };
}

// =============================================================
// REWARD DISTRIBUTION -- GAMEPLAY AUTO-RESOLVE PATH
// =============================================================
async function distributeRewardAutoResolve(t, match, matchRef, confirmedWinner, nonSubmitterUid) {
  const winner  = winnerReward(match.entryFee);
  const rc      = winnerRc(match.entryFee);
  const loser   = loserReward(match.entryFee);
  const plat    = platformFee(match.entryFee);
  const dRefund = drawRefund(match.entryFee);
  const dPlat   = drawPlatformFee(match.entryFee);

  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);
  const platformRef = db.collection("platform").doc("earnings");

  const [playerA_Doc, playerB_Doc, platformDoc] = await Promise.all([
    t.get(playerA_Ref), t.get(playerB_Ref), t.get(platformRef),
  ]);

  if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const aUpdated = Object.assign({}, playerA_Data, { completedMatches: inc(playerA_Data.completedMatches), totalMatches: inc(playerA_Data.totalMatches) });
    const bUpdated = Object.assign({}, playerB_Data, { completedMatches: inc(playerB_Data.completedMatches), totalMatches: inc(playerB_Data.totalMatches) });
    t.update(playerA_Ref, { coins: inc(playerA_Data.coins, dRefund), draws: inc(playerA_Data.draws), totalMatches: inc(playerA_Data.totalMatches), completedMatches: inc(playerA_Data.completedMatches) });
    t.update(playerB_Ref, { coins: inc(playerB_Data.coins, dRefund), draws: inc(playerB_Data.draws), totalMatches: inc(playerB_Data.totalMatches), completedMatches: inc(playerB_Data.completedMatches) });
    applyCleanMatchReward(t, playerA_Ref, aUpdated);
    applyCleanMatchReward(t, playerB_Ref, bUpdated);
    const platformCoins = platformDoc.exists ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0) : 0;
    t.set(platformRef, { totalCoins: inc(platformCoins, dPlat), lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    updateLiveActivity(null, match.entryFee, true).catch(() => {});
  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();
    const winnerUpdated = Object.assign({}, winnerData, { completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0) });
    const loserUpdated  = Object.assign({}, loserData,  { completedMatches: inc(loserData.completedMatches  != null ? loserData.completedMatches  : 0), totalMatches: inc(loserData.totalMatches  != null ? loserData.totalMatches  : 0) });

    t.update(winnerRef, { coins: inc(winnerData.coins != null ? winnerData.coins : 0, winner), wins: inc(winnerData.wins != null ? winnerData.wins : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0), completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0) });
    t.update(loserRef,  { coins: inc(loserData.coins  != null ? loserData.coins  : 0, loser),  losses: inc(loserData.losses != null ? loserData.losses : 0), totalMatches: inc(loserData.totalMatches != null ? loserData.totalMatches : 0), completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0) });

    if (rc > 0 && confirmedWinner !== nonSubmitterUid) t.update(winnerRef, { rcBalance: (Number(winnerData.rcBalance) || 0) + rc });
    if (confirmedWinner !== nonSubmitterUid) applyCleanMatchReward(t, winnerRef, winnerUpdated);
    if (loserUid        !== nonSubmitterUid) applyCleanMatchReward(t, loserRef,  loserUpdated);

    const platformCoins = platformDoc.exists ? (platformDoc.data().totalCoins != null ? platformDoc.data().totalCoins : 0) : 0;
    t.set(platformRef, { totalCoins: inc(platformCoins, plat), lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    if (rc > 0 && confirmedWinner !== nonSubmitterUid) {
      createTransactionRecord(confirmedWinner, "rc_earned", rc, "RC earned for winning match (auto-resolved) " + match.id,
        { matchId: match.id, entryFee: match.entryFee, coinsWon: winner, walletType: "gameplay" }).catch(() => {});
    }
    updateLiveActivity(winnerData.displayName || "Player", match.entryFee, false).catch(() => {});
  }

  t.update(matchRef, {
    status: "completed", confirmedWinner, rewarded: true,
    winnerReward: confirmedWinner === "draw" ? 0 : winner,
    winnerRc:     confirmedWinner === "draw" ? 0 : rc,
    loserReward:  confirmedWinner === "draw" ? 0 : loser,
    walletType: "gameplay", confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null,
  });

  return { winner, rc, loser, confirmedWinner };
}

// =============================================================
// REWARD DISTRIBUTION -- BONUS AUTO-RESOLVE PATH
// =============================================================
async function distributeBonusRewardAutoResolve(t, match, matchRef, confirmedWinner, nonSubmitterUid) {
  const playerA_Ref = db.collection("users").doc(match.playerA);
  const playerB_Ref = db.collection("users").doc(match.playerB);

  const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);
  if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");

  const playerA_Data = playerA_Doc.data();
  const playerB_Data = playerB_Doc.data();

  if (confirmedWinner === "draw") {
    const refund = bonusDrawRefund(match.entryFee);
    t.update(playerA_Ref, { bonusCoins: inc(Number(playerA_Data.bonusCoins) || 0, refund), draws: inc(playerA_Data.draws), totalMatches: inc(playerA_Data.totalMatches), completedMatches: inc(playerA_Data.completedMatches) });
    t.update(playerB_Ref, { bonusCoins: inc(Number(playerB_Data.bonusCoins) || 0, refund), draws: inc(playerB_Data.draws), totalMatches: inc(playerB_Data.totalMatches), completedMatches: inc(playerB_Data.completedMatches) });
    updateLiveActivity(null, match.entryFee, true).catch(() => {});
  } else {
    const loserUid   = confirmedWinner === match.playerA ? match.playerB : match.playerA;
    const winnerRef  = db.collection("users").doc(confirmedWinner);
    const loserRef   = db.collection("users").doc(loserUid);
    const winnerDoc  = confirmedWinner === match.playerA ? playerA_Doc : playerB_Doc;
    const loserDoc   = loserUid        === match.playerA ? playerA_Doc : playerB_Doc;
    const winnerData = winnerDoc.data();
    const loserData  = loserDoc.data();
    const bonusWin   = bonusWinnerReward(match.entryFee);

    if (confirmedWinner !== nonSubmitterUid) {
      t.update(winnerRef, { coins: inc(winnerData.coins != null ? winnerData.coins : 0, bonusWin), wins: inc(winnerData.wins != null ? winnerData.wins : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0), completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0) });
    } else {
      t.update(winnerRef, { wins: inc(winnerData.wins != null ? winnerData.wins : 0), totalMatches: inc(winnerData.totalMatches != null ? winnerData.totalMatches : 0), completedMatches: inc(winnerData.completedMatches != null ? winnerData.completedMatches : 0) });
    }
    t.update(loserRef, { losses: inc(loserData.losses != null ? loserData.losses : 0), totalMatches: inc(loserData.totalMatches != null ? loserData.totalMatches : 0), completedMatches: inc(loserData.completedMatches != null ? loserData.completedMatches : 0) });
    updateLiveActivity(winnerDoc.data().displayName || "Player", match.entryFee, false).catch(() => {});
  }

  const bonusWin = confirmedWinner === "draw" ? 0 : bonusWinnerReward(match.entryFee);
  const refund   = confirmedWinner === "draw" ? bonusDrawRefund(match.entryFee) : 0;

  t.update(matchRef, {
    status: "completed", confirmedWinner, rewarded: true,
    winnerReward: bonusWin, winnerRc: 0, loserReward: 0, bonusDrawRefund: refund,
    walletType: "bonus", confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null,
  });

  return { winner: bonusWin, rc: 0, loser: 0, bonusDrawRefund: refund, confirmedWinner };
}

// =============================================================
// HEALTH
// =============================================================
app.get("/",       (_req, res) => res.send("Duelix backend is live"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// =============================================================
// LAST SEEN UPDATE ENDPOINT (HEARTBEAT)
// =============================================================
app.post("/user/last-seen", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    await db.collection("users").doc(uid).set(
      { lastSeen: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return res.json({ message: "lastSeen updated" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// LIVE ACTIVITY -- PUBLIC READ ENDPOINT
// =============================================================
app.get("/platform/live-activity", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("platform").doc("live_activity").get();
    if (!doc.exists) return res.json({ matchesPlayedToday: 0, onlinePlayers: 0, recentWinners: [] });
    return res.json(doc.data());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// MATCH ROOM PRESENCE ENDPOINTS
// =============================================================

app.post("/matches/presence/enter", verifyToken, async (req, res) => {
  const uid         = req.user.uid;
  const { matchId } = req.body;
  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }
  try {
    const { role } = await getPresenceRole(matchId.trim(), uid);
    const inField  = role === "A" ? "playerAInMatchRoom" : "playerBInMatchRoom";
    const hbField  = role === "A" ? "playerAHeartbeat"   : "playerBHeartbeat";
    await db.collection("matches").doc(matchId.trim()).update({
      [inField]: true,
      [hbField]: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[presence] enter matchId=" + matchId + " uid=" + uid + " role=" + role);
    return res.json({ message: "Presence entered", role });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/presence/heartbeat", verifyToken, async (req, res) => {
  const uid         = req.user.uid;
  const { matchId } = req.body;
  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }
  try {
    const { role } = await getPresenceRole(matchId.trim(), uid);
    const inField  = role === "A" ? "playerAInMatchRoom" : "playerBInMatchRoom";
    const hbField  = role === "A" ? "playerAHeartbeat"   : "playerBHeartbeat";
    await db.collection("matches").doc(matchId.trim()).update({
      [inField]: true,
      [hbField]: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ message: "Heartbeat updated", role });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/matches/presence/leave", verifyToken, async (req, res) => {
  const uid         = req.user.uid;
  const { matchId } = req.body;
  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }
  try {
    const { role } = await getPresenceRole(matchId.trim(), uid);
    const inField  = role === "A" ? "playerAInMatchRoom" : "playerBInMatchRoom";
    await db.collection("matches").doc(matchId.trim()).update({ [inField]: false });
    console.log("[presence] leave matchId=" + matchId + " uid=" + uid + " role=" + role);
    return res.json({ message: "Presence left", role });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/matches/:matchId/presence", verifyToken, async (req, res) => {
  try {
    const matchDoc = await db.collection("matches").doc(req.params.matchId).get();
    if (!matchDoc.exists) return res.status(404).json({ error: "Match not found" });
    const d   = matchDoc.data();
    const now = Date.now();
    function computePresent(inRoom, hbTimestamp) {
      if (!inRoom) return false;
      if (!hbTimestamp) return false;
      const ms = hbTimestamp._seconds ? hbTimestamp._seconds * 1000 : hbTimestamp.toMillis ? hbTimestamp.toMillis() : 0;
      return (now - ms) <= PRESENCE_STALE_MS;
    }
    return res.json({
      playerA: { uid: d.playerA || null, inMatchRoom: computePresent(d.playerAInMatchRoom, d.playerAHeartbeat) },
      playerB: { uid: d.playerB || null, inMatchRoom: computePresent(d.playerBInMatchRoom, d.playerBHeartbeat) },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// INVITE SYSTEM
// =============================================================

app.get("/api/matches/:matchId/invite", async (req, res) => {
  const { matchId } = req.params;

  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }

  try {
    const match = await validateInviteMatch(matchId.trim());

    const hostDoc = await db.collection("users").doc(match.playerA).get();
    const hostData = hostDoc.exists ? hostDoc.data() : {};

    const hostTrustScore = hostDoc.exists ? computeTrustScore(hostData) : 80;
    const hostUsername   = hostData.displayName || "Unknown Player";
    const hostAvatar     = hostData.avatar       || "assets/avatars/avatar1.png";

    const walletType = validateWalletType(match.walletType);
    const fee        = match.entryFee || 0;

    const wReward = walletType === "bonus" ? bonusWinnerReward(fee) : winnerReward(fee);
    const wRc     = walletType === "bonus" ? 0 : winnerRc(fee);
    const lReward = walletType === "bonus" ? 0 : loserReward(fee);

    return res.json({
      matchId:      matchId.trim(),
      gameType:     match.game        || "",
      matchType:    match.matchType   || "private",
      walletType,
      matchTicket:  fee,
      winnerReward: wReward,
      winnerRc:     wRc,
      loserReward:  lReward,
      hostUsername,
      hostTrustScore,
      hostAvatar,
      status:       match.status,
      inviteEnabled: match.inviteEnabled !== false,
    });
  } catch (err) {
    if (
      err.message === "Match not found" ||
      err.message.includes("cancelled") ||
      err.message.includes("completed") ||
      err.message.includes("no longer") ||
      err.message.includes("already full") ||
      err.message.includes("expired")
    ) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.post("/matches/join-by-invite", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid         = req.user.uid;

  if (!matchId || typeof matchId !== "string" || !matchId.trim()) {
    return res.status(400).json({ error: "matchId is required" });
  }

  const safeMatchId = matchId.trim();

  try {
    const activeSnap = await db.collection("matches")
      .where("status", "in", ["waiting", "active"])
      .where("players", "array-contains", uid)
      .limit(1)
      .get();

    const otherActive = activeSnap.docs.filter((d) => d.id !== safeMatchId);
    if (otherActive.length > 0) {
      return res.status(400).json({
        error: "You are already in another active match. Finish it before joining a new one.",
      });
    }
  } catch (err) {
    console.error("[join-by-invite] active match check:", err.message);
  }

  try {
    let joinedMatch = null;
    let hostUid     = null;
    let hostUsername = "";
    let joinerUsername = "";

    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(safeMatchId);
      const userRef  = db.collection("users").doc(uid);

      const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);

      if (!matchDoc.exists) throw new Error("Match not found");
      if (!userDoc.exists)  throw new Error("User not found");

      const match      = matchDoc.data();
      const userData   = userDoc.data();
      const walletType = validateWalletType(match.walletType);

      if (match.playerA === uid)  throw new Error("You cannot join your own match");
      if (match.playerB != null)  throw new Error("This match is already full");
      if (match.status !== "waiting") throw new Error("This match is no longer available");
      if (match.inviteEnabled === false) throw new Error("Invites are disabled for this match");

      const createdAt = match.createdAt;
      if (createdAt) {
        const createdMs = createdAt._seconds
          ? createdAt._seconds * 1000
          : createdAt.toMillis ? createdAt.toMillis() : 0;
        if (createdMs > 0 && (Date.now() - createdMs) > INVITE_EXPIRY_MS) {
          throw new Error("This invite link has expired");
        }
      }

      if (walletType === "bonus") {
        const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
        if (bonusCoins < match.entryFee) throw new Error("Insufficient Bonus Coins to join this match");
        t.update(userRef, { bonusCoins: bonusCoins - match.entryFee });
      } else {
        const coins = userData.coins != null ? userData.coins : 0;
        if (coins < match.entryFee) throw new Error("Insufficient Gameplay Coins to join this match");
        t.update(userRef, { coins: coins - match.entryFee });
      }

      hostUid      = match.playerA;
      joinerUsername = userData.displayName || "Player";

      const now = admin.firestore.FieldValue.serverTimestamp();

      t.update(matchRef, {
        playerB:        uid,
        opponentUid:    uid,
        opponentUsername: joinerUsername,
        players:        admin.firestore.FieldValue.arrayUnion(uid),
        status:         "active",
        startedAt:      now,
        matchStartedAt: now,
        joinedAt:       now,
        joinedViaInvite: true,
        inviteEnabled:  false,
      });

      joinedMatch = {
        matchId: safeMatchId,
        playerA: match.playerA,
        playerB: uid,
        game:    match.game,
        entryFee: match.entryFee,
        walletType,
        status: "active",
        winnerReward: walletType === "bonus" ? bonusWinnerReward(match.entryFee) : winnerReward(match.entryFee),
        winnerRc:     walletType === "bonus" ? 0 : winnerRc(match.entryFee),
        loserReward:  walletType === "bonus" ? 0 : loserReward(match.entryFee),
      };
    });

    try {
      const hostDoc = await db.collection("users").doc(hostUid).get();
      hostUsername = hostDoc.exists ? (hostDoc.data().displayName || "Host") : "Host";
    } catch (_) {}

    notifyInviteJoined(hostUid, joinerUsername, safeMatchId, joinedMatch.game).catch(() => {});
    notifyMatchStarted(hostUid, uid, safeMatchId, joinedMatch.game).catch(() => {});

    console.log("[join-by-invite] matchId=" + safeMatchId + " joiner=" + uid + " host=" + hostUid);

    return res.json({
      message:     "Joined match successfully via invite",
      match:       joinedMatch,
      hostUsername,
    });
  } catch (err) {
    const code = err.message.includes("already full")     ? 409
               : err.message.includes("own match")        ? 400
               : err.message.includes("expired")          ? 410
               : err.message.includes("not available")    ? 410
               : err.message.includes("Insufficient")     ? 402
               : err.message.includes("already in another") ? 409
               : 400;
    return res.status(code).json({ error: err.message });
  }
});

// =============================================================
// PAYSTACK WEBHOOK
// =============================================================
app.post("/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!PAYSTACK_SECRET_KEY) { console.error("[webhook] PAYSTACK_SECRET_KEY not configured"); return res.status(500).send("Server misconfiguration"); }
  if (!signature) { console.warn("[webhook] Missing x-paystack-signature header"); return res.status(400).send("Missing signature"); }
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) { console.warn("[webhook] Empty or non-buffer body"); return res.status(400).send("Empty body"); }
  const expectedSignature = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  if (expectedSignature !== signature) { console.warn("[webhook] Signature mismatch"); return res.status(400).send("Invalid signature"); }
  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); } catch (parseErr) { console.error("[webhook] Failed to parse body:", parseErr.message); return res.status(400).send("Invalid JSON"); }
  const eventType = event.event || "";
  console.log("[webhook] Received event=" + eventType);
  res.status(200).send("OK");
  if (eventType !== "charge.success") return;
  const txData        = event.data || {};
  const reference     = (txData.reference  || "").trim();
  const txStatus      = (txData.status     || "").toLowerCase();
  const amount        = Number(txData.amount) || 0;
  const currency      = (txData.currency   || "").toUpperCase();
  const customerEmail = txData.customer && txData.customer.email ? txData.customer.email : null;
  if (!reference || txStatus !== "success") return;
  (async () => {
    try {
      const existingSnap = await db.collection("coin_purchases").where("reference", "==", reference).limit(1).get();
      if (!existingSnap.empty) return;
      let pendingDocSnap = await db.collection("pending_purchases").doc(reference).get();
      if (!pendingDocSnap.exists) { await new Promise((resolve) => setTimeout(resolve, 3000)); pendingDocSnap = await db.collection("pending_purchases").doc(reference).get(); }
      if (!pendingDocSnap.exists) return;
      const pendingData = pendingDocSnap.data();
      const uid = pendingData.uid;
      if (!uid) return;
      const pkg = COIN_PACKAGES[pendingData.packageId];
      if (!pkg) return;
      if (amount < pkg.koboAmount || currency !== pkg.currency.toUpperCase()) return;
      const pkgWithMeta = Object.assign({}, pkg, { amountCharged: amount, chargedCurrency: currency, source: "webhook" });
      let creditResult;
      try { creditResult = await creditCoinsForReference(reference, uid, pkgWithMeta, customerEmail); }
      catch (creditErr) { if (creditErr.message === "ALREADY_CREDITED") return; throw creditErr; }
      const { newCoinBalance, isFirstPurchase } = creditResult;
      notifyCoinPurchase(uid, pkg.coins, newCoinBalance, pkg.label).catch(() => {});
      createTransactionRecord(uid, "coin_purchase", pkg.coins, "Coin purchase: " + pkg.label + " (" + pkg.coins + " coins)", { packageId: pendingData.packageId, packageLabel: pkg.label, reference, amountCharged: amount, currency, newCoinBalance }).catch(() => {});
      if (isFirstPurchase) tryGrantReferralReward(uid).catch(() => {});
    } catch (err) { console.error("[webhook] Processing error for ref=" + reference + ":", err.message); }
  })();
});

// =============================================================
// STORE -- INITIALIZE PAYMENT
// =============================================================
app.post("/store/initialize-payment", verifyToken, async (req, res) => {
  const { packageId, email } = req.body;
  const uid = req.user.uid;
  if (!packageId || typeof packageId !== "string" || !packageId.trim()) return res.status(400).json({ error: "packageId is required" });
  if (!email || typeof email !== "string" || !email.trim()) return res.status(400).json({ error: "email is required" });
  const safePackageId = packageId.trim();
  const pkg           = COIN_PACKAGES[safePackageId];
  if (!pkg) return res.status(400).json({ error: "Unknown package: " + safePackageId });
  const reference = "duelix_" + uid.substring(0, 8) + "_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  try {
    const paystackData = await initializePaystackTransaction(email.trim(), pkg.koboAmount, pkg.currency, reference, { uid, packageId: safePackageId, packageLabel: pkg.label, coins: pkg.coins });
    const authUrl     = paystackData.authorization_url || null;
    const paystackRef = paystackData.reference         || reference;
    const accessCode  = paystackData.access_code       || null;
    if (!authUrl) return res.status(502).json({ error: "Paystack did not return a payment URL. Please try again." });
    await db.collection("pending_purchases").doc(paystackRef).set({ uid, packageId: safePackageId, packageLabel: pkg.label, coins: pkg.coins, amountKobo: pkg.koboAmount, currency: pkg.currency, reference: paystackRef, status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ authorization_url: authUrl, authorizationUrl: authUrl, reference: paystackRef, access_code: accessCode });
  } catch (err) {
    return res.status(502).json({ error: "Payment initialization failed: " + err.message });
  }
});

// =============================================================
// STORE -- VERIFY PURCHASE
// =============================================================
app.post("/store/verify-purchase", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { reference } = req.body;
  if (!reference || typeof reference !== "string" || !reference.trim()) return res.status(400).json({ error: "reference is required" });
  const safeRef = reference.trim();
  try {
    const existingSnap = await db.collection("coin_purchases").where("reference", "==", safeRef).limit(1).get();
    if (!existingSnap.empty) {
      const userDoc     = await db.collection("users").doc(uid).get();
      const coinBalance = userDoc.exists ? (userDoc.data().coins || 0) : 0;
      const rcBalance   = userDoc.exists ? (userDoc.data().rcBalance || 0) : 0;
      return res.status(409).json({ error: "This payment has already been processed.", newCoinBalance: coinBalance, newRcBalance: rcBalance, coinsAdded: existingSnap.docs[0].data().coinsAdded || 0 });
    }
    const pendingDocSnap = await db.collection("pending_purchases").doc(safeRef).get();
    if (!pendingDocSnap.exists) return res.status(400).json({ error: "No pending purchase found for this reference." });
    const pendingData = pendingDocSnap.data();
    if (pendingData.uid !== uid) return res.status(403).json({ error: "Reference does not belong to this account." });
    const pkg = COIN_PACKAGES[pendingData.packageId];
    if (!pkg) return res.status(400).json({ error: "Unknown package in pending record: " + pendingData.packageId });
    let paystackData;
    try { paystackData = await verifyPaystackTransaction(safeRef); }
    catch (verifyErr) { return res.status(502).json({ error: "Payment verification failed: " + verifyErr.message }); }
    if (!paystackData.status || paystackData.status !== "success") return res.status(400).json({ error: "Payment was not completed. Status: " + (paystackData.status || "unknown") });
    const chargedAmount   = Number(paystackData.amount)   || 0;
    const chargedCurrency = (paystackData.currency        || "").toUpperCase();
    if (chargedAmount < pkg.koboAmount) return res.status(400).json({ error: "Payment amount does not match the selected package." });
    if (chargedCurrency !== pkg.currency.toUpperCase()) return res.status(400).json({ error: "Payment currency does not match the selected package." });
    const pkgWithMeta = Object.assign({}, pkg, { amountCharged: chargedAmount, chargedCurrency: chargedCurrency, source: "verify" });
    let creditResult;
    try { creditResult = await creditCoinsForReference(safeRef, uid, pkgWithMeta, paystackData.customer && paystackData.customer.email ? paystackData.customer.email : null); }
    catch (creditErr) {
      if (creditErr.message === "ALREADY_CREDITED") {
        const userDoc     = await db.collection("users").doc(uid).get();
        const coinBalance = userDoc.exists ? (userDoc.data().coins || 0) : 0;
        const rcBalance   = userDoc.exists ? (userDoc.data().rcBalance || 0) : 0;
        return res.status(409).json({ error: "This payment has already been processed.", newCoinBalance: coinBalance, newRcBalance: rcBalance, coinsAdded: pkg.coins });
      }
      throw creditErr;
    }
    const { newCoinBalance, newRcBalance, isFirstPurchase } = creditResult;
    notifyCoinPurchase(uid, pkg.coins, newCoinBalance, pkg.label).catch(() => {});
    createTransactionRecord(uid, "coin_purchase", pkg.coins, "Coin purchase: " + pkg.label + " (" + pkg.coins + " coins)", { packageId: pendingData.packageId, packageLabel: pkg.label, reference: safeRef, amountCharged: chargedAmount, currency: chargedCurrency, newCoinBalance }).catch(() => {});
    if (isFirstPurchase) tryGrantReferralReward(uid).catch(() => {});
    return res.json({ message: "Purchase verified and coins credited", coinsAdded: pkg.coins, newCoinBalance, newRcBalance });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// STORE -- PURCHASE HISTORY
// =============================================================
app.get("/store/purchase-history", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection("coin_purchases").where("userId", "==", uid).where("status", "==", "completed").orderBy("createdAt", "desc").limit(20).get();
    const history = snap.docs.map((doc) => {
      const d = doc.data();
      return { id: d.id || doc.id, packageId: d.packageId || "", packageLabel: d.packageLabel || "", coinsAdded: d.coinsAdded || 0, reference: d.reference || "", amountCharged: d.amountCharged || 0, currency: d.currency || "GHS", status: d.status || "completed", newCoinBalance: d.newCoinBalance || null, createdAt: d.createdAt || null };
    });
    return res.json({ history });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// RC BALANCE
// =============================================================
app.get("/rc/balance/:uid", verifyToken, async (req, res) => {
  try {
    const doc       = await db.collection("users").doc(req.params.uid).get();
    const rcBalance = doc.exists && doc.data().rcBalance != null ? doc.data().rcBalance : 0;
    return res.json({ rcBalance });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// RC REDEEM
// =============================================================
app.post("/rc/redeem", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { rcAmount, network, accountName } = req.body;
  if (typeof rcAmount !== "number" || !Number.isInteger(rcAmount)) return res.status(400).json({ error: "rcAmount must be an integer" });
  if (rcAmount < 200) return res.status(400).json({ error: "Minimum redemption is 200 RC" });
  if (rcAmount % 100 !== 0) return res.status(400).json({ error: "RC amount must be a multiple of 100" });
  if (!network || typeof network !== "string" || !network.trim()) return res.status(400).json({ error: "network is required" });
  if (!accountName || typeof accountName !== "string" || !accountName.trim()) return res.status(400).json({ error: "accountName is required" });
  const safeNetwork     = network.trim();
  const safeAccountName = accountName.trim().substring(0, 80);
  const usdValue        = rcAmount / 100;
  try {
    const userDocPre = await db.collection("users").doc(uid).get();
    if (!userDocPre.exists) return res.status(404).json({ error: "User not found" });
    const phone = userDocPre.data().phone || "";
    let newRcBalance = 0;
    await db.runTransaction(async (t) => {
      const userRef = db.collection("users").doc(uid);
      const snap    = await t.get(userRef);
      if (!snap.exists) throw new Error("User not found");
      const currentRc = Number(snap.data().rcBalance) || 0;
      if (rcAmount > currentRc) throw new Error("Insufficient RC balance. You have " + currentRc + " RC.");
      newRcBalance = currentRc - rcAmount;
      t.update(userRef, { rcBalance: newRcBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const redeemRef = db.collection("redemption_requests").doc();
      t.set(redeemRef, { id: redeemRef.id, userId: uid, rcAmount, usdValue, phone, network: safeNetwork, accountName: safeAccountName, status: "pending", adminNote: null, resolvedAt: null, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    notifyRedemptionRequested(uid, rcAmount, usdValue).catch(() => {});
    createTransactionRecord(uid, "redemption_requested", -rcAmount, "RC redemption request: " + rcAmount + " RC ($" + usdValue.toFixed(2) + ")", { rcAmount, usdValue, network: safeNetwork, accountName: safeAccountName, status: "pending" }).catch(() => {});
    return res.json({ message: "Redemption request submitted", newRcBalance });
  } catch (err) {
    if (err.message.startsWith("Insufficient RC")) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// RC CONVERT TO GAMEPLAY COINS
// =============================================================
app.post("/rc/convert", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { rcAmount } = req.body;

  if (rcAmount === null || rcAmount === undefined) {
    return res.status(400).json({ error: "rcAmount is required" });
  }
  if (typeof rcAmount !== "number") {
    return res.status(400).json({ error: "rcAmount must be a number" });
  }
  if (!Number.isInteger(rcAmount)) {
    return res.status(400).json({ error: "rcAmount must be a whole integer — no decimals allowed" });
  }
  if (rcAmount < 5) {
    return res.status(400).json({ error: "Minimum conversion is 5 RC" });
  }
  if (rcAmount <= 0) {
    return res.status(400).json({ error: "rcAmount must be a positive integer" });
  }

  try {
    let newRcBalance    = 0;
    let newCoinBalance  = 0;
    const coinsToCredit = rcAmount;

    await db.runTransaction(async (t) => {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await t.get(userRef);

      if (!userDoc.exists) throw new Error("User not found");

      const userData   = userDoc.data();
      const currentRc  = Number(userData.rcBalance) || 0;
      const currentCns = Number(userData.coins)     || 0;

      if (rcAmount > currentRc) {
        throw new Error("Insufficient RC balance. You have " + currentRc + " RC.");
      }

      newRcBalance   = currentRc  - rcAmount;
      newCoinBalance = currentCns + coinsToCredit;

      t.update(userRef, {
        rcBalance:  newRcBalance,
        coins:      newCoinBalance,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      const txRef = db.collection("transactions").doc();
      t.set(txRef, {
        id:          txRef.id,
        userId:      uid,
        type:        "rc_converted",
        amount:      coinsToCredit,
        description: "Converted " + rcAmount + " RC into " + coinsToCredit + " Gameplay Coins",
        status:      "completed",
        rcDeducted:  rcAmount,
        coinsAdded:  coinsToCredit,
        newRcBalance,
        newCoinBalance,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    notifyRcConverted(uid, rcAmount, coinsToCredit).catch(() => {});

    console.log("[rc/convert] uid=" + uid + " rcAmount=" + rcAmount + " coinsAdded=" + coinsToCredit + " newRcBalance=" + newRcBalance + " newCoinBalance=" + newCoinBalance);

    return res.json({
      message:        "Successfully converted " + rcAmount + " RC into " + coinsToCredit + " Gameplay Coins.",
      rcDeducted:     rcAmount,
      coinsAdded:     coinsToCredit,
      newRcBalance,
      newCoinBalance,
    });
  } catch (err) {
    if (err.message.startsWith("Insufficient RC")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === "User not found") {
      return res.status(404).json({ error: err.message });
    }
    console.error("[rc/convert] uid=" + uid + " error=" + err.message);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// RC HISTORY
// =============================================================
app.get("/rc/history", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection("redemption_requests").where("userId", "==", uid).orderBy("createdAt", "desc").limit(50).get();
    return res.json(snap.docs.map((doc) => doc.data()));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// FCM TOKEN
// =============================================================
app.post("/save-fcm-token", verifyToken, async (req, res) => {
  const uid       = req.user.uid;
  const { token } = req.body;
  if (!token || typeof token !== "string" || !token.trim()) return res.status(400).json({ error: "token is required" });
  try {
    await db.collection("users").doc(uid).update({ fcmToken: token.trim(), fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    touchLastSeen(uid).catch(() => {});
    return res.json({ message: "FCM token saved" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.delete("/save-fcm-token", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    await db.collection("users").doc(uid).update({ fcmToken: admin.firestore.FieldValue.delete(), fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ message: "FCM token removed" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// TRUST ENDPOINTS
// =============================================================
app.post("/trust/update", verifyToken, async (req, res) => {
  const targetUid = req.body.uid || req.user.uid;
  try {
    const userRef = db.collection("users").doc(targetUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
    const data = userDoc.data();
    await userRef.set({ trustScore: computeTrustScore(data), matchCompletionRate: computeCompletionRate(data), fairPlayRating: computeFairPlayRating(data), trustUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ message: "Trust score updated", trustScore: computeTrustScore(data) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
    return res.json({ message: "Rage quit recorded" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
    return res.json({ message: "Dispute penalty applied" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
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
    return res.json({ message: "Fake result penalty applied" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// CREATE USER PROFILE  ← country/currency auto-detected here
// =============================================================
app.post("/users/create-profile", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { displayName, phone, email, deviceId, installId } = req.body;
  if (!displayName || !phone) return res.status(400).json({ error: "displayName and phone are required" });
  if (!/^\+\d{7,15}$/.test(phone)) return res.status(400).json({ error: "phone must be in E.164 format" });
  const name = displayName.trim();
  if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) return res.status(400).json({ error: "displayName: 3-20 chars, letters/numbers/underscores/dots only" });
  const ipAddress = req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket.remoteAddress || null;

  // Detect country and currency from the phone number
  const { country, currency } = detectCountryFromPhone(phone);
  console.log("[create-profile] uid=" + uid + " phone=" + phone + " country=" + country + " currency=" + currency);

  try {
    if (ipAddress && (await isIpAbusive(ipAddress))) return res.status(429).json({ error: "Too many accounts registered from this network." });
    const deviceCount = await countAccountsByDevice(deviceId, installId);
    if (deviceCount >= 3) detectSuspiciousActivity(uid, "multi_account_device count=" + deviceCount).catch(() => {});
    const userRef      = db.collection("users").doc(uid);
    const referralCode = await uniqueReferralCode();
    const phoneSnap = await db.collection("users").where("phone", "==", phone).limit(1).get();
    if (!phoneSnap.empty && phoneSnap.docs[0].id !== uid) return res.status(409).json({ error: "That phone number is already registered" });
    const nameSnap = await db.collection("users").where("displayName", "==", name).limit(1).get();
    if (!nameSnap.empty && nameSnap.docs[0].id !== uid) return res.status(409).json({ error: "That username is already taken" });
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (snap.exists) return;
      t.set(userRef, Object.assign({
        uid, displayName: name, phone, email: email != null ? email : "",
        country,    // ← new
        currency,   // ← new
        coins: 0, bonusCoins: 10, wins: 0, losses: 0, draws: 0, totalMatches: 0,
        loginStreak: 0, lastLogin: null,
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        avatar: "assets/avatars/avatar1.png",
        referralCode, referredBy: null, referredByName: null,
        referralCount: 0, referralRewardGranted: false, firstPurchaseDone: false,
        fcmToken: null, deviceId: deviceId || null, installId: installId || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, DEFAULT_TRUST_FIELDS));
    });
    recordDeviceFingerprint(uid, deviceId, installId, ipAddress).catch(() => {});
    notifyUser(uid, "system", "Welcome to Duelix!", "Your account is ready! You have 10 bonus coins to start. Play and win to earn more!", {}).catch(() => {});
    return res.status(201).json({ message: "Profile created", uid, referralCode, country, currency });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/user-exists/:uid", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.uid).get();
    return res.json({ exists: doc.exists });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// MIGRATION: ENSURE BONUS COINS AND LAST SEEN
// =============================================================
app.post("/users/ensure-fields", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
    const data    = userDoc.data();
    const updates = {};
    if (data.bonusCoins === undefined || data.bonusCoins === null) updates.bonusCoins = 0;
    if (!data.lastSeen) updates.lastSeen = admin.firestore.FieldValue.serverTimestamp();
    if (data.bonusMatchUsed !== undefined)      updates.bonusMatchUsed = admin.firestore.FieldValue.delete();
    if (data.firstMatchBonusUsed !== undefined) updates.firstMatchBonusUsed = admin.firestore.FieldValue.delete();

    // Backfill country/currency if missing
    if (!data.country || !data.currency) {
      const detected = detectCountryFromPhone(data.phone || "");
      if (!data.country)  updates.country  = detected.country;
      if (!data.currency) updates.currency = detected.currency;
    }

    if (Object.keys(updates).length > 0) await userRef.set(updates, { merge: true });
    return res.json({
      message:    "Fields ensured",
      bonusCoins: updates.bonusCoins !== undefined ? updates.bonusCoins : data.bonusCoins,
      lastSeen:   updates.lastSeen   !== undefined ? "set" : "already_present",
      country:    updates.country    || data.country,
      currency:   updates.currency   || data.currency,
      removed:    [
        data.bonusMatchUsed      !== undefined ? "bonusMatchUsed"      : null,
        data.firstMatchBonusUsed !== undefined ? "firstMatchBonusUsed" : null,
      ].filter(Boolean),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// REFERRAL SYSTEM
// =============================================================
app.post("/apply-referral", verifyToken, async (req, res) => {
  const currentUid       = req.user.uid;
  const { referralCode } = req.body;
  if (!referralCode || typeof referralCode !== "string") return res.status(400).json({ error: "referralCode is required" });
  const code = referralCode.trim().toUpperCase();
  try {
    const codeSnap = await db.collection("users").where("referralCode", "==", code).limit(1).get();
    if (codeSnap.empty) return res.status(404).json({ error: "Referral code not found" });
    const referrerUid  = codeSnap.docs[0].id;
    const referrerData = codeSnap.docs[0].data();
    if (referrerUid === currentUid) return res.status(400).json({ error: "You cannot use your own referral code" });
    await db.runTransaction(async (t) => {
      const currentRef  = db.collection("users").doc(currentUid);
      const referrerRef = db.collection("users").doc(referrerUid);
      const [currentDoc, referrerDoc] = await Promise.all([t.get(currentRef), t.get(referrerRef)]);
      if (!currentDoc.exists)           throw new Error("Your account was not found");
      if (currentDoc.data().referredBy) throw new Error("ALREADY_REFERRED");
      t.update(currentRef, { referredBy: referrerUid, referredByName: referrerData.displayName || "A friend" });
      if (referrerDoc.exists) t.update(referrerRef, { referralCount: inc(referrerDoc.data().referralCount != null ? referrerDoc.data().referralCount : 0) });
    });
    return res.json({ message: "Referral code linked. Rewards unlock after your first purchase." });
  } catch (err) {
    if (err.message === "ALREADY_REFERRED") return res.status(409).json({ error: "You have already used a referral code" });
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// USER ENDPOINTS
// =============================================================
app.get("/user/:uid", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const data  = doc.data();
    const patch = {};
    if (data.bonusCoins === undefined || data.bonusCoins === null) patch.bonusCoins = 0;
    if (!data.lastSeen) patch.lastSeen = admin.firestore.FieldValue.serverTimestamp();
    if (data.bonusMatchUsed !== undefined)      patch.bonusMatchUsed = admin.firestore.FieldValue.delete();
    if (data.firstMatchBonusUsed !== undefined) patch.firstMatchBonusUsed = admin.firestore.FieldValue.delete();

    // Backfill country/currency on read if missing
    if (!data.country || !data.currency) {
      const detected = detectCountryFromPhone(data.phone || "");
      if (!data.country)  patch.country  = detected.country;
      if (!data.currency) patch.currency = detected.currency;
    }

    if (data.trustScore === undefined) {
      const trustFields = {
        trustScore: 80, completedMatches: data.completedMatches || 0,
        cancelledMatches: data.cancelledMatches || 0, disputesLost: data.disputesLost || 0,
        reportsReceived: data.reportsReceived || 0, fakeResults: data.fakeResults || 0,
        rageQuits: data.rageQuits || 0, fairPlayRating: 100, matchCompletionRate: 0,
        cleanMatchBonus: 0, fairPlayBonus: 0, rcBalance: data.rcBalance || 0,
        bonusCoins: data.bonusCoins != null ? data.bonusCoins : 0,
        firstPurchaseDone: data.firstPurchaseDone || false,
        referralRewardGranted: data.referralRewardGranted || false,
        onlineStatus: data.onlineStatus !== undefined ? data.onlineStatus : true,
        friendRequests: data.friendRequests !== undefined ? data.friendRequests : true,
        country:  patch.country  || data.country  || "Unknown",
        currency: patch.currency || data.currency || "Unknown",
      };
      Object.assign(trustFields, patch);
      db.collection("users").doc(req.params.uid).set(Object.assign({}, trustFields, patch), { merge: true }).catch(() => {});
      const result = Object.assign({}, data, trustFields);
      delete result.bonusMatchUsed; delete result.firstMatchBonusUsed;
      return res.json(result);
    }
    const needsPatch = data.cleanMatchBonus === undefined || data.fairPlayBonus === undefined ||
      data.rcBalance === undefined || data.bonusCoins === undefined ||
      data.firstPurchaseDone === undefined || data.referralRewardGranted === undefined ||
      !data.lastSeen || !data.country || !data.currency ||
      data.bonusMatchUsed !== undefined || data.firstMatchBonusUsed !== undefined;
    if (needsPatch || Object.keys(patch).length > 0) {
      const fullPatch = Object.assign({
        cleanMatchBonus: data.cleanMatchBonus || 0, fairPlayBonus: data.fairPlayBonus || 0,
        rcBalance: data.rcBalance || 0, bonusCoins: data.bonusCoins != null ? data.bonusCoins : 0,
        firstPurchaseDone: data.firstPurchaseDone || false,
        referralRewardGranted: data.referralRewardGranted || false,
      }, patch);
      db.collection("users").doc(req.params.uid).set(fullPatch, { merge: true }).catch(() => {});
      const result = Object.assign({}, data, fullPatch);
      delete result.bonusMatchUsed; delete result.firstMatchBonusUsed;
      return res.json(result);
    }
    const result = Object.assign({}, data);
    delete result.bonusMatchUsed; delete result.firstMatchBonusUsed;
    return res.json(result);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/update-name", verifyToken, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });
  const name = displayName.trim();
  if (name.length < 3 || name.length > 20 || !/^[a-zA-Z0-9_.]+$/.test(name)) return res.status(400).json({ error: "displayName: 3-20 chars, letters/numbers/underscores/dots only" });
  try {
    const snap = await db.collection("users").where("displayName", "==", name).limit(1).get();
    if (!snap.empty && snap.docs[0].id !== req.user.uid) return res.status(409).json({ error: "That username is already taken" });
    await db.collection("users").doc(req.user.uid).update({ displayName: name });
    return res.json({ message: "Username updated" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/update-avatar", verifyToken, async (req, res) => {
  const { avatar, isAsset } = req.body;
  if (!avatar) return res.status(400).json({ error: "avatar required" });
  try {
    await db.collection("users").doc(req.user.uid).update({ avatar, avatarType: isAsset ? "asset" : "upload", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ message: "Avatar updated successfully" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/check-username/:username", verifyToken, async (req, res) => {
  try {
    const snap = await db.collection("users").where("displayName", "==", req.params.username).limit(1).get();
    return res.json({ available: snap.empty || snap.docs[0].id === req.user.uid });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// COINS
// =============================================================
app.get("/coins/:uid", verifyToken, async (req, res) => {
  try {
    const doc   = await db.collection("users").doc(req.params.uid).get();
    const coins = doc.exists && doc.data().coins != null ? doc.data().coins : 0;
    return res.json({ coins });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/add-coins", verifyToken, async (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "amount must be a positive integer" });
  try {
    const userRef = db.collection("users").doc(req.user.uid);
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("User not found");
      t.update(userRef, { coins: inc(doc.data().coins, amount) });
    });
    return res.json({ message: "Coins added" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/reset-account", verifyToken, async (req, res) => {
  const { coins } = req.body;
  const resetCoins = coins != null && Number.isInteger(coins) && coins >= 0 && coins <= 100000 ? coins : 0;
  try {
    await db.collection("users").doc(req.user.uid).update({ coins: resetCoins, wins: 0, losses: 0, draws: 0, totalMatches: 0 });
    return res.json({ message: "Account reset" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// MATCH SYSTEM
// =============================================================

app.post("/matches/create", verifyToken, async (req, res) => {
  const { game, entryFee, walletType: rawWalletType } = req.body;
  const uid        = req.user.uid;
  const walletType = validateWalletType(rawWalletType);
  if (!game || typeof game !== "string" || !game.trim()) return res.status(400).json({ error: "game is required" });
  try { validateEntryFee(entryFee); } catch (err) { return res.status(400).json({ error: err.message }); }
  const gameUpper = game.trim().toUpperCase();
  try {
    let matchId;
    await db.runTransaction(async (t) => {
      const userRef  = db.collection("users").doc(uid);
      const matchRef = db.collection("matches").doc();
      matchId = matchRef.id;
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");
      const userData = userDoc.data();
      if (walletType === "bonus") {
        const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
        if (bonusCoins < entryFee) throw new Error("Insufficient Bonus Coins");
        t.update(userRef, { bonusCoins: bonusCoins - entryFee });
      } else {
        const coins = userData.coins != null ? userData.coins : 0;
        if (coins < entryFee) throw new Error("Insufficient Gameplay Coins");
        t.update(userRef, { coins: coins - entryFee });
      }
      t.set(matchRef, {
        id: matchId, playerA: uid, playerB: null,
        hostUid: uid,
        hostUsername: userData.displayName || "",
        opponentUid: null, opponentUsername: null,
        players: [uid],
        game: gameUpper, entryFee, walletType,
        status: "waiting", matchType: "private",
        isPrivate: true, result: null, submittedBy: null, submittedAt: null,
        confirmedWinner: null, rewarded: false,
        inviteEnabled: true,
        joinedViaInvite: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        startedAt: null, matchStartedAt: null, joinedAt: null,
        rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null,
        autoResolved: false, autoCancelled: false, cancelReason: null,
        playerAInMatchRoom: false, playerBInMatchRoom: false,
        playerAHeartbeat:   null,  playerBHeartbeat:   null,
      });
    });
    notifyMatchCreated(uid, matchId, gameUpper, entryFee, walletType).catch(() => {});
    return res.status(201).json({
      matchId, status: "waiting", playerA: uid, playerB: null,
      game: gameUpper, entryFee, walletType,
      winnerReward: walletType === "bonus" ? bonusWinnerReward(entryFee) : winnerReward(entryFee),
      winnerRc:     walletType === "bonus" ? 0 : winnerRc(entryFee),
      loserReward:  walletType === "bonus" ? 0 : loserReward(entryFee),
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.get("/matches", verifyToken, async (req, res) => {
  try {
    const [waitingSnap, activeSnap] = await Promise.all([
      db.collection("matches").where("status", "==", "waiting").orderBy("createdAt", "desc").get(),
      db.collection("matches").where("status", "==", "active").orderBy("startedAt", "desc").get(),
    ]);
    const matches = [
      ...waitingSnap.docs.map((d) => d.data()),
      ...activeSnap.docs.map((d)  => d.data()),
    ].filter((m) => m.id && m.playerA && m.game);
    return res.json(matches);
  } catch (err) { return res.status(500).json({ error: "Failed to load matches." }); }
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
      const match      = matchDoc.data();
      const userData   = userDoc.data();
      const walletType = validateWalletType(match.walletType);
      if (match.status !== "waiting")  throw new Error("Match no longer available");
      if (match.playerA === uid)       throw new Error("Cannot join your own match");
      if (match.playerB != null)       throw new Error("Match already has an opponent");
      if (walletType === "bonus") {
        const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
        if (bonusCoins < match.entryFee) throw new Error("Insufficient Bonus Coins");
        t.update(userRef, { bonusCoins: bonusCoins - match.entryFee });
      } else {
        const coins = userData.coins != null ? userData.coins : 0;
        if (coins < match.entryFee) throw new Error("Insufficient Gameplay Coins");
        t.update(userRef, { coins: coins - match.entryFee });
      }
      const now = admin.firestore.FieldValue.serverTimestamp();
      t.update(matchRef, {
        playerB: uid,
        opponentUid: uid,
        opponentUsername: userData.displayName || "",
        players: admin.firestore.FieldValue.arrayUnion(uid),
        status: "active", startedAt: now, matchStartedAt: now, joinedAt: now,
        inviteEnabled: false,
      });
      joinedMatch = { matchId, playerA: match.playerA, playerB: uid, game: match.game, entryFee: match.entryFee, walletType, status: "active", winnerReward: walletType === "bonus" ? bonusWinnerReward(match.entryFee) : winnerReward(match.entryFee), winnerRc: walletType === "bonus" ? 0 : winnerRc(match.entryFee), loserReward: walletType === "bonus" ? 0 : loserReward(match.entryFee) };
    });
    notifyMatchJoined(joinedMatch.playerA, uid, matchId, joinedMatch.game).catch(() => {});
    notifyMatchStarted(joinedMatch.playerA, uid, matchId, joinedMatch.game).catch(() => {});
    return res.json({ message: "Joined match successfully", match: joinedMatch });
  } catch (err) { return res.status(400).json({ error: err.message }); }
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
      const match      = matchDoc.data();
      const userData   = userDoc.data();
      const walletType = validateWalletType(match.walletType);
      if (match.playerA !== uid)      throw new Error("Only the match creator can cancel");
      if (match.playerB != null)      throw new Error("Cannot cancel -- opponent has already joined");
      if (match.status !== "waiting") throw new Error("Match cannot be cancelled at this stage");
      entryFeeRefunded = match.entryFee;
      if (walletType === "bonus") {
        const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
        t.update(userRef, { bonusCoins: bonusCoins + match.entryFee });
      } else {
        t.update(userRef, { coins: inc(userData.coins, match.entryFee) });
      }
      t.update(matchRef, { status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp(), inviteEnabled: false });
    });
    notifyMatchCancelled(uid, matchId, entryFeeRefunded).catch(() => {});
    return res.json({ message: "Match cancelled -- match ticket refunded" });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/quick-match", verifyToken, async (req, res) => {
  const { game, entryFee, walletType: rawWalletType } = req.body;
  const uid        = req.user.uid;
  const walletType = validateWalletType(rawWalletType);
  if (!game || typeof game !== "string" || !game.trim()) return res.status(400).json({ error: "game is required" });
  try { validateEntryFee(entryFee); } catch (err) { return res.status(400).json({ error: err.message }); }
  const gameUpper = game.trim().toUpperCase();
  try {
    let matchId = null, didCreate = false, playerAUid = null;
    const candidateSnap = await db.collection("matches").where("status", "==", "waiting").where("game", "==", gameUpper).where("entryFee", "==", entryFee).where("walletType", "==", walletType).where("isPrivate", "==", false).orderBy("createdAt", "asc").limit(10).get();
    const candidates = candidateSnap.docs.filter((doc) => { const d = doc.data(); return d.playerA !== uid && d.playerB === null; });
    if (candidates.length > 0) {
      matchId = candidates[0].id;
      await db.runTransaction(async (t) => {
        const matchRef = db.collection("matches").doc(matchId);
        const userRef  = db.collection("users").doc(uid);
        const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);
        if (!matchDoc.exists) throw new Error("Match no longer exists");
        if (!userDoc.exists)  throw new Error("User not found");
        const match    = matchDoc.data();
        const userData = userDoc.data();
        if (match.status !== "waiting")  throw new Error("Match no longer available");
        if (match.playerA === uid)       throw new Error("Cannot join your own match");
        if (match.playerB != null)       throw new Error("Match already taken");
        if (match.isPrivate === true)    throw new Error("Cannot join a private match");
        if (walletType === "bonus") {
          const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
          if (bonusCoins < match.entryFee) throw new Error("Insufficient Bonus Coins");
          t.update(userRef, { bonusCoins: bonusCoins - match.entryFee });
        } else {
          const coins = userData.coins != null ? userData.coins : 0;
          if (coins < match.entryFee) throw new Error("Insufficient Gameplay Coins");
          t.update(userRef, { coins: coins - match.entryFee });
        }
        playerAUid = match.playerA;
        const now  = admin.firestore.FieldValue.serverTimestamp();
        t.update(matchRef, { playerB: uid, opponentUid: uid, opponentUsername: userData.displayName || "", players: admin.firestore.FieldValue.arrayUnion(uid), status: "active", startedAt: now, matchStartedAt: now, joinedAt: now, inviteEnabled: false });
      });
      if (playerAUid) { notifyMatchJoined(playerAUid, uid, matchId, gameUpper).catch(() => {}); notifyMatchStarted(playerAUid, uid, matchId, gameUpper).catch(() => {}); }
    } else {
      didCreate = true;
      await db.runTransaction(async (t) => {
        const userRef  = db.collection("users").doc(uid);
        const matchRef = db.collection("matches").doc();
        matchId = matchRef.id;
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error("User not found");
        const userData = userDoc.data();
        if (walletType === "bonus") {
          const bonusCoins = userData.bonusCoins != null ? Number(userData.bonusCoins) : 0;
          if (bonusCoins < entryFee) throw new Error("Insufficient Bonus Coins");
          t.update(userRef, { bonusCoins: bonusCoins - entryFee });
        } else {
          const coins = userData.coins != null ? userData.coins : 0;
          if (coins < entryFee) throw new Error("Insufficient Gameplay Coins");
          t.update(userRef, { coins: coins - entryFee });
        }
        t.set(matchRef, { id: matchId, playerA: uid, playerB: null, hostUid: uid, hostUsername: userData.displayName || "", opponentUid: null, opponentUsername: null, players: [uid], game: gameUpper, entryFee, walletType, status: "waiting", matchType: "quick", isPrivate: false, result: null, submittedBy: null, submittedAt: null, confirmedWinner: null, rewarded: false, inviteEnabled: false, joinedViaInvite: false, createdAt: admin.firestore.FieldValue.serverTimestamp(), startedAt: null, matchStartedAt: null, joinedAt: null, rematchRequestedBy: null, rematchStatus: null, rematchRequestedAt: null, autoResolved: false, autoCancelled: false, cancelReason: null, playerAInMatchRoom: false, playerBInMatchRoom: false, playerAHeartbeat: null, playerBHeartbeat: null });
      });
      notifyMatchCreated(uid, matchId, gameUpper, entryFee, walletType).catch(() => {});
    }
    return res.status(didCreate ? 201 : 200).json({ matchId, action: didCreate ? "created" : "joined", status: didCreate ? "waiting" : "active", walletType, winnerReward: walletType === "bonus" ? bonusWinnerReward(entryFee) : winnerReward(entryFee), winnerRc: walletType === "bonus" ? 0 : winnerRc(entryFee), loserReward: walletType === "bonus" ? 0 : loserReward(entryFee) });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/submit-result", verifyToken, async (req, res) => {
  const { matchId, myScore, opponentScore } = req.body;
  const uid = req.user.uid;
  if (!matchId || myScore === undefined || opponentScore === undefined) return res.status(400).json({ error: "matchId, myScore, opponentScore required" });
  try { validateScore(myScore, "myScore"); validateScore(opponentScore, "opponentScore"); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    let opponentUid = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");
      const match = matchDoc.data();
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.status !== "active")  throw new Error("Match is not active");
      if (hasSubmittedResult(match))  throw new Error("Result already submitted");
      opponentUid = uid === match.playerA ? match.playerB : match.playerA;
      t.update(matchRef, { result: { myScore, opponentScore, scoreOf: { [uid]: myScore, [opponentUid]: opponentScore } }, submittedBy: uid, submittedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    if (opponentUid) notifyResultSubmitted(opponentUid, matchId).catch(() => {});
    return res.json({ message: "Result submitted -- waiting for opponent to confirm" });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/confirm-result", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  const uid = req.user.uid;
  if (!matchId) return res.status(400).json({ error: "matchId required" });
  try {
    let result = {}, matchSnapshot = null;
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
      const submitter = match.submittedBy;
      const confirmer = uid;
      const scoreOf   = match.result && match.result.scoreOf ? match.result.scoreOf : {};
      const submitterScore = scoreOf[submitter] != null ? scoreOf[submitter] : 0;
      const confirmerScore = scoreOf[confirmer] != null ? scoreOf[confirmer] : 0;
      let confirmedWinner;
      if (submitterScore > confirmerScore)      confirmedWinner = submitter;
      else if (confirmerScore > submitterScore) confirmedWinner = confirmer;
      else                                      confirmedWinner = "draw";
      const walletType = validateWalletType(match.walletType);
      if (walletType === "bonus") result = await distributeBonusReward(t, match, matchRef, confirmedWinner);
      else                        result = await distributeReward(t, match, matchRef, confirmedWinner);
    });
    if (matchSnapshot) {
      const w = result.confirmedWinner; const entryFee = matchSnapshot.entryFee; const matchId_ = matchSnapshot.id || matchId; const walletType = validateWalletType(matchSnapshot.walletType);
      notifyResultConfirmed(matchSnapshot.playerA, matchId_).catch(() => {});
      notifyResultConfirmed(matchSnapshot.playerB, matchId_).catch(() => {});
      if (walletType === "bonus") {
        if (w === "draw") { const refund = bonusDrawRefund(entryFee); notifyBonusMatchDraw(matchSnapshot.playerA, matchId_, refund).catch(() => {}); notifyBonusMatchDraw(matchSnapshot.playerB, matchId_, refund).catch(() => {}); createTransactionRecord(matchSnapshot.playerA, "bonus_match_draw", refund, "Bonus match draw: +" + refund + " Bonus Coins refunded", { matchId: matchId_, entryFee, refund, walletType: "bonus" }).catch(() => {}); createTransactionRecord(matchSnapshot.playerB, "bonus_match_draw", refund, "Bonus match draw: +" + refund + " Bonus Coins refunded", { matchId: matchId_, entryFee, refund, walletType: "bonus" }).catch(() => {}); }
        else { const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA; const bonusWin = bonusWinnerReward(entryFee); notifyBonusMatchWon(w, matchId_, bonusWin).catch(() => {}); notifyBonusMatchLost(loserUid, matchId_).catch(() => {}); createTransactionRecord(w, "bonus_match_won", bonusWin, "Bonus match won: +" + bonusWin + " Gameplay Coins", { matchId: matchId_, entryFee, walletType: "bonus", coinsWon: bonusWin }).catch(() => {}); createTransactionRecord(loserUid, "bonus_match_lost", 0, "Bonus match lost. No refund on bonus matches.", { matchId: matchId_, entryFee, walletType: "bonus" }).catch(() => {}); }
      } else {
        if (w === "draw") { const refund = drawRefund(entryFee); notifyMatchDraw(matchSnapshot.playerA, matchId_, refund).catch(() => {}); notifyMatchDraw(matchSnapshot.playerB, matchId_, refund).catch(() => {}); createTransactionRecord(matchSnapshot.playerA, "match_draw", refund, "Draw refund for match " + matchId_, { matchId: matchId_, entryFee, refund, walletType: "gameplay" }).catch(() => {}); createTransactionRecord(matchSnapshot.playerB, "match_draw", refund, "Draw refund for match " + matchId_, { matchId: matchId_, entryFee, refund, walletType: "gameplay" }).catch(() => {}); }
        else { const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA; const rcEarned = winnerRc(entryFee); const winCoins = winnerReward(entryFee); const losCoins = loserReward(entryFee); notifyMatchWon(w, matchId_, winCoins, rcEarned).catch(() => {}); notifyMatchLost(loserUid, matchId_, losCoins).catch(() => {}); notifyRcEarned(w, rcEarned, winCoins, matchId_).catch(() => {}); createTransactionRecord(w, "match_win", winCoins, "Match won: +" + winCoins + " coins + +" + rcEarned + " RC", { matchId: matchId_, entryFee, coinsWon: winCoins, rcEarned, walletType: "gameplay" }).catch(() => {}); createTransactionRecord(loserUid, "match_lost", losCoins, "Match lost: consolation +" + losCoins + " coins", { matchId: matchId_, entryFee, coinsBack: losCoins, walletType: "gameplay" }).catch(() => {}); }
      }
    }
    return res.json({ message: "Result confirmed", confirmedWinner: result.confirmedWinner });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/dispute", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { matchId, reason, note, evidenceImage } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId is required" });
  let validatedReason;
  try { validatedReason = validateDisputeReason(reason); } catch (err) { return res.status(400).json({ error: err.message }); }
  let validatedNote = "";
  if (note !== undefined && note !== null && note !== "") { try { validatedNote = validateDisputeNote(note); } catch (err) { return res.status(400).json({ error: err.message }); } }
  let validatedEvidence = "";
  if (evidenceImage) { if (typeof evidenceImage !== "string" || evidenceImage.length > 2000) return res.status(400).json({ error: "evidenceImage must be a valid URL string" }); validatedEvidence = evidenceImage.trim(); }
  try {
    let disputeId = null, opponentUid = null;
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
      t.set(disputeRef, { id: disputeId, matchId, disputeReason: validatedReason, disputeNote: validatedNote, evidenceImage: validatedEvidence, reportedBy: uid, disputedBy: uid, status: "pending", resolvedBy: null, resolvedAt: null, resolutionNote: null, matchData: { playerA: match.playerA, playerB: match.playerB, game: match.game, entryFee: match.entryFee, walletType: match.walletType || "gameplay", submittedBy: match.submittedBy != null ? match.submittedBy : null, result: match.result != null ? match.result : null }, createdAt: now });
      t.update(matchRef, { status: "disputed", disputedAt: now, disputedBy: uid, disputeId });
    });
    notifyDisputeOpened(uid, matchId).catch(() => {});
    if (opponentUid) notifyDisputeOpened(opponentUid, matchId).catch(() => {});
    return res.json({ message: "Dispute submitted -- under review", disputeId });
  } catch (err) {
    if (err.message === "NOT_IN_MATCH")      return res.status(403).json({ error: "You are not in this match" });
    if (err.message === "ALREADY_DISPUTED")  return res.status(409).json({ error: "This match has already been disputed" });
    if (err.message === "ALREADY_COMPLETED") return res.status(400).json({ error: "Match is already completed -- cannot dispute" });
    if (err.message === "ALREADY_CANCELLED") return res.status(400).json({ error: "Match is cancelled -- cannot dispute" });
    if (err.message === "Match not found")   return res.status(404).json({ error: "Match not found" });
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
    const history = [...snapA.docs.map((d) => d.data()), ...snapB.docs.map((d) => d.data())].sort((a, b) => { const bSec = b.createdAt && b.createdAt._seconds ? b.createdAt._seconds : 0; const aSec = a.createdAt && a.createdAt._seconds ? a.createdAt._seconds : 0; return bSec - aSec; }).slice(0, 50);
    return res.json(history);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/matches/auto-resolve", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });
  try {
    let result = {}, matchSnapshot = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");
      const match = matchDoc.data();
      if (match.status === "completed" || match.rewarded || match.autoResolved) { result = { confirmedWinner: match.confirmedWinner, alreadyResolved: true }; return; }
      if (match.status === "cancelled") { result = { alreadyCancelled: true }; return; }
      if (match.status !== "active") throw new Error("Cannot auto-resolve -- status is \"" + match.status + "\"");
      if (!hasSubmittedResult(match)) throw new Error("No result submitted -- use auto-cancel");
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
      if (nonSubmitterDoc.exists) { const nsData = Object.assign({}, nonSubmitterDoc.data(), { rageQuits: inc(nonSubmitterDoc.data().rageQuits) }); t.update(nonSubmitterRef, { rageQuits: inc(nonSubmitterDoc.data().rageQuits) }); applyTrustUpdate(t, nonSubmitterRef, nsData); }
      const walletType = validateWalletType(match.walletType);
      if (walletType === "bonus") result = await distributeBonusRewardAutoResolve(t, match, matchRef, confirmedWinner, other);
      else                        result = await distributeRewardAutoResolve(t, match, matchRef, confirmedWinner, other);
      t.update(matchRef, { autoResolved: true });
    });
    if (matchSnapshot && !result.alreadyResolved && !result.alreadyCancelled) {
      const w = result.confirmedWinner; const matchId_ = matchSnapshot.id || matchId; const entryFee = matchSnapshot.entryFee; const walletType = validateWalletType(matchSnapshot.walletType);
      notifyAutoResolved(matchSnapshot.playerA, matchId_, w).catch(() => {});
      notifyAutoResolved(matchSnapshot.playerB, matchId_, w).catch(() => {});
      if (walletType === "bonus") {
        if (w === "draw") { const refund = bonusDrawRefund(entryFee); notifyBonusMatchDraw(matchSnapshot.playerA, matchId_, refund).catch(() => {}); notifyBonusMatchDraw(matchSnapshot.playerB, matchId_, refund).catch(() => {}); createTransactionRecord(matchSnapshot.playerA, "bonus_match_draw", refund, "Bonus match draw (auto-resolved): +" + refund + " Bonus Coins refunded", { matchId: matchId_, walletType: "bonus" }).catch(() => {}); createTransactionRecord(matchSnapshot.playerB, "bonus_match_draw", refund, "Bonus match draw (auto-resolved): +" + refund + " Bonus Coins refunded", { matchId: matchId_, walletType: "bonus" }).catch(() => {}); }
        else { const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA; const bonusWin = bonusWinnerReward(entryFee); notifyBonusMatchWon(w, matchId_, bonusWin).catch(() => {}); notifyBonusMatchLost(loserUid, matchId_).catch(() => {}); createTransactionRecord(w, "bonus_match_won", bonusWin, "Bonus match won (auto-resolved): +" + bonusWin + " Gameplay Coins", { matchId: matchId_, walletType: "bonus" }).catch(() => {}); createTransactionRecord(loserUid, "bonus_match_lost", 0, "Bonus match lost (auto-resolved). No refund.", { matchId: matchId_, walletType: "bonus" }).catch(() => {}); }
      } else {
        if (w === "draw") { const refund = drawRefund(entryFee); notifyMatchDraw(matchSnapshot.playerA, matchId_, refund).catch(() => {}); notifyMatchDraw(matchSnapshot.playerB, matchId_, refund).catch(() => {}); createTransactionRecord(matchSnapshot.playerA, "match_draw", refund, "Draw refund (auto-resolved)", { matchId: matchId_, walletType: "gameplay" }).catch(() => {}); createTransactionRecord(matchSnapshot.playerB, "match_draw", refund, "Draw refund (auto-resolved)", { matchId: matchId_, walletType: "gameplay" }).catch(() => {}); }
        else { const loserUid = w === matchSnapshot.playerA ? matchSnapshot.playerB : matchSnapshot.playerA; const rcEarned = winnerRc(entryFee); const winCoins = winnerReward(entryFee); const losCoins = loserReward(entryFee); notifyMatchWon(w, matchId_, winCoins, rcEarned).catch(() => {}); notifyMatchLost(loserUid, matchId_, losCoins).catch(() => {}); notifyRcEarned(w, rcEarned, winCoins, matchId_).catch(() => {}); createTransactionRecord(w, "match_win", winCoins, "Match won (auto-resolved): +" + winCoins + " coins + +" + rcEarned + " RC", { matchId: matchId_, rcEarned, walletType: "gameplay" }).catch(() => {}); createTransactionRecord(loserUid, "match_lost", losCoins, "Match lost (auto-resolved): +" + losCoins + " coins", { matchId: matchId_, walletType: "gameplay" }).catch(() => {}); }
      }
    }
    if (result.alreadyResolved) return res.json({ message: "Already resolved", confirmedWinner: result.confirmedWinner });
    if (result.alreadyCancelled) return res.json({ message: "Already cancelled" });
    return res.json({ message: "Auto-resolved", confirmedWinner: result.confirmedWinner });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/auto-cancel", verifyToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId required" });
  try {
    let alreadyDone = false, matchSnapshot = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");
      const match = matchDoc.data();
      if (match.status === "cancelled" || match.status === "completed") { alreadyDone = true; return; }
      if (match.status !== "active") throw new Error("Cannot auto-cancel -- status is \"" + match.status + "\"");
      if (hasSubmittedResult(match)) throw new Error("Result submitted -- use auto-resolve");
      matchSnapshot = match;
      const playerA_Ref = db.collection("users").doc(match.playerA);
      const playerB_Ref = db.collection("users").doc(match.playerB);
      const walletType  = validateWalletType(match.walletType);
      const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);
      if (!playerA_Doc.exists || !playerB_Doc.exists) throw new Error("Player data not found");
      const playerA_Data = playerA_Doc.data();
      const playerB_Data = playerB_Doc.data();
      if (walletType === "bonus") { t.update(playerA_Ref, { bonusCoins: inc(Number(playerA_Data.bonusCoins) || 0, match.entryFee) }); t.update(playerB_Ref, { bonusCoins: inc(Number(playerB_Data.bonusCoins) || 0, match.entryFee) }); }
      else { t.update(playerA_Ref, { coins: inc(playerA_Data.coins, match.entryFee) }); t.update(playerB_Ref, { coins: inc(playerB_Data.coins, match.entryFee) }); }
      const aUpdated = Object.assign({}, playerA_Data, { rageQuits: inc(playerA_Data.rageQuits) });
      const bUpdated = Object.assign({}, playerB_Data, { rageQuits: inc(playerB_Data.rageQuits) });
      t.update(playerA_Ref, { rageQuits: inc(playerA_Data.rageQuits) });
      t.update(playerB_Ref, { rageQuits: inc(playerB_Data.rageQuits) });
      applyTrustUpdate(t, playerA_Ref, aUpdated);
      applyTrustUpdate(t, playerB_Ref, bUpdated);
      t.update(matchRef, { status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp(), autoCancelled: true, cancelReason: "match_timer_expired_no_submission", inviteEnabled: false });
    });
    if (!alreadyDone && matchSnapshot) { notifyAutoCancelled(matchSnapshot.playerA, matchId, matchSnapshot.entryFee).catch(() => {}); notifyAutoCancelled(matchSnapshot.playerB, matchId, matchSnapshot.entryFee).catch(() => {}); }
    if (alreadyDone) return res.json({ message: "No action needed" });
    return res.json({ message: "Auto-cancelled -- both players refunded" });
  } catch (err) { return res.status(400).json({ error: err.message }); }
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
      const match      = matchDoc.data();
      const userData   = userDoc.data();
      const walletType = validateWalletType(match.walletType);
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.status !== "completed") throw new Error("Match not completed");
      if (match.rematchRequestedBy)     throw new Error("Rematch already requested");
      if (walletType === "bonus") { const bonusCoins = Number(userData.bonusCoins) || 0; if (bonusCoins < match.entryFee) throw new Error("Insufficient Bonus Coins for rematch"); }
      else { const coins = userData.coins != null ? userData.coins : 0; if (coins < match.entryFee) throw new Error("Insufficient coins for rematch"); }
      opponentUid = match.playerA === uid ? match.playerB : match.playerA;
      t.update(matchRef, { rematchRequestedBy: uid, rematchStatus: "pending", rematchRequestedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    if (opponentUid) notifyRematchRequested(opponentUid, matchId).catch(() => {});
    return res.json({ message: "Rematch requested" });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/rematch-respond", verifyToken, async (req, res) => {
  const { matchId, accept } = req.body;
  const uid = req.user.uid;
  if (!matchId || accept === undefined) return res.status(400).json({ error: "matchId and accept required" });
  if (!accept) {
    try {
      const matchDoc = await db.collection("matches").doc(matchId).get();
      const rematchRequester = matchDoc.exists && matchDoc.data().rematchRequestedBy ? matchDoc.data().rematchRequestedBy : null;
      await db.collection("matches").doc(matchId).update({ rematchStatus: "declined", rematchDeclinedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (rematchRequester) notifyRematchDeclined(rematchRequester, matchId).catch(() => {});
      return res.json({ message: "Rematch declined" });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  try {
    let playerAUid = null, playerBUid = null;
    await db.runTransaction(async (t) => {
      const matchRef = db.collection("matches").doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error("Match not found");
      const match = matchDoc.data();
      if (match.playerA !== uid && match.playerB !== uid) throw new Error("You are not in this match");
      if (match.rematchStatus !== "pending") throw new Error("No pending rematch");
      if (match.rematchRequestedBy === uid)  throw new Error("Cannot accept own rematch request");
      playerAUid = match.playerA; playerBUid = match.playerB;
      const playerA_Ref = db.collection("users").doc(match.playerA);
      const playerB_Ref = db.collection("users").doc(match.playerB);
      const walletType  = validateWalletType(match.walletType);
      const [playerA_Doc, playerB_Doc] = await Promise.all([t.get(playerA_Ref), t.get(playerB_Ref)]);
      if (walletType === "bonus") { const bcA = Number(playerA_Doc.data().bonusCoins) || 0; const bcB = Number(playerB_Doc.data().bonusCoins) || 0; if (bcA < match.entryFee) throw new Error("Player A insufficient Bonus Coins"); if (bcB < match.entryFee) throw new Error("Player B insufficient Bonus Coins"); t.update(playerA_Ref, { bonusCoins: bcA - match.entryFee }); t.update(playerB_Ref, { bonusCoins: bcB - match.entryFee }); }
      else { const coinsA = playerA_Doc.exists && playerA_Doc.data().coins != null ? playerA_Doc.data().coins : 0; const coinsB = playerB_Doc.exists && playerB_Doc.data().coins != null ? playerB_Doc.data().coins : 0; if (coinsA < match.entryFee) throw new Error("Player A insufficient coins"); if (coinsB < match.entryFee) throw new Error("Player B insufficient coins"); t.update(playerA_Ref, { coins: inc(coinsA, -match.entryFee) }); t.update(playerB_Ref, { coins: inc(coinsB, -match.entryFee) }); }
      const now = admin.firestore.FieldValue.serverTimestamp();
      t.update(matchRef, { status: "active", result: null, submittedBy: null, submittedAt: null, confirmedWinner: null, rewarded: false, winnerReward: 0, winnerRc: 0, loserReward: 0, confirmedAt: null, disputedAt: null, disputedBy: null, disputeId: null, autoResolved: false, autoCancelled: false, cancelReason: null, rematchStatus: "accepted", rematchStartedAt: now, startedAt: now, matchStartedAt: now, players: [match.playerA, match.playerB], inviteEnabled: false, playerAInMatchRoom: false, playerBInMatchRoom: false, playerAHeartbeat: null, playerBHeartbeat: null });
    });
    if (playerAUid) notifyRematchAccepted(playerAUid, matchId).catch(() => {});
    if (playerBUid) notifyRematchAccepted(playerBUid, matchId).catch(() => {});
    return res.json({ message: "Rematch accepted -- match restarted" });
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

app.post("/matches/chat/send", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { matchId, message } = req.body;
  if (!matchId || typeof matchId !== "string" || !matchId.trim()) return res.status(400).json({ error: "matchId is required" });
  if (!message || typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message is required" });
  const safeText = message.trim().substring(0, 300);
  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) return res.status(404).json({ error: "Match not found" });
    const match = matchDoc.data();
    if (match.playerA !== uid && match.playerB !== uid) return res.status(403).json({ error: "You are not in this match" });
    const recipientUid = match.playerA === uid ? match.playerB : match.playerA;
    const senderDoc    = await db.collection("users").doc(uid).get();
    const senderName   = senderDoc.exists && senderDoc.data().displayName ? senderDoc.data().displayName : "Opponent";
    const chatRef = db.collection("matches").doc(matchId).collection("chat").doc();
    await chatRef.set({ id: chatRef.id, matchId, senderId: uid, senderName, message: safeText, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    if (recipientUid) notifyChatMessage(recipientUid, senderName, matchId, safeText).catch(() => {});
    return res.status(201).json({ message: "Message sent", messageId: chatRef.id });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/matches/chat/:matchId", verifyToken, async (req, res) => {
  const uid     = req.user.uid;
  const matchId = req.params.matchId;
  if (!matchId || typeof matchId !== "string") return res.status(400).json({ error: "matchId is required" });
  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) return res.status(404).json({ error: "Match not found" });
    const match = matchDoc.data();
    if (match.playerA !== uid && match.playerB !== uid) return res.status(403).json({ error: "You are not in this match" });
    const chatSnap = await db.collection("matches").doc(matchId).collection("chat").orderBy("createdAt", "asc").limit(50).get();
    return res.json(chatSnap.docs.map((d) => d.data()));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/report", verifyToken, async (req, res) => {
  const { reportedUid, description } = req.body;
  const reporterUid = req.user.uid;
  if (!reportedUid || !description) return res.status(400).json({ error: "reportedUid and description required" });
  if (reportedUid === reporterUid)  return res.status(400).json({ error: "You cannot report yourself" });
  try {
    const reportRef = db.collection("reports").doc();
    await reportRef.set({ id: reportRef.id, reporterUid, reportedUid, description: description.trim().substring(0, 500), status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    db.collection("users").doc(reportedUid).get().then((doc) => {
      if (!doc.exists) return;
      const data    = doc.data();
      const updated = Object.assign({}, data, { reportsReceived: inc(data.reportsReceived) });
      doc.ref.update({ reportsReceived: inc(data.reportsReceived) }).catch(() => {});
      doc.ref.set({ trustScore: computeTrustScore(updated), matchCompletionRate: computeCompletionRate(updated), fairPlayRating: computeFairPlayRating(updated), trustUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }).catch(() => {});
    return res.json({ message: "Report submitted" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/leaderboard", verifyToken, async (req, res) => {
  try {
    const snap = await db.collection("users").orderBy("wins", "desc").limit(20).get();
    const leaderboard = snap.docs.map((doc, i) => {
      const d = doc.data();
      return { rank: i + 1, uid: d.uid != null ? d.uid : doc.id, displayName: d.displayName != null ? d.displayName : "Player", wins: d.wins != null ? d.wins : 0, losses: d.losses != null ? d.losses : 0, totalMatches: d.totalMatches != null ? d.totalMatches : 0, avatar: d.avatar != null ? d.avatar : null, trustScore: d.trustScore != null ? d.trustScore : 80 };
    });
    return res.json(leaderboard);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// ADMIN -- TRUST + FIELD MIGRATION  ← country/currency added
// =============================================================
app.post("/admin/migrate-trust", verifyToken, async (req, res) => {
  let migrated = 0, errors = 0;
  try {
    const query = db.collection("users").limit(100);
    let lastDoc = null, hasMore = true;
    while (hasMore) {
      const snap = lastDoc ? await query.startAfter(lastDoc).get() : await query.get();
      if (snap.empty) { hasMore = false; break; }
      const batch = db.batch();
      snap.docs.forEach((doc) => {
        try {
          const data = doc.data();
          const detected = detectCountryFromPhone(data.phone || "");
          const updateFields = {
            trustScore:            computeTrustScore(data),
            fairPlayRating:        computeFairPlayRating(data),
            matchCompletionRate:   computeCompletionRate(data),
            rcBalance:             data.rcBalance             || 0,
            bonusCoins:            data.bonusCoins != null    ? data.bonusCoins : 0,
            firstPurchaseDone:     data.firstPurchaseDone     || false,
            referralRewardGranted: data.referralRewardGranted || false,
            trustUpdatedAt:        admin.firestore.FieldValue.serverTimestamp(),
            // Only set country/currency if currently missing
            ...(!data.country  ? { country:  detected.country  } : {}),
            ...(!data.currency ? { currency: detected.currency } : {}),
          };
          if (!data.lastSeen)                    updateFields.lastSeen          = admin.firestore.FieldValue.serverTimestamp();
          if (data.bonusMatchUsed !== undefined)  updateFields.bonusMatchUsed    = admin.firestore.FieldValue.delete();
          if (data.firstMatchBonusUsed !== undefined) updateFields.firstMatchBonusUsed = admin.firestore.FieldValue.delete();
          batch.set(doc.ref, updateFields, { merge: true });
          migrated++;
        } catch (e) { errors++; }
      });
      await batch.commit();
      lastDoc = snap.docs[snap.docs.length - 1];
      hasMore = snap.docs.length === 100;
    }
    return res.json({ message: "Trust migration complete", migrated, errors });
  } catch (err) { return res.status(500).json({ error: err.message, migrated, errors }); }
});

// =============================================================
// ADMIN -- COUNTRY/CURRENCY MIGRATION (standalone)
// =============================================================
// POST /admin/migrate-country-currency
//
// Iterates every user doc, detects country/currency from phone,
// and writes the fields only when they are currently missing.
// Existing valid values are never overwritten.
// Returns { migrated, skipped, errors } for visibility.
// =============================================================
app.post("/admin/migrate-country-currency", verifyToken, async (req, res) => {
  let migrated = 0, skipped = 0, errors = 0;
  try {
    const PAGE = 100;
    let lastDoc = null, hasMore = true;

    while (hasMore) {
      let query = db.collection("users").limit(PAGE);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();

      if (snap.empty) { hasMore = false; break; }

      const batch = db.batch();
      let batchWrites = 0;

      snap.docs.forEach((doc) => {
        try {
          const data = doc.data();
          const needsCountry  = !data.country  || data.country  === "Unknown";
          const needsCurrency = !data.currency || data.currency === "Unknown";

          if (!needsCountry && !needsCurrency) { skipped++; return; }

          const detected = detectCountryFromPhone(data.phone || "");
          const patch    = {};
          if (needsCountry)  patch.country  = detected.country;
          if (needsCurrency) patch.currency = detected.currency;

          batch.set(doc.ref, patch, { merge: true });
          batchWrites++;
          migrated++;
        } catch (e) {
          console.error("[migrate-country-currency] uid=" + doc.id + " err=" + e.message);
          errors++;
        }
      });

      if (batchWrites > 0) await batch.commit();

      lastDoc = snap.docs[snap.docs.length - 1];
      hasMore = snap.docs.length === PAGE;
    }

    console.log("[migrate-country-currency] migrated=" + migrated + " skipped=" + skipped + " errors=" + errors);
    return res.json({ message: "Country/currency migration complete", migrated, skipped, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message, migrated, skipped, errors });
  }
});

app.post("/matches/timer-alert", verifyToken, async (req, res) => {
  const { matchId, alertType } = req.body;
  if (!matchId) return res.status(400).json({ error: "matchId is required" });
  const validAlerts = ["5min", "1min", "expired"];
  if (!alertType || !validAlerts.includes(alertType)) return res.status(400).json({ error: "alertType must be 5min, 1min, or expired" });
  try {
    const matchDoc = await db.collection("matches").doc(matchId).get();
    if (!matchDoc.exists) return res.status(404).json({ error: "Match not found" });
    const match = matchDoc.data();
    if (match.status !== "active") return res.json({ message: "Match not active -- no alert sent" });
    const uids = [match.playerA, match.playerB].filter(Boolean);
    await Promise.all(uids.map((uid) => notifyRoomTimer(uid, matchId, alertType).catch(() => {})));
    return res.json({ message: "Timer alert sent", alertType, matchId });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/notifications/trigger", verifyToken, async (req, res) => {
  const { userId, type, title, message, meta } = req.body;
  if (!userId  || typeof userId  !== "string" || !userId.trim())  return res.status(400).json({ error: "userId is required" });
  if (!type    || typeof type    !== "string" || !type.trim())    return res.status(400).json({ error: "type is required" });
  if (!title   || typeof title   !== "string" || !title.trim())   return res.status(400).json({ error: "title is required" });
  if (!message || typeof message !== "string")                    return res.status(400).json({ error: "message is required" });
  const safeMeta      = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const pushOnlyTypes = ["chat_message", "room_timer"];
  const isPushOnly    = pushOnlyTypes.includes(type.trim());
  try {
    if (!isPushOnly) await createNotification(userId, type, title, message, safeMeta);
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) { const userData = userDoc.data(); if (userData.notificationsEnabled === true && userData.fcmToken) await sendPushNotification(userId, title, message, Object.assign({}, safeMeta, { type })); }
    return res.json({ message: "Notification triggered", pushOnly: isPushOnly });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/update-notification-prefs", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { notificationPromptShown, notificationsEnabled } = req.body;
  if (typeof notificationPromptShown !== "boolean" || typeof notificationsEnabled !== "boolean") return res.status(400).json({ error: "Both fields must be boolean" });
  try {
    const update = { notificationPromptShown, notificationsEnabled, notificationPrefsUpdatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (!notificationsEnabled) update.fcmToken = admin.firestore.FieldValue.delete();
    await db.collection("users").doc(uid).update(update);
    return res.json({ message: "Notification preferences saved" });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// =============================================================
// REDEMPTION APPROVAL LISTENER
// =============================================================
function startRedemptionApprovalListener() {
  console.log("[redemption-listener] Starting...");
  db.collection("redemption_requests").where("status", "in", ["approved", "rejected"]).onSnapshot(
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "modified" && change.type !== "added") return;
        const data   = change.doc.data();
        const docId  = change.doc.id;
        const status = data.status || "";
        const userId = data.userId || "";
        if (data.processedAt) return;
        if (status !== "approved" && status !== "rejected") return;
        if (!userId) { console.warn("[redemption-listener] No userId on doc=" + docId); return; }
        (async () => {
          try {
            await db.collection("redemption_requests").doc(docId).update({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
            const adminNote = data.adminNote ? String(data.adminNote).trim() : (status === "approved" ? "Your redemption has been approved and payment has been sent." : "Your redemption request was not approved. Please contact support.");
            const rcAmount = Number(data.rcAmount) || 0;
            const usdValue = Number(data.usdValue)  || 0;
            if (status === "approved") {
              await notifyUser(userId, "redemption_approved", "Redemption Approved!", adminNote, { rcAmount, usdValue, adminNote, redemptionId: docId });
              await createTransactionRecord(userId, "redemption_approved", rcAmount, "Redemption approved: " + rcAmount + " RC ($" + usdValue.toFixed(2) + "). " + adminNote, { rcAmount, usdValue, adminNote, redemptionId: docId, network: data.network || "", accountName: data.accountName || "" });
              console.log("[redemption-listener] approved userId=" + userId + " rc=" + rcAmount + " docId=" + docId);
            } else {
              await notifyUser(userId, "redemption_rejected", "Redemption Not Approved", adminNote, { rcAmount, usdValue, adminNote, redemptionId: docId });
              await createTransactionRecord(userId, "redemption_rejected", rcAmount, "Redemption rejected: " + rcAmount + " RC. " + adminNote, { rcAmount, usdValue, adminNote, redemptionId: docId });
              console.log("[redemption-listener] rejected userId=" + userId + " rc=" + rcAmount + " docId=" + docId);
            }
          } catch (err) { console.error("[redemption-listener] Error processing docId=" + docId + ":", err.message); }
        })();
      });
    },
    (err) => { console.error("[redemption-listener] Snapshot error:", err.message); }
  );
}

// =============================================================
// SYSTEM NOTIFICATIONS LISTENER
// =============================================================
function startSystemNotificationsListener() {
  console.log("[system-notif-listener] Starting...");
  db.collection("system_notifications").where("processedAt", "==", null).onSnapshot(
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== "added" && change.type !== "modified") return;
        const data  = change.doc.data();
        const docId = change.doc.id;
        if (data.processedAt) return;
        const title      = data.title      || "";
        const message    = data.message    || "";
        const targetType = data.targetType || "single";
        if (!title || !message) { console.warn("[system-notif-listener] Missing title or message on docId=" + docId); return; }
        (async () => {
          try {
            await db.collection("system_notifications").doc(docId).update({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
            const meta = { systemNotificationId: docId, createdBy: data.createdBy || "admin" };
            if (targetType === "all") {
              let lastDoc = null, hasMore = true, totalSent = 0;
              while (hasMore) {
                let query = db.collection("users").limit(100);
                if (lastDoc) query = query.startAfter(lastDoc);
                const userSnap = await query.get();
                if (userSnap.empty) { hasMore = false; break; }
                await Promise.all(userSnap.docs.map(async (userDoc) => { try { await notifyUser(userDoc.id, "system", title, message, meta); totalSent++; } catch (e) { console.error("[system-notif-listener] Failed uid=" + userDoc.id + ":", e.message); } }));
                lastDoc = userSnap.docs[userSnap.docs.length - 1];
                hasMore = userSnap.docs.length === 100;
              }
              await db.collection("system_notifications").doc(docId).update({ deliveredCount: totalSent, deliveredAt: admin.firestore.FieldValue.serverTimestamp() });
              console.log("[system-notif-listener] Broadcast to " + totalSent + " users. docId=" + docId);
            } else if (targetType === "multiple") {
              const targetIds = Array.isArray(data.targetUserIds) ? data.targetUserIds.filter((id) => typeof id === "string" && id.trim()) : [];
              if (targetIds.length === 0) { console.warn("[system-notif-listener] Empty targetUserIds docId=" + docId); return; }
              await notifyMultipleUsers(targetIds, "system", title, message, meta);
              await db.collection("system_notifications").doc(docId).update({ deliveredCount: targetIds.length, deliveredAt: admin.firestore.FieldValue.serverTimestamp() });
            } else {
              const targetIds = Array.isArray(data.targetUserIds) ? data.targetUserIds : [];
              const targetUid = typeof targetIds[0] === "string" ? targetIds[0].trim() : "";
              if (!targetUid) { console.warn("[system-notif-listener] No targetUid docId=" + docId); return; }
              await notifyUser(targetUid, "system", title, message, meta);
              await db.collection("system_notifications").doc(docId).update({ deliveredCount: 1, deliveredAt: admin.firestore.FieldValue.serverTimestamp() });
            }
          } catch (err) { console.error("[system-notif-listener] Error on docId=" + docId + ":", err.message); }
        })();
      });
    },
    (err) => { console.error("[system-notif-listener] Snapshot error:", err.message); }
  );
}

// =============================================================
// ONLINE PLAYERS REFRESH LOOP
// =============================================================
const ONLINE_REFRESH_INTERVAL_MS = 60 * 1000;

function startOnlinePlayersRefreshLoop() {
  console.log("[online-refresh] Starting (interval=" + ONLINE_REFRESH_INTERVAL_MS + "ms, window=" + ONLINE_WINDOW_MS + "ms)");
  refreshOnlinePlayersCount();
  setInterval(() => { refreshOnlinePlayersCount(); }, ONLINE_REFRESH_INTERVAL_MS);
}

// =============================================================
// START
// =============================================================
const PORT   = process.env.PORT || 4000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Duelix backend running on port " + PORT);
  startRedemptionApprovalListener();
  startSystemNotificationsListener();
  startOnlinePlayersRefreshLoop();
  startPresenceCleanupLoop();
});
server.on("error", (err) => {
  console.error("Server error:", err.message);
  process.exit(1);
});