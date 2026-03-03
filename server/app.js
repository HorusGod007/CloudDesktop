const http = require('http');
const path = require('path');
const url = require('url');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const authRoutes = require('./routes/auth');
const desktopRoutes = require('./routes/desktop');
const adminRoutes = require('./routes/admin');
const terminalRoutes = require('./routes/terminal');
const { createVncWss, authenticateWs } = require('./ws-proxy');
const { createTerminalWss } = require('./ws-terminal');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://static.cloudflareinsights.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Middleware
app.use(express.json());
app.use(cookieParser());

// Trust proxy (behind nginx)
app.set('trust proxy', 1);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/desktop', desktopRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/terminal', terminalRoutes);

// Serve vendor files (noVNC + xterm)
app.use('/vendor/novnc', express.static(
  path.join(__dirname, '..', 'client', 'vendor', 'novnc'),
  { maxAge: '7d' }
));
app.use('/vendor/xterm', express.static(
  path.join(__dirname, '..', 'client', 'vendor', 'xterm'),
  { maxAge: '7d' }
));

// Serve client static files (no cache for CSS/JS so updates are immediate)
app.use(express.static(path.join(__dirname, '..', 'client'), {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: 0,
}));

// SPA routing: serve app.js routing page for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'login.html'));
});

app.get('/desktop', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'desktop.html'));
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'login.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'admin.html'));
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Create HTTP server
const server = http.createServer(app);

// ── WebSocket upgrade dispatcher ─────────────────────────────
// /websockify → VNC proxy
// /terminal   → Terminal PTY
const vncWss = createVncWss();
const terminalWss = createTerminalWss();

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/websockify') {
    if (!authenticateWs(req, parsed.query)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    vncWss.handleUpgrade(req, socket, head, (ws) => {
      vncWss.emit('connection', ws, req);
    });
    return;
  }

  if (parsed.pathname === '/terminal') {
    if (!authenticateWs(req, parsed.query)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});

// Start server
server.listen(config.PORT, config.HOST, () => {
  console.log(`CloudDesktop server listening on ${config.HOST}:${config.PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
  // Force exit if close hangs
  setTimeout(() => process.exit(0), 5000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

// Crash recovery — log and let systemd restart
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
