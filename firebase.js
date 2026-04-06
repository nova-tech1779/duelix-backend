const admin = require('firebase-admin');

let serviceAccount;

try {
  const raw = process.env.FIREBASE_KEY;

  if (!raw) {
    throw new Error("FIREBASE_KEY is missing");
  }

  serviceAccount = JSON.parse(raw);

  // 🔥 THIS is the real fix
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  console.log("✅ Firebase key loaded");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("✅ Firebase initialized");

} catch (e) {
  console.error("❌ Firebase init failed:", e.message);
  process.exit(1);
}

const db = admin.firestore();

module.exports = { admin, db };