const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');
const config = require('./config');

const SALT_ROUNDS = 12;

// Short-lived WebSocket tickets (one-time use)
const wsTickets = new Map();

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateToken(username) {
  return jwt.sign(
    { sub: username, iat: Math.floor(Date.now() / 1000) },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRY }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET);
}

function generateWsTicket(username) {
  const ticket = crypto.randomBytes(32).toString('hex');
  wsTickets.set(ticket, {
    username,
    created: Date.now(),
    expires: Date.now() + config.WS_TICKET_EXPIRY * 1000,
  });
  return ticket;
}

function consumeWsTicket(ticket) {
  const data = wsTickets.get(ticket);
  if (!data) return null;
  wsTickets.delete(ticket);
  if (Date.now() > data.expires) return null;
  return data.username;
}

// Clean up expired tickets periodically
setInterval(() => {
  const now = Date.now();
  for (const [ticket, data] of wsTickets) {
    if (now > data.expires) wsTickets.delete(ticket);
  }
}, 60000);

async function generateOtpSecret(username) {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: 'CloudDesktop',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  const uri = totp.toString();
  const qr = await QRCode.toDataURL(uri);
  return { secret: secret.base32, uri, qr };
}

function verifyOtp(token, secret) {
  const totp = new TOTP({
    issuer: 'CloudDesktop',
    label: 'user',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  generateWsTicket,
  consumeWsTicket,
  generateOtpSecret,
  verifyOtp,
};
