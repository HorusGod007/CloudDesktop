const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', 'data', '.env');

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

function updateEnv(key, val) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  }
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    if (k === key) {
      lines[i] = `${key}=${val}`;
      found = true;
      break;
    }
  }
  if (!found) {
    lines.push(`${key}=${val}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

const env = loadEnv();

const config = {
  PORT: parseInt(env.PORT || process.env.PORT || '3000', 10),
  HOST: env.HOST || process.env.HOST || '127.0.0.1',
  JWT_SECRET: env.JWT_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  JWT_EXPIRY: env.JWT_EXPIRY || process.env.JWT_EXPIRY || '24h',
  PASSWORD_HASH: env.PASSWORD_HASH || process.env.PASSWORD_HASH || '',
  USERNAME: env.USERNAME || process.env.CD_USERNAME || 'admin',
  VNC_HOST: env.VNC_HOST || process.env.VNC_HOST || '127.0.0.1',
  VNC_PORT: parseInt(env.VNC_PORT || process.env.VNC_PORT || '6080', 10),
  WS_TICKET_EXPIRY: parseInt(env.WS_TICKET_EXPIRY || '30', 10),
  DISPLAY: env.DISPLAY || process.env.DISPLAY || ':1',
  LOG_LEVEL: env.LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  OTP_SECRET: env.OTP_SECRET || '',
  OTP_ENABLED: (env.OTP_ENABLED || 'false').toLowerCase() === 'true',
};

function reloadConfig() {
  const fresh = loadEnv();
  config.PASSWORD_HASH = fresh.PASSWORD_HASH || process.env.PASSWORD_HASH || '';
  config.OTP_SECRET = fresh.OTP_SECRET || '';
  config.OTP_ENABLED = (fresh.OTP_ENABLED || 'false').toLowerCase() === 'true';
}

config.updateEnv = updateEnv;
config.reloadConfig = reloadConfig;

module.exports = config;
