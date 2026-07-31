#!/usr/bin/env python3
"""Ladder-test uvicorn request-line/header size handling.

Evidence for the 2026-07-31 WS-outage follow-up (FLASH 2):

  * PLAIN HTTP path (h11): cookie headers to 512 KiB all answered 200;
    request-line paths <= 32 KiB answered 200, 64 KiB+ answered a clean
    400 Bad Request. The >8 KiB "silent swallow" does NOT reproduce here.
  * UPGRADE path (websockets-sansio): a browser-shaped WebSocket upgrade
    request with a cookie block > ~8 KiB is SILENTLY swallowed — no HTTP
    response, no log line, connection just dies. This is the outage class:
    the front layer (Cloudflare + origin nginx) currently caps/strips the
    Cookie block before the backend, so the public surface answers a clean
    400/101 — but the uvicorn upgrade-path limit itself is still present.
"""
from __future__ import annotations

import base64
import os
import socket
import threading
import time

import uvicorn
from fastapi import FastAPI, WebSocket

app = FastAPI()


@app.get("/")
async def ok():
    return {"ok": True}


@app.websocket("/ws")
async def echo(ws: WebSocket) -> None:
    await ws.accept()
    while True:
        msg = await ws.receive_text()
        await ws.send_text(msg)


def raw_request(req: bytes, timeout_s: float = 3.0) -> str:
    s = socket.create_connection(("127.0.0.1", 18001), timeout=timeout_s)
    s.settimeout(timeout_s)
    s.sendall(req)
    try:
        data = s.recv(1024)
        if not data:
            return "NO RESPONSE"
        return data.split(b"\r\n", 1)[0].decode(errors="replace")
    except socket.timeout:
        return "TIMEOUT"
    except ConnectionResetError:
        return "RST"
    finally:
        s.close()


def main() -> None:
    config = uvicorn.Config(app, host="127.0.0.1", port=18001, log_level="error")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    time.sleep(1.5)
    print("uvicorn", uvicorn.__version__)

    print("\n-- Cookie ladder (header size) --")
    for kb in (4, 8, 16, 32, 64, 128, 256, 512):
        cookie = b"a" * (kb * 1024)
        req = b"GET / HTTP/1.1\r\nHost: x\r\nCookie: " + cookie + b"\r\n\r\n"
        print(f"  {kb:4d} KiB cookie -> {raw_request(req)}")

    print("\n-- Request-line (path) ladder --")
    for kb in (4, 8, 16, 32, 64, 128):
        path = b"/" + b"a" * (kb * 1024)
        req = b"GET " + path + b" HTTP/1.1\r\nHost: x\r\n\r\n"
        print(f"  {kb:4d} KiB path   -> {raw_request(req)}")

    print("\n-- WS upgrade ladder (cookie block, browser-shaped handshake) --")
    for kb in (2, 4, 8, 16, 32):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n".encode()
            + b"Cookie: " + b"a" * (kb * 1024) + b"\r\n\r\n"
        )
        print(f"  {kb:4d} KiB cookie -> {raw_request(req)}")

    server.should_exit = True
    t.join(timeout=3)


if __name__ == "__main__":
    main()
