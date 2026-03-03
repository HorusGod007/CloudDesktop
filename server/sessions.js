const sessions = new Map();

function getKey(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return `${ip}::${ua}`;
}

function touch(req) {
  const key = getKey(req);
  const existing = sessions.get(key);
  const now = Date.now();

  if (existing) {
    existing.lastActivity = now;
  } else {
    sessions.set(key, {
      ip: req.ip || req.connection?.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      loginTime: now,
      lastActivity: now,
    });
  }
}

function remove(req) {
  sessions.delete(getKey(req));
}

function getAll() {
  const result = [];
  for (const [, session] of sessions) {
    result.push({ ...session });
  }
  return result;
}

// Auto-cleanup sessions older than 24h
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, session] of sessions) {
    if (session.lastActivity < cutoff) {
      sessions.delete(key);
    }
  }
}, 60 * 1000);

module.exports = { touch, remove, getAll };
