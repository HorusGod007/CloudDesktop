#!/bin/bash
# CloudDesktop VNC starter — runs Xtigervnc + XFCE session

# Clean up stale locks
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null

export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export DISPLAY=:1

# Generate Xauthority
touch "$HOME/.Xauthority"
xauth generate :1 . trusted 2>/dev/null || true

# Start Xtigervnc in background
/usr/bin/Xtigervnc :1 \
  -geometry 1920x1080 \
  -depth 24 \
  -rfbport 5901 \
  -localhost yes \
  -SecurityTypes None \
  -AlwaysShared \
  -AcceptKeyEvents \
  -AcceptPointerEvents \
  -SendCutText \
  -AcceptCutText \
  -auth "$HOME/.Xauthority" &

VNC_PID=$!

# Wait for X server to be ready
for i in $(seq 1 10); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Start D-Bus session
if command -v dbus-launch &>/dev/null; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi

# Set XDG variables
export XDG_SESSION_TYPE=x11
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_CONFIG_DIRS=/etc/xdg
export XDG_DATA_DIRS=/usr/local/share:/usr/share

# Start clipboard sync (bridges VNC clipboard with X selections)
vncconfig -nowin &
autocutsel -fork -selection CLIPBOARD 2>/dev/null || true

# Start XFCE4 in background
startxfce4 &

# Wait for VNC process (main process)
wait $VNC_PID
