const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'audit.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function log(action, details = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    details,
  }) + '\n';

  try {
    // Auto-rotate if file exceeds max size
    if (fs.existsSync(LOG_PATH)) {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size >= MAX_SIZE) {
        const backup = LOG_PATH + '.1';
        try { fs.unlinkSync(backup); } catch {}
        fs.renameSync(LOG_PATH, backup);
      }
    }
    fs.appendFileSync(LOG_PATH, entry);
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

function readLog({ limit = 50, offset = 0, action, search } = {}) {
  try {
    if (!fs.existsSync(LOG_PATH)) return { entries: [], total: 0 };

    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    let entries = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try { entries.push(JSON.parse(lines[i])); } catch {}
    }

    if (action) {
      entries = entries.filter(e => e.action === action);
    }
    if (search) {
      const lower = search.toLowerCase();
      entries = entries.filter(e =>
        JSON.stringify(e).toLowerCase().includes(lower)
      );
    }

    const total = entries.length;
    entries = entries.slice(offset, offset + limit);

    return { entries, total };
  } catch {
    return { entries: [], total: 0 };
  }
}

module.exports = { log, readLog };
