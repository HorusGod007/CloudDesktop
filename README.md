# CloudDesktop

**Turn any Linux VPS into a full desktop GUI — accessible from any device, anywhere.**

No PuTTY. No SSH terminals. Just open your browser and you're on your desktop.

---

## What is CloudDesktop?

CloudDesktop transforms a bare Linux VPS into a complete browser-based desktop environment. It works on **any device** — your phone, tablet, iPad, TV, laptop — all sharing the **same live session**. Start work on your PC, continue on your phone. It's your desktop, everywhere.

### Key Features

- **Universal Access** — Works on any device with a browser. Mobile, tablet, desktop, even smart TVs
- **Shared Session** — All devices connect to the same live desktop. No sync needed
- **Trackpad Mode** — RDP-style virtual cursor on mobile. No awkward touch-to-click
- **Auto-Fit Resolution** — Screen adjusts automatically to your device, orientation changes, and fullscreen
- **PWA Support** — Install as a native app on iOS, Android, and desktop
- **Secure Login** — Password auth with optional TOTP two-factor authentication
- **File Transfer** — Upload and download files with chunked transfer, pause/resume support
- **Clipboard Sync** — Copy/paste between your local device and the remote desktop
- **macOS-style Dock** — App launcher, window switcher, system stats, all in a clean dock
- **XFCE Desktop** — Lightweight, full-featured Linux desktop with Firefox, Chrome, file manager, and more
- **SSL/TLS** — Self-signed or Let's Encrypt certificates out of the box
- **Fail2ban + UFW** — Brute-force protection and firewall configured automatically

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

## Mobile Experience

CloudDesktop is built mobile-first:
- Virtual trackpad cursor (like Microsoft RD Client)
- Pinch zoom and scroll
- On-screen keyboard
- Fullscreen PWA mode with no browser chrome
- Auto-resolution fitting for any screen size

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

## License

MIT

---

**Built by [HorusGod](https://github.com/HorusGod007)**
