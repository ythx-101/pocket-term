#!/usr/bin/env python3
"""pocket-term shared manifest + rollback logic.

Used by both install-l1.sh (automatic rollback on failure) and uninstall.sh
(explicit teardown), so there is exactly one place that reverses installer
steps and restores tailscale serve/funnel state.

Security invariant: every undo command is executed as an argv list via
subprocess.run([...]) — never via a shell string ("bash -c '<text>'" or
shell=True). Attacker-influenced paths (e.g. --prefix) can contain arbitrary
bytes, including shell metacharacters or embedded newlines; since those bytes
are only ever passed as discrete argv elements (never concatenated into a
string that a shell re-parses), they cannot break out of their argument
position. Do not "simplify" this back into a shell string.
"""
import http.client
import json
import os
import socket
import subprocess
import sys

# tailscale serve/funnel are ONE unified config (tailscale.com/ipn.ServeConfig
# has TCP/Web/AllowFunnel/Services fields all together — "funnel status" is
# even the exact same CLI code path as "serve status", see
# cmd/tailscale/cli/funnel.go's Subcommands: [{Name: "status", Exec:
# e.runServeStatus, ...}]). `tailscale serve reset` / `tailscale funnel reset`
# are ALSO identical: both just call SetServeConfig(new(ipn.ServeConfig)) —
# see cmd/tailscale/cli/serve_legacy.go's runServeReset. So one snapshot
# (`tailscale serve status --json`) and one reset call is all that's needed;
# there is no separate "funnel-only" config to snapshot or reset.
#
# `tailscale serve set-config <file> --all` is NOT usable to restore that
# snapshot: in this tailscale version it is scoped to the newer "Services"
# (named virtual-IP-service) feature only. When fed a raw legacy
# `serve status --json` blob it explicitly discards TCP/Web/AllowFunnel with
# a stderr warning ("ignoring node-level fields not supported by set-config")
# and applies only the (usually empty, for pocket-term) Services map — see
# cmd/tailscale/cli/serve_v2.go's runServeSetConfig / legacyNodeLevelFields.
# That is what silently dropped a prior Funnel config in the previous
# version of this file.
#
# The actual mechanism every `tailscale serve`/`funnel`/`reset` CLI command
# uses under the hood is a POST of the *complete* ipn.ServeConfig JSON to the
# tailscaled local API (`POST /localapi/v0/serve-config`, unrestricted, no
# Services-only carve-out — see ipn/localapi/serve.go's serveServeConfig).
# Restoring a snapshot therefore means POSTing it back to that same endpoint
# directly, not going through the CLI's `set-config` subcommand.
_REAL_TAILSCALED_SOCKET_CANDIDATES = [
    "/run/tailscale/tailscaled.sock",
    "/var/run/tailscale/tailscaled.sock",
]


def _run(argv, timeout=30):
    """Execute argv (never a shell string) and report the outcome."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            print(f"  WARNING: {argv!r} exit={r.returncode} "
                  f"stderr={r.stderr.strip()[:200]}", file=sys.stderr)
            return False
        return True
    except Exception as exc:
        print(f"  ERROR running {argv!r}: {exc}", file=sys.stderr)
        return False


class _UnixSocketHTTPConnection(http.client.HTTPConnection):
    def __init__(self, sock_path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self._sock_path = sock_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._sock_path)
        self.sock = sock


def _override_mode():
    """True iff PT_TAILSCALED_SOCKET is set at all (test/override mode).

    Every code path that could otherwise reach the real tailscaled -- not
    just _find_tailscaled_socket()'s own resolution, but any CLI-fallback
    subprocess too -- must check this and refuse to touch the real daemon
    when it's true.
    """
    return "PT_TAILSCALED_SOCKET" in os.environ


def _find_tailscaled_socket():
    """Resolve the tailscaled local-API socket path.

    PT_TAILSCALED_SOCKET, when set at all (including to a bogus/nonexistent
    path), is AUTHORITATIVE: it is used as-is and this function NEVER falls
    through to a real /run/tailscale path in that case. This is what makes a
    test that sets PT_TAILSCALED_SOCKET to a bogus path structurally
    incapable of touching the real daemon — a nonexistent override means "no
    socket available" for this call, full stop, not "try the real one
    instead." (A prior version fell through to the real candidates whenever
    the override path didn't exist, which let a test meant to simulate an
    unreachable daemon accidentally hit the real one.)
    """
    if _override_mode():
        override = os.environ["PT_TAILSCALED_SOCKET"]
        return override if (override and os.path.exists(override)) else None
    for candidate in _REAL_TAILSCALED_SOCKET_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def _localapi_serve_config(method, body_bytes=None, timeout=10):
    """POST/GET raw ipn.ServeConfig JSON to tailscaled's local API.

    Returns (status_code, body_bytes) on a completed HTTP round trip, or
    (None, error_message) if the socket couldn't be reached at all. Never
    raises — every caller must handle both outcomes explicitly.
    """
    sock_path = _find_tailscaled_socket()
    if not sock_path:
        if "PT_TAILSCALED_SOCKET" in os.environ:
            return None, f"PT_TAILSCALED_SOCKET override not found: {os.environ['PT_TAILSCALED_SOCKET']!r}"
        return None, "tailscaled socket not found (checked: %s)" % ", ".join(
            _REAL_TAILSCALED_SOCKET_CANDIDATES)
    try:
        conn = _UnixSocketHTTPConnection(sock_path, timeout=timeout)
        headers = {"Host": "local-tailscaled.sock"}
        if body_bytes is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, "/localapi/v0/serve-config", body=body_bytes, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data
    except Exception as exc:
        return None, str(exc)


def manifest_init(manifest_path):
    with open(manifest_path, "w") as f:
        json.dump({"steps": []}, f, indent=2)


def manifest_add(manifest_path, action, target, undo):
    """undo: list[str] argv, or None if this step has nothing to reverse."""
    with open(manifest_path) as f:
        m = json.load(f)
    m["steps"].append({"action": action, "target": target, "undo": undo})
    with open(manifest_path, "w") as f:
        json.dump(m, f, indent=2)


def restore_tailscale_routes(route_snapshot_path):
    """Restore tailscale serve+funnel to their pre-install state.

    route_snapshot_path holds one JSON snapshot of the FULL unified
    ipn.ServeConfig (TCP, Web, AllowFunnel, Services) captured by
    `tailscale serve status --json` before pocket-term changed anything —
    see the module docstring above for why this single blob already covers
    funnel state too, and why it must be restored via a local API POST
    rather than `tailscale serve set-config`.

    Returns True if fully restored (including a genuinely non-empty prior
    Funnel config), False if a manual follow-up step is required (never
    raises — a failure here must not stop the rest of rollback/uninstall).
    """
    if not route_snapshot_path or not os.path.exists(route_snapshot_path):
        return True

    try:
        with open(route_snapshot_path) as f:
            raw = f.read()
        prev = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        print(f"  WARNING: could not read route snapshot {route_snapshot_path}: {exc}",
              file=sys.stderr)
        os.unlink(route_snapshot_path)
        return False

    if not prev:
        # Nothing existed before us: a full reset already restores that state
        # -- BUT only if the reset actually happened. A previous version of
        # this branch printed "reset is sufficient" and deleted the snapshot
        # unconditionally, even when BOTH the local-API POST and the CLI
        # fallback failed -- silently claiming success while pocket-term's
        # own route could still be live and the reference snapshot was gone.
        status, data = _localapi_serve_config("POST", b"{}")
        cleared = (status == 200)
        if not cleared:
            if _override_mode():
                # PT_TAILSCALED_SOCKET is set: this is a test/override run,
                # and it must be STRUCTURALLY incapable of reaching the real
                # tailscaled -- not just for the local-API path above, but
                # for every fallback too. The bare `tailscale` CLI has no way
                # to be pointed at our fake socket in a way it would actually
                # understand (it speaks the real local-API protocol, which a
                # minimal test double doesn't implement), so the only safe
                # choice is to skip the CLI fallback entirely here and fail
                # explicitly, rather than let it silently fall back to the
                # real /run or /var/run socket path.
                print("  WARNING: local-API restore failed and PT_TAILSCALED_SOCKET is set "
                      "-- skipping the real tailscale CLI fallback (test/override mode must "
                      "never reach the real daemon).", file=sys.stderr)
            else:
                print(f"  WARNING: could not clear tailscale serve/funnel config "
                      f"via local API (status={status}: {data}); trying CLI fallback", file=sys.stderr)
                cleared = _run(["tailscale", "serve", "reset"], timeout=15)
        if cleared:
            print("  Previous tailscale serve+funnel config was empty — reset confirmed.")
            os.unlink(route_snapshot_path)
            return True
        print("  WARNING: could not confirm tailscale serve/funnel was reset -- "
              "pocket-term's own route may still be live.", file=sys.stderr)
        _print_manual_restore_hint(route_snapshot_path)
        return False

    status, data = _localapi_serve_config("POST", raw.encode())
    if status == 200:
        had_funnel = bool(prev.get("AllowFunnel"))
        print("  Previous tailscale serve+funnel config restored from snapshot"
              + (" (including Funnel)." if had_funnel else "."))
        os.unlink(route_snapshot_path)
        return True

    print(f"  WARNING: could not restore previous tailscale serve/funnel config "
          f"via local API (status={status}): {str(data)[:300]!r}", file=sys.stderr)
    _print_manual_restore_hint(route_snapshot_path)
    return False


def _print_manual_restore_hint(route_snapshot_path):
    """Tell the user their prior config is safe on disk and how to reapply it.

    Called on every restore failure path. Never deletes the snapshot --
    that is the caller's job, and only on confirmed success.
    """
    print(f"  Previous config preserved at: {route_snapshot_path}", file=sys.stderr)
    sock_path = _find_tailscaled_socket() or "/run/tailscale/tailscaled.sock"
    print("  Restore manually with:", file=sys.stderr)
    print(f"    curl --unix-socket {sock_path} -H 'Host: local-tailscaled.sock' "
          f"-X POST --data-binary @{route_snapshot_path} "
          f"http://local-tailscaled.sock/localapi/v0/serve-config", file=sys.stderr)


def rollback(manifest_path, route_snapshot_path=None):
    """Reverse every manifest step in LIFO order, then restore routes.

    Returns the number of steps/restores that could not be cleanly reversed
    (0 == fully clean). Never raises.
    """
    if not manifest_path or not os.path.exists(manifest_path):
        return 0
    with open(manifest_path) as f:
        m = json.load(f)
    errors = 0
    for step in reversed(m.get("steps", [])):
        undo = step.get("undo")
        action = step.get("action", "?")
        target = step.get("target", "")
        if undo:
            print(f"  UNDO: {' '.join(undo)}")
            if not _run(undo):
                errors += 1
        else:
            print(f"  SKIP (no undo): {action} {target}")
    if route_snapshot_path:
        if not restore_tailscale_routes(route_snapshot_path):
            errors += 1
    return errors


def _cli():
    """Thin argv-only CLI so install-l1.sh/uninstall.sh never build shell strings.

    usage:
      pt_lib.py init   <manifest_path>
      pt_lib.py add     <manifest_path> <action> <target> [undo_argv...]
      pt_lib.py rollback <manifest_path> [route_snapshot_path]
    """
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    cmd, manifest_path = sys.argv[1], sys.argv[2]

    if cmd == "init":
        manifest_init(manifest_path)
        return 0

    if cmd == "add":
        if len(sys.argv) < 5:
            print("usage: pt_lib.py add <manifest_path> <action> <target> [undo_argv...]",
                  file=sys.stderr)
            sys.exit(2)
        action, target = sys.argv[3], sys.argv[4]
        undo = sys.argv[5:] if len(sys.argv) > 5 else None
        manifest_add(manifest_path, action, target, undo)
        return 0

    if cmd == "rollback":
        snapshot_arg = sys.argv[3] if len(sys.argv) > 3 else None
        n_errors = rollback(manifest_path, snapshot_arg)
        if n_errors:
            print(f"  Rollback completed with {n_errors} warning(s)", file=sys.stderr)
        else:
            print("All steps reversed cleanly.")
        return 1 if n_errors else 0

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
