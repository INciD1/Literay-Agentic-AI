// ===== lib/auth.js =====
// Google Sign-In (Identity Services) verification + session-cookie auth.
//
// Flow:
//  1. Frontend loads Google's "gsi/client" script, renders the Sign in
//     with Google button, and gets a signed ID token (JWT) back from Google
//     when the user picks an account.
//  2. Frontend POSTs that ID token to /api/auth/google.
//  3. We verify it against Google's public keys using google-auth-library
//     (this is the "real" verification step — nothing is trusted from the
//     client beyond the token itself).
//  4. On success we store the verified profile in an httpOnly session
//     cookie (cookie-session) — no server-side session store needed, which
//     keeps this deployable as-is on Cloud Run.

const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

async function verifyGoogleIdToken(idToken) {
  if (!oauthClient) {
    throw new Error('GOOGLE_CLIENT_ID is not configured on the server.');
  }
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Google token payload was missing a subject claim.');
  }
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || null
  };
}

// Blocks API/page access unless a valid session cookie is present.
// HTML requests get redirected to /login; API requests get a 401 JSON body.
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  return res.redirect('/login');
}

module.exports = { verifyGoogleIdToken, requireAuth, GOOGLE_CLIENT_ID };