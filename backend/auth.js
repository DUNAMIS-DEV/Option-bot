/**
 * auth.js — Password Protection & Session Management
 * ===================================================
 * Two-tier auth:
 *   1. Access Password  → view dashboard, trade, generate setups
 *   2. Admin Password   → full access + change access password
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(__dirname, 'config');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');

// Ensure config directory and default auth file exist
function ensureAuthConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(AUTH_FILE)) {
      const defaults = {
        accessPassword: 'trader123',
        adminPassword: 'admin123',
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(AUTH_FILE, JSON.stringify(defaults, null, 2));
      console.log('[AUTH] Created default auth config. Access: trader123 | Admin: admin123');
    }
  } catch (err) {
    console.error('[AUTH] Failed to create auth config:', err.message);
  }
}

function loadAuthConfig() {
  ensureAuthConfig();
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[AUTH] Failed to load auth config:', err.message);
    return { accessPassword: 'trader123', adminPassword: 'admin123' };
  }
}

function saveAuthConfig(config) {
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[AUTH] Failed to save auth config:', err.message);
    return false;
  }
}

// Simple token store (in-memory, resets on server restart)
const sessions = new Map(); // token -> { role, createdAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(role) {
  const token = generateToken();
  sessions.set(token, {
    role,
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
  return session;
}

function verifyPassword(password) {
  const config = loadAuthConfig();
  if (password === config.accessPassword) {
    return { valid: true, role: 'user' };
  }
  if (password === config.adminPassword) {
    return { valid: true, role: 'admin' };
  }
  return { valid: false, role: null };
}

function changeAccessPassword(adminPassword, newPassword) {
  const config = loadAuthConfig();
  if (adminPassword !== config.adminPassword) {
    return { success: false, error: 'Invalid admin password' };
  }
  if (!newPassword || newPassword.length < 4) {
    return { success: false, error: 'New password must be at least 4 characters' };
  }
  config.accessPassword = newPassword;
  if (saveAuthConfig(config)) {
    return { success: true, message: 'Access password updated successfully' };
  }
  return { success: false, error: 'Failed to save new password' };
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
  requireAuth,
  requireAdmin,
  loadAuthConfig
};
