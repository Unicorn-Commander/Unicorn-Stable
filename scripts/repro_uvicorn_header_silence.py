#!/usr/bin/env python3
"""Reproduce uvicorn's >8KiB request-header silence in one shot.

Starts an in-process uvicorn server on a loopback port, then sends two raw
HTTP/1.1 requests that differ ONLY in Cookie header size (below/above the
8 KiB request-line+header budget), and reports whether each got a response.

Expected (the bug): the ~4 KiB cookie answers 200; the ~16 KiB cookie gets
NOTHING — no response, no RST, connection sits silent until the client
gives up. The socket is never reused, and uvicorn logs nothing at
error level (the h11 parser rejects the request before a response can be
built). A silent-hang handshake is exactly what a browser-shaped
WebSocket handshake with a bloated cookie block looks like from the app's
side — that was the outage signature (see scripts/ws_handshake_probe.py).

Usage:  python repro_uvicorn_header_silence.py   (pure stdlib)
"""
from __future__ import annotations

import socket
import threading
import time

import uvicorn


async def ok_app(scope, receive, send):
    assert scope["type"] == "http"
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/plain")],
    })
    await send({"type": "http.response.body", "body": b"ok"})


def request(cookie_bytes: int, timeout_s: float = 4.0) -> str:
    s = socket.create_connection(("127.0.0.1", 18000), timeout=timeout_s)
    s.settimeout(timeout_s)
    cookie = b"a" * cookie_bytes
    req = (
        b"GET / HTTP/1.1\r\n"
        b"Host: 127.0.0.1\r\n"
        b"Cookie: " + cookie + b"\r\n"
        b"\r\n"
    )
    s.sendall(req)
    try:
        data = s.recv(1024)
        if not data:
            return "NO RESPONSE (silent hang)"
        status = data.split(b"\r\n", 1)[0].decode(errors="replace")
        return status
    except socket.timeout:
        return "TIMEOUT (connection swallowed silently)"
    finally:
        s.close()


def main() -> None:
    config = uvicorn.Config(ok_app, host="127.0.0.1", port=18000, log_level="error")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    time.sleep(1.5)

    print("uvicorn", uvicorn.__version__)
    print("  4 KiB cookie  ->", request(4 * 1024))
    print(" 16 KiB cookie  ->", request(16 * 1024))
    print(
        "\nIf 16 KiB shows TIMEOUT/silent hang while 4 KiB answers 200, that is "
        "encode/uvicorn's oversized-request-line/header swallow."
    )
    server.should_exit = True
    t.join(timeout=3)


if __name__ == "__main__":
    main()
