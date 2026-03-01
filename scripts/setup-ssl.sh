#!/bin/bash
# CloudDesktop SSL certificate setup
# Usage: sudo ./setup-ssl.sh [domain] [email]

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
NGINX_CONF="/etc/nginx/sites-available/clouddesktop"
CERT_DIR="/etc/ssl/certs"
KEY_DIR="/etc/ssl/private"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: Must run as root"
    exit 1
fi

# Self-signed certificate
generate_self_signed() {
    echo "Generating self-signed certificate..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "${KEY_DIR}/clouddesktop.key" \
        -out "${CERT_DIR}/clouddesktop.crt" \
        -subj "/CN=${DOMAIN:-localhost}/O=CloudDesktop"

    chmod 600 "${KEY_DIR}/clouddesktop.key"
    echo "Self-signed certificate generated."
}

# Let's Encrypt certificate
generate_letsencrypt() {
    if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
        echo "Error: Domain and email required for Let's Encrypt"
        echo "Usage: $0 domain email"
        exit 1
    fi

    echo "Obtaining Let's Encrypt certificate for ${DOMAIN}..."

    # Ensure certbot is installed
    if ! command -v certbot &>/dev/null; then
        apt-get update && apt-get install -y certbot python3-certbot-nginx
    fi

    # Get certificate
    certbot certonly --nginx \
        -d "$DOMAIN" \
        --email "$EMAIL" \
        --agree-tos \
        --non-interactive \
        --redirect

    # Update nginx config to use Let's Encrypt certs
    sed -i "s|ssl_certificate .*|ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;|" "$NGINX_CONF"
    sed -i "s|ssl_certificate_key .*|ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;|" "$NGINX_CONF"

    # Enable OCSP stapling
    sed -i 's|# ssl_stapling on;|ssl_stapling on;|' "$NGINX_CONF"
    sed -i 's|# ssl_stapling_verify on;|ssl_stapling_verify on;|' "$NGINX_CONF"

    # Update server_name
    sed -i "s|server_name _;|server_name ${DOMAIN};|g" "$NGINX_CONF"

    echo "Let's Encrypt certificate installed for ${DOMAIN}."
    echo "Auto-renewal is configured via certbot's systemd timer."
}

if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ] && [ -n "$EMAIL" ]; then
    generate_letsencrypt
else
    generate_self_signed
fi

# Reload nginx
nginx -t && systemctl reload nginx
echo "SSL setup complete."
