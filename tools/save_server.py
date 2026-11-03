"""Tiny local endpoint that lets the browser save recorded videos into ./output.

Run:  python -I tools/save_server.py      then POST a body to http://localhost:8766/save?name=file.mp4
"""
import os, re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output")
os.makedirs(OUT, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        q = parse_qs(urlparse(self.path).query)
        name = re.sub(r"[^A-Za-z0-9._-]", "_", q.get("name", ["video.webm"])[0])
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(body)
        self.send_response(200); self.cors(); self.end_headers()
        self.wfile.write(f"saved {name} ({len(body)} bytes)".encode())


if __name__ == "__main__":
    print("saving to", OUT)
    HTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
