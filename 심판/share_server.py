#!/usr/bin/env python3
"""Serve only the public referee app files on the loopback interface."""

import argparse
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")
PUBLIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/csv.js": ("csv.js", "text/javascript; charset=utf-8"),
    "/assets/intrusion.mp3": ("assets/intrusion.mp3", "audio/mpeg"),
    "/assets/intrusion-female.mp3": ("assets/intrusion-female.mp3", "audio/mpeg"),
    "/assets/intrusion-male.mp3": ("assets/intrusion-male.mp3", "audio/mpeg"),
    # 성대 마크는 선택 파일이다. assets/에 넣으면 헤더에 표시되고, 없으면 404로 넘어간다.
    "/assets/skku-mark.svg": ("assets/skku-mark.svg", "image/svg+xml"),
    "/assets/skku-mark.png": ("assets/skku-mark.png", "image/png"),
}


class ShareHandler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        # 접속 기기·브라우저를 알 수 있도록 User-Agent를 함께 남긴다 (원격 진단용).
        agent = (self.headers.get("User-Agent") or "-")[:160]
        self.log_message('"%s" %s "%s"', self.requestline, str(code), agent)

    def do_GET(self):
        self._serve_file(include_body=True)

    def do_HEAD(self):
        self._serve_file(include_body=False)

    def _serve_file(self, include_body):
        try:
            public_file = PUBLIC_FILES.get(urlsplit(self.path).path)
        except ValueError:
            public_file = None
        if public_file is None:
            self.send_error(404)
            return

        relative_path, content_type = public_file
        file_path = (ROOT / relative_path).resolve()
        if not file_path.is_relative_to(ROOT):
            self.send_error(404)
            return
        try:
            content = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return

        # Safari/iOS refuse to play media unless the server honours byte ranges (206).
        status, body, content_range = 200, content, None
        requested = RANGE_PATTERN.fullmatch((self.headers.get("Range") or "").strip())
        if requested and content and (requested.group(1) or requested.group(2)):
            first, last = requested.group(1), requested.group(2)
            if first:
                start = int(first)
                end = min(int(last), len(content) - 1) if last else len(content) - 1
            else:
                start = max(len(content) - int(last), 0)
                end = len(content) - 1
            if start > end or start >= len(content):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(content)}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status, body = 206, content[start:end + 1]
            content_range = f"bytes {start}-{end}/{len(content)}"

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        if content_range:
            self.send_header("Content-Range", content_range)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), ShareHandler) as server:
        print(f"Serving public app files at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
