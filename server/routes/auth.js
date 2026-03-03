const express = require('express');
const config = require('../config');
const { verifyPassword, hashPassword, generateToken, generateWsTicket, generateOtpSecret, verifyOtp } = require('../auth');
const authenticate = require('../middleware/authenticate');
const rateLimit = require('express-rate-limit');
const audit = require('../audit');
const sessions = require('../sessions');

const router = express.Router();

// Pending OTP secrets (in-memory, keyed by username)
const pendingOtpSecrets = new Map();

// Reject non-string inputs to prevent type confusion / bcrypt crashes
function requireStrings(obj, fields) {
  for (const f of fields) {
    if (typeof obj[f] !== 'string') return false;
  }
  return true;
}

// Rate limit login attempts: 10 per 15 minutes per IP
// (OTP flow uses 2 requests per login, so limit accounts for that)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

function setCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password || !requireStrings(req.body, ['username', 'password'])) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    config.reloadConfig();

    if (username !== config.USERNAME) {
      console.log(`AUTH_FAILURE: user=${username} ip=${req.ip}`);
      audit.log('login_failed', { username, ip: req.ip, reason: 'invalid_username' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, config.PASSWORD_HASH);
    if (!valid) {
      console.log(`AUTH_FAILURE: user=${username} ip=${req.ip}`);
      audit.log('login_failed', { username, ip: req.ip, reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If OTP is enabled, don't issue token yet
    if (config.OTP_ENABLED && config.OTP_SECRET) {
      return res.json({ otpRequired: true });
    }

    const token = generateToken(username);
    setCookie(res, token);

    console.log(`AUTH_SUCCESS: user=${username} ip=${req.ip}`);
    audit.log('login', { username, ip: req.ip });
    res.json({ ok: true, username });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login/otp — verify username + password + OTP code
router.post('/login/otp', loginLimiter, async (req, res) => {
  try {
    const { username, password, otp } = req.body;

    if (!username || !password || !otp || !requireStrings(req.body, ['username', 'password', 'otp'])) {
      return res.status(400).json({ error: 'Username, password, and OTP code required' });
    }

    config.reloadConfig();

    if (username !== config.USERNAME) {
      console.log(`AUTH_FAILURE: user=${username} ip=${req.ip}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, config.PASSWORD_HASH);
    if (!valid) {
      console.log(`AUTH_FAILURE: user=${username} ip=${req.ip}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!config.OTP_ENABLED || !config.OTP_SECRET) {
      return res.status(400).json({ error: 'OTP is not enabled' });
    }

    if (!verifyOtp(otp, config.OTP_SECRET)) {
      console.log(`AUTH_FAILURE: user=${username} ip=${req.ip} reason=invalid_otp`);
      audit.log('login_failed', { username, ip: req.ip, reason: 'invalid_otp' });
      return res.status(401).json({ error: 'Invalid OTP code' });
    }

    const token = generateToken(username);
    setCookie(res, token);

    console.log(`AUTH_SUCCESS: user=${username} ip=${req.ip} otp=verified`);
    audit.log('login', { username, ip: req.ip, otp: true });
    res.json({ ok: true, username });
  } catch (err) {
    console.error('OTP login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  audit.log('logout', { ip: req.ip });
  sessions.remove(req);
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

// GET /api/auth/verify
router.get('/verify', authenticate, (req, res) => {
  res.json({ ok: true, username: req.user.sub });
});

// POST /api/auth/ws-ticket — get a short-lived WebSocket ticket
router.post('/ws-ticket', authenticate, (req, res) => {
  const ticket = generateWsTicket(req.user.sub);
  res.json({ ticket });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword || !requireStrings(req.body, ['oldPassword', 'newPassword'])) {
      return res.status(400).json({ error: 'Old and new passwords required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (/[\r\n]/.test(newPassword)) {
      return res.status(400).json({ error: 'Password contains invalid characters' });
    }

    config.reloadConfig();

    const valid = await verifyPassword(oldPassword, config.PASSWORD_HASH);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await hashPassword(newPassword);
    config.updateEnv('PASSWORD_HASH', hash);
    config.reloadConfig();

    audit.log('password_changed', { username: req.user.sub, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/otp/setup — generate a new OTP secret (does not enable yet)
router.post('/otp/setup', authenticate, async (req, res) => {
  try {
    const username = req.user.sub;
    const { secret, qr } = await generateOtpSecret(username);
    pendingOtpSecrets.set(username, secret);
    res.json({ secret, qr });
  } catch (err) {
    console.error('OTP setup error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/otp/enable — verify code against pending secret, save to .env
router.post('/otp/enable', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    const username = req.user.sub;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'OTP code required' });
    }

    const pendingSecret = pendingOtpSecrets.get(username);
    if (!pendingSecret) {
      return res.status(400).json({ error: 'No pending OTP setup. Call /otp/setup first.' });
    }

    if (!verifyOtp(code, pendingSecret)) {
      return res.status(401).json({ error: 'Invalid OTP code. Try again.' });
    }

    config.updateEnv('OTP_SECRET', pendingSecret);
    config.updateEnv('OTP_ENABLED', 'true');
    config.reloadConfig();
    pendingOtpSecrets.delete(username);

    audit.log('otp_enabled', { username, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error('OTP enable error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/otp/disable — verify password, remove OTP from .env
router.post('/otp/disable', authenticate, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password required to disable OTP' });
    }

    config.reloadConfig();

    const valid = await verifyPassword(password, config.PASSWORD_HASH);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    config.updateEnv('OTP_ENABLED', 'false');
    config.updateEnv('OTP_SECRET', '');
    config.reloadConfig();

    audit.log('otp_disabled', { username: req.user.sub, ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    console.error('OTP disable error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/otp/status
router.get('/otp/status', authenticate, (_req, res) => {
  config.reloadConfig();
  res.json({ enabled: config.OTP_ENABLED });
});

module.exports = router;
