const express = require('express');
const { execFile, exec, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// All desktop routes require authentication
router.use(authenticate);

// Resolve home directory dynamically (works for root or dedicated user)
const RUN_HOME = process.env.HOME || os.homedir() || '/root';

// X environment for all xrandr/xclip commands
const X_ENV = {
  ...process.env,
  DISPLAY: config.DISPLAY,
  XAUTHORITY: path.join(RUN_HOME, '.Xauthority'),
  HOME: RUN_HOME,
};

const DESKTOP_DIR = path.join(RUN_HOME, 'Desktop');
const DOWNLOADS_DIR = path.join(RUN_HOME, 'Downloads');

// ── Chunked upload system ──────────────────────────────────
const UPLOAD_TEMP_DIR = '/tmp/clouddesktop-uploads';
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk
const activeUploads = new Map();

// Cleanup stale uploads every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, up] of activeUploads) {
    if (now - up.lastActivity > 30 * 60 * 1000) {
      try { fs.unlinkSync(up.tempPath); } catch {}
      activeUploads.delete(id);
    }
  }
}, 10 * 60 * 1000);

function sanitizeDestDir(dest) {
  if (!dest) return DESKTOP_DIR;
  const clean = path.resolve(dest.replace(/\0/g, ''));
  // Block only /proc, /sys, /dev for safety; allow everything else
  if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) return DESKTOP_DIR;
  return clean;
}

// Multer setup for file uploads (100MB limit)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(DESKTOP_DIR, { recursive: true });
    cb(null, DESKTOP_DIR);
  },
  filename: (_req, file, cb) => {
    // Sanitize filename: strip path separators, null bytes, leading dots
    let name = file.originalname
      .replace(/[/\\]/g, '_')
      .replace(/\0/g, '')
      .replace(/^\.+/, '');
    if (!name) name = 'upload';
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Allowlisted apps for launch endpoint
const ALLOWED_APPS = {
  terminal: { cmd: 'xfce4-terminal', args: [] },
  firefox: { cmd: 'firefox', args: ['--no-remote'] },
  chrome: { cmd: 'google-chrome', args: ['--no-sandbox', '--no-first-run'] },
  filemanager: { cmd: 'thunar', args: [] },
  claude: { cmd: 'xfce4-terminal', args: ['-x', 'bash', '-c', 'export PATH="$HOME/.local/bin:$PATH"; claude; exec bash'] },
  'claude-perf': { cmd: 'xfce4-terminal', args: ['-x', 'bash', '-c', 'export PATH="$HOME/.local/bin:$PATH"; export IS_SANDBOX=1; claude --dangerously-skip-permissions; exec bash'] },
  editor: { cmd: 'mousepad', args: [] },
};

// GET /api/desktop/config — dock configuration + environment info
router.get('/config', (_req, res) => {
  res.json({
    claudeDock: process.env.CLAUDE_DOCK !== 'false',
    homeDir: RUN_HOME,
    desktopDir: DESKTOP_DIR,
  });
});

// GET /api/desktop/status
router.get('/status', (_req, res) => {
  const checks = {};

  // Check VNC
  execFile('systemctl', ['is-active', 'clouddesktop-vnc'], (err, stdout) => {
    checks.vnc = (stdout || '').trim() === 'active';

    // Check web backend
    execFile('systemctl', ['is-active', 'clouddesktop-web'], (err2, stdout2) => {
      checks.web = (stdout2 || '').trim() === 'active';
      checks.allHealthy = checks.vnc && checks.web;

      res.json(checks);
    });
  });
});

// POST /api/desktop/resolution
router.post('/resolution', (req, res) => {
  const { width, height } = req.body;

  if (!width || !height ||
      width < 640 || width > 3840 ||
      height < 480 || height > 2160) {
    return res.status(400).json({ error: 'Invalid resolution (640-3840 x 480-2160)' });
  }

  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const modeName = `${w}x${h}`;

  // Try setting the mode directly first
  execFile('xrandr', ['--output', 'VNC-0', '--mode', modeName], {
    env: X_ENV,
  }, (err) => {
    if (!err) {
      return res.json({ ok: true, width: w, height: h });
    }

    // Mode doesn't exist — create it with cvt, then add it
    execFile('cvt', [String(w), String(h), '60'], (cvtErr, cvtOut) => {
      if (cvtErr) {
        return res.status(500).json({ error: 'Failed to generate modeline' });
      }

      // Parse cvt output: "Modeline "1366x768_60.00" 85.25 ..."
      const match = cvtOut.match(/Modeline\s+"[^"]+"\s+(.+)/);
      if (!match) {
        return res.status(500).json({ error: 'Failed to parse modeline' });
      }

      const modeline = match[1].trim();
      const newModeName = `${w}x${h}_60.00`;

      // Chain: newmode → addmode → set mode
      const cmd = [
        `xrandr --newmode "${newModeName}" ${modeline} 2>/dev/null; true`,
        `xrandr --addmode VNC-0 "${newModeName}" 2>/dev/null; true`,
        `xrandr --output VNC-0 --mode "${newModeName}"`,
      ].join(' && ');

      exec(cmd, { env: X_ENV }, (execErr) => {
        if (execErr) {
          return res.status(500).json({ error: 'Failed to change resolution' });
        }
        res.json({ ok: true, width: w, height: h });
      });
    });
  });
});

// POST /api/desktop/restart
router.post('/restart', (_req, res) => {
  execFile('systemctl', ['restart', 'clouddesktop-vnc'], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to restart VNC' });
    }
    // Give VNC a moment to start
    setTimeout(() => {
      execFile('systemctl', ['restart', 'clouddesktop-ws'], (err2) => {
        if (err2) {
          return res.status(500).json({ error: 'VNC restarted but websockify failed' });
        }
        res.json({ ok: true });
      });
    }, 2000);
  });
});

// POST /api/desktop/clipboard
router.post('/clipboard', (req, res) => {
  const { text } = req.body;

  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'Text required' });
  }

  // Write to X clipboard using xclip
  const proc = spawn('xclip', ['-selection', 'clipboard'], {
    env: X_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdin.write(text);
  proc.stdin.end();

  proc.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Failed to set clipboard' });
    }
    res.json({ ok: true });
  });

  proc.on('error', () => {
    res.status(500).json({ error: 'xclip not available' });
  });
});

// GET /api/desktop/clipboard
router.get('/clipboard', (_req, res) => {
  execFile('xclip', ['-selection', 'clipboard', '-o'], {
    env: X_ENV,
  }, (err, stdout) => {
    if (err) {
      return res.json({ text: '' });
    }
    res.json({ text: stdout });
  });
});

// POST /api/desktop/upload — file upload to ~/Desktop
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  res.json({ ok: true, filename: req.file.filename, size: req.file.size });
});

// GET /api/desktop/download — serve file with Range support for pause/resume
// Supports ?file=/absolute/path (any allowed dir) or ?path=filename (Desktop/Downloads)
router.get('/download', (req, res) => {
  let filePath = null;

  if (req.query.file) {
    // Absolute path mode
    const clean = path.resolve(req.query.file.replace(/\0/g, ''));
    if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (fs.existsSync(clean) && fs.statSync(clean).isFile()) filePath = clean;
  } else if (req.query.path) {
    // Legacy basename mode (Desktop/Downloads lookup)
    const base = path.basename(req.query.path);
    if (!base || base === '.' || base === '..') {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const desktopPath = path.join(DESKTOP_DIR, base);
    const downloadsPath = path.join(DOWNLOADS_DIR, base);
    if (fs.existsSync(desktopPath)) filePath = desktopPath;
    else if (fs.existsSync(downloadsPath)) filePath = downloadsPath;
  } else {
    return res.status(400).json({ error: 'Missing file or path parameter' });
  }

  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const filename = path.basename(filePath);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/desktop/files — list files in Desktop + Downloads
router.get('/files', (_req, res) => {
  const results = [];

  const readDir = (dir, label) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            results.push({
              name: entry.name,
              location: label,
              size: stat.size,
              modified: stat.mtime,
            });
          } catch {
            // skip files we can't stat
          }
        }
      }
    } catch {
      // directory may not exist yet
    }
  };

  readDir(DESKTOP_DIR, 'Desktop');
  readDir(DOWNLOADS_DIR, 'Downloads');

  res.json({ files: results });
});

// GET /api/desktop/stats — CPU/RAM/disk usage
router.get('/stats', (_req, res) => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const cpuPercent = Math.round(100 - (totalIdle / totalTick) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  // Get disk usage via df
  exec('df -B1 / | tail -1', (err, stdout) => {
    let diskPercent = 0;
    if (!err && stdout) {
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 5) {
        diskPercent = parseInt(parts[4], 10) || 0;
      }
    }

    res.json({
      cpu: cpuPercent,
      ram: memPercent,
      disk: diskPercent,
      totalMem: totalMem,
      freeMem: freeMem,
      user: os.userInfo().username,
    });
  });
});

// POST /api/desktop/launch — launch allowlisted app
router.post('/launch', (req, res) => {
  const { app, cwd } = req.body;

  if (!app || !ALLOWED_APPS[app]) {
    return res.status(400).json({
      error: 'Invalid app. Allowed: ' + Object.keys(ALLOWED_APPS).join(', '),
    });
  }

  // Determine working directory for claude apps
  let workDir = undefined;
  if (cwd && (app === 'claude' || app === 'claude-perf')) {
    // Sanitize: must be absolute path, no null bytes
    const cleanPath = path.resolve(cwd.replace(/\0/g, ''));
    // Create directory if it doesn't exist
    try {
      fs.mkdirSync(cleanPath, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: `Cannot create directory: ${e.message}` });
    }
    workDir = cleanPath;
  }

  const { cmd, args } = ALLOWED_APPS[app];

  const spawnOpts = {
    env: X_ENV,
    detached: true,
    stdio: 'ignore',
  };
  if (workDir) spawnOpts.cwd = workDir;

  const child = spawn(cmd, args, spawnOpts);

  child.unref();

  child.on('error', (err) => {
    return res.status(500).json({ error: `Failed to launch ${app}: ${err.message}` });
  });

  // Give it a moment to see if it fails immediately
  setTimeout(() => {
    res.json({ ok: true, app });
  }, 300);
});

// GET /api/desktop/windows — list open X11 windows
router.get('/windows', (_req, res) => {
  execFile('wmctrl', ['-l', '-p'], { env: X_ENV }, (err, stdout) => {
    if (err) {
      return res.json({ windows: [] });
    }
    const windows = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      // Format: 0x00c0002c  0  1234  hostname Title here
      const m = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.+)$/i);
      if (!m) continue;
      const desktop = parseInt(m[2], 10);
      const title = m[4].trim();
      // Skip the root desktop window and negative desktop entries
      if (desktop < 0 || title === 'Desktop') continue;
      windows.push({ id: m[1], pid: parseInt(m[3], 10), title });
    }
    res.json({ windows });
  });
});

// POST /api/desktop/windows/focus — raise and focus a window
router.post('/windows/focus', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string' || !/^0x[\da-f]+$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid window id' });
  }
  execFile('wmctrl', ['-i', '-a', id], { env: X_ENV }, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to focus window' });
    }
    res.json({ ok: true });
  });
});

// ── Chunked Upload Endpoints ───────────────────────────────

// POST /api/desktop/upload/init — start chunked upload
router.post('/upload/init', (req, res) => {
  const { filename, totalSize, destination } = req.body;
  if (!filename || !totalSize || totalSize <= 0) {
    return res.status(400).json({ error: 'filename and totalSize required' });
  }
  let safeName = filename.replace(/[/\\]/g, '_').replace(/\0/g, '').replace(/^\.+/, '');
  if (!safeName) safeName = 'upload';
  const destDir = sanitizeDestDir(destination);
  const uploadId = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(UPLOAD_TEMP_DIR, uploadId);
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  activeUploads.set(uploadId, {
    id: uploadId, filename: safeName, totalSize,
    bytesReceived: 0, totalChunks, chunksReceived: 0,
    destination: destDir, tempPath,
    status: 'uploading', startedAt: Date.now(), lastActivity: Date.now(),
  });

  fs.writeFileSync(tempPath, Buffer.alloc(0));
  res.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
});

// POST /api/desktop/upload/chunk?uploadId=X — receive one chunk (raw binary)
router.post('/upload/chunk',
  express.raw({ type: 'application/octet-stream', limit: '6mb' }),
  (req, res) => {
    const up = activeUploads.get(req.query.uploadId);
    if (!up) return res.status(404).json({ error: 'Upload not found' });
    if (up.status === 'cancelled') return res.status(410).json({ error: 'Cancelled' });
    const chunk = req.body;
    if (!Buffer.isBuffer(chunk) || !chunk.length) {
      return res.status(400).json({ error: 'Empty chunk' });
    }
    try {
      fs.appendFileSync(up.tempPath, chunk);
      up.bytesReceived += chunk.length;
      up.chunksReceived++;
      up.lastActivity = Date.now();

      if (up.bytesReceived >= up.totalSize) {
        fs.mkdirSync(up.destination, { recursive: true });
        let finalName = up.filename;
        let target = path.join(up.destination, finalName);
        if (fs.existsSync(target)) {
          const ext = path.extname(finalName);
          const base = path.basename(finalName, ext);
          let i = 1;
          while (fs.existsSync(target)) {
            finalName = `${base} (${i})${ext}`;
            target = path.join(up.destination, finalName);
            i++;
          }
        }
        try { fs.renameSync(up.tempPath, target); }
        catch { fs.copyFileSync(up.tempPath, target); fs.unlinkSync(up.tempPath); }
        up.status = 'completed';
        activeUploads.delete(up.id);
        return res.json({ ok: true, completed: true, filename: finalName });
      }
      res.json({ ok: true, bytesReceived: up.bytesReceived, chunksReceived: up.chunksReceived });
    } catch {
      up.status = 'error';
      res.status(500).json({ error: 'Write failed' });
    }
  });

// POST /api/desktop/upload/pause
router.post('/upload/pause', (req, res) => {
  const up = activeUploads.get(req.body.uploadId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  up.status = 'paused';
  up.lastActivity = Date.now();
  res.json({ ok: true });
});

// POST /api/desktop/upload/resume — returns progress so client can resume
router.post('/upload/resume', (req, res) => {
  const up = activeUploads.get(req.body.uploadId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  up.status = 'uploading';
  up.lastActivity = Date.now();
  res.json({ ok: true, bytesReceived: up.bytesReceived, chunksReceived: up.chunksReceived });
});

// DELETE /api/desktop/upload/:uploadId — cancel and cleanup
router.delete('/upload/:uploadId', (req, res) => {
  const up = activeUploads.get(req.params.uploadId);
  if (up) {
    up.status = 'cancelled';
    try { fs.unlinkSync(up.tempPath); } catch {}
    activeUploads.delete(req.params.uploadId);
  }
  res.json({ ok: true });
});

// GET /api/desktop/upload/active — list active uploads
router.get('/upload/active', (_req, res) => {
  const list = [];
  for (const up of activeUploads.values()) {
    list.push({
      id: up.id, filename: up.filename, totalSize: up.totalSize,
      bytesReceived: up.bytesReceived, status: up.status, destination: up.destination,
    });
  }
  res.json({ uploads: list });
});

// POST /api/desktop/rename — rename a file or directory
router.post('/rename', (req, res) => {
  const { oldPath, newName } = req.body;
  if (!oldPath || !newName || typeof oldPath !== 'string' || typeof newName !== 'string') {
    return res.status(400).json({ error: 'oldPath and newName required' });
  }
  const clean = path.resolve(oldPath.replace(/\0/g, ''));
  if (clean.startsWith('/proc') || clean.startsWith('/sys') || clean.startsWith('/dev')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  // Sanitize new name
  const safeName = newName.replace(/[/\\]/g, '_').replace(/\0/g, '').trim();
  if (!safeName || safeName === '.' || safeName === '..') {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const newPath = path.join(path.dirname(clean), safeName);
  if (!fs.existsSync(clean)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ error: 'Name already exists' });
  }
  try {
    fs.renameSync(clean, newPath);
    res.json({ ok: true, newPath });
  } catch {
    res.status(500).json({ error: 'Rename failed' });
  }
});

// GET /api/desktop/browse — directory listing; ?files=true to include files
router.get('/browse', (req, res) => {
  const dir = req.query.dir || RUN_HOME;
  const includeFiles = req.query.files === 'true';
  const clean = path.resolve(dir.replace(/\0/g, ''));
  try {
    const entries = fs.readdirSync(clean, { withFileTypes: true });
    const dirs = entries
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        try { fs.accessSync(path.join(clean, e.name), fs.constants.R_OK); return e.isDirectory(); }
        catch { return false; }
      })
      .map(e => ({ name: e.name, path: path.join(clean, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const result = { current: clean, parent: path.dirname(clean), directories: dirs };
    if (includeFiles) {
      result.files = entries
        .filter(e => e.isFile() && !e.name.startsWith('.'))
        .map(e => {
          try {
            const s = fs.statSync(path.join(clean, e.name));
            return { name: e.name, path: path.join(clean, e.name), size: s.size, modified: s.mtime };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json(result);
  } catch {
    res.status(404).json({ error: 'Directory not found' });
  }
});

module.exports = router;
