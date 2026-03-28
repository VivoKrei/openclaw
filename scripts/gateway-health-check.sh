#!/usr/bin/env bash
# gateway-health-check.sh — Check if OpenClaw gateway is alive, alert + restart if not.
#
# Cron: * * * * * /home/volt/.openclaw/workspace/scripts/gateway-health-check.sh
# (every 60s)
#
# Checks:
#   1. Gateway process is running
#   2. Gateway responds to status command
# If both fail: posts alert to NC Talk (main-room), attempts restart.

set -uo pipefail

NC_HOST="https://cloud.example.com"
NC_USER="Vault"
NC_PASS=$(cat /path/to/nextcloud-password.txt 2>/dev/null || echo "")
ALERT_ROOM="main-room"
STATE_FILE="/tmp/gateway-health-state"

# Avoid alert spam: only alert once per 5 minutes
if [ -f "$STATE_FILE" ]; then
    last_alert=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
    now=$(date +%s)
    elapsed=$(( now - last_alert ))
    if [ "$elapsed" -lt 300 ]; then
        exit 0  # Already alerted recently
    fi
fi

# Check 1: Is the gateway process running?
gateway_running=false
if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
    gateway_running=true
elif pgrep -f "openclaw.*gateway" >/dev/null 2>&1; then
    gateway_running=true
fi

# Check 2: Does the RPC probe respond? (grep for "RPC probe: ok" — definitive health signal)
status_ok=false
if openclaw gateway status 2>&1 | grep -q "RPC probe: ok"; then
    status_ok=true
fi

# If either check passes, we're good (RPC ok alone is sufficient)
if $status_ok || $gateway_running; then
    # Clear any stale state
    rm -f "$STATE_FILE" 2>/dev/null
    exit 0
fi

# Something is wrong — attempt restart first
openclaw gateway restart 2>/dev/null || systemctl --user restart openclaw-gateway.service 2>/dev/null || true
sleep 5

# Re-check after restart
restarted=false
if openclaw gateway status 2>&1 | grep -qi "running\|active\|ok" 2>/dev/null; then
    restarted=true
fi

# Alert
if [ -n "$NC_PASS" ]; then
    if $restarted; then
        msg="⚠️ Gateway was down — auto-restarted successfully. If you sent a message in the last minute, it may have been lost. Send it again."
    else
        msg="🚨 Gateway is DOWN and restart failed. Check: ssh volt-ubuntu && openclaw gateway status"
    fi
    curl -s -X POST \
        -u "${NC_USER}:${NC_PASS}" \
        -H "OCS-APIRequest: true" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"$msg\"}" \
        "${NC_HOST}/ocs/v2.php/apps/spreed/api/v1/chat/${ALERT_ROOM}" >/dev/null 2>&1
fi

# Record alert time
date +%s > "$STATE_FILE"
