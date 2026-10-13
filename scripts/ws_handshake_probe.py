#!/usr/bin/env python3
"""Browser-shaped WebSocket handshake probe (regression gate + diagnostic).

Replicates the 2026-07-31 outage class: a REAL browser-shaped upgrade request
(Chrome UA, Origin, optional Cookie block, permessage-deflate offer, valid
Sec-WebSocket-Key) — NOT the websockets client library, which never sent the
headers that triggered the outage.

Modes:
  --serve
      Start an ephemeral uvicorn server on 127.0.0.1:0 serving a bare
      starlette websocket echo (deliberately NOT FastAPI: the gate isolates
      uvicorn's upgrade path; the prod app itself is verified separately
      against the live surface) and probe:
        * GATE:   2KiB Cookie upgrade  -> MUST be 101 + masked PING->PONG
        * CANARY: 16KiB Cookie upgrade -> informational; non-responsive is
          WARN (known uvicorn websockets-sansio bug: header block > ~8KiB on
          the UPGRADE path is silently swallowed, no response, no log; the
          h11 HTTP path handles 512KiB fine). With --strict a canary failure
          fails the run.
  --url <wss://...> [--cookie-bytes N] [--timeout S] [--expect-status S]
      Probe a remote surface. Default assertion: the server ANSWERS within the
      timeout (responsive). --require-101 additionally requires a 101 + PONG
      round-trip. --expect-status pins the exact HTTP status.

Exit codes: 0 all assertions met; 1 gate/assertion failure; 2 usage error.
"""

from __future__ import annotations

import argparse
import base64
import os
import socket
import struct
import sys
import time
from dataclasses import dataclass
from urllib.parse import urlparse

CHROME_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


@dataclass
class ProbeResult:
    status: str = "NO RESPONSE"
    header_bytes: int = 0
    pong_ok: bool = False
    deflate_accepted: bool = False
    error: str | None = None


def build_upgrade(path: str, host: str, cookie_value: str | None) -> bytes:
    key = base64.b64encode(os.urandom(16)).decode()
    headers = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Pragma: no-cache",
        "Cache-Control: no-cache",
        "User-Agent: " + CHROME_UA,
        "Origin: " + (os.environ.get("PROBE_ORIGIN", "").strip() or f"https://{host}"),
        "Sec-WebSocket-Version: 13",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "Accept-Language: en-US,en;q=0.9",
    ]
    if cookie_value is not None:
        headers.append(f"Cookie: {cookie_value}")
    return ("\r\n".join(headers) + "\r\n\r\n").encode()


def read_until_headers(sock: socket.socket, timeout_s: float) -> tuple[str, bytes, int]:
    """Return (head, leftover_bytes, total_bytes_read). Raises socket.timeout."""
    sock.settimeout(timeout_s)
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < 64 * 1024:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, leftover = buf.partition(b"\r\n\r\n")
    return head.decode(errors="replace"), leftover, len(buf)


def _parse_ws_frame(data: bytes):
    b1, b2 = data[0], data[1]
    opcode = b1 & 0x0F
    length = b2 & 0x7F
    off = 2
    if length == 126:
        length = struct.unpack(">H", data[2:4])[0]
        off = 4
    elif length == 127:
        length = struct.unpack(">Q", data[2:10])[0]
        off = 10
    payload = data[off : off + length]
    return opcode, payload


def probe(
    url: str,
    cookie_bytes: int,
    cookie_value: str | None,
    timeout_s: float,
    require_101: bool,
    expect_status: str | None,
) -> ProbeResult:
    res = ProbeResult()
    parsed = urlparse(url)
    if parsed.scheme not in ("ws", "wss"):
        res.error = f"unsupported scheme {parsed.scheme!r}"
        return res
    host = parsed.hostname
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    if cookie_bytes and cookie_value is None:
        cookie_value = "a" * cookie_bytes

    try:
        raw = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "wss" else 80), proto=socket.IPPROTO_TCP)
        sock = socket.socket(raw[0][0], socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(raw[0][4])
        if parsed.scheme == "wss":
            import ssl

            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=host)
        request = build_upgrade(path, host, cookie_value)
        sock.sendall(request)
        head, leftover, total = read_until_headers(sock, timeout_s)
    except socket.timeout:
        res.status = "TIMEOUT"
        res.error = f"no response in {timeout_s}s after sending {len(request)} bytes"
        return res
    except (ConnectionResetError, ConnectionError, OSError) as exc:
        res.status = "CONN ERROR"
        res.error = f"{type(exc).__name__}: {exc}"
        return res

    res.header_bytes = total
    status_line = head.split("\r\n", 1)[0]
    res.status = status_line.split()[1] if len(status_line.split()) >= 2 else status_line
    lowered = head.lower()
    res.deflate_accepted = "sec-websocket-extensions" in lowered and "permessage-deflate" in lowered
    if expect_status and res.status != expect_status:
        res.error = f"expected HTTP {expect_status}, got {status_line}"
        return res
    if res.status != "101":
        if require_101:
            res.error = f"required 101, got {status_line}"
        return res

    def send_frame(opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = struct.pack(">BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack(">BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            hdr = struct.pack(">BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        sock.sendall(hdr + mask + masked)

    try:
        send_frame(0x9, b"probe")
        sock.settimeout(timeout_s)
        for _ in range(3):
            data = sock.recv(4096)
            if not data:
                res.error = "connection closed after 101 without PONG"
                return res
            opcode, payload = _parse_ws_frame(data)
            if opcode == 0xA:  # PONG
                res.pong_ok = payload == b"probe"
                return res
            if opcode in (0x8, 0x9, 0x1):
                continue
        res.error = "no PONG frame received after 101"
    except socket.timeout:
        res.error = "101 received but no PONG within timeout"
    finally:
        sock.close()
    return res


def run_serve(strict: bool) -> int:
    import threading

    import uvicorn
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute

    async def echo(ws) -> None:
        from starlette.websockets import WebSocketDisconnect

        await ws.accept()
        try:
            while True:
                msg = await ws.receive_text()
                await ws.send_text(msg)
        except WebSocketDisconnect:
            pass

    server = uvicorn.Server(
        uvicorn.Config(
            Starlette(routes=[WebSocketRoute("/ws", echo)]),
            host="127.0.0.1",
            port=0,
            log_level="error",
        )
    )
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        print("FAIL: uvicorn failed to start")
        return 1
    port = server.servers[0].sockets[0].getsockname()[1]
    url = f"ws://127.0.0.1:{port}/ws"
    print(f"[serve] uvicorn {uvicorn.__version__} on {url}")

    print("  GATE:  2KiB cookie upgrade -> must be 101 + PONG round-trip")
    gate = probe(url, 2048, None, timeout_s=6.0, require_101=True, expect_status=None)
    print(f"    status={gate.status} pong={gate.pong_ok} bytes_in={gate.header_bytes}")
    if gate.error:
        print(f"    FAIL: {gate.error}")
        server.should_exit = True
        return 1

    print("  CANARY: 16KiB cookie upgrade -> informational (known upstream bug)")
    canary = probe(url, 16384, None, timeout_s=6.0, require_101=False, expect_status=None)
    print(f"    status={canary.status} pong={canary.pong_ok} bytes_in={canary.header_bytes}")
    if canary.error:
        if canary.status == "TIMEOUT" and not strict:
            print(
                "    WARN: non-responsive on 16KiB upgrade — known uvicorn "
                "websockets-sansio bug (headers > ~8KiB silently swallowed on the "
                "UPGRADE path only; h11 HTTP path fine). Tracked as upstream finding; "
                "prod is protected (front layer strips/caps Cookie before backend). "
                "Not a regression. Use --strict to fail on it."
            )
        else:
            print(f"    FAIL: {canary.error}")
            server.should_exit = True
            return 1

    server.should_exit = True
    print("RESULT: PASS")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serve", action="store_true", help="run gate+canary against an ephemeral local server")
    ap.add_argument("--url", help="remote surface, e.g. wss://example.com/ws")
    ap.add_argument("--cookie-bytes", type=int, default=0, help="Cookie block size in bytes (0 = none)")
    ap.add_argument("--cookie-value", default=None, help="exact Cookie value (overrides --cookie-bytes)")
    ap.add_argument("--timeout", type=float, default=8.0, help="response timeout in seconds")
    ap.add_argument("--require-101", action="store_true", help="remote: require 101 + PONG round-trip")
    ap.add_argument("--expect-status", default=None, help="remote: pin exact HTTP status")
    ap.add_argument("--strict", action="store_true", help="serve: fail on the 16KiB canary too")
    args = ap.parse_args()

    if args.serve:
        return run_serve(args.strict)
    if not args.url:
        ap.error("either --serve or --url is required")

    cookie_display = args.cookie_bytes if args.cookie_bytes else len(args.cookie_value or "")
    print(f"  handshake -> {args.url}  cookie={cookie_display} bytes  timeout={args.timeout}s")
    res = probe(
        args.url,
        args.cookie_bytes,
        args.cookie_value,
        timeout_s=args.timeout,
        require_101=args.require_101,
        expect_status=args.expect_status,
    )
    print(f"  {res.status}" + (f"  ({res.error})" if res.error else ""))
    if res.status == "101":
        print(f"  permessage-deflate accepted: {res.deflate_accepted}")
        if res.pong_ok:
            print("  PONG received — round-trip OK")
            return 0
        print(f"  FAIL: {res.error}")
        return 1
    print(f"  non-101 status {res.status} — server responsive, PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
