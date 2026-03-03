// ── Auth check ──────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/auth/verify', { credentials: 'same-origin' });
    if (!res.ok) { window.location.href = '/login'; return; }
  } catch { window.location.href = '/login'; return; }
  init();
})();

function init() {
  // Hide header when embedded in iframe
  if (window !== window.top) {
    const header = document.querySelector('.admin-header');
    if (header) header.style.display = 'none';
    document.body.style.paddingTop = '0';
  }

  loadSystemInfo();
  pollStats();
  pollServices();
  pollSessions();
  loadAuditLog();

  setInterval(pollStats, 5000);
  setInterval(pollServices, 30000);
  setInterval(pollSessions, 30000);

  // Theme toggle
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  document.getElementById('btn-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });

  // Audit controls
  let auditTimer = null;
  document.getElementById('audit-search').addEventListener('input', () => {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => loadAuditLog(), 400);
  });
  document.getElementById('audit-filter').addEventListener('change', () => loadAuditLog());
  document.getElementById('audit-more').addEventListener('click', () => loadMoreAudit());
}

// ── System Info ──────────────────────────────────────────────

async function loadSystemInfo() {
  try {
    const res = await fetch('/api/admin/system-info', { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();
    setText('si-hostname', d.hostname);
    setText('si-os', d.osName || `${d.platform} ${d.release}`);
    setText('si-kernel', d.release);
    setText('si-cpu', d.cpuModel);
    setText('si-cores', d.cpuCount);
    setText('si-memory', fmtBytes(d.totalMem));
    setText('si-uptime', fmtUptime(d.uptime));
    setText('si-arch', d.arch);
  } catch {}
}

// ── Live Stats + Gauges ──────────────────────────────────────

const netHistory = { rx: [], tx: [], labels: [] };
const NET_MAX_POINTS = 60;
let lastNetRx = 0, lastNetTx = 0, lastNetTime = 0;

async function pollStats() {
  try {
    const res = await fetch('/api/admin/stats', { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();

    drawGauge('gauge-cpu', d.cpu / 100, '#30d158');
    drawGauge('gauge-ram', d.ram / 100, '#0a84ff');
    drawGauge('gauge-disk', d.disk / 100, '#ff9f0a');

    setText('gv-cpu', d.cpu + '%');
    setText('gv-ram', d.ram + '%');
    setText('gv-disk', d.disk + '%');

    setText('stat-load', d.loadAvg.map(v => v.toFixed(2)).join(' / '));

    // Network delta
    const now = Date.now();
    if (lastNetTime > 0) {
      const dt = (now - lastNetTime) / 1000;
      const rxRate = Math.max(0, (d.netRx - lastNetRx) / dt);
      const txRate = Math.max(0, (d.netTx - lastNetTx) / dt);

      netHistory.rx.push(rxRate);
      netHistory.tx.push(txRate);
      const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      netHistory.labels.push(timeStr);

      if (netHistory.rx.length > NET_MAX_POINTS) {
        netHistory.rx.shift();
        netHistory.tx.shift();
        netHistory.labels.shift();
      }

      setText('stat-netrx', fmtSpeed(rxRate));
      setText('stat-nettx', fmtSpeed(txRate));
      drawNetChart();
    }
    lastNetRx = d.netRx;
    lastNetTx = d.netTx;
    lastNetTime = now;
  } catch {}
}

function drawGauge(canvasId, pct, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 10;
  const startAngle = 0.75 * Math.PI;
  const endAngle = 2.25 * Math.PI;
  const lineWidth = 10;

  ctx.clearRect(0, 0, w, h);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  const angle = startAngle + (endAngle - startAngle) * Math.min(pct, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawNetChart() {
  const canvas = document.getElementById('net-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (netHistory.rx.length < 2) return;

  const allValues = [...netHistory.rx, ...netHistory.tx];
  const maxVal = Math.max(...allValues, 1024);
  const pad = { top: 10, right: 10, bottom: 20, left: 50 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtSpeed(maxVal * (1 - i / 4)), pad.left - 6, y + 3);
  }

  function drawLine(data, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (i / (data.length - 1)) * chartW;
      const y = pad.top + chartH - (data[i] / maxVal) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = color.replace(')', ',0.1)').replace('rgb', 'rgba');
    ctx.fill();
  }

  drawLine(netHistory.rx, 'rgb(48, 209, 88)');
  drawLine(netHistory.tx, 'rgb(10, 132, 255)');

  // Legend
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillStyle = 'rgb(48, 209, 88)';
  ctx.fillText('● RX', pad.left + 4, h - 4);
  ctx.fillStyle = 'rgb(10, 132, 255)';
  ctx.fillText('● TX', pad.left + 40, h - 4);
}

// ── Services ─────────────────────────────────────────────────

async function pollServices() {
  try {
    const res = await fetch('/api/admin/services', { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();
    const body = document.getElementById('services-body');
    body.innerHTML = d.services.map(s => {
      const isActive = s.status === 'active';
      return `<tr>
        <td><code>${esc(s.name)}</code></td>
        <td><span class="status-badge ${isActive ? 'status-active' : 'status-inactive'}"><span class="status-dot"></span>${s.status}</span></td>
        <td><button class="svc-restart-btn" data-svc="${esc(s.name)}">Restart</button></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('.svc-restart-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Restarting…';
        try {
          await fetch('/api/admin/services/restart', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: btn.dataset.svc }),
          });
          setTimeout(pollServices, 3000);
        } catch {}
      });
    });
  } catch {}
}

// ── Sessions ─────────────────────────────────────────────────

async function pollSessions() {
  try {
    const res = await fetch('/api/admin/sessions', { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();
    const body = document.getElementById('sessions-body');
    if (d.sessions.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="table-loading">No active sessions</td></tr>';
      return;
    }
    body.innerHTML = d.sessions.map(s => `<tr>
      <td><code>${esc(s.ip)}</code></td>
      <td class="ua-cell" title="${esc(s.userAgent)}">${esc(shortUA(s.userAgent))}</td>
      <td>${fmtTime(s.loginTime)}</td>
      <td>${fmtTime(s.lastActivity)}</td>
    </tr>`).join('');
  } catch {}
}

// ── Audit Log ────────────────────────────────────────────────

let auditOffset = 0;
const AUDIT_PAGE = 50;

async function loadAuditLog() {
  auditOffset = 0;
  const search = document.getElementById('audit-search').value.trim();
  const action = document.getElementById('audit-filter').value;
  await fetchAudit(search, action, 0, false);
}

async function loadMoreAudit() {
  const search = document.getElementById('audit-search').value.trim();
  const action = document.getElementById('audit-filter').value;
  await fetchAudit(search, action, auditOffset, true);
}

async function fetchAudit(search, action, offset, append) {
  try {
    const params = new URLSearchParams({ limit: AUDIT_PAGE, offset });
    if (action) params.set('action', action);
    if (search) params.set('search', search);

    const res = await fetch(`/api/admin/audit?${params}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();

    const body = document.getElementById('audit-body');
    const html = d.entries.map(e => {
      const cls = 'action-' + (e.action || '').replace(/[^a-z_]/g, '');
      const details = Object.entries(e.details || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      return `<tr>
        <td>${fmtTime(e.ts)}</td>
        <td><span class="action-badge ${cls}">${esc(e.action)}</span></td>
        <td class="audit-details">${esc(details)}</td>
      </tr>`;
    }).join('');

    if (append) {
      body.innerHTML += html;
    } else {
      body.innerHTML = html || '<tr><td colspan="3" class="table-loading">No log entries</td></tr>';
    }

    auditOffset = offset + d.entries.length;
    document.getElementById('audit-count').textContent = `${auditOffset} of ${d.total}`;
    document.getElementById('audit-more').hidden = auditOffset >= d.total;
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  parts.push(m + 'm');
  return parts.join(' ');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function shortUA(ua) {
  if (!ua) return 'Unknown';
  // Extract browser name
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  if (ua.length > 40) return ua.substring(0, 40) + '…';
  return ua;
}
