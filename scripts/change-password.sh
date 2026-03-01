#!/bin/bash
# CloudDesktop password change utility
# Usage: sudo ./change-password.sh

set -euo pipefail

ENV_FILE="/opt/OS/data/.env"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: Must run as root"
    exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: Environment file not found at ${ENV_FILE}"
    exit 1
fi

# Prompt for new password
echo "CloudDesktop — Change Password"
echo "==============================="

while true; do
    read -rsp "New password: " PASSWORD
    echo
    read -rsp "Confirm password: " PASSWORD2
    echo

    if [ "$PASSWORD" != "$PASSWORD2" ]; then
        echo "Passwords do not match. Try again."
        continue
    fi

    if [ ${#PASSWORD} -lt 8 ]; then
        echo "Password must be at least 8 characters. Try again."
        continue
    fi

    break
done

# Hash password using Node.js
HASH=$(node -e "
const bcrypt = require('/opt/OS/server/node_modules/bcryptjs');
bcrypt.hash(process.argv[1], 12).then(h => process.stdout.write(h));
" "$PASSWORD")

# Update .env file
if grep -q "^PASSWORD_HASH=" "$ENV_FILE"; then
    sed -i "s|^PASSWORD_HASH=.*|PASSWORD_HASH=${HASH}|" "$ENV_FILE"
else
    echo "PASSWORD_HASH=${HASH}" >> "$ENV_FILE"
fi

# Restart web service to pick up new password
systemctl restart clouddesktop-web

echo ""
echo "Password changed successfully."
echo "The web service has been restarted."
