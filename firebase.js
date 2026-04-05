const admin = require('firebase-admin');

let serviceAccount;

try {
  serviceAccount = require('./serviceAccountKey.json');
} catch (e) {
  console.error('❌ Cannot load serviceAccountKey.json:', e.message);
  process.exit(1);
}

try {
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