#!/usr/bin/env python3
"""Derive a per-org Stable compose from the canonical base.

The base docker-compose.yml is the source of service configuration. The
per-org renderer applies the isolation and deployment transforms that cannot be
represented by the dogfood compose itself: unique container/network/volume
names, org-specific edge hosts and media ports, and instance-local paths.

Usage: render_compose.py <base_compose> <out_compose> <slug> <domain> \
                         <livekit_domain> <turn_domain> <lk_api> <lk_tcp> <lk_udp> \
                         [ws_domain] [--allow-existing]
"""
from __future__ import annotations

import copy
import difflib
import ipaddress
import os
import re
import sys
import zlib
from pathlib import Path

import yaml


_HOST_RULE_RE = re.compile(r"(HostSNI|Host)\([^)]*\)")


def _split_mount(m: str) -> tuple[str, str]:
    """Split host:container[:mode] without cutting inside variable syntax."""
    depth = 0
    i = 0
    while i < len(m):
        if m.startswith("$" + "{", i):
            depth += 1
            i += 2
            continue
        ch = m[i]
        if ch == "}" and depth:
            depth -= 1
        elif ch == ":" and depth == 0:
            return m[:i], m[i + 1 :]
        i += 1
    return m, ""


def _prefix_container_name(name: object, prefix: str) -> object:
    if isinstance(name, str) and name.startswith("stable-"):
        return f"{prefix}-{name[len('stable-') :]}"
    return name


def _rewrite_environment(environment: object, dns_names: dict[str, str]) -> object:
    """Rewrite only exact Stable container names in environment values."""
    if isinstance(environment, dict):
        return {
            key: _rewrite_dns_value(value, dns_names)
            for key, value in environment.items()
        }
    if not isinstance(environment, list):
        return environment

    rewritten = []
    for item in environment:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            rewritten.append(f"{key}={_rewrite_dns_value(value, dns_names)}")
        else:
            rewritten.append(item)
    return rewritten


def _rewrite_dns_value(value: object, dns_names: dict[str, str]) -> object:
    if not isinstance(value, str):
        return value
    for source, target in sorted(dns_names.items(), key=lambda item: -len(item[0])):
        value = re.sub(
            rf"(?<![A-Za-z0-9_-]){re.escape(source)}(?![A-Za-z0-9_-])",
            target,
            value,
        )
    return value


def _router_domain(label: str, dom: str, lkdom: str, turndom: str, wsdom: str) -> str:
    """Choose a router's host before its name is prefixed."""
    if re.search(r"routers\.stable-livekit(?:[-.=]|$)", label):
        return lkdom
    if re.search(r"routers\.stable-turn(?:[-.=]|$)", label):
        return turndom
    if re.search(r"routers\.stable-ws(?:[-.=]|$)", label):
        return wsdom
    return dom


def _rewrite_labels(
    labels: object,
    slug: str,
    dom: str,
    lkdom: str,
    turndom: str,
    wsdom: str,
) -> object:
    """Prefix Traefik names and rewrite each router's host expression."""
    if not isinstance(labels, list):
        return labels

    name_ctx = re.compile(
        rf"(routers\.|services\.|middlewares\.|service=|middlewares=)"
        rf"stable(?!-{re.escape(slug)}(?:[-.=]|$))"
    )
    out = []
    for label in labels:
        original = str(label)
        host_domain = _router_domain(original, dom, lkdom, turndom, wsdom)
        rewritten = name_ctx.sub(rf"\1stable-{slug}", original)
        rewritten = _HOST_RULE_RE.sub(
            lambda match: f"{match.group(1)}({chr(96)}{host_domain}{chr(96)})",
            rewritten,
        )
        out.append(rewritten)
    return out


def _volume_name_from_existing(
    existing: dict | None, prefix: str, base_name: str
) -> str | None:
    if not isinstance(existing, dict):
        return None
    volumes = existing.get("volumes", {})
    if not isinstance(volumes, dict):
        return None
    candidates = {base_name, f"{prefix}-{base_name}"}
    for key, body in volumes.items():
        if str(key) in candidates or str(key).endswith(f"-{base_name}"):
            if isinstance(body, dict) and body.get("name"):
                return str(body["name"])
            return str(key)
    return None


def _rewrite_named_mounts(mounts: object, volume_remap: dict[str, str]) -> object:
    if not isinstance(mounts, list):
        return mounts
    rewritten = []
    for mount in mounts:
        if not isinstance(mount, str):
            rewritten.append(mount)
            continue
        source, rest = _split_mount(mount)
        replacement = volume_remap.get(source)
        if replacement:
            mount = f"{replacement}:{rest}" if rest else replacement
        rewritten.append(mount)
    return rewritten


def _default_ipam(slug: str) -> dict:
    configured = os.environ.get("STABLE_NETWORK_SUBNET", "").strip()
    if configured:
        network = ipaddress.ip_network(configured, strict=False)
    else:
        # Flagship is the captured live stack's 10.202.0.0/24 network. Other
        # slugs get a deterministic slot so a fresh org does not silently
        # reuse flagship's bridge subnet.
        slot = 0 if slug == "flagship" else (zlib.crc32(slug.encode()) % 254) + 1
        network = ipaddress.ip_network(f"10.202.{slot}.0/24")
    gateway = network.network_address + 1
    return {
        "config": [{"subnet": str(network), "gateway": str(gateway)}],
    }


def _existing_private_network(existing: dict | None, prefix: str) -> dict | None:
    if not isinstance(existing, dict):
        return None
    networks = existing.get("networks", {})
    if not isinstance(networks, dict):
        return None
    expected_key = f"{prefix}-net"
    expected_name = f"{prefix}-network"
    for key, body in networks.items():
        if not isinstance(body, dict):
            continue
        if str(key) == expected_key or body.get("name") == expected_name:
            return body
    return None


def _egress_enabled(existing: dict | None) -> bool:
    if isinstance(existing, dict):
        services = existing.get("services", {})
        if isinstance(services, dict) and "egress" in services:
            return True
    return os.environ.get("STABLE_EGRESS_ENABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _normalize_service_volumes(
    svcs: dict,
    volume_keys: dict[str, str],
    base_dir: str,
    out_dir: str,
    include_egress: bool,
) -> None:
    """Keep only paths that exist beside a generated per-org compose."""
    org_volumes = {
        "livekit": ["./livekit.yaml:/etc/livekit.yaml:ro"],
        "postgres": [
            f"{volume_keys['postgres_data']}:/var/lib/postgresql/data",
            f"{os.path.join(base_dir, 'server/init-db.sql')}:/docker-entrypoint-initdb.d/01-init.sql:ro",
        ],
        "redis": [f"{volume_keys['redis_data']}:/data"],
        "backend": [
            f"{volume_keys['backend_uploads']}:/home/stable/server/uploads",
        ],
        # The agent image is shipped pre-built; mounting the source tree would
        # turn a release deployment back into a mutable development container.
        "agent-runtime": [],
        "web": [
            f"{os.path.join(base_dir, 'web/public/favicon.svg')}:/usr/share/nginx/html/favicon.svg:ro",
            f"{os.path.join(out_dir, 'instances.json')}:/usr/share/nginx/html/instances.json:ro",
        ],
    }
    if include_egress:
        org_volumes["backend"].append(f"{volume_keys['egress_out']}:/egress-out")
        org_volumes["egress"] = [
            "./egress.yaml:/etc/egress.yaml:ro",
            f"{volume_keys['egress_out']}:/egress-out",
        ]

    # The explicit service maps above replace all known service mounts. Keep
    # this fallback for future named volumes added to the base.
    for name, service in svcs.items():
        if name in org_volumes:
            service["volumes"] = list(org_volumes[name])
        elif isinstance(service, dict) and "volumes" in service:
            service["volumes"] = _rewrite_named_mounts(
                service["volumes"], volume_keys
            )


def _parse_args(argv: list[str]) -> tuple[list[str], bool]:
    allow_existing = False
    positional = []
    for arg in argv:
        if arg == "--allow-existing":
            allow_existing = True
        elif arg.startswith("--"):
            raise ValueError(f"unknown option: {arg}")
        else:
            positional.append(arg)
    if len(positional) not in (9, 10):
        raise ValueError("expected 9 required arguments and an optional ws domain")
    return positional, allow_existing


def _sorted_yaml(value: dict) -> str:
    return yaml.safe_dump(value, sort_keys=True, default_flow_style=False)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        positional, allow_existing = _parse_args(argv)
    except ValueError as exc:
        print(
            "usage: render_compose.py <base> <out> <slug> <domain> "
            "<livekit_domain> <turn_domain> <lk_api> <lk_tcp> <lk_udp> "
            "[ws_domain] [--allow-existing]",
            file=sys.stderr,
        )
        print(f"error: {exc}", file=sys.stderr)
        return 2

    base, out, slug, dom, lkdom, turndom, lk_api, lk_tcp, lk_udp = positional[:9]
    wsdom = (
        positional[9]
        if len(positional) == 10
        else f"{slug}-ws.{dom.partition('.')[2] or dom}"
    )

    out_path = Path(out)
    existing: dict | None = None
    candidate = False
    if out_path.exists():
        if not allow_existing:
            print(
                f"refusing to overwrite existing compose: {out_path}; "
                "pass --allow-existing to write a candidate and see the diff",
                file=sys.stderr,
            )
            return 2
        candidate_path = out_path.with_name(f"{out_path.name}.candidate")
        if candidate_path.exists():
            print(
                f"refusing to overwrite existing candidate: {candidate_path}; "
                "review or remove it first",
                file=sys.stderr,
            )
            return 2
        with out_path.open() as handle:
            existing = yaml.safe_load(handle) or {}
        destination = candidate_path
        candidate = True
    else:
        destination = out_path

    with Path(base).open() as handle:
        compose = yaml.safe_load(handle) or {}

    prefix = f"stable-{slug}"
    svcs = compose.setdefault("services", {})
    include_egress = _egress_enabled(existing)
    if not include_egress:
        svcs.pop("egress", None)

    base_container_names = {}
    for service in svcs.values():
        if not isinstance(service, dict):
            continue
        container_name = service.get("container_name")
        if isinstance(container_name, str) and container_name.startswith("stable-"):
            base_container_names[container_name] = str(
                _prefix_container_name(container_name, prefix)
            )

    for name, service in svcs.items():
        if not isinstance(service, dict):
            continue
        if "container_name" in service:
            service["container_name"] = _prefix_container_name(
                service["container_name"], prefix
            )
        if "build" in service:
            service.pop("build")
            service.setdefault("image", f"unicorn-stable-{name}:latest")
        if "labels" in service:
            service["labels"] = _rewrite_labels(
                service["labels"], slug, dom, lkdom, turndom, wsdom
            )
        if "environment" in service:
            service["environment"] = _rewrite_environment(
                service["environment"], base_container_names
            )
        if isinstance(service.get("networks"), list):
            service["networks"] = [
                f"{prefix}-net" if network == "stable-net" else network
                for network in service["networks"]
            ]
        if name == "livekit":
            service["ports"] = [
                f"{lk_api}:7880",
                f"{lk_tcp}:7881",
                f"{lk_udp}:7882/udp",
            ]
        elif "ports" in service:
            del service["ports"]

    base_dir = os.path.dirname(os.path.abspath(base))
    out_dir = os.path.dirname(os.path.abspath(destination))

    base_volumes = compose.get("volumes", {})
    if not isinstance(base_volumes, dict):
        base_volumes = {}
    retained_volume_names = [
        name for name in base_volumes if include_egress or name != "egress_out"
    ]
    volume_keys: dict[str, str] = {}
    new_volumes: dict[str, dict] = {}
    for base_name in retained_volume_names:
        output_name = f"{prefix}-{base_name}"
        volume_keys[base_name] = output_name
        body = copy.deepcopy(base_volumes.get(base_name) or {})
        existing_name = _volume_name_from_existing(existing, prefix, base_name)
        body["name"] = existing_name or output_name
        new_volumes[output_name] = body
    compose["volumes"] = new_volumes

    _normalize_service_volumes(
        svcs,
        volume_keys,
        base_dir,
        out_dir,
        include_egress,
    )

    networks = compose.get("networks", {})
    if not isinstance(networks, dict):
        networks = {}
    base_private_network = copy.deepcopy(networks.get("stable-net") or {})
    existing_private_network = _existing_private_network(existing, prefix) or {}
    private_network = copy.deepcopy(base_private_network)
    if existing_private_network.get("name"):
        private_network["name"] = existing_private_network["name"]
    else:
        private_network["name"] = f"{prefix}-network"
    private_network["ipam"] = copy.deepcopy(
        existing_private_network.get("ipam")
        or base_private_network.get("ipam")
        or _default_ipam(slug)
    )

    new_networks = {}
    for name, body in networks.items():
        if name == "stable-net":
            new_networks[f"{prefix}-net"] = private_network
        else:
            new_networks[name] = body
    if "stable-net" not in networks:
        new_networks[f"{prefix}-net"] = private_network
    compose["networks"] = new_networks

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        yaml.safe_dump(compose, sort_keys=False, default_flow_style=False)
    )

    if candidate:
        old_text = _sorted_yaml(existing or {})
        new_text = _sorted_yaml(compose)
        diff = "".join(
            difflib.unified_diff(
                old_text.splitlines(keepends=True),
                new_text.splitlines(keepends=True),
                fromfile=str(out_path),
                tofile=str(destination),
            )
        )
        print(f"existing compose preserved: {out_path}")
        print(f"rendered candidate compose: {destination}")
        print(diff or "(no compose diff)", end="" if diff.endswith("\n") else "\n")
    else:
        print(f"rendered per-org compose -> {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
