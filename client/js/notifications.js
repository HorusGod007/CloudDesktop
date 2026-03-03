// ── Notification System ─────────────────────────────────────
// notify(message, type, duration) — shows toast notification
// Types: info (blue), success (green), warning (orange), error (red)

const MAX_HISTORY = 20;
const history = [];
let container = null;
let bellBtn = null;
let bellBadge = null;
let dropdown = null;
let dropdownList = null;
let unreadCount = 0;

function init() {
  container = document.getElementById('notification-container');
  bellBtn = document.getElementById('topbar-bell');
  bellBadge = document.getElementById('bell-badge');
  dropdown = document.getElementById('notification-dropdown');
  dropdownList = document.getElementById('notification-list');

  if (bellBtn) {
    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = !dropdown.hidden;
      if (!dropdown.hidden) {
        unreadCount = 0;
        updateBadge();
        renderDropdown();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (dropdown && !dropdown.hidden && !dropdown.contains(e.target) && e.target !== bellBtn) {
      dropdown.hidden = true;
    }
  });
}

function notify(message, type = 'info', duration = 4000) {
  if (!container) init();
  if (!container) return;

  const entry = {
    message,
    type,
    time: new Date(),
  };

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.pop();

  unreadCount++;
  updateBadge();

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `notif-toast notif-${type}`;
  toast.innerHTML = `
    <span class="notif-icon">${typeIcon(type)}</span>
    <span class="notif-msg">${escHtml(message)}</span>
    <button class="notif-close">&times;</button>
  `;

  toast.querySelector('.notif-close').addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);

  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add('notif-show'));

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  toast.classList.remove('notif-show');
  toast.classList.add('notif-hide');
  setTimeout(() => toast.remove(), 300);
}

function updateBadge() {
  if (!bellBadge) return;
  if (unreadCount > 0) {
    bellBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
    bellBadge.hidden = false;
  } else {
    bellBadge.hidden = true;
  }
}

function renderDropdown() {
  if (!dropdownList) return;
  if (history.length === 0) {
    dropdownList.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  dropdownList.innerHTML = history.map(entry => {
    const ago = timeAgo(entry.time);
    return `<div class="notif-entry notif-entry-${entry.type}">
      <span class="notif-entry-icon">${typeIcon(entry.type)}</span>
      <span class="notif-entry-msg">${escHtml(entry.message)}</span>
      <span class="notif-entry-time">${ago}</span>
    </div>`;
  }).join('');
}

function typeIcon(type) {
  switch (type) {
    case 'success': return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 8 7 12 13 4"/></svg>';
    case 'warning': return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="6" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>';
    case 'error':   return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/><line x1="5" y1="5" x2="11" y2="11"/><line x1="11" y1="5" x2="5" y2="11"/></svg>';
    default:        return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>';
  }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { notify, init };
