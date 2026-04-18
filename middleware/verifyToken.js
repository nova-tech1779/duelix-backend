const { admin } = require('../firebase');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  console.log(` DEBUG: VERIFY TOKEN - Auth Header: ${authHeader ? "Present" : "Missing"}`);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log(` DEBUG: VERIFY TOKEN ERROR - No token provided`);
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    console.log(` DEBUG: VERIFY TOKEN - Verifying token...`);
    const decoded = await admin.auth().verifyIdToken(token);
    console.log(` DEBUG: VERIFY TOKEN UID: ${decoded?.uid}`);
    console.log(` DEBUG: VERIFY TOKEN SUCCESS - Token valid`);
    req.user = decoded;
    next();
  } catch (error) {
    console.log(` DEBUG: VERIFY TOKEN ERROR: ${error.message}`);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = verifyToken;