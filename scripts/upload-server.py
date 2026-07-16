#!/usr/bin/env python3
"""pocket-term upload-server — File upload sink for /up endpoint.

Sits behind ttyd (same origin). Requires Basic auth (shares ttyd credentials).
All security decisions are in this file; external reverse proxy is optional.

Usage:
  python3 upload-server.py \\
    --upload-dir /path/to/uploads \\
    --port 7698 \\
    --max-bytes 26214400 \\
    --credentials /path/to/credentials \\
    [--allowed-ext .jpg,.png,.pdf,...]

Or via environment variables:
  UPLOAD_DIR=/path PORT=7698 MAX_BYTES=26214400 \\
  CREDENTIALS_FILE=/path/to/credentials \\
  python3 upload-server.py

Security properties:
  - Basic auth REQUIRED — refuses to start without valid credentials (fail-closed)
  - O_EXCL atomic writes prevent concurrent overwrite
  - basename + regex sanitize filenames (path traversal prevention)
  - Disallowed extensions → 400 (not silently renamed)
  - Size limit enforced before disk write
  - Symlink destination safety check
  - Binds 127.0.0.1 only

Author: pocket-term contributors
License: MIT
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_credentials(path: str) -> str:
    """Load username:password from credentials file. Returns Base64 encoded value.

    Exits with error if the file is unreadable, empty, or malformed.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            line = f.readline().strip()
    except OSError as exc:
        print(f"ERROR: cannot read credentials file {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    if not line or ":" not in line:
        print(f"ERROR: credentials file {path} is empty or malformed (expected 'user:password')", file=sys.stderr)
        sys.exit(1)
    return base64.b64encode(line.encode()).decode()


class UploadHandler(BaseHTTPRequestHandler):
    upload_dir: str = "/tmp/pocket-term-uploads"
    max_bytes: int = 25 * 1024 * 1024
    allowed_ext: set[str] = {
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic",
        ".pdf", ".txt", ".log", ".json", ".md", ".csv", ".html",
    }
    expected_auth: str = ""  # Base64-encoded "user:password" — always set at startup

    def _reply(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _check_auth(self) -> bool:
        """Validate Basic auth header. Always 401 on failure."""
        if not self.expected_auth:
            # Fail-closed: if somehow expected_auth is empty, reject everything
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="pocket-term"')
            self.end_headers()
            return False
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Basic "):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="pocket-term"')
            self.end_headers()
            return False
        if auth_header[6:] != self.expected_auth:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="pocket-term"')
            self.end_headers()
            return False
        return True

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/up":
            return self._reply(404, {"error": "not found"})

        if not self._check_auth():
            return

        # ── Content-Length validation ──
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._reply(400, {"error": "empty body"})
        if length > self.max_bytes:
            return self._reply(413, {
                "error": f"too large (max {self.max_bytes} bytes, got {length})",
            })

        # ── Filename sanitization ──
        from urllib.parse import unquote as _unquote
        raw_name = _unquote(self.headers.get("X-Filename") or "upload.bin")
        name = os.path.basename(raw_name)
        name = re.sub(r"[^\w.\-]", "_", name)
        name = name[-100:] or "upload.bin"

        # ── Extension whitelist ──
        ext = os.path.splitext(name)[1].lower()
        if ext not in self.allowed_ext:
            return self._reply(400, {
                "error": f"file extension not allowed: {ext or '(none)'}",
                "allowed": sorted(self.allowed_ext),
            })

        # ── Read body ──
        body = self.rfile.read(length)

        # ── Atomic write with O_EXCL + symlink safety ──
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base_path = os.path.join(self.upload_dir, f"{stamp}-{name}")
        path = base_path
        seq = 1
        while True:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
                break
            except FileExistsError:
                seq += 1
                path = os.path.join(self.upload_dir, f"{stamp}-{seq}-{name}")
                if seq > 999:
                    return self._reply(500, {"error": "could not create unique file"})

        # Symlink safety: after creating fd, verify it's a regular file
        try:
            st = os.fstat(fd)
            import stat
            if not stat.S_ISREG(st.st_mode):
                os.close(fd)
                os.unlink(path)
                return self._reply(400, {"error": "destination is not a regular file"})
        except OSError:
            os.close(fd)
            return self._reply(500, {"error": "filesystem error"})

        try:
            os.write(fd, body)
        finally:
            os.close(fd)

        self._reply(200, {"path": path, "bytes": length, "name": name})

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="pocket-term upload-server")
    parser.add_argument(
        "--upload-dir",
        default=os.environ.get("UPLOAD_DIR", "/tmp/pocket-term-uploads"),
        help="Directory to store uploaded files",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "7698")),
        help="Port to listen on (default: 7698)",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=int(os.environ.get("MAX_BYTES", str(25 * 1024 * 1024))),
        help="Maximum upload size in bytes (default: 25MB)",
    )
    parser.add_argument(
        "--credentials",
        required=True,
        default=os.environ.get("CREDENTIALS_FILE", ""),
        help="Path to credentials file (format: user:password on first line). REQUIRED.",
    )
    parser.add_argument(
        "--allowed-ext",
        default=os.environ.get(
            "ALLOWED_EXTS",
            ".jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.pdf,.txt,.log,.json,.md,.csv,.html"
        ),
        help="Comma-separated list of allowed extensions with dots",
    )
    args = parser.parse_args()

    if not args.credentials:
        print("ERROR: --credentials is required. Auth cannot be disabled.", file=sys.stderr)
        sys.exit(1)

    # Configure handler class
    UploadHandler.upload_dir = os.path.abspath(args.upload_dir)
    UploadHandler.max_bytes = args.max_bytes
    UploadHandler.allowed_ext = {
        ext.strip() if ext.strip().startswith(".") else f".{ext.strip()}"
        for ext in args.allowed_ext.split(",") if ext.strip()
    }
    # Fail-closed: exit if credentials are invalid
    UploadHandler.expected_auth = load_credentials(args.credentials)

    os.makedirs(UploadHandler.upload_dir, exist_ok=True)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), UploadHandler)
    print(
        f"upload-server: listening on 127.0.0.1:{args.port} (auth=enabled)",
        file=sys.stderr,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nupload-server: shutting down", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
