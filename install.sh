#!/bin/bash
# ============================================================
#  CloudDesktop Installer
#  Turn a bare Linux VPS into a browser-accessible GUI desktop
#  Usage: sudo bash install.sh
# ============================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

INSTALL_DIR="/opt/OS"
DATA_DIR="${INSTALL_DIR}/data"
ENV_FILE="${DATA_DIR}/.env"
LOG_DIR="/var/log/clouddesktop"

# ── Helpers ──────────────────────────────────────────────────

log()   { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[i]${NC} $1"; }

# ── Pre-flight checks ───────────────────────────────────────

preflight() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║       CloudDesktop Installer         ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
    echo ""

    # Root check
    if [ "$(id -u)" -ne 0 ]; then
        error "Must run as root. Use: sudo bash install.sh"
    fi

    # OS check
    if [ ! -f /etc/os-release ]; then
        error "Cannot determine OS. Only Ubuntu/Debian supported."
    fi

    . /etc/os-release
    case "$ID" in
        ubuntu|debian) log "Detected $PRETTY_NAME" ;;
        *) error "Unsupported OS: $ID. Only Ubuntu/Debian supported." ;;
    esac

    # Architecture check
    ARCH=$(uname -m)
    if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
        warn "Architecture $ARCH may not be fully supported"
    fi

    # Memory check
    TOTAL_MEM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    if [ "$TOTAL_MEM" -lt 512 ]; then
        error "Minimum 512MB RAM required. Found: ${TOTAL_MEM}MB"
    elif [ "$TOTAL_MEM" -lt 1024 ]; then
        warn "1GB+ RAM recommended for smooth experience. Found: ${TOTAL_MEM}MB"
    else
        log "Memory: ${TOTAL_MEM}MB"
    fi

    # Disk check
    AVAIL_DISK=$(df -m /opt | awk 'NR==2 {print $4}')
    if [ "$AVAIL_DISK" -lt 1024 ]; then
        error "Minimum 1GB free disk space required. Found: ${AVAIL_DISK}MB"
    fi
    log "Disk: ${AVAIL_DISK}MB available"
}

# ── User prompts ─────────────────────────────────────────────

prompt_config() {
    echo ""
    echo -e "${CYAN}── Configuration ──${NC}"
    echo ""

    # System user selection
    echo -e "${BOLD}Desktop user mode:${NC}"
    echo "  1) root       — Run desktop as root (simpler, full access)"
    echo "  2) clouddesktop — Run as dedicated user (recommended for security)"
    echo ""
    read -rp "Select mode [1]: " USER_MODE
    USER_MODE="${USER_MODE:-1}"

    if [ "$USER_MODE" = "2" ]; then
        RUN_USER="clouddesktop"
        RUN_HOME="/home/clouddesktop"
        log "Will run as dedicated 'clouddesktop' user"
    else
        RUN_USER="root"
        RUN_HOME="/root"
        log "Will run as root"
    fi
    echo ""

    # Domain
    read -rp "Domain name (or 'localhost' for self-signed SSL): " DOMAIN
    DOMAIN="${DOMAIN:-localhost}"

    # Password
    while true; do
        read -rsp "Set admin password (min 8 chars): " PASSWORD
        echo
        if [ ${#PASSWORD} -lt 8 ]; then
            warn "Password must be at least 8 characters"
            continue
        fi
        read -rsp "Confirm password: " PASSWORD2
        echo
        if [ "$PASSWORD" != "$PASSWORD2" ]; then
            warn "Passwords do not match"
            continue
        fi
        break
    done

    # Email (for Let's Encrypt)
    EMAIL=""
    if [ "$DOMAIN" != "localhost" ]; then
        read -rp "Email for Let's Encrypt SSL (optional): " EMAIL
    fi

    # Claude Code in dock
    echo ""
    echo -e "${BOLD}Install Claude Code in dock?${NC}"
    echo "  Claude Code CLI will be installed and appear as dock icons."
    read -rp "Include Claude Code? (Y/n): " CLAUDE_DOCK
    if [[ "$CLAUDE_DOCK" =~ ^[Nn]$ ]]; then
        CLAUDE_DOCK="false"
        info "Claude Code dock icons will be hidden"
    else
        CLAUDE_DOCK="true"
        info "Claude Code dock icons will be enabled"
    fi
    echo ""

    # Username
    read -rp "Admin username [admin]: " USERNAME
    USERNAME="${USERNAME:-admin}"

    echo ""
    info "Mode:     $RUN_USER"
    info "Home:     $RUN_HOME"
    info "Domain:   $DOMAIN"
    info "Username: $USERNAME"
    info "Claude:   $CLAUDE_DOCK"
    echo ""
    read -rp "Proceed with installation? (Y/n): " PROCEED
    if [[ "$PROCEED" =~ ^[Nn]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
}

# ── Package installation ─────────────────────────────────────

install_packages() {
    log "Updating package lists..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq

    log "Installing system packages..."
    apt-get install -y -qq \
        tigervnc-standalone-server \
        tigervnc-common \
        xfce4 \
        xfce4-terminal \
        xfce4-goodies \
        dbus-x11 \
        x11-xserver-utils \
        xclip \
        autocutsel \
        mousepad \
        thunar \
        nginx \
        ufw \
        fail2ban \
        openssl \
        curl \
        wget \
        git \
        sudo \
        firefox \
        wmctrl \
        2>/dev/null

    # Install Node.js (LTS) if not present
    if ! command -v node &>/dev/null; then
        log "Installing Node.js LTS..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - 2>/dev/null
        apt-get install -y -qq nodejs 2>/dev/null
    fi
    log "Node.js $(node --version)"

    # Install Claude Code CLI (if dock enabled)
    if [ "$CLAUDE_DOCK" = "true" ]; then
        if ! command -v claude &>/dev/null; then
            log "Installing Claude Code CLI..."
            npm install -g @anthropic-ai/claude-code 2>/dev/null || warn "Claude Code install failed (can install later)"
        else
            log "Claude Code CLI already installed"
        fi
    fi

    # Install Google Chrome
    if ! command -v google-chrome &>/dev/null; then
        log "Installing Google Chrome..."
        wget -q -O /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" 2>/dev/null
        apt-get install -y -qq /tmp/google-chrome.deb 2>/dev/null || warn "Chrome install failed (can install later)"
        rm -f /tmp/google-chrome.deb
    fi

    # Install websockify
    if ! command -v websockify &>/dev/null; then
        log "Installing websockify..."
        apt-get install -y -qq python3-pip python3-numpy 2>/dev/null
        pip3 install websockify 2>/dev/null || apt-get install -y -qq websockify 2>/dev/null
    fi

    # Install certbot if domain is not localhost
    if [ "$DOMAIN" != "localhost" ] && ! command -v certbot &>/dev/null; then
        log "Installing certbot..."
        apt-get install -y -qq certbot python3-certbot-nginx 2>/dev/null
    fi
}

# ── Setup directories ─────────────────────────────────────────

setup_user() {
    if [ "$RUN_USER" = "root" ]; then
        log "Using root user..."
        mkdir -p /run/user/0
        chmod 700 /run/user/0
    else
        log "Setting up dedicated user..."
        if id "clouddesktop" &>/dev/null; then
            log "User 'clouddesktop' already exists"
        else
            useradd -r -m -d /home/clouddesktop -s /bin/bash clouddesktop
            usermod -aG sudo clouddesktop
        fi
        mkdir -p /run/user/$(id -u clouddesktop)
        chown clouddesktop:clouddesktop /run/user/$(id -u clouddesktop)
        chmod 700 /run/user/$(id -u clouddesktop)
    fi

    # Create Desktop, Downloads, and upload temp dir
    mkdir -p "${RUN_HOME}/Desktop" "${RUN_HOME}/Downloads" "/tmp/clouddesktop-uploads"
    chown -R ${RUN_USER}:${RUN_USER} "${RUN_HOME}/Desktop" "${RUN_HOME}/Downloads"
    chown ${RUN_USER}:${RUN_USER} "/tmp/clouddesktop-uploads"
}

# ── VNC setup ─────────────────────────────────────────────────

setup_vnc() {
    log "Configuring VNC..."

    # Create VNC config directories
    VNC_DIR="${RUN_HOME}/.config/tigervnc"
    VNC_LEGACY="${RUN_HOME}/.vnc"
    mkdir -p "$VNC_DIR" "$VNC_LEGACY"

    # Copy xstartup to both locations (uses $HOME so works for any user)
    cp "${INSTALL_DIR}/config/vnc/xstartup" "${VNC_DIR}/xstartup"
    cp "${INSTALL_DIR}/config/vnc/xstartup" "${VNC_LEGACY}/xstartup"
    chmod +x "${VNC_DIR}/xstartup" "${VNC_LEGACY}/xstartup"

    chown -R ${RUN_USER}:${RUN_USER} "$VNC_DIR" "$VNC_LEGACY"
}

# ── Download noVNC ────────────────────────────────────────────

download_novnc() {
    log "Downloading noVNC..."
    NOVNC_DIR="${INSTALL_DIR}/client/vendor/novnc"

    if [ -d "${NOVNC_DIR}/core" ]; then
        log "noVNC already present, skipping download"
        return
    fi

    # Download noVNC release
    NOVNC_VERSION="1.5.0"
    NOVNC_URL="https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz"

    TEMP_DIR=$(mktemp -d)
    curl -fsSL "$NOVNC_URL" -o "${TEMP_DIR}/novnc.tar.gz"
    tar -xzf "${TEMP_DIR}/novnc.tar.gz" -C "$TEMP_DIR"

    # Copy only needed files
    rm -rf "$NOVNC_DIR"
    mkdir -p "$NOVNC_DIR"
    cp -r "${TEMP_DIR}/noVNC-${NOVNC_VERSION}/core" "${NOVNC_DIR}/core"
    cp -r "${TEMP_DIR}/noVNC-${NOVNC_VERSION}/vendor" "${NOVNC_DIR}/vendor" 2>/dev/null || true
    cp "${TEMP_DIR}/noVNC-${NOVNC_VERSION}/package.json" "${NOVNC_DIR}/package.json" 2>/dev/null || true

    rm -rf "$TEMP_DIR"
    log "noVNC ${NOVNC_VERSION} installed"
}

# ── Node.js dependencies ─────────────────────────────────────

install_node_deps() {
    log "Installing Node.js dependencies..."
    cd "${INSTALL_DIR}/server"
    npm install --production 2>/dev/null
    cd "${INSTALL_DIR}"
}

# ── Generate secrets ─────────────────────────────────────────

generate_env() {
    log "Generating secrets..."

    mkdir -p "$DATA_DIR"

    JWT_SECRET=$(openssl rand -hex 32)

    # Hash password using bcryptjs
    PASSWORD_HASH=$(node -e "
const bcrypt = require('${INSTALL_DIR}/server/node_modules/bcryptjs');
bcrypt.hash(process.argv[1], 12).then(h => process.stdout.write(h));
" "$PASSWORD")

    cat > "$ENV_FILE" <<ENVEOF
# CloudDesktop Configuration
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

HOST=127.0.0.1
PORT=3000

USERNAME=${USERNAME}
PASSWORD_HASH=${PASSWORD_HASH}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRY=24h

VNC_HOST=127.0.0.1
VNC_PORT=6080

DISPLAY=:1

CLAUDE_DOCK=${CLAUDE_DOCK}

OTP_ENABLED=false
OTP_SECRET=
ENVEOF

    chmod 600 "$ENV_FILE"
    log "Environment file created"
}

# ── SSL setup ─────────────────────────────────────────────────

setup_ssl() {
    if [ "$DOMAIN" != "localhost" ] && [ -n "$EMAIL" ]; then
        log "Setting up Let's Encrypt SSL..."
        bash "${INSTALL_DIR}/scripts/setup-ssl.sh" "$DOMAIN" "$EMAIL" || {
            warn "Let's Encrypt failed, falling back to self-signed"
            bash "${INSTALL_DIR}/scripts/setup-ssl.sh"
        }
    else
        log "Generating self-signed SSL certificate..."
        bash "${INSTALL_DIR}/scripts/setup-ssl.sh"
    fi
}

# ── Nginx setup ───────────────────────────────────────────────

setup_nginx() {
    log "Configuring Nginx..."

    # Create certbot webroot
    mkdir -p /var/www/certbot

    # Copy config
    cp "${INSTALL_DIR}/config/nginx/clouddesktop.conf" /etc/nginx/sites-available/clouddesktop

    # Update server_name if domain provided
    if [ "$DOMAIN" != "localhost" ]; then
        sed -i "s|server_name _;|server_name ${DOMAIN};|g" /etc/nginx/sites-available/clouddesktop
    fi

    # Enable site
    ln -sf /etc/nginx/sites-available/clouddesktop /etc/nginx/sites-enabled/clouddesktop

    # Remove default site if it exists
    rm -f /etc/nginx/sites-enabled/default

    # Test and reload
    nginx -t
    systemctl enable nginx
    systemctl restart nginx
}

# ── Firewall setup ────────────────────────────────────────────

setup_firewall() {
    log "Configuring firewall..."

    # Reset UFW
    ufw --force reset >/dev/null 2>&1

    # Default policies
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null

    # Allow SSH, HTTP, HTTPS
    ufw allow 22/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null

    # Enable firewall
    echo "y" | ufw enable >/dev/null
    log "Firewall enabled (ports 22, 80, 443)"
}

# ── Fail2ban setup ────────────────────────────────────────────

setup_fail2ban() {
    log "Configuring fail2ban..."

    # Create log directory and log file (needed for fail2ban)
    mkdir -p "$LOG_DIR"
    touch "${LOG_DIR}/web.log"
    chown -R ${RUN_USER}:${RUN_USER} "$LOG_DIR"

    # Install filter
    cat > /etc/fail2ban/filter.d/clouddesktop.conf <<'F2BFILTER'
[Definition]
failregex = AUTH_FAILURE:.*ip=<HOST>
ignoreregex =
F2BFILTER

    # Install jail
    cat > /etc/fail2ban/jail.d/clouddesktop.conf <<'F2BJAIL'
[clouddesktop]
enabled  = true
port     = http,https
filter   = clouddesktop
logpath  = /var/log/clouddesktop/web.log
maxretry = 5
bantime  = 3600
findtime = 600
F2BJAIL

    systemctl enable fail2ban
    systemctl restart fail2ban
}

# ── Desktop launchers ─────────────────────────────────────────

setup_desktop_launchers() {
    log "Creating desktop launchers..."

    DESKTOP_DIR="${RUN_HOME}/Desktop"
    APPS_DIR="/usr/share/applications"
    mkdir -p "$DESKTOP_DIR"

    # Firefox
    cat > "${DESKTOP_DIR}/firefox.desktop" <<'DTEOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox Web Browser
Exec=firefox %u
Icon=firefox
Terminal=false
Categories=Network;WebBrowser;
DTEOF

    # Google Chrome
    cat > "${DESKTOP_DIR}/chrome.desktop" <<'DTEOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Google Chrome
Exec=google-chrome --no-sandbox --no-first-run %u
Icon=google-chrome
Terminal=false
Categories=Network;WebBrowser;
DTEOF

    # Claude Code (only if dock enabled)
    if [ "$CLAUDE_DOCK" = "true" ]; then
        cat > "${DESKTOP_DIR}/claude-code.desktop" <<'DTEOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Claude Code
Exec=xfce4-terminal -x bash -c "claude; exec bash"
Icon=utilities-terminal
Terminal=false
Categories=Development;
DTEOF

        cat > "${DESKTOP_DIR}/claude-fast.desktop" <<'DTEOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Claude Fast
Exec=xfce4-terminal -x bash -c "IS_SANDBOX=1 claude --dangerously-skip-permissions; exec bash"
Icon=utilities-terminal
Terminal=false
Categories=Development;
DTEOF
    fi

    # Copy to system applications and set permissions
    for f in "${DESKTOP_DIR}"/*.desktop; do
        chmod +x "$f"
        cp "$f" "${APPS_DIR}/" 2>/dev/null || true
    done

    chown -R root:root "$DESKTOP_DIR"

    # Disable XFCE panel (replaced by web dock)
    AUTOSTART_DIR="${RUN_HOME}/.config/autostart"
    mkdir -p "$AUTOSTART_DIR"
    cat > "${AUTOSTART_DIR}/xfce4-panel.desktop" <<'PANELEOF'
[Desktop Entry]
Hidden=true
Name=Panel
Type=Application
Exec=xfce4-panel
PANELEOF

    # Configure XFCE session to exclude panel from failsafe startup
    XFCONF_DIR="${RUN_HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
    mkdir -p "$XFCONF_DIR"

    cat > "${XFCONF_DIR}/xfce4-session.xml" <<'SESSEOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="general" type="empty">
    <property name="SessionName" type="string" value="Default"/>
    <property name="SaveOnExit" type="bool" value="false"/>
  </property>
  <property name="sessions" type="empty">
    <property name="Failsafe" type="empty">
      <property name="IsFailsafe" type="bool" value="true"/>
      <property name="Count" type="int" value="3"/>
      <property name="Client0_Command" type="array">
        <value type="string" value="xfwm4"/>
      </property>
      <property name="Client0_Priority" type="int" value="15"/>
      <property name="Client0_PerScreen" type="bool" value="false"/>
      <property name="Client1_Command" type="array">
        <value type="string" value="xfdesktop"/>
      </property>
      <property name="Client1_Priority" type="int" value="25"/>
      <property name="Client1_PerScreen" type="bool" value="false"/>
      <property name="Client2_Command" type="array">
        <value type="string" value="xfsettingsd"/>
      </property>
      <property name="Client2_Priority" type="int" value="30"/>
      <property name="Client2_PerScreen" type="bool" value="false"/>
    </property>
  </property>
</channel>
SESSEOF

    # Empty panel config so it has no panels even if started
    cat > "${XFCONF_DIR}/xfce4-panel.xml" <<'PANELXEOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array"/>
</channel>
PANELXEOF

    chown -R ${RUN_USER}:${RUN_USER} "${RUN_HOME}/.config"
}

# ── Systemd services ─────────────────────────────────────────

setup_services() {
    log "Installing systemd services..."

    # Copy service files and patch user/home for chosen mode
    for svc in clouddesktop-vnc clouddesktop-ws clouddesktop-web; do
        cp "${INSTALL_DIR}/config/systemd/${svc}.service" /etc/systemd/system/
        sed -i "s|User=root|User=${RUN_USER}|g" "/etc/systemd/system/${svc}.service"
        sed -i "s|Group=root|Group=${RUN_USER}|g" "/etc/systemd/system/${svc}.service"
        sed -i "s|HOME=/root|HOME=${RUN_HOME}|g" "/etc/systemd/system/${svc}.service"
        sed -i "s|USER=root|USER=${RUN_USER}|g" "/etc/systemd/system/${svc}.service"
    done

    # Patch start-vnc.sh for chosen user
    sed -i "s|HOME=/root|HOME=${RUN_HOME}|g" "${INSTALL_DIR}/scripts/start-vnc.sh"
    sed -i "s|USER=root|USER=${RUN_USER}|g" "${INSTALL_DIR}/scripts/start-vnc.sh"

    # Set permissions on install dir
    chmod -R 755 "${INSTALL_DIR}"
    chmod 600 "$ENV_FILE"
    if [ "$RUN_USER" != "root" ]; then
        chown -R ${RUN_USER}:${RUN_USER} "${INSTALL_DIR}"
        chown ${RUN_USER}:${RUN_USER} "$ENV_FILE"
    fi

    # Reload and enable
    systemctl daemon-reload
    systemctl enable clouddesktop-vnc clouddesktop-ws clouddesktop-web

    # Start services in order
    log "Starting VNC server..."
    systemctl start clouddesktop-vnc
    sleep 3

    log "Starting websockify bridge..."
    systemctl start clouddesktop-ws
    sleep 1

    log "Starting web backend..."
    systemctl start clouddesktop-web
    sleep 2
}

# ── Verification ──────────────────────────────────────────────

verify() {
    echo ""
    echo -e "${CYAN}── Verification ──${NC}"

    PASS=true

    # Check services
    for svc in clouddesktop-vnc clouddesktop-ws clouddesktop-web nginx; do
        if systemctl is-active --quiet "$svc"; then
            log "$svc: running"
        else
            warn "$svc: NOT running"
            PASS=false
        fi
    done

    # Check ports
    for port in 5901 6080 3000; do
        if ss -tlnp | grep -q ":${port} "; then
            log "Port $port: listening"
        else
            warn "Port $port: NOT listening"
            PASS=false
        fi
    done

    # Check web endpoint
    HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
        log "Web endpoint: responding (HTTP $HTTP_CODE)"
    else
        warn "Web endpoint: HTTP $HTTP_CODE"
        PASS=false
    fi

    echo ""

    if [ "$PASS" = true ]; then
        echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
        echo -e "${GREEN}${BOLD}║     Installation Successful!         ║${NC}"
        echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
    else
        echo -e "${YELLOW}${BOLD}Installation completed with warnings.${NC}"
        echo -e "${YELLOW}Check service logs: journalctl -u clouddesktop-vnc -f${NC}"
    fi

    echo ""
    if [ "$DOMAIN" != "localhost" ]; then
        echo -e "  ${BOLD}Access URL:${NC}  https://${DOMAIN}"
    else
        echo -e "  ${BOLD}Access URL:${NC}  https://<your-server-ip>"
    fi
    echo -e "  ${BOLD}Username:${NC}    ${USERNAME}"
    echo -e "  ${BOLD}Password:${NC}    (as set during install)"
    echo ""
    echo -e "  ${CYAN}Management commands:${NC}"
    echo "    Change password:  sudo bash /opt/OS/scripts/change-password.sh"
    echo "    Setup SSL:        sudo bash /opt/OS/scripts/setup-ssl.sh <domain> <email>"
    echo "    Service logs:     journalctl -u clouddesktop-web -f"
    echo "    Restart desktop:  sudo systemctl restart clouddesktop-vnc"
    echo "    Uninstall:        sudo bash /opt/OS/uninstall.sh"
    echo ""
}

# ── Main ──────────────────────────────────────────────────────

main() {
    preflight
    prompt_config
    install_packages
    setup_user
    setup_vnc
    setup_desktop_launchers
    download_novnc
    install_node_deps
    generate_env
    setup_ssl
    setup_nginx
    setup_firewall
    setup_fail2ban
    setup_services
    verify
}

main "$@"
