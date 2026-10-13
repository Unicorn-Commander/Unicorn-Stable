#!/usr/bin/env python3
"""Derive a per-org Stable compose from the canonical base — no template drift.

The base ``docker-compose.yml`` is the single source of truth (it IS the
dogfood stack). Rather than maintain a parallel template that silently drifts,
we load the base and apply a small, documented set of per-org transforms:

  * prefix every container_name / network / volume with the org slug so N orgs
    coexist on one host;
  * rewrite the Traefik router NAMES + Host/HostSNI rules to the org's domains
    (router names are global in Traefik — they must be unique per org);
  * repoint the LiveKit media ports to the org's allocated block (the one hard
    multi-instance constraint — UDP 7882 cannot be shared);
  * keep every hardening default from the base (loopback binds, redis
    requirepass, internal-deny router, production env, org_id).

Usage: render_compose.py <base_compose> <out_compose> <slug> <domain> \
                         <livekit_domain> <turn_domain> <lk_api> <lk_tcp> <lk_udp>
"""
from __future__ import annotations

import os
import re
import sys

import yaml


def _split_mount(m):
    """Split ``host:container[:mode]`` without tripping on ``${VAR:-default}``.

    The base compose writes the rail mount as
    ``${STABLE_INSTANCES_FILE:-./web/public/instances.json}:/...:ro`` — a naive
    ``split(":")`` would cut inside the ``:-`` default and produce a garbage
    host path, so track ``${...}`` nesting and only split at depth 0.
    """
    depth = 0
    i = 0
    while i < len(m):
        if m.startswith("${", i):
            depth += 1
            i += 2
            continue
        ch = m[i]
        if ch == "}" and depth:
            depth -= 1
        elif ch == ":" and depth == 0:
            return m[:i], m[i + 1:]
        i += 1
    return m, ""


def _rewrite_web_mounts(svc, base_dir, out_dir):
    """Point the web service's host binds at paths that exist for THIS org.

    Two silent-failure modes are closed here:

    * the rendered compose lives in ``deploy/per-org/instances/<slug>/``, so a
      path written relative to the BASE compose (``./web/public/favicon.svg``)
      resolves against the ORG directory instead — Docker then creates an empty
      directory at the missing source and nginx serves nothing;
    * the base rail mount is an env-var default aimed at the dogfood stack.
      Left as-is, a per-org deploy either inherits dogfood's federation list or
      mounts nothing. Each org gets its OWN ``instances.json`` (seeded by
      provision-org.sh) so its rail is independently editable.
    """
    if not isinstance(svc, dict) or not isinstance(svc.get("volumes"), list):
        return
    fixed = []
    for m in svc["volumes"]:
        if not isinstance(m, str):
            fixed.append(m)
            continue
        host, rest = _split_mount(m)
        if rest.startswith("/usr/share/nginx/html/instances.json"):
            host = os.path.join(out_dir, "instances.json")
        elif host.startswith("./") or host.startswith("../"):
            host = os.path.normpath(os.path.join(base_dir, host))
        fixed.append(f"{host}:{rest}" if rest else host)
    svc["volumes"] = fixed


def _rewrite_labels(labels, slug, dom, lkdom, turndom, wsdom):
    """Rewrite Traefik router names + host rules in a service's label list.

    Traefik router/service/middleware NAMES are global (Traefik sees every
    container on the shared `web` network), so they must be unique per org or
    two instances collide. A single regex inserts ``-<slug>`` right after the
    ``stable`` token in every Traefik NAME position — both definitions
    (``routers.stable``, ``services.stable-livekit``, …) and the value
    references that wire them together (``service=stable``, ``middlewares=…``).
    It matches ``stable`` whether followed by ``.``/``-``/``=``/end, and runs
    once so it never double-prefixes.
    """
    name_ctx = re.compile(r"(routers\.|services\.|middlewares\.|service=|middlewares=)stable")
    out = []
    for lb in labels or []:
        s = str(lb)
        s = name_ctx.sub(rf"\1stable-{slug}", s)
        # Host rules → the org's domains. Select the target from the router
        # name, then replace only Host/HostSNI expressions. This keeps the
        # canonical compose free to choose its own example/default domains.
        host_domain = dom
        if re.search(r"routers\.stable-livekit(?:[-.]|=)", s):
            host_domain = lkdom
        elif re.search(r"routers\.stable-turn(?:[-.]|=)", s):
            host_domain = turndom
        elif re.search(r"routers\.stable-ws(?:[-.]|=)", s):
            host_domain = wsdom
        host_rule = re.compile(r"(HostSNI|Host)\(`[^`]*`\)")
        s = host_rule.sub(lambda match: f"{match.group(1)}(`{host_domain}`)", s)
        out.append(s)
    return out


def main() -> int:
    (base, out, slug, dom, lkdom, turndom, lk_api, lk_tcp, lk_udp) = sys.argv[1:10]
    # Optional 10th arg (older callers omit it): the org's websocket bypass
    # host. Default derives from the app domain the same way provision-org.sh
    # does, so a stale caller still renders a working (if unregistered) host.
    wsdom = sys.argv[10] if len(sys.argv) > 10 else f"{slug}-ws.{dom.split('.', 1)[1]}"
    with open(base) as f:
        c = yaml.safe_load(f)

    pfx = f"stable-{slug}"
    svcs = c.get("services", {})
    for name, svc in svcs.items():
        # container name
        if "container_name" in svc:
            svc["container_name"] = svc["container_name"].replace("stable-", f"{pfx}-", 1)
        # traefik labels
        if isinstance(svc.get("labels"), list):
            svc["labels"] = _rewrite_labels(svc["labels"], slug, dom, lkdom, turndom, wsdom)
        # networks: rename the private net; keep external `web`
        if isinstance(svc.get("networks"), list):
            svc["networks"] = [
                f"{pfx}-net" if n == "stable-net" else n for n in svc["networks"]
            ]
        # LiveKit media ports → allocated block (the only host-published ports
        # a per-org stack keeps; they're uniquely allocated so they don't clash).
        if name == "livekit":
            svc["ports"] = [
                f"{lk_api}:7880",
                f"{lk_tcp}:7881",
                f"{lk_udp}:7882/udp",
            ]
        elif "ports" in svc:
            # Drop host port publishes for postgres/redis/backend/web: on a
            # multi-org host the fixed loopback ports (5433/6381/8400/8401)
            # would collide between orgs, and none are needed — the app reaches
            # them over the per-org Docker network and Traefik serves the web +
            # api. Admin access is via `docker exec`.
            del svc["ports"]

    # networks block: rename private net, keep external web
    nets = c.get("networks", {})
    if "stable-net" in nets:
        nets[f"{pfx}-net"] = {"driver": "bridge", "name": f"{pfx}-network"}
        del nets["stable-net"]
    # web stays external

    # volumes: prefix names so they don't collide across orgs
    vols = c.get("volumes", {})
    newvols = {}
    for vname, vbody in vols.items():
        nb = dict(vbody or {})
        if "name" in nb:
            nb["name"] = nb["name"].replace("stable-", f"{pfx}-", 1)
        newvols[f"{pfx}-{vname}" if not vname.startswith(pfx) else vname] = nb
    # remap volume references inside services
    vol_remap = {old: (f"{pfx}-{old}") for old in vols}
    for svc in svcs.values():
        if isinstance(svc.get("volumes"), list):
            fixed = []
            for m in svc["volumes"]:
                for old, new in vol_remap.items():
                    if isinstance(m, str) and m.startswith(old + ":"):
                        m = new + m[len(old):]
                        break
                fixed.append(m)
            svc["volumes"] = fixed
    c["volumes"] = newvols

    # web host binds: absolutise repo assets + give this org its own rail list
    _rewrite_web_mounts(
        svcs.get("web"),
        os.path.dirname(os.path.abspath(base)),
        os.path.dirname(os.path.abspath(out)),
    )

    with open(out, "w") as f:
        yaml.safe_dump(c, f, sort_keys=False, default_flow_style=False)
    print(f"rendered per-org compose -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
