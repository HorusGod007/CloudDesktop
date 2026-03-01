#!/bin/bash
# CloudDesktop Uninstaller
# Cleanly removes CloudDesktop from the system

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Error: Must run as root (sudo ./uninstall.sh)${NC}"
    exit 1
fi

echo "========================================"
echo "   CloudDesktop Uninstaller"
echo "========================================"
echo ""
echo -e "${YELLOW}This will remove CloudDesktop and all its components.${NC}"
echo ""
read -rp "Are you sure? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled."
    exit 0
fi

echo ""

# Remove Claude Code CLI (if installed)
if command -v claude &>/dev/null; then
    echo "Removing Claude Code CLI..."
    npm uninstall -g @anthropic-ai/claude-code 2>/dev/null || true
fi

# Stop and disable services
echo "Stopping services..."
for svc in clouddesktop-web clouddesktop-ws clouddesktop-vnc; do
    systemctl stop "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
    rm -f "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload

# Remove nginx config
echo "Removing nginx config..."
rm -f /etc/nginx/sites-enabled/clouddesktop
rm -f /etc/nginx/sites-available/clouddesktop
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true

# Remove fail2ban config
echo "Removing fail2ban config..."
rm -f /etc/fail2ban/filter.d/clouddesktop.conf
rm -f /etc/fail2ban/jail.d/clouddesktop.conf
systemctl reload fail2ban 2>/dev/null || true

# Remove SSL certificates (self-signed only)
echo "Removing self-signed certificates..."
rm -f /etc/ssl/certs/clouddesktop.crt
rm -f /etc/ssl/private/clouddesktop.key

# Remove log directory and upload temp
rm -rf /var/log/clouddesktop
rm -rf /tmp/clouddesktop-uploads

# Remove certbot directory (if applicable)
rm -rf /var/www/certbot

# Remove clouddesktop user if it exists
if id "clouddesktop" &>/dev/null; then
    read -rp "Remove clouddesktop system user? (y/N): " REMOVE_USER
    if [[ "$REMOVE_USER" =~ ^[Yy]$ ]]; then
        userdel -r clouddesktop 2>/dev/null || true
        echo "User removed."
    fi
fi

# Ask about removing application files
read -rp "Remove /opt/OS directory? (y/N): " REMOVE_FILES
if [[ "$REMOVE_FILES" =~ ^[Yy]$ ]]; then
    rm -rf /opt/OS
    echo "Application files removed."
else
    echo "Application files preserved at /opt/OS"
fi

echo ""
echo -e "${GREEN}CloudDesktop has been uninstalled.${NC}"
echo ""
echo "Note: The following packages were installed but NOT removed:"
echo "  tigervnc-standalone-server, xfce4, nginx, nodejs, ufw, fail2ban"
echo "Remove them manually with: apt remove <package>"
