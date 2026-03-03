const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const audit = require('./audit');

function createTerminalWss() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';

    const shell = pty.spawn('/bin/bash', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || '/root',
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    audit.log('terminal_open', { ip, pid: shell.pid });

    // PTY → WebSocket (binary)
    shell.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data, { binary: false });
      }
    });

    shell.onExit(({ exitCode }) => {
      audit.log('terminal_close', { ip, pid: shell.pid, exitCode });
      if (ws.readyState === ws.OPEN) ws.close();
    });

    // WebSocket → PTY
    ws.on('message', (data) => {
      const msg = data.toString();

      // Check for JSON resize messages
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            shell.resize(
              Math.max(2, Math.min(500, parsed.cols)),
              Math.max(1, Math.min(200, parsed.rows))
            );
            return;
          }
        } catch {}
      }

      shell.write(msg);
    });

    // Keepalive: ping every 30s
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    ws.on('close', () => {
      clearInterval(pingInterval);
      shell.kill();
    });

    ws.on('error', (err) => {
      clearInterval(pingInterval);
      console.error('Terminal WebSocket error:', err.message);
      shell.kill();
    });
  });

  return wss;
}

module.exports = { createTerminalWss };
