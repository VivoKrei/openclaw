#!/usr/bin/env python3
"""Claude Code PostToolUse hook — sends real-time progress updates to NC Talk.

Reads JSON from stdin (Claude Code hook payload), extracts meaningful events,
and posts 1-liner updates to an NC Talk room. Rate-limited to avoid spam.

Hook setup in ~/.claude/settings.json:
  "PostToolUse": [{
    "matcher": "Write|Edit|Bash",
    "hooks": [{"type": "command", "command": "python3 /path/to/workspace/scripts/claude-hook-notify.py"}]
  }],
  "Stop": [{
    "hooks": [{"type": "command", "command": "python3 /path/to/workspace/scripts/claude-hook-notify.py"}]
  }]

Environment variable NOTIFY_ROOM controls which NC Talk room gets updates.
Falls back to omwwq238 (BMAD room) if not set.
"""

import fcntl
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

# Config
NC_HOST = "https://cloud.example.com"
NC_USER = "Vault"
NC_PASS_FILE = Path("/path/to/nextcloud-password.txt")
MIN_INTERVAL_SECONDS = 30

# P7 fix: use user-private dir instead of world-writable /tmp
_STATE_DIR = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
if not _STATE_DIR.exists():
    _STATE_DIR = Path.home() / ".cache"
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = _STATE_DIR / "claude-hook-notify-state.json"

# P5 fix: validate room token format (alphanumeric only)
_raw_room = os.environ.get("NOTIFY_ROOM", "omwwq238")
ROOM = _raw_room if re.match(r'^[a-zA-Z0-9]+$', _raw_room) else "omwwq238"

# P8 fix: noise filters — match anywhere in command, not just startswith
SKIP_PATTERNS = [
    "cat ", "head ", "tail ", "grep ", "wc ", "ls ", "find ",
    "echo ", "pwd", "which ", "type ", "file ", "diff ", "stat ",
]


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"last_post_ts": 0}


def _save_state(state: dict):
    """Atomic write with file locking (P2 fix)."""
    tmp = STATE_FILE.with_suffix(".tmp")
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            json.dump(state, f)
            fcntl.flock(f, fcntl.LOCK_UN)
        os.replace(str(tmp), str(STATE_FILE))
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def _should_post(state: dict) -> bool:
    elapsed = time.time() - state.get("last_post_ts", 0)
    return elapsed >= MIN_INTERVAL_SECONDS


def _post_to_nc_talk(message: str):
    """Post via urllib (P1 fix: no password in process args)."""
    try:
        password = NC_PASS_FILE.read_text().strip()
    except FileNotFoundError:
        return  # P4 fix: fail silently if password file missing

    url = f"{NC_HOST}/ocs/v2.php/apps/spreed/api/v1/chat/{ROOM}"
    data = json.dumps({"message": message}).encode()

    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("OCS-APIRequest", "true")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")

    # Basic auth without exposing in process args
    import base64
    cred = base64.b64encode(f"{NC_USER}:{password}".encode()).decode()
    req.add_header("Authorization", f"Basic {cred}")

    try:
        # P6 fix: 5s timeout instead of 10s to avoid blocking hook return
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def _format_event(payload: dict) -> tuple[str | None, bool]:
    """Extract a meaningful 1-liner from the hook payload.

    Returns (message, bypass_rate_limit).
    """
    # P11 fix: guard tool_input type
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_output = payload.get("tool_output", "")

    # Stop event (agent finished) — P3 fix: bypass rate limit, but dedup
    hook_event = payload.get("hook_event_name", "")
    if hook_event == "Stop" or (not tool_name and not hook_event):
        # Dedup: only post "finished" once per session
        session_id = payload.get("session_id", "unknown")
        state = _load_state()
        last_stop = state.get("last_stop_session", "")
        if last_stop == session_id:
            return None, False  # already posted for this session
        return "✅ Agent finished", True

    if tool_name in ("Write", "Edit", "MultiEdit"):
        file_path = tool_input.get("file_path", tool_input.get("path", ""))
        if file_path:
            basename = Path(file_path).name
            action = "wrote" if tool_name == "Write" else "edited"
            return f"📝 {action} {basename}", False
        return None, False

    if tool_name == "Bash":
        command = str(tool_input.get("command", ""))

        # P8 fix: check if the core command is a read-only one
        # Strip leading pipes/env vars to get actual command
        core = command.strip().lstrip("| ").split("|")[0].strip()
        for prefix in ("sudo", "env", "cd"):
            if core.startswith(prefix + " "):
                core = core[len(prefix):].strip()
        if any(core.startswith(p) for p in SKIP_PATTERNS):
            return None, False

        # Detect test runs
        if "pytest" in command or "python -m pytest" in command:
            output_str = str(tool_output)[:500] if tool_output else ""
            # P10 fix: use regex to extract test summary line
            match = re.search(r'(\d+ passed.*(?:failed|error)?.*)', output_str)
            if match:
                return f"🧪 Tests: {match.group(1)[:80]}", False
            elif "failed" in output_str or "error" in output_str.lower():
                return "🧪 Tests: some failures detected", False
            return "🧪 Running tests...", False

        # Detect git operations
        if core.startswith("git commit"):
            return "📦 Committed changes", False
        if core.startswith("git push"):
            return "🚀 Pushed to remote", False
        if "gh pr create" in command:
            return "🔗 Creating pull request", False

        # Detect Deck API calls
        if "deck/api" in command:
            return "🗂️ NC Deck API call", False

        # Skip agent's own NC Talk posts
        if "spreed/api" in command and "chat" in command:
            return None, False

        # Generic meaningful bash (only if somewhat long)
        if len(command) > 20:
            short = command.strip()[:60].replace("\n", " ")
            return f"⚙️ {short}", False

        return None, False

    return None, False


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError, ValueError):
        return

    state = _load_state()
    message, bypass_rate_limit = _format_event(payload)

    if not message:
        return

    # P3 fix: Stop events always post, regardless of rate limit
    if not bypass_rate_limit and not _should_post(state):
        return

    try:
        _post_to_nc_talk(f"[agent] {message}")
        state["last_post_ts"] = time.time()
        # Track Stop session for dedup
        hook_event = payload.get("hook_event_name", "")
        if hook_event == "Stop":
            state["last_stop_session"] = payload.get("session_id", "unknown")
        _save_state(state)
    except Exception:
        pass  # hooks must not crash the agent


if __name__ == "__main__":
    main()
