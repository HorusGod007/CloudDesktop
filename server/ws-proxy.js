const net = require('net');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { consumeWsTicket, verifyToken } = require('./auth');

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

function authenticateWs(req, query) {
  // Authenticate via ticket (preferred) or token
  if (query.ticket) {
    const username = consumeWsTicket(query.ticket);
    if (username) return true;
  }

  if (query.token) {
    try { verifyToken(query.token); return true; } catch {}
  }

  // Check cookie as fallback
  if (req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.token) {
      try { verifyToken(cookies.token); return true; } catch {}
    }
  }

  return false;
}

function createVncWss() {
  const wss = new WebSocketServer({
    noServer: true,
    // Accept the 'binary' subprotocol that noVNC requests
    handleProtocols(protocols) {
      if (protocols.has('binary')) return 'binary';
      return false;
    },
  });

  wss.on('connection', (ws) => {
    // Connect directly to VNC server (raw TCP RFB protocol)
    const target = net.createConnection(config.VNC_PORT, config.VNC_HOST, () => {
      target.setNoDelay(true);
      console.log('WS proxy: connected to VNC backend');
    });

    // Keepalive: ping every 30s to prevent idle disconnects
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    target.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data, { binary: true });
      }
    });

    target.on('end', () => {
      ws.close();
    });

    target.on('error', (err) => {
      console.error('VNC connection error:', err.message);
      ws.close();
    });

    ws.on('message', (data, isBinary) => {
      if (target.writable) {
        target.write(Buffer.from(data));
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      target.destroy();
    });

    ws.on('error', (err) => {
      clearInterval(pingInterval);
      console.error('WebSocket error:', err.message);
      target.destroy();
    });
  });

  return wss;
}

module.exports = { createVncWss, authenticateWs };
