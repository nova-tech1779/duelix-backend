const admin = require('firebase-admin');

let serviceAccount;

try {
  if (process.env.FIREBASE_KEY) {
    // ✅ Railway / Production
    serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    console.log('🌐 Using FIREBASE_KEY from environment');
  } else {
    // ✅ Local development
    serviceAccount = require('./serviceAccountKey.json');
    console.log('💻 Using local serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('✅ Firebase Admin initialized');

} catch (e) {
  console.error('❌ Firebase init failed:', e.message);
  process.exit(1);
}

const db = admin.firestore();

module.exports = { admin, db };