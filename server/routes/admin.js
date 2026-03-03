const express = require('express');
const { execFile, exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const authenticate = require('../middleware/authenticate');
const audit = require('../audit');
const sessions = require('../sessions');

const router = express.Router();
router.use(authenticate);

// Whitelisted services for restart
const SERVICES = ['clouddesktop-vnc', 'clouddesktop-web', 'clouddesktop-ws'];

// GET /api/admin/stats — CPU, RAM, disk, network, load
router.get('/stats', (_req, res) => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const cpuPercent = Math.round(100 - (totalIdle / totalTick) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const loadAvg = os.loadavg();

  exec('df -B1 / | tail -1', (err, stdout) => {
    let diskPercent = 0, diskTotal = 0, diskUsed = 0;
    if (!err && stdout) {
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 5) {
        diskTotal = parseInt(parts[1], 10) || 0;
        diskUsed = parseInt(parts[2], 10) || 0;
        diskPercent = parseInt(parts[4], 10) || 0;
      }
    }

    // Network throughput from /proc/net/dev
    let netRx = 0, netTx = 0;
    try {
      const netdev = fs.readFileSync('/proc/net/dev', 'utf8');
      for (const line of netdev.split('\n')) {
        const m = line.match(/^\s*(\w+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (m && m[1] !== 'lo') {
          netRx += parseInt(m[2], 10);
          netTx += parseInt(m[3], 10);
        }
      }
    } catch {}

    res.json({
      cpu: cpuPercent,
      ram: memPercent,
      totalMem,
      freeMem,
      disk: diskPercent,
      diskTotal,
      diskUsed,
      loadAvg,
      netRx,
      netTx,
      cpuCount: cpus.length,
    });
  });
});

// GET /api/admin/system-info — static system info
router.get('/system-info', (_req, res) => {
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    uptime: os.uptime(),
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cpuCount: os.cpus().length,
    totalMem: os.totalmem(),
  };

  // Try to get OS pretty name
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const m = osRelease.match(/PRETTY_NAME="([^"]+)"/);
    if (m) info.osName = m[1];
  } catch {}

  res.json(info);
});

// GET /api/admin/services — status of managed services
router.get('/services', (_req, res) => {
  const results = {};
  let pending = SERVICES.length;

  for (const svc of SERVICES) {
    execFile('systemctl', ['is-active', svc], (err, stdout) => {
      results[svc] = (stdout || '').trim() === 'active' ? 'active' : 'inactive';
      if (--pending === 0) {
        res.json({ services: SERVICES.map(s => ({ name: s, status: results[s] })) });
      }
    });
  }
});

// POST /api/admin/services/restart — restart a whitelisted service
router.post('/services/restart', (req, res) => {
  const { service } = req.body;
  if (!service || !SERVICES.includes(service)) {
    return res.status(400).json({ error: 'Invalid service. Allowed: ' + SERVICES.join(', ') });
  }

  audit.log('service_restart', { service, ip: req.ip, source: 'admin' });

  execFile('systemctl', ['restart', service], (err) => {
    if (err) {
      return res.status(500).json({ error: `Failed to restart ${service}` });
    }
    res.json({ ok: true, service });
  });
});

// GET /api/admin/sessions — active sessions
router.get('/sessions', (_req, res) => {
  res.json({ sessions: sessions.getAll() });
});

// GET /api/admin/audit — paginated audit log
router.get('/audit', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const action = req.query.action || undefined;
  const search = req.query.search || undefined;

  const result = audit.readLog({ limit, offset, action, search });
  res.json(result);
});

// GET /api/admin/network — network interface stats
router.get('/network', (_req, res) => {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (name === 'lo') continue;
    const ipv4 = addrs.find(a => a.family === 'IPv4');
    if (ipv4) {
      result.push({ name, address: ipv4.address, mac: ipv4.mac });
    }
  }

  // Read bytes from /proc/net/dev
  try {
    const netdev = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of netdev.split('\n')) {
      const m = line.match(/^\s*(\w+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (m) {
        const iface = result.find(i => i.name === m[1]);
        if (iface) {
          iface.rxBytes = parseInt(m[2], 10);
          iface.txBytes = parseInt(m[3], 10);
        }
      }
    }
  } catch {}

  res.json({ interfaces: result });
});

module.exports = router;
