import RFB from '/vendor/novnc/core/rfb.js';

const statusOverlay = document.getElementById('status-overlay');
const statusText    = document.getElementById('status-text');
const vncContainer  = document.getElementById('vnc-container');

// Modals (declared early so they're available everywhere)
const uploadModal      = document.getElementById('upload-modal');
const dirModal         = document.getElementById('dir-modal');
const filebrowserModal = document.getElementById('filebrowser-modal');

// Upload/download state (declared early for use throughout)
let selectedUploadFiles = [];
const uploads   = new Map();
const downloads = new Map();

let rfb = null;
let reconnectTimer = null;

// ── Device detection ────────────────────────────────────────
const isTouch   = navigator.maxTouchPoints > 0 || window.matchMedia('(hover: none)').matches;
const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const isMobile  = isTouch && (Math.min(window.innerWidth, window.innerHeight) <= 600);

// ── Auth check ──────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/verify', { credentials: 'same-origin' });
    if (!res.ok) { window.location.href = '/login'; return false; }
    return true;
  } catch {
    window.location.href = '/login';
    return false;
  }
}

// ── WS ticket ───────────────────────────────────────────────

async function getWsTicket() {
  const res = await fetch('/api/auth/ws-ticket', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to get WS ticket');
  return (await res.json()).ticket;
}

// ── VNC connect ─────────────────────────────────────────────

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  showStatus('Connecting to desktop…');

  try {
    const ticket   = await getWsTicket();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl    = `${protocol}//${location.host}/websockify?ticket=${ticket}`;

    if (rfb) { rfb.disconnect(); rfb = null; }

    rfb = new RFB(vncContainer, wsUrl, { wsProtocols: ['binary'] });
    rfb.scaleViewport  = true;
    rfb.resizeSession  = true;
    rfb.clipViewport   = false;
    rfb.showDotCursor  = true;
    rfb.qualityLevel   = 6;
    rfb.compressionLevel = 2;

    rfb.addEventListener('connect',             onConnect);
    rfb.addEventListener('disconnect',          onDisconnect);
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: '' }));
    rfb.addEventListener('clipboard',           onVncClipboard);
  } catch {
    showStatus('Connection failed. Retrying…');
    scheduleReconnect();
  }
}

function onConnect() { hideStatus(); rfb.focus(); }

function onDisconnect(e) {
  const clean = (e.detail || {}).clean;
  showStatus(clean ? 'Disconnected from desktop.' : 'Connection lost. Reconnecting…');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (await checkAuth()) connect();
  }, 3000);
}

function showStatus(msg) { statusText.textContent = msg; statusOverlay.classList.remove('hidden'); }
function hideStatus()    { statusOverlay.classList.add('hidden'); }

// ── Native clipboard sync ───────────────────────────────────

// VNC → browser: when VNC clipboard changes, write to browser clipboard
function onVncClipboard(e) {
  const text = e.detail.text;
  if (navigator.clipboard && text) navigator.clipboard.writeText(text).catch(() => {});
}

// Push text to X server clipboard via API
function setXClipboard(text) {
  return fetch('/api/desktop/clipboard', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

// Ctrl+V: intercept BEFORE noVNC, set X clipboard, wait, then replay keystroke
vncContainer.addEventListener('keydown', async (e) => {
  if (!rfb) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        // Set VNC protocol clipboard + X server clipboard
        rfb.clipboardPasteFrom(text);
        await setXClipboard(text);

        // Small delay to ensure xclip has written before sending Ctrl+V
        await new Promise(r => setTimeout(r, 80));

        // Replay Ctrl+V to remote desktop
        rfb.sendKey(0xFFE3, 'ControlLeft', true);
        rfb.sendKey(0x0076, 'KeyV', true);
        rfb.sendKey(0x0076, 'KeyV', false);
        rfb.sendKey(0xFFE3, 'ControlLeft', false);
      }
    } catch { /* clipboard permission denied */ }
  }
}, true);

// Ctrl+C: also sync from X clipboard back to browser after a short delay
vncContainer.addEventListener('keydown', async (e) => {
  if (!rfb) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    // Let noVNC send the Ctrl+C normally, then after a moment read X clipboard
    setTimeout(async () => {
      try {
        const res = await fetch('/api/desktop/clipboard', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.text && navigator.clipboard) {
          navigator.clipboard.writeText(data.text).catch(() => {});
        }
      } catch { /* silent */ }
    }, 300);
  }
});

// ── Dock auto-hide ──────────────────────────────────────────

const dock        = document.getElementById('dock');
const dockTrigger = document.getElementById('dock-trigger');
let dockHideTimer = null;
// Force auto-hide on mobile, respect setting on desktop
let dockAutoHide  = isMobile ? true : (localStorage.getItem('dock-autohide') === 'on');

function showDock() {
  clearTimeout(dockHideTimer);
  dock.classList.add('visible');
}

function hideDock() {
  clearTimeout(dockHideTimer);
  dock.classList.remove('visible');
}

function scheduleDockHide() {
  if (!dockAutoHide) return;
  clearTimeout(dockHideTimer);
  dockHideTimer = setTimeout(hideDock, isMobile ? 3000 : 900);
}

function applyAutoHide() {
  if (dockAutoHide) {
    dock.classList.remove('no-autohide', 'visible');
  } else {
    dock.classList.add('no-autohide', 'visible');
  }
}

// Mouse trigger (desktop)
dockTrigger.addEventListener('mouseenter', showDock);
dock.addEventListener('mouseenter', showDock);
dock.addEventListener('mouseleave', scheduleDockHide);

// Touch trigger — tap bottom edge to toggle dock
dockTrigger.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (dock.classList.contains('visible')) {
    hideDock();
  } else {
    showDock();
    scheduleDockHide();
  }
}, { passive: false });

// Close dock when tapping VNC area or any dock button on mobile
if (isTouch) {
  vncContainer.addEventListener('touchstart', () => {
    if (dock.classList.contains('visible')) hideDock();
  }, { passive: true });

  // Hide dock after tapping a dock button (app launched)
  dock.addEventListener('click', (e) => {
    if (e.target.closest('.dock-item')) {
      setTimeout(hideDock, 300);
    }
  });
}

applyAutoHide();

// ── Dock magnification (desktop only) ──────────────────────

if (!isTouch) {
  const MAG_RADIUS = 110;
  const MAG_MAX    = 1.4;
  const dockItems  = dock.querySelectorAll('.dock-item');

  dock.addEventListener('mousemove', (e) => {
    const mx = e.clientX;
    for (const item of dockItems) {
      const rect = item.getBoundingClientRect();
      const dist = Math.abs(mx - (rect.left + rect.width / 2));
      const mag  = dist < MAG_RADIUS
        ? 1 + (MAG_MAX - 1) * (1 - dist / MAG_RADIUS)
        : 1;
      item.style.setProperty('--mag', mag.toFixed(3));
    }
  });

  dock.addEventListener('mouseleave', () => {
    for (const item of dock.querySelectorAll('.dock-item'))
      item.style.setProperty('--mag', '1');
  });
}

// ── Stats polling (topbar only) ─────────────────────────────

const topbarCpu  = document.getElementById('topbar-cpu');
const topbarRam  = document.getElementById('topbar-ram');
const topbarDisk = document.getElementById('topbar-disk');
const topbarUser = document.getElementById('topbar-user');

async function pollStats() {
  try {
    const res  = await fetch('/api/desktop/stats', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (topbarCpu)  topbarCpu.textContent  = `${data.cpu}%`;
    if (topbarRam)  topbarRam.textContent  = `${data.ram}%`;
    if (topbarDisk) topbarDisk.textContent = `${data.disk}%`;
    if (topbarUser && data.user) topbarUser.textContent = data.user;
  } catch { /* silent */ }
}

setInterval(pollStats, 5000);
pollStats();

// ── Top bar clock ───────────────────────────────────────────

const topbarClock = document.getElementById('topbar-clock');
function updateClock() {
  if (!topbarClock) return;
  const now  = new Date();
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  topbarClock.textContent = now.toLocaleDateString('en-US', opts);
}
setInterval(updateClock, 10000);
updateClock();

// ── Top bar buttons ─────────────────────────────────────────

const topbar = document.getElementById('topbar');
let topbarVisible = localStorage.getItem('topbar') !== 'off';

function applyTopbar() {
  // On mobile (<=600px), topbar is hidden via CSS; --topbar-h = 0
  const mobile = window.innerWidth <= 600;
  topbar.classList.toggle('hidden', !topbarVisible || mobile);
  document.documentElement.style.setProperty('--topbar-h', (topbarVisible && !mobile) ? '28px' : '0px');
}
applyTopbar();

document.getElementById('topbar-fullscreen').addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => { toggleMobileFullscreen(); });
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    // iOS Safari / browsers without Fullscreen API
    toggleMobileFullscreen();
  }
});

let mobileFullscreen = false;
function toggleMobileFullscreen() {
  mobileFullscreen = !mobileFullscreen;
  document.body.classList.toggle('mobile-fullscreen', mobileFullscreen);
  if (mobileFullscreen) {
    topbar.classList.add('hidden');
    window.scrollTo(0, 1); // nudge iOS to hide address bar
  } else {
    applyTopbar();
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) applyTopbar();
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement) applyTopbar();
});

document.getElementById('topbar-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ── App launch helpers ──────────────────────────────────────

async function launchApp(app, cwd) {
  try {
    await fetch('/api/desktop/launch', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cwd ? { app, cwd } : { app }),
    });
  } catch { /* silent */ }
}

// ── Claude directory picker ─────────────────────────────────

// ── Server-side config (home dir, dock options) ─────────────
let SERVER_HOME = '/root';
let SERVER_DESKTOP = '/root/Desktop';

const claudeDirModal  = document.getElementById('claude-dir-modal');
const claudeDirInput  = document.getElementById('claude-dir-input');
const claudeDirTitle  = document.getElementById('claude-dir-title');
let pendingClaudeApp  = null;

claudeDirInput.value = localStorage.getItem('claude-dir') || SERVER_HOME;

document.getElementById('claude-dir-go').addEventListener('click', async () => {
  const dir = claudeDirInput.value.trim() || SERVER_HOME;
  localStorage.setItem('claude-dir', dir);
  claudeDirModal.hidden = true;
  await launchApp(pendingClaudeApp, dir);
});

document.getElementById('claude-dir-close').addEventListener('click', () => {
  claudeDirModal.hidden = true;
});

claudeDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('claude-dir-go').click();
});

(async () => {
  try {
    const r = await fetch('/api/desktop/config', { credentials: 'same-origin' });
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.homeDir) SERVER_HOME = cfg.homeDir;
      if (cfg.desktopDir) SERVER_DESKTOP = cfg.desktopDir;
      if (cfg.claudeDock) {
        document.querySelectorAll('.dock-claude').forEach(el => el.hidden = false);
      }
      // Update defaults that depend on home dir
      if (!localStorage.getItem('claude-dir')) claudeDirInput.value = SERVER_HOME;
      if (!localStorage.getItem('upload-dest')) uploadDestInput.value = SERVER_DESKTOP;
    }
  } catch {}
})();

// ── Dock app icon clicks ────────────────────────────────────

document.querySelectorAll('.dock-app').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const app = btn.dataset.app;

    // Claude apps → show dir picker first
    if (app === 'claude' || app === 'claude-perf') {
      pendingClaudeApp         = app;
      claudeDirTitle.textContent = app === 'claude' ? 'Launch Claude Code' : 'Launch Claude Fast';
      claudeDirModal.hidden    = false;
      claudeDirInput.focus();
      claudeDirInput.select();
      return;
    }

    await launchApp(app);
  });
});

// ── Drag-and-drop uploads ───────────────────────────────────

const dropOverlay = document.getElementById('drop-overlay');
let dragCounter   = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault(); dragCounter++;
  if (dragCounter === 1) dropOverlay.hidden = false;
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault(); dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.hidden = true; }
});
document.addEventListener('dragover',  (e) => e.preventDefault());

document.addEventListener('drop', async (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.hidden = true;
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const dest = localStorage.getItem('upload-dest') || SERVER_DESKTOP;
  for (const file of files) {
    startUpload(file, dest);
  }
});

// ── Upload button ───────────────────────────────────────────

document.getElementById('btn-upload').addEventListener('click', () => {
  selectedUploadFiles = [];
  updateSelectedFiles();
  uploadModal.hidden = false;
});

// ── Theme ───────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = document.getElementById('settings-theme');
  if (btn) btn.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

setTheme(localStorage.getItem('theme') || 'dark');

// ── Settings modal ──────────────────────────────────────────

const settingsModal = document.getElementById('settings-modal');

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsModal.hidden = false;
  refreshOtpStatus();
});
document.getElementById('settings-close').addEventListener('click', () => {
  settingsModal.hidden = true;
});
document.getElementById('settings-theme').addEventListener('click', () => {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

const autohideBtn = document.getElementById('settings-autohide');
autohideBtn.textContent = dockAutoHide ? 'On' : 'Off';
autohideBtn.addEventListener('click', () => {
  dockAutoHide = !dockAutoHide;
  localStorage.setItem('dock-autohide', dockAutoHide ? 'on' : 'off');
  autohideBtn.textContent = dockAutoHide ? 'On' : 'Off';
  applyAutoHide();
});

const topbarBtn = document.getElementById('settings-topbar');
topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
topbarBtn.addEventListener('click', () => {
  topbarVisible = !topbarVisible;
  localStorage.setItem('topbar', topbarVisible ? 'on' : 'off');
  topbarBtn.textContent = topbarVisible ? 'On' : 'Off';
  applyTopbar();
});

// ── Change Password ─────────────────────────────────────────

const chpwModal    = document.getElementById('chpw-modal');
const chpwOld      = document.getElementById('chpw-old');
const chpwNew      = document.getElementById('chpw-new');
const chpwConfirm  = document.getElementById('chpw-confirm');
const chpwError    = document.getElementById('chpw-error');
const chpwSuccess  = document.getElementById('chpw-success');

function chpwReset() {
  chpwOld.value = ''; chpwNew.value = ''; chpwConfirm.value = '';
  chpwError.hidden = true; chpwSuccess.hidden = true;
}

document.getElementById('settings-chpw').addEventListener('click', () => {
  chpwReset();
  chpwModal.hidden = false;
});
document.getElementById('chpw-close').addEventListener('click', () => {
  chpwModal.hidden = true;
});

document.getElementById('chpw-submit').addEventListener('click', async () => {
  chpwError.hidden = true;
  chpwSuccess.hidden = true;

  const oldPw = chpwOld.value;
  const newPw = chpwNew.value;
  const confirmPw = chpwConfirm.value;

  if (!oldPw || !newPw || !confirmPw) {
    chpwError.textContent = 'All fields are required';
    chpwError.hidden = false;
    return;
  }
  if (newPw.length < 8) {
    chpwError.textContent = 'New password must be at least 8 characters';
    chpwError.hidden = false;
    return;
  }
  if (newPw !== confirmPw) {
    chpwError.textContent = 'New passwords do not match';
    chpwError.hidden = false;
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      chpwSuccess.textContent = 'Password changed successfully';
      chpwSuccess.hidden = false;
      chpwOld.value = ''; chpwNew.value = ''; chpwConfirm.value = '';
    } else {
      chpwError.textContent = data.error || 'Failed to change password';
      chpwError.hidden = false;
    }
  } catch {
    chpwError.textContent = 'Connection error';
    chpwError.hidden = false;
  }
});

// ── Two-Factor Auth ─────────────────────────────────────────

const otpToggleBtn    = document.getElementById('settings-otp-toggle');
const otpStatusDot    = document.getElementById('otp-status-dot');
const otpSetupModal   = document.getElementById('otp-setup-modal');
const otpDisableModal = document.getElementById('otp-disable-modal');

let otpEnabled = false;

async function refreshOtpStatus() {
  try {
    const res = await fetch('/api/auth/otp/status', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      otpEnabled = data.enabled;
      otpToggleBtn.textContent = otpEnabled ? 'Disable' : 'Enable';
      otpStatusDot.classList.toggle('enabled', otpEnabled);
    }
  } catch { /* silent */ }
}

otpToggleBtn.addEventListener('click', () => {
  if (otpEnabled) {
    // Disable flow
    document.getElementById('otp-disable-pw').value = '';
    document.getElementById('otp-disable-error').hidden = true;
    otpDisableModal.hidden = false;
  } else {
    // Enable flow: call setup first
    startOtpSetup();
  }
});

async function startOtpSetup() {
  try {
    const res = await fetch('/api/auth/otp/setup', {
      method: 'POST', credentials: 'same-origin',
    });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('otp-qr-img').src = data.qr;
    document.getElementById('otp-secret-text').textContent = data.secret;
    document.getElementById('otp-verify-code').value = '';
    document.getElementById('otp-setup-error').hidden = true;
    otpSetupModal.hidden = false;
  } catch { /* silent */ }
}

document.getElementById('otp-verify-btn').addEventListener('click', async () => {
  const code = document.getElementById('otp-verify-code').value.trim();
  const errEl = document.getElementById('otp-setup-error');
  errEl.hidden = true;

  if (!code) {
    errEl.textContent = 'Enter the 6-digit code';
    errEl.hidden = false;
    return;
  }

  try {
    const res = await fetch('/api/auth/otp/enable', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      otpSetupModal.hidden = true;
      refreshOtpStatus();
    } else {
      errEl.textContent = data.error || 'Invalid code';
      errEl.hidden = false;
    }
  } catch {
    errEl.textContent = 'Connection error';
    errEl.hidden = false;
  }
});

document.getElementById('otp-setup-close').addEventListener('click', () => {
  otpSetupModal.hidden = true;
});

document.getElementById('otp-disable-btn').addEventListener('click', async () => {
  const pw = document.getElementById('otp-disable-pw').value;
  const errEl = document.getElementById('otp-disable-error');
  errEl.hidden = true;

  if (!pw) {
    errEl.textContent = 'Password is required';
    errEl.hidden = false;
    return;
  }

  try {
    const res = await fetch('/api/auth/otp/disable', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      otpDisableModal.hidden = true;
      refreshOtpStatus();
    } else {
      errEl.textContent = data.error || 'Invalid password';
      errEl.hidden = false;
    }
  } catch {
    errEl.textContent = 'Connection error';
    errEl.hidden = false;
  }
});

document.getElementById('otp-disable-close').addEventListener('click', () => {
  otpDisableModal.hidden = true;
});

// ── Resolution modal ────────────────────────────────────────

const resolutionModal = document.getElementById('resolution-modal');

document.getElementById('btn-resolution').addEventListener('click', () => {
  resolutionModal.hidden = false;
});
document.getElementById('resolution-close').addEventListener('click', () => {
  resolutionModal.hidden = true;
});

document.querySelectorAll('.res-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    let w = parseInt(btn.dataset.w, 10);
    let h = parseInt(btn.dataset.h, 10);
    if (w === 0 && h === 0) {
      autoFitResolution();
      resolutionModal.hidden = true;
      return;
    }
    try {
      await fetch('/api/desktop/resolution', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: w, height: h }),
      });
    } catch { /* silent */ }
    resolutionModal.hidden = true;
  });
});

// ── Send Ctrl+Alt+Del ───────────────────────────────────────

document.getElementById('btn-keys').addEventListener('click', () => {
  if (rfb) rfb.sendCtrlAltDel();
});

// ── Restart desktop ─────────────────────────────────────────

document.getElementById('btn-restart').addEventListener('click', async () => {
  if (!confirm('Restart the desktop session? Unsaved work will be lost.')) return;
  showStatus('Restarting desktop…');
  try { await fetch('/api/desktop/restart', { method: 'POST', credentials: 'same-origin' }); }
  catch { /* continue */ }
  setTimeout(connect, 4500);
});

// ── Logout ──────────────────────────────────────────────────

document.getElementById('btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
  catch { /* continue */ }
  window.location.href = '/login';
});

// ── Window switcher ─────────────────────────────────────────

const windowList      = document.getElementById('window-list');
const windowListItems = document.getElementById('window-list-items');

function windowIcon(title) {
  const t = title.toLowerCase();
  if (t.includes('firefox') || t.includes('mozilla'))   return 'firefox';
  if (t.includes('chrome') || t.includes('chromium'))    return 'chrome';
  if (t.includes('terminal'))                            return 'terminal';
  if (t.includes('thunar') || t.includes('file'))        return 'folder';
  if (t.includes('mousepad') || t.includes('editor'))    return 'edit';
  return 'window';
}

const iconSvgs = {
  firefox:  '<svg viewBox="0 0 16 16" fill="#ff6611"><circle cx="8" cy="8" r="7"/></svg>',
  chrome:   '<svg viewBox="0 0 16 16" fill="#4285f4"><circle cx="8" cy="8" r="7"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="#30d158" stroke-width="2"><path d="M3 4l5 4-5 4"/></svg>',
  folder:   '<svg viewBox="0 0 16 16" fill="#42a5f5"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>',
  edit:     '<svg viewBox="0 0 16 16" fill="none" stroke="#4caf50" stroke-width="1.5"><rect x="3" y="1" width="10" height="14" rx="2"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>',
  window:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="6" x2="14" y2="6"/></svg>',
};

async function refreshWindowList() {
  try {
    const res  = await fetch('/api/desktop/windows', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.windows.length) {
      windowListItems.innerHTML = '<div class="window-list-empty">No windows open</div>';
      return;
    }

    windowListItems.innerHTML = data.windows.map(w => {
      const ico = windowIcon(w.title);
      const safeTitle = w.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<button class="window-entry" data-wid="${w.id}">
        <span class="window-entry-icon">${iconSvgs[ico]}</span>
        <span class="window-entry-title">${safeTitle}</span>
      </button>`;
    }).join('');

    // Attach click handlers
    windowListItems.querySelectorAll('.window-entry').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wid = btn.dataset.wid;
        try {
          await fetch('/api/desktop/windows/focus', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: wid }),
          });
        } catch { /* silent */ }
        windowList.hidden = true;
      });
    });
  } catch { /* silent */ }
}

document.getElementById('btn-windows').addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = windowList.hidden;
  windowList.hidden = !wasHidden;
  if (wasHidden) refreshWindowList();
});

// Close window list on outside click
document.addEventListener('click', (e) => {
  if (!windowList.hidden && !windowList.contains(e.target) && e.target.id !== 'btn-windows') {
    windowList.hidden = true;
  }
});

// ── Modal dismiss: backdrop click & Escape ──────────────────

const allModals = [resolutionModal, settingsModal, claudeDirModal, uploadModal, dirModal, filebrowserModal, chpwModal, otpSetupModal, otpDisableModal];

allModals.forEach((modal) => {
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    allModals.forEach((m) => { m.hidden = true; });
    windowList.hidden = true;
  }
});

// ── Upload Manager ──────────────────────────────────────────

const uploadMgr       = document.getElementById('upload-manager');
const uploadList      = document.getElementById('upload-list');
const uploadCount     = document.getElementById('upload-count');
const uploadDestInput = document.getElementById('upload-dest-input');
const uploadFileInput = document.getElementById('upload-file-input');
const uploadDropzone  = document.getElementById('upload-dropzone');
const uploadSelected  = document.getElementById('upload-selected');
const uploadStartBtn  = document.getElementById('upload-start-btn');

// (selectedUploadFiles, uploads, downloads declared at top of file)

function fmtSize(bytes) {
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

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.ceil(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function showUploadMgr() {
  uploadMgr.hidden = false;
  uploadMgr.classList.remove('minimized');
}

function updateTransferCount() {
  let active = 0;
  for (const u of uploads.values()) {
    if (u.status === 'uploading' || u.status === 'paused') active++;
  }
  for (const d of downloads.values()) {
    if (d.status === 'downloading' || d.status === 'paused') active++;
  }
  uploadCount.textContent = active > 0 ? `${active} active` : '';
}

async function startUpload(file, destination) {
  try {
    const res = await fetch('/api/desktop/upload/init', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, totalSize: file.size, destination }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const upload = {
      id: data.uploadId, file, filename: file.name,
      totalSize: file.size, chunkSize: data.chunkSize,
      totalChunks: data.totalChunks, currentChunk: 0,
      bytesUploaded: 0, status: 'uploading', speed: 0, xhr: null,
      startTime: Date.now(), lastSpeedTime: Date.now(), lastSpeedBytes: 0,
    };

    uploads.set(upload.id, upload);
    renderUploadItem(upload);
    showUploadMgr();
    updateTransferCount();
    sendChunk(upload);
  } catch (err) {
    console.error('Upload init failed:', err);
  }
}

function sendChunk(upload) {
  if (upload.status !== 'uploading') return;
  if (upload.currentChunk >= upload.totalChunks) return;

  const start = upload.currentChunk * upload.chunkSize;
  const end = Math.min(start + upload.chunkSize, upload.totalSize);
  const blob = upload.file.slice(start, end);

  const xhr = new XMLHttpRequest();
  upload.xhr = xhr;

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      upload.bytesUploaded = start + e.loaded;
      const now = Date.now();
      const dt = (now - upload.lastSpeedTime) / 1000;
      if (dt > 0.3) {
        upload.speed = (upload.bytesUploaded - upload.lastSpeedBytes) / dt;
        upload.lastSpeedTime = now;
        upload.lastSpeedBytes = upload.bytesUploaded;
      }
      updateUploadItem(upload);
    }
  });

  xhr.addEventListener('load', () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      upload.currentChunk++;
      if (data.completed) {
        upload.status = 'completed';
        upload.bytesUploaded = upload.totalSize;
        updateUploadItem(upload);
        updateTransferCount();
        return;
      }
      sendChunk(upload);
    } else {
      upload.status = 'error';
      updateUploadItem(upload);
      updateTransferCount();
    }
  });

  xhr.addEventListener('error', () => {
    upload.status = 'error';
    updateUploadItem(upload);
    updateTransferCount();
  });

  xhr.open('POST', `/api/desktop/upload/chunk?uploadId=${encodeURIComponent(upload.id)}`);
  xhr.withCredentials = true;
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.send(blob);
}

function pauseUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u || u.status !== 'uploading') return;
  u.status = 'paused';
  if (u.xhr) { u.xhr.abort(); u.xhr = null; }
  updateUploadItem(u);
  updateTransferCount();
  fetch('/api/desktop/upload/pause', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  }).catch(() => {});
}

async function resumeUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u || u.status !== 'paused') return;
  try {
    const res = await fetch('/api/desktop/upload/resume', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    const data = await res.json();
    u.currentChunk = data.chunksReceived;
    u.bytesUploaded = data.bytesReceived;
    u.status = 'uploading';
    u.lastSpeedTime = Date.now();
    u.lastSpeedBytes = u.bytesUploaded;
    updateUploadItem(u);
    updateTransferCount();
    sendChunk(u);
  } catch { /* silent */ }
}

function cancelUpload(uploadId) {
  const u = uploads.get(uploadId);
  if (!u) return;
  if (u.xhr) { u.xhr.abort(); u.xhr = null; }
  u.status = 'cancelled';
  updateUploadItem(u);
  updateTransferCount();
  fetch(`/api/desktop/upload/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }).catch(() => {});
  setTimeout(() => {
    uploads.delete(uploadId);
    const el = document.getElementById(`upload-${uploadId}`);
    if (el) el.remove();
    if (uploads.size === 0) uploadMgr.hidden = true;
  }, 2000);
}

function renderUploadItem(u) {
  const div = document.createElement('div');
  div.className = 'upload-item';
  div.id = `upload-${u.id}`;
  div.innerHTML = `
    <div class="upload-item-info">
      <span class="upload-item-name">${u.filename.replace(/</g, '&lt;')}</span>
      <span class="upload-item-meta">
        <span class="upload-item-progress-text">0%</span>
        <span class="upload-item-speed"></span>
        <span class="upload-item-eta"></span>
      </span>
    </div>
    <div class="upload-item-bar"><div class="upload-item-fill"></div></div>
    <div class="upload-item-actions">
      <button class="upload-action-btn upload-pause" title="Pause">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>
      </button>
      <button class="upload-action-btn upload-resume" title="Resume" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
      </button>
      <button class="upload-action-btn upload-cancel" title="Cancel">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
      </button>
    </div>
  `;
  div.querySelector('.upload-pause').addEventListener('click', () => pauseUpload(u.id));
  div.querySelector('.upload-resume').addEventListener('click', () => resumeUpload(u.id));
  div.querySelector('.upload-cancel').addEventListener('click', () => cancelUpload(u.id));
  uploadList.appendChild(div);
}

function updateUploadItem(u) {
  const el = document.getElementById(`upload-${u.id}`);
  if (!el) return;
  const pct = u.totalSize > 0 ? Math.round((u.bytesUploaded / u.totalSize) * 100) : 0;
  el.querySelector('.upload-item-fill').style.width = pct + '%';
  el.querySelector('.upload-item-progress-text').textContent = pct + '%';

  const speedEl   = el.querySelector('.upload-item-speed');
  const etaEl     = el.querySelector('.upload-item-eta');
  const pauseBtn  = el.querySelector('.upload-pause');
  const resumeBtn = el.querySelector('.upload-resume');
  const cancelBtn = el.querySelector('.upload-cancel');

  if (u.status === 'uploading') {
    speedEl.textContent = fmtSpeed(u.speed);
    const remaining = u.totalSize - u.bytesUploaded;
    etaEl.textContent = u.speed > 0 ? fmtEta(remaining / u.speed) : '';
    pauseBtn.hidden = false; resumeBtn.hidden = true; cancelBtn.hidden = false;
  } else if (u.status === 'paused') {
    speedEl.textContent = 'Paused'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (u.status === 'completed') {
    speedEl.textContent = 'Done'; etaEl.textContent = fmtSize(u.totalSize);
    el.querySelector('.upload-item-fill').style.background = 'var(--stat-cpu)';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
  } else if (u.status === 'error') {
    speedEl.textContent = 'Error'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (u.status === 'cancelled') {
    speedEl.textContent = 'Cancelled'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
    el.style.opacity = '0.5';
  }
}

// ── Upload Modal interactions ───────────────────────────────

uploadDestInput.value = localStorage.getItem('upload-dest') || SERVER_DESKTOP;

uploadDropzone.addEventListener('click', () => uploadFileInput.click());
uploadDropzone.addEventListener('dragover', (e) => {
  e.preventDefault(); uploadDropzone.classList.add('dragover');
});
uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('dragover'));
uploadDropzone.addEventListener('drop', (e) => {
  e.preventDefault(); e.stopPropagation();
  uploadDropzone.classList.remove('dragover');
  dragCounter = 0; dropOverlay.hidden = true;
  if (e.dataTransfer?.files) {
    for (const f of e.dataTransfer.files) selectedUploadFiles.push(f);
    updateSelectedFiles();
  }
});

uploadFileInput.addEventListener('change', () => {
  for (const f of (uploadFileInput.files || [])) selectedUploadFiles.push(f);
  uploadFileInput.value = '';
  updateSelectedFiles();
});

function updateSelectedFiles() {
  uploadStartBtn.disabled = selectedUploadFiles.length === 0;
  if (selectedUploadFiles.length === 0) { uploadSelected.innerHTML = ''; return; }
  const totalSize = selectedUploadFiles.reduce((a, f) => a + f.size, 0);
  uploadSelected.innerHTML =
    `<div class="upload-file-count">${selectedUploadFiles.length} file${selectedUploadFiles.length > 1 ? 's' : ''} (${fmtSize(totalSize)})</div>` +
    selectedUploadFiles.map((f, i) =>
      `<div class="upload-file-entry">
        <span>${f.name.replace(/</g, '&lt;')}</span>
        <span class="upload-file-size">${fmtSize(f.size)}</span>
        <button class="upload-file-remove" data-idx="${i}">&times;</button>
      </div>`
    ).join('');
  uploadSelected.querySelectorAll('.upload-file-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedUploadFiles.splice(parseInt(btn.dataset.idx), 1);
      updateSelectedFiles();
    });
  });
}

uploadStartBtn.addEventListener('click', () => {
  const dest = uploadDestInput.value.trim() || SERVER_DESKTOP;
  localStorage.setItem('upload-dest', dest);
  uploadModal.hidden = true;
  for (const file of selectedUploadFiles) startUpload(file, dest);
  selectedUploadFiles = [];
});

document.getElementById('upload-cancel-btn').addEventListener('click', () => {
  uploadModal.hidden = true;
  selectedUploadFiles = [];
});

// ── Directory Browser ───────────────────────────────────────

const dirPath = document.getElementById('dir-path');
const dirList = document.getElementById('dir-list');
let currentBrowseDir = SERVER_HOME;

document.getElementById('upload-browse-dir').addEventListener('click', () => {
  currentBrowseDir = uploadDestInput.value.trim() || SERVER_HOME;
  loadDirList(currentBrowseDir);
  dirModal.hidden = false;
});

async function loadDirList(dir) {
  dirPath.textContent = dir;
  currentBrowseDir = dir;
  try {
    const res = await fetch(`/api/desktop/browse?dir=${encodeURIComponent(dir)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    let html = '';
    if (data.parent !== data.current) {
      html += `<button class="dir-entry dir-parent" data-path="${data.parent.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4L6 8l4 4"/></svg>
        ..
      </button>`;
    }
    for (const d of data.directories) {
      html += `<button class="dir-entry" data-path="${d.path.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="var(--accent)"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>
        ${d.name.replace(/</g, '&lt;')}
      </button>`;
    }
    if (!data.directories.length && data.parent === data.current) {
      html = '<div class="dir-empty">Empty directory</div>';
    }
    dirList.innerHTML = html;
    dirList.querySelectorAll('.dir-entry').forEach(btn => {
      btn.addEventListener('click', () => loadDirList(btn.dataset.path));
    });
  } catch {
    dirList.innerHTML = '<div class="dir-empty">Cannot access directory</div>';
  }
}

document.getElementById('dir-select-btn').addEventListener('click', () => {
  uploadDestInput.value = currentBrowseDir;
  dirModal.hidden = true;
});

document.getElementById('dir-cancel-btn').addEventListener('click', () => {
  dirModal.hidden = true;
});

// ── Upload Manager controls ─────────────────────────────────

document.getElementById('upload-minimize').addEventListener('click', () => {
  uploadMgr.classList.toggle('minimized');
});

document.getElementById('upload-close-mgr').addEventListener('click', () => {
  let hasActive = false;
  for (const u of uploads.values()) {
    if (u.status === 'uploading' || u.status === 'paused') hasActive = true;
  }
  for (const d of downloads.values()) {
    if (d.status === 'downloading' || d.status === 'paused') hasActive = true;
  }
  if (hasActive) {
    uploadMgr.classList.add('minimized');
  } else {
    uploadMgr.hidden = true;
    uploads.clear();
    downloads.clear();
    uploadList.innerHTML = '';
  }
});

// ── Download Manager ────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

async function startDownload(filePath, filename, fileSize) {
  const dl = {
    id: genId(), filePath, filename, totalSize: fileSize,
    bytesDownloaded: 0, status: 'downloading', speed: 0,
    chunks: [], controller: null,
    startTime: Date.now(), lastSpeedTime: Date.now(), lastSpeedBytes: 0,
  };
  downloads.set(dl.id, dl);
  renderDownloadItem(dl);
  showUploadMgr();
  updateTransferCount();
  fetchDownloadChunks(dl);
}

async function fetchDownloadChunks(dl) {
  if (dl.status !== 'downloading') return;
  const controller = new AbortController();
  dl.controller = controller;
  try {
    const headers = {};
    if (dl.bytesDownloaded > 0) {
      headers['Range'] = `bytes=${dl.bytesDownloaded}-`;
    }
    const res = await fetch(`/api/desktop/download?file=${encodeURIComponent(dl.filePath)}`, {
      credentials: 'same-origin', signal: controller.signal, headers,
    });
    if (!res.ok && res.status !== 206) throw new Error('Download failed');
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (dl.status !== 'downloading') { reader.cancel(); return; }
      dl.chunks.push(value);
      dl.bytesDownloaded += value.length;
      const now = Date.now();
      const dt = (now - dl.lastSpeedTime) / 1000;
      if (dt > 0.3) {
        dl.speed = (dl.bytesDownloaded - dl.lastSpeedBytes) / dt;
        dl.lastSpeedTime = now;
        dl.lastSpeedBytes = dl.bytesDownloaded;
      }
      updateDownloadItem(dl);
    }
    // Complete — trigger browser save
    const blob = new Blob(dl.chunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = dl.filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    dl.status = 'completed';
    dl.chunks = [];
    updateDownloadItem(dl);
    updateTransferCount();
  } catch (err) {
    if (err.name === 'AbortError') return;
    dl.status = 'error';
    updateDownloadItem(dl);
    updateTransferCount();
  }
}

function pauseDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl || dl.status !== 'downloading') return;
  dl.status = 'paused';
  if (dl.controller) { dl.controller.abort(); dl.controller = null; }
  updateDownloadItem(dl);
  updateTransferCount();
}

function resumeDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl || dl.status !== 'paused') return;
  dl.status = 'downloading';
  dl.lastSpeedTime = Date.now();
  dl.lastSpeedBytes = dl.bytesDownloaded;
  updateDownloadItem(dl);
  updateTransferCount();
  fetchDownloadChunks(dl);
}

function cancelDownload(dlId) {
  const dl = downloads.get(dlId);
  if (!dl) return;
  if (dl.controller) { dl.controller.abort(); dl.controller = null; }
  dl.status = 'cancelled';
  dl.chunks = [];
  updateDownloadItem(dl);
  updateTransferCount();
  setTimeout(() => {
    downloads.delete(dlId);
    const el = document.getElementById(`dl-${dlId}`);
    if (el) el.remove();
    if (uploads.size === 0 && downloads.size === 0) uploadMgr.hidden = true;
  }, 2000);
}

function renderDownloadItem(dl) {
  const div = document.createElement('div');
  div.className = 'upload-item upload-item-dl';
  div.id = `dl-${dl.id}`;
  div.innerHTML = `
    <div class="upload-item-info">
      <span class="upload-item-name">${dl.filename.replace(/</g, '&lt;')}</span>
      <span class="upload-item-meta">
        <span class="upload-item-progress-text">0%</span>
        <span class="upload-item-speed"></span>
        <span class="upload-item-eta"></span>
      </span>
    </div>
    <div class="upload-item-bar"><div class="upload-item-fill"></div></div>
    <div class="upload-item-actions">
      <button class="upload-action-btn upload-pause" title="Pause">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>
      </button>
      <button class="upload-action-btn upload-resume" title="Resume" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>
      </button>
      <button class="upload-action-btn upload-cancel" title="Cancel">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
      </button>
    </div>
  `;
  div.querySelector('.upload-pause').addEventListener('click', () => pauseDownload(dl.id));
  div.querySelector('.upload-resume').addEventListener('click', () => resumeDownload(dl.id));
  div.querySelector('.upload-cancel').addEventListener('click', () => cancelDownload(dl.id));
  uploadList.appendChild(div);
}

function updateDownloadItem(dl) {
  const el = document.getElementById(`dl-${dl.id}`);
  if (!el) return;
  const pct = dl.totalSize > 0 ? Math.round((dl.bytesDownloaded / dl.totalSize) * 100) : 0;
  el.querySelector('.upload-item-fill').style.width = pct + '%';
  el.querySelector('.upload-item-progress-text').textContent = pct + '%';

  const speedEl   = el.querySelector('.upload-item-speed');
  const etaEl     = el.querySelector('.upload-item-eta');
  const pauseBtn  = el.querySelector('.upload-pause');
  const resumeBtn = el.querySelector('.upload-resume');
  const cancelBtn = el.querySelector('.upload-cancel');

  if (dl.status === 'downloading') {
    speedEl.textContent = fmtSpeed(dl.speed);
    const remaining = dl.totalSize - dl.bytesDownloaded;
    etaEl.textContent = dl.speed > 0 ? fmtEta(remaining / dl.speed) : '';
    pauseBtn.hidden = false; resumeBtn.hidden = true; cancelBtn.hidden = false;
  } else if (dl.status === 'paused') {
    speedEl.textContent = 'Paused'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (dl.status === 'completed') {
    speedEl.textContent = 'Saved'; etaEl.textContent = fmtSize(dl.totalSize);
    el.querySelector('.upload-item-fill').style.width = '100%';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
  } else if (dl.status === 'error') {
    speedEl.textContent = 'Error'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = false; cancelBtn.hidden = false;
  } else if (dl.status === 'cancelled') {
    speedEl.textContent = 'Cancelled'; etaEl.textContent = '';
    pauseBtn.hidden = true; resumeBtn.hidden = true; cancelBtn.hidden = true;
    el.style.opacity = '0.5';
  }
}

// ── File Browser (for downloads) ────────────────────────────

const fbPathInput = document.getElementById('fb-path-input');
const fbList = document.getElementById('fb-list');
let currentFbDir = SERVER_HOME;
const fbHistory = [];

document.getElementById('btn-download').addEventListener('click', () => {
  currentFbDir = SERVER_HOME;
  fbHistory.length = 0;
  loadFileBrowser(currentFbDir);
  filebrowserModal.hidden = false;
});

document.getElementById('fb-close').addEventListener('click', () => {
  filebrowserModal.hidden = true;
});

// Back button
document.getElementById('fb-back').addEventListener('click', () => {
  if (fbHistory.length > 0) {
    loadFileBrowser(fbHistory.pop(), true);
  } else if (currentFbDir !== '/') {
    // Go to parent
    const parent = currentFbDir.replace(/\/[^/]+\/?$/, '') || '/';
    loadFileBrowser(parent, true);
  }
});

// Path input — Enter or Go button
document.getElementById('fb-go').addEventListener('click', () => {
  const val = fbPathInput.value.trim();
  if (val) loadFileBrowser(val);
});
fbPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = fbPathInput.value.trim();
    if (val) loadFileBrowser(val);
  }
});

// Rename helper
async function renameFbEntry(oldPath, currentName, entry) {
  const nameSpan = entry.querySelector('.fb-entry-name');
  const origHtml = nameSpan.innerHTML;

  // Replace name with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fb-rename-input';
  input.value = currentName;
  nameSpan.innerHTML = '';
  nameSpan.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      nameSpan.innerHTML = origHtml;
      return;
    }
    try {
      const res = await fetch('/api/desktop/rename', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath, newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      loadFileBrowser(currentFbDir);
    } catch (err) {
      nameSpan.innerHTML = origHtml;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { nameSpan.innerHTML = origHtml; }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

async function loadFileBrowser(dir, skipHistory) {
  if (!skipHistory && currentFbDir && currentFbDir !== dir) {
    fbHistory.push(currentFbDir);
  }
  currentFbDir = dir;
  fbPathInput.value = dir;
  try {
    const res = await fetch(`/api/desktop/browse?dir=${encodeURIComponent(dir)}&files=true`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const renameSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>';

    let html = '';
    // Directories
    for (const d of data.directories) {
      html += `<div class="fb-entry fb-dir-row" data-path="${d.path.replace(/"/g, '&quot;')}" data-name="${d.name.replace(/"/g, '&quot;')}">
        <svg class="fb-entry-icon" viewBox="0 0 16 16" width="14" height="14" fill="var(--accent)"><rect x="1" y="5" width="14" height="9" rx="2"/><path d="M1 7V5Q1 3 3 3H6Q8 3 8.5 5L10 7Z"/></svg>
        <span class="fb-entry-name">${d.name.replace(/</g, '&lt;')}</span>
        <span class="fb-entry-size"></span>
        <button class="fb-entry-rename" title="Rename">${renameSvg}</button>
      </div>`;
    }
    // Files
    if (data.files) {
      for (const f of data.files) {
        html += `<div class="fb-entry fb-file" data-path="${f.path.replace(/"/g, '&quot;')}" data-name="${f.name.replace(/"/g, '&quot;')}">
          <svg class="fb-entry-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--text-muted)" stroke-width="1.3"><rect x="3" y="1" width="10" height="14" rx="2"/><line x1="6" y1="5" x2="10" y2="5"/><line x1="6" y1="8" x2="10" y2="8"/></svg>
          <span class="fb-entry-name">${f.name.replace(/</g, '&lt;')}</span>
          <span class="fb-entry-size">${fmtSize(f.size)}</span>
          <button class="fb-entry-rename" title="Rename">${renameSvg}</button>
          <button class="fb-entry-dl" data-path="${f.path.replace(/"/g, '&quot;')}" data-name="${f.name.replace(/"/g, '&quot;')}" data-size="${f.size}" title="Download">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 8 8 12 12 8"/><line x1="8" y1="12" x2="8" y2="2"/></svg>
          </button>
        </div>`;
      }
    }
    if (!data.directories.length && (!data.files || !data.files.length)) {
      html = '<div class="dir-empty">Empty directory</div>';
    }
    fbList.innerHTML = html;

    // Navigate directories (click on row, not buttons)
    fbList.querySelectorAll('.fb-dir-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.fb-entry-rename')) return;
        loadFileBrowser(row.dataset.path);
      });
      row.style.cursor = 'pointer';
    });
    // Rename buttons
    fbList.querySelectorAll('.fb-entry-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = btn.closest('.fb-entry');
        renameFbEntry(entry.dataset.path, entry.dataset.name, entry);
      });
    });
    // Download buttons
    fbList.querySelectorAll('.fb-entry-dl').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startDownload(btn.dataset.path, btn.dataset.name, parseInt(btn.dataset.size, 10));
      });
    });
  } catch {
    fbList.innerHTML = '<div class="dir-empty">Cannot access directory</div>';
  }
}

// ── Mobile / Touch Enhancements ─────────────────────────────

// Standalone (home screen app) detection
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

// iOS-specific fixes
if (isIOS) {
  // Fix iOS Safari 100vh issue
  function setVH() {
    document.documentElement.style.setProperty('--real-vh', window.innerHeight + 'px');
  }
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));
  setVH();
}

// In standalone mode, prevent back-navigation gestures and ensure full screen usage
if (isStandalone) {
  document.body.classList.add('standalone-app');
  // Prevent accidental navigation
  window.addEventListener('beforeunload', (e) => {
    if (rfb) { e.preventDefault(); }
  });
}

// Auto-fit VNC resolution to match current viewport
function autoFitResolution() {
  const dpr = window.devicePixelRatio || 1;
  let w = window.innerWidth;
  let h = window.innerHeight;

  // Scale up for phone HiDPI — makes desktop more usable at small viewport
  if (isMobile && dpr >= 2) {
    w *= 1.5;
    h *= 1.5;
  }

  // Align to 8px grid (xrandr modeline requirement)
  w = Math.floor(w / 8) * 8;
  h = Math.floor(h / 8) * 8;

  // Clamp to usable range
  w = Math.max(640, Math.min(1920, w));
  h = Math.max(480, Math.min(1200, h));

  return fetch('/api/desktop/resolution', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: w, height: h }),
  }).then(r => r.json()).catch(() => {});
}

// Auto-refit on fullscreen & orientation changes
let _fitTimer = null;
function scheduleAutoFit() {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(() => { if (rfb) autoFitResolution(); }, 400);
}
document.addEventListener('fullscreenchange', scheduleAutoFit);
document.addEventListener('webkitfullscreenchange', scheduleAutoFit);
window.addEventListener('orientationchange', () => setTimeout(scheduleAutoFit, 300));

if (isTouch) {
  const mobileToolbar = document.getElementById('mobile-toolbar');
  const touchCursor   = document.getElementById('touch-cursor');
  const mobZoomLabel  = document.getElementById('mob-zoom-level');
  const mobRightBtn   = document.getElementById('mob-rightclick');

  let vncZoom = 1;
  let panX = 0.5, panY = 0.5;
  let rightClickMode = false;

  // ── Virtual cursor state (trackpad mode) ──
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let touchStartX = 0, touchStartY = 0;
  let touchStartTime = 0;
  let touchMoved = false;
  let longPressTimer = null;
  let longPressFired = false;
  let isDragging = false;   // double-tap-hold drag
  let lastTapTime = 0;

  const CURSOR_SPEED = 1.5;
  const TAP_MAX_DURATION = 300;
  const TAP_MAX_MOVE = 10;
  const LONG_PRESS_MS = 500;

  mobileToolbar.hidden = false;
  touchCursor.hidden = false; // Always visible in trackpad mode

  function updateCursorPos() {
    touchCursor.style.left = cursorX + 'px';
    touchCursor.style.top  = cursorY + 'px';
  }
  updateCursorPos();

  // Get noVNC canvas element
  function getCanvas() {
    return vncContainer.querySelector('canvas');
  }

  // Monkey-patch setPointerCapture so synthetic events don't throw
  function patchCanvas(canvas) {
    if (canvas._trackpadPatched) return;
    canvas._trackpadPatched = true;
    const origSet = canvas.setPointerCapture.bind(canvas);
    const origRel = canvas.releasePointerCapture.bind(canvas);
    canvas.setPointerCapture = (id) => { try { origSet(id); } catch {} };
    canvas.releasePointerCapture = (id) => { try { origRel(id); } catch {} };
  }

  // Dispatch synthetic PointerEvent to noVNC canvas
  function sendPointer(type, button, buttons) {
    const canvas = getCanvas();
    if (!canvas) return;
    patchCanvas(canvas);
    canvas.dispatchEvent(new PointerEvent(type, {
      clientX: cursorX, clientY: cursorY,
      screenX: cursorX, screenY: cursorY,
      pointerId: 9999, pointerType: 'mouse', isPrimary: true,
      button, buttons,
      bubbles: true, cancelable: true, view: window,
    }));
  }

  // Move virtual cursor and send pointermove to VNC
  function moveCursor(x, y) {
    cursorX = Math.max(0, Math.min(window.innerWidth, x));
    cursorY = Math.max(0, Math.min(window.innerHeight, y));
    updateCursorPos();
    sendPointer('pointermove', 0, isDragging ? 1 : 0);
  }

  // Click at current cursor position
  function clickAt(button) {
    const btns = button === 2 ? 2 : 1;
    sendPointer('pointerdown', button, btns);
    setTimeout(() => sendPointer('pointerup', button, 0), 60);
  }

  // ── Zoom ──
  function applyVncZoom() {
    const screen = vncContainer.firstElementChild;
    if (!screen) return;
    if (vncZoom > 1) {
      screen.style.transformOrigin = `${panX * 100}% ${panY * 100}%`;
      screen.style.transform = `scale(${vncZoom})`;
    } else {
      screen.style.transform = '';
      screen.style.transformOrigin = '';
      panX = 0.5; panY = 0.5;
    }
    mobZoomLabel.textContent = Math.round(vncZoom * 100) + '%';
  }

  document.getElementById('mob-zoom-in').addEventListener('click', () => {
    vncZoom = Math.min(3, +(vncZoom + 0.5).toFixed(1));
    applyVncZoom();
  });
  document.getElementById('mob-zoom-out').addEventListener('click', () => {
    vncZoom = Math.max(1, +(vncZoom - 0.5).toFixed(1));
    applyVncZoom();
  });
  document.getElementById('mob-zoom-fit').addEventListener('click', () => {
    vncZoom = 1;
    applyVncZoom();
    autoFitResolution();
  });

  // Right-click mode: next tap sends right-click
  mobRightBtn.addEventListener('click', () => {
    rightClickMode = !rightClickMode;
    mobRightBtn.classList.toggle('active', rightClickMode);
  });

  // ── Pinch-to-zoom + two-finger pan ──
  let pinchActive = false;
  let lastPinchDist = 0;
  let lastPinchCenter = null;

  function touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  // ═══ TRACKPAD TOUCH HANDLING ═══
  // Block ALL real touch pointer events from reaching noVNC canvas.
  // Pointer events fire BEFORE touch events, so preventDefault on touchstart
  // is too late — the pointerdown already reached the canvas. We must
  // intercept at the pointer level and stop propagation for touch pointers.
  // Only our synthetic pointerType:'mouse' events should reach noVNC.
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(evt => {
    vncContainer.addEventListener(evt, (e) => {
      if (e.pointerType === 'touch') {
        e.stopPropagation();
        // NOT preventDefault — that would kill touch events (spec requirement)
      }
    }, { capture: true });
  });

  // Single-finger drag  = move virtual cursor (like a trackpad)
  // Tap (<300ms)        = left-click at cursor position
  // Long-press (>500ms) = right-click at cursor position
  // Double-tap + hold   = drag (mousedown + move)
  // Two-finger          = pinch-zoom / pan

  vncContainer.addEventListener('touchstart', (e) => {
    // Two-finger → pinch/pan
    if (e.touches.length === 2) {
      pinchActive = true;
      lastPinchDist = touchDist(e.touches[0], e.touches[1]);
      lastPinchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      clearTimeout(longPressTimer);
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    if (e.touches.length !== 1) return;
    e.stopPropagation();
    e.preventDefault();

    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
    touchMoved = false;
    longPressFired = false;

    // Double-tap-and-hold → start drag
    if (Date.now() - lastTapTime < 300) {
      isDragging = true;
      sendPointer('pointerdown', 0, 1);
    }

    // Long-press timer → right-click
    longPressTimer = setTimeout(() => {
      if (!touchMoved && !isDragging) {
        longPressFired = true;
        clickAt(2);
        if (navigator.vibrate) navigator.vibrate(50);
      }
    }, LONG_PRESS_MS);
  }, { capture: true, passive: false });

  vncContainer.addEventListener('touchmove', (e) => {
    e.stopPropagation();
    // Two-finger pinch/pan
    if (pinchActive && e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastPinchDist > 0) {
        vncZoom = Math.max(1, Math.min(3, vncZoom * (dist / lastPinchDist)));
      }
      lastPinchDist = dist;
      if (vncZoom > 1 && lastPinchCenter) {
        const dx = cx - lastPinchCenter.x;
        const dy = cy - lastPinchCenter.y;
        const cw = vncContainer.clientWidth;
        const ch = vncContainer.clientHeight;
        panX = Math.max(0, Math.min(1, panX - dx / (cw * Math.max(0.01, vncZoom - 1))));
        panY = Math.max(0, Math.min(1, panY - dy / (ch * Math.max(0.01, vncZoom - 1))));
      }
      lastPinchCenter = { x: cx, y: cy };
      applyVncZoom();
      return;
    }

    // Single-finger trackpad movement
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = (t.clientX - touchStartX) * CURSOR_SPEED;
    const dy = (t.clientY - touchStartY) * CURSOR_SPEED;

    if (Math.abs(t.clientX - touchStartX) > TAP_MAX_MOVE ||
        Math.abs(t.clientY - touchStartY) > TAP_MAX_MOVE) {
      if (!touchMoved) {
        touchMoved = true;
        clearTimeout(longPressTimer);
      }
    }

    touchStartX = t.clientX;
    touchStartY = t.clientY;
    moveCursor(cursorX + dx, cursorY + dy);
  }, { capture: true, passive: false });

  vncContainer.addEventListener('touchend', (e) => {
    e.stopPropagation();
    if (e.touches.length < 2) {
      pinchActive = false;
      lastPinchDist = 0;
      lastPinchCenter = null;
    }

    clearTimeout(longPressTimer);

    // All fingers lifted
    if (e.touches.length === 0) {
      // End drag if active
      if (isDragging) {
        sendPointer('pointerup', 0, 0);
        isDragging = false;
        return;
      }

      const elapsed = Date.now() - touchStartTime;

      // Tap → click
      if (!touchMoved && !longPressFired && elapsed < TAP_MAX_DURATION) {
        if (rightClickMode) {
          clickAt(2);
          rightClickMode = false;
          mobRightBtn.classList.remove('active');
        } else {
          clickAt(0);
        }
        lastTapTime = Date.now();
      }
    }
  }, { capture: true });

  // Two-finger scroll → mouse wheel
  let scrollAccY = 0;
  vncContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinchActive) return;
    // If fingers move together (not spreading), treat as scroll
    const dist = touchDist(e.touches[0], e.touches[1]);
    if (lastPinchDist > 0 && Math.abs(dist - lastPinchDist) < 5) {
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (lastPinchCenter) {
        scrollAccY += cy - lastPinchCenter.y;
        const canvas = getCanvas();
        if (canvas && Math.abs(scrollAccY) > 20) {
          const dir = scrollAccY > 0 ? -1 : 1; // natural scroll
          canvas.dispatchEvent(new WheelEvent('wheel', {
            clientX: cursorX, clientY: cursorY,
            deltaY: dir * 120, deltaMode: 0,
            bubbles: true, cancelable: true, view: window,
          }));
          scrollAccY = 0;
        }
      }
    }
  }, { passive: true });
  vncContainer.addEventListener('touchend', () => { scrollAccY = 0; }, { passive: true });

  // Virtual keyboard
  document.getElementById('mob-keyboard').addEventListener('click', () => {
    const textarea = vncContainer.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      textarea.click();
    } else if (rfb) {
      rfb.focus();
    }
  });

  // Auto-hide toolbar after inactivity
  let toolbarTimer = null;
  function resetToolbarTimer() {
    mobileToolbar.style.opacity = '';
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => {
      mobileToolbar.style.opacity = '0.3';
    }, 5000);
  }
  mobileToolbar.addEventListener('touchstart', () => {
    mobileToolbar.style.opacity = '';
    clearTimeout(toolbarTimer);
  });
  mobileToolbar.addEventListener('touchend', resetToolbarTimer);
  resetToolbarTimer();
}

// ── Init ────────────────────────────────────────────────────

(async function init() {
  if (await checkAuth()) {
    // Auto-fit resolution to viewport before connecting
    await autoFitResolution();
    await new Promise(r => setTimeout(r, 500));
    connect();
  }
})();
