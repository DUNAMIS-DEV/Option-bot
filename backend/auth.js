/**
 * auth.js — Password Protection & Session Management
 * ===================================================
 * All passwords come from environment variables ONLY.
 * Nothing is written to disk, sent to the client, or exposed in any HTML/JS.
 *
 * Env vars required (set these on your host / .env — never commit .env):
 *   ACCESS_PASSWORD   → normal login, lets someone use the dashboard
 *   MASTER_PASSWORD    → your root password. Used to log in as admin AND
 *                        to rotate ACCESS_PASSWORD at runtime.
 *
 * How revocation works:
 *   The current access password has a "version" number, bumped every time
 *   it's changed. Every session token is stamped with the version that was
 *   active when the user logged in. If you rotate the access password,
 *   the version bumps and ALL previously-issued access-tier tokens are
 *   instantly rejected — even ones with 20 hours left on their TTL. So if
 *   you've given someone the access password and want to cut them off,
 *   just change the password (via /api/auth/change-password using the
 *   master password) and their existing session dies immediately, not
 *   just future logins.
 *
 *   The master/admin password itself is NOT rotatable via the API — it
 *   only ever lives in the environment. If you need to change it, change
 *   the env var and restart the process.
 */

const crypto = require('crypto');

if (!process.env.ACCESS_PASSWORD || !process.env.MASTER_PASSWORD) {
  console.error('[AUTH] FATAL: ACCESS_PASSWORD and MASTER_PASSWORD must be set as environment variables.');
  console.error('[AUTH] Set them in your .env file (and never commit it) or in your host\'s env config.');
  process.exit(1);
}

// In-memory only — never persisted to disk.
let state = {
  accessPassword: process.env.ACCESS_PASSWORD,
  accessVersion: 1
};

const MASTER_PASSWORD = process.env.MASTER_PASSWORD;

// Session store: token -> { role, accessVersion, createdAt }
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time string comparison to avoid timing attacks on password checks.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to keep timing consistent.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(password) {
  if (!password) return { valid: false, role: null };

  if (safeEqual(password, MASTER_PASSWORD)) {
    return { valid: true, role: 'admin' };
  }
  if (safeEqual(password, state.accessPassword)) {
    return { valid: true, role: 'user' };
  }
  return { valid: false, role: null };
}

function createSession(role) {
  const token = generateToken();
  sessions.set(token, {
    role,
    accessVersion: state.accessVersion,
    createdAt: Date.now()
  });
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }

  // Admin sessions ride on the master password, which never rotates at
  // runtime, so they're not tied to accessVersion. Access-tier sessions
  // are invalidated the moment the access password changes.
  if (session.role === 'user' && session.accessVersion !== state.accessVersion) {
    sessions.delete(token);
    return null;
  }

  return session;
}

// Rotate the access password. Requires the master password. Bumping the
// version immediately kills every outstanding access-tier session.
function changeAccessPassword(masterPassword, newPassword) {
  if (!safeEqual(masterPassword, MASTER_PASSWORD)) {
    return { success: false, error: 'Invalid master password' };
  }
  if (!newPassword || newPassword.length < 4) {
    return { success: false, error: 'New password must be at least 4 characters' };
  }

  state.accessPassword = newPassword;
  state.accessVersion += 1;

  // Explicitly purge any lingering access-tier sessions right away rather
  // than waiting for their next validateToken() call.
  for (const [token, session] of sessions.entries()) {
    if (session.role === 'user') {
      sessions.delete(token);
    }
  }

  return { success: true, message: 'Access password updated. All previous access sessions have been revoked.' };
}

// Explicit "kick everyone out" without necessarily changing the password —
// still master-only.
function revokeAllAccessSessions(masterPassword) {
  if (!safeEqual(masterPassword, MASTER_PASSWORD)) {
    return { success: false, error: 'Invalid master password' };
  }
  let count = 0;
  for (const [token, session] of sessions.entries()) {
    if (session.role === 'user') {
      sessions.delete(token);
      count += 1;
    }
  }
  return { success: true, message: `Revoked ${count} active access session(s).` };
}

// Express middleware to protect API routes
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const session = validateToken(token);

  if (!session) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Please log in to access this resource'
    });
  }

  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Admin access required'
      });
    }
    next();
  });
}

module.exports = {
  verifyPassword,
  createSession,
  validateToken,
  changeAccessPassword,
  revokeAllAccessSessions,
  requireAuth,
  requireAdmin
};
