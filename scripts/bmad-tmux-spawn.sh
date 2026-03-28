#!/usr/bin/env bash
# bmad-tmux-spawn.sh — Spawn Claude Code in a named tmux session for BMAD work
#
# Usage:
#   bash scripts/bmad-tmux-spawn.sh <session-name> <project-dir> <task-prompt-file> [notify-room]
#
# Example:
#   bash scripts/bmad-tmux-spawn.sh bmad-omi /home/volt/.openclaw/workspace/projects/omi-stt /tmp/task.txt omwwq238
#
# The task prompt is read from a file (not inline) to handle multi-line prompts safely.
# the user can attach at any time: tmux attach -t <session-name>
# Volt monitors via: tmux capture-pane -t <session-name> -p

set -euo pipefail

SESSION_NAME="${1:?Usage: bmad-tmux-spawn.sh <session-name> <project-dir> <task-prompt-file> [notify-room]}"
PROJECT_DIR="${2:?Missing project directory}"
TASK_FILE="${3:?Missing task prompt file}"
NOTIFY_ROOM="${4:-omwwq238}"

# Validate inputs
if [ ! -d "$PROJECT_DIR" ]; then
    echo "ERROR: Project directory does not exist: $PROJECT_DIR" >&2
    exit 1
fi
if [ ! -f "$TASK_FILE" ]; then
    echo "ERROR: Task prompt file does not exist: $TASK_FILE" >&2
    exit 1
fi

# Kill existing session with same name (if any)
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# Create tmux session running Claude Code in the project dir
# --permission-mode bypassPermissions = no approval prompts
# NOTIFY_ROOM env var picked up by the PostToolUse hook
tmux new-session -d -s "$SESSION_NAME" \
    -x 200 -y 50 \
    "cd '$PROJECT_DIR' && NOTIFY_ROOM='$NOTIFY_ROOM' claude --permission-mode bypassPermissions; echo '--- SESSION COMPLETE ---'; sleep 3600"

# Give Claude Code a moment to start up
sleep 3

# Send the task prompt via tmux (bracketed paste for safety with special chars)
tmux send-keys -t "$SESSION_NAME" "$(cat "$TASK_FILE")" Enter

echo "SESSION_NAME=$SESSION_NAME"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "NOTIFY_ROOM=$NOTIFY_ROOM"
echo ""
echo "the user can attach: tmux attach -t $SESSION_NAME"
echo "Volt monitors:    tmux capture-pane -t $SESSION_NAME -p -S -50"
