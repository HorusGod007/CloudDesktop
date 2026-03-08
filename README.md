# CloudDesktop

<p align="center">
  <img src="screenshots/desktop.png?v=2" alt="CloudDesktop" width="700">
</p>

<p align="center">
  <b>Turn any Linux VPS into a full desktop GUI — accessible from any device, anywhere.</b><br>
  Fully open source. Free forever.
</p>

<p align="center">
  <a href="https://github.com/HorusGod007/CloudDesktop/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/open%20source-100%25-brightgreen" alt="Open Source">
</p>

---

No PuTTY. No SSH terminals. Just open your browser and you're on your desktop.

## What is CloudDesktop?

CloudDesktop transforms a bare Linux VPS into a complete browser-based desktop environment. It works on **any device** — your phone, tablet, iPad, TV, laptop — all sharing the **same live session**. Start work on your PC, continue on your phone. It's your desktop, everywhere.

**100% open source** — no hidden fees, no premium tiers, no telemetry. Fork it, modify it, self-host it. It's yours.

### Key Features

- **Universal Access** — Works on any device with a browser. Mobile, tablet, desktop, even smart TVs
- **Shared Session** — All devices connect to the same live desktop. No sync needed
- **Trackpad Mode** — RDP-style virtual cursor on mobile. No awkward touch-to-click
- **Auto-Fit Resolution** — Screen adjusts automatically to your device, orientation changes, and fullscreen
- **PWA Support** — Install as a native app on Windows, macOS, Linux, iOS, and Android. No browser toolbar — runs like a real desktop app
- **Claude Code Integration** — Built-in Claude Code CLI support with dedicated dock icons. Launch Claude Code or Claude Fast directly from your desktop
- **Secure Login** — Password auth with optional TOTP two-factor authentication
- **File Transfer** — Upload and download files with chunked transfer, pause/resume support
- **Clipboard Sync** — Copy/paste between your local device and the remote desktop
- **macOS-style Dock** — App launcher, window switcher, system stats, all in a clean dock
- **XFCE Desktop** — Lightweight, full-featured Linux desktop with Firefox, Chrome, file manager, and more
- **SSL/TLS** — Self-signed or Let's Encrypt certificates out of the box
- **Fail2ban + UFW** — Brute-force protection and firewall configured automatically

---

## Screenshots

| Login | Desktop |
|-------|---------|
| ![Login](screenshots/login.png?v=2) | ![Desktop](screenshots/desktop.png?v=2) |

| Settings | Claude Code in Dock |
|----------|-------------------|
| ![Settings](screenshots/settings.png?v=2) | ![Claude Code](screenshots/claude.png?v=2) |

---

## Quick Install

```bash
sudo bash install.sh
```

The installer handles everything:
- XFCE desktop + TigerVNC
- noVNC + WebSocket bridge
- Node.js web backend
- Nginx reverse proxy with SSL
- Firewall + Fail2ban
- Systemd services (auto-start on boot)
- Claude Code CLI (optional — toggle during install)

---

## Claude Code Support

CloudDesktop comes with first-class [Claude Code](https://docs.anthropic.com/en/docs/claude-code) support:

- **Claude Code** — Launch Claude Code CLI in a terminal directly from the dock
- **Claude Fast** — One-click launch with sandbox mode for quick tasks
- **Directory Picker** — Choose your working directory before launching
- Toggle Claude dock icons on/off during install or via config (`CLAUDE_DOCK=true/false`)

---

## Requirements

- Ubuntu or Debian Linux
- 512MB+ RAM (1GB recommended)
- 1GB+ free disk space
- Root access

---

## Architecture

```
Browser ──HTTPS──▸ Nginx ──▸ Express API (auth, files, resolution)
                        └──▸ WebSocket ──▸ websockify ──▸ VNC (TigerVNC/XFCE)
```

---

## Management

```bash
# Change password
sudo bash /opt/OS/scripts/change-password.sh

# Setup SSL with domain
sudo bash /opt/OS/scripts/setup-ssl.sh yourdomain.com you@email.com

# View logs
journalctl -u clouddesktop-web -f

# Restart desktop
sudo systemctl restart clouddesktop-vnc

# Uninstall
sudo bash /opt/OS/uninstall.sh
```

---

## Install as App (PWA)

CloudDesktop can be installed as a standalone app — no browser toolbar, runs like a native desktop application.

**Windows / macOS / Linux (Chrome/Edge):**
1. Open CloudDesktop in Chrome or Edge
2. Click the install icon in the address bar (or Menu → "Install CloudDesktop")
3. Done — launches as its own window with no browser UI

**iPhone / iPad:**
1. Open in Safari → Tap Share → "Add to Home Screen"

**Android:**
1. Open in Chrome → Tap "Add to Home Screen" or the install banner

---

## Mobile Experience

CloudDesktop is built mobile-first:
- Virtual trackpad cursor (like Microsoft RD Client)
- Pinch zoom and scroll
- On-screen keyboard
- Fullscreen PWA mode with no browser chrome
- Auto-resolution fitting for any screen size
- Resolution auto-adjusts on orientation change

---

## Security

- Bcrypt password hashing
- JWT session tokens (httpOnly cookies)
- TOTP two-factor authentication
- Rate limiting on auth endpoints
- Fail2ban integration
- UFW firewall (ports 22, 80, 443 only)
- HTTPS enforced

---

## Donate

If CloudDesktop is useful to you, consider supporting development:

| Currency | Address |
|----------|---------|
| **USDT (TRC20)** | `TWPe2RnNbTLLgn1cfZhHqkzNb46tHxpsCD` |
| **ETH / ERC-20 Tokens** | `0x1786f09980942725480d4ba67287366e0a90970a` |
| **BTC** | `1GzK3GrASavA2d7dC7RKEH3aGf1pY1gjHu` |
| **LTC** | `LeJJjy1PSbUTyNHuLi6QR276sij5C1MT8u` |

---

## Contributing

CloudDesktop is fully open source and contributions are welcome! Feel free to open issues, submit pull requests, or fork the project.

---

## License

This project is licensed under the [MIT License](LICENSE) — free to use, modify, and distribute.

---

**Built by [HorusGod](https://github.com/HorusGod007)**
