const net = require('net');
const { WebSocketServer } = require('ws');
const url = require('url');
const config = require('./config');
const { consumeWsTicket, verifyToken } = require('./auth');

function setupWsProxy(server) {
  const wss = new WebSocketServer({
    noServer: true,
    // Accept the 'binary' subprotocol that noVNC requests
    handleProtocols(protocols) {
      if (protocols.has('binary')) return 'binary';
      return false;
    },
  });

  server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);

    // Only handle /websockify path
    if (parsed.pathname !== '/websockify') {
      socket.destroy();
      return;
    }

    // Authenticate via ticket (preferred) or token
    let authenticated = false;

    if (parsed.query.ticket) {
      const username = consumeWsTicket(parsed.query.ticket);
      if (username) {
        authenticated = true;
      }
    }

    if (!authenticated && parsed.query.token) {
      try {
        verifyToken(parsed.query.token);
        authenticated = true;
      } catch (e) {
        // invalid token
      }
    }

    // Check cookie as fallback
    if (!authenticated && req.headers.cookie) {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.token) {
        try {
          verifyToken(cookies.token);
          authenticated = true;
        } catch (e) {
          // invalid token
        }
      }
    }

    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
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
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

module.exports = setupWsProxy;
