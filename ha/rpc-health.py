#!/usr/bin/env python3
"""Health of the Besu RPC nodes behind the RPC VIP, for HAProxy (ha/README.md).

eth_syncing alone is not enough: a node that stopped importing blocks (lost its peers, stuck
import) still answers "false" and keeps the VIP while serving an old chain. This service checks
every RPC node every CHECK_SECONDS and answers HAProxy on one local port per node:

  200  the node is current: within MAX_BEHIND blocks of the best head seen (the RPC nodes and the
       local validator), and its newest block is younger than MAX_AGE seconds unless no node has
       a newer block (the whole chain is halted: then serving it is still right)
  503  unreachable, syncing, behind, or stalled

If no node passes, the most up-to-date reachable one is reported healthy anyway (degraded), so the
VIP keeps answering instead of failing every request.

A local RPC node (on this host) that stays stalled for RESTART_MINUTES while the chain moves on is
restarted with `docker restart` (at most once per RESTART_MINUTES; 0 = never). RPC nodes hold no
keys, so this is safe.

Configuration: /etc/besu-rpc-health.env (written by ansible/07-ha.yml):
  RPC_NODES="rpc1=http://192.168.68.135:8555=8411=besu-rpc1-besu-1 rpc2=...=8412=..."
  (name=url=local port=container; the container is restarted only for nodes on this host)
  LOCAL_NODES="rpc1"            RPC nodes running on this host
  HEAD_REFERENCE="http://127.0.0.1:8645"   local validator (optional)
  HOST_HEADER="192.168.68.150"  MAX_AGE=30  MAX_BEHIND=10  CHECK_SECONDS=2  RESTART_MINUTES=5
Status of all nodes as JSON: GET http://127.0.0.1:8410/
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENV = os.environ
NODES = []
for spec in ENV.get("RPC_NODES", "").split():
    name, url, port, container = spec.split("=")
    NODES.append({"name": name, "url": url, "port": int(port), "container": container})
LOCAL = set(ENV.get("LOCAL_NODES", "").split())
REFERENCE = ENV.get("HEAD_REFERENCE", "").strip()
HOST = ENV.get("HOST_HEADER", "").strip()
MAX_AGE = float(ENV.get("MAX_AGE", "30"))
MAX_BEHIND = int(ENV.get("MAX_BEHIND", "10"))
CHECK_SECONDS = float(ENV.get("CHECK_SECONDS", "2"))
RESTART_MINUTES = float(ENV.get("RESTART_MINUTES", "5"))
STATUS_PORT = int(ENV.get("STATUS_PORT", "8410"))

state = {n["name"]: {"healthy": False, "reason": "not checked yet"} for n in NODES}
stalled_since = {}
last_restart = {}
lock = threading.Lock()


def log(message):
    print(message, flush=True)


def rpc(url, method, params=None, host=HOST):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    headers = {"Content-Type": "application/json"}
    if host:
        headers["Host"] = host
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=1.5) as response:
        answer = json.loads(response.read())
    if "error" in answer:
        raise RuntimeError(answer["error"].get("message", "error"))
    return answer["result"]


def probe(url, host=HOST):
    """(height, block timestamp, syncing, peers) or an exception"""
    block = rpc(url, "eth_getBlockByNumber", ["latest", False], host)
    syncing = rpc(url, "eth_syncing", None, host) is not False
    try:
        peers = int(rpc(url, "net_peerCount", None, host), 16)
    except Exception:  # net API not enabled
        peers = None
    return int(block["number"], 16), int(block["timestamp"], 16), syncing, peers


def check_once():
    now = time.time()
    seen = {}
    for node in NODES:
        try:
            seen[node["name"]] = probe(node["url"])
        except Exception as error:  # unreachable or a bad answer
            seen[node["name"]] = error
    heights = [v[0] for v in seen.values() if not isinstance(v, Exception)]
    newest = [v[1] for v in seen.values() if not isinstance(v, Exception)]
    if REFERENCE:
        try:
            height, stamp, _, _ = probe(REFERENCE, None)  # the local validator: its own Host
            heights.append(height)
            newest.append(stamp)
        except Exception:
            pass
    head = max(heights) if heights else None
    head_time = max(newest) if newest else None

    result = {}
    for node in NODES:
        value = seen[node["name"]]
        if isinstance(value, Exception):
            result[node["name"]] = {"healthy": False, "reason": "unreachable: %s" % value}
            continue
        height, stamp, syncing, peers = value
        age = now - stamp
        behind = head - height
        info = {"height": height, "age": round(age, 1), "behind": behind, "peers": peers, "syncing": syncing}
        if syncing:
            info.update(healthy=False, reason="syncing")
        elif behind > MAX_BEHIND:
            info.update(healthy=False, reason="%d blocks behind" % behind)
        elif age > MAX_AGE and stamp < head_time:
            info.update(healthy=False, reason="stalled: newest block %.0fs old, others are newer" % age)
        else:
            info.update(healthy=True, reason="ok")
        result[node["name"]] = info

    if NODES and not any(v["healthy"] for v in result.values()):
        reachable = [(v["height"], name) for name, v in result.items() if "height" in v]
        if reachable:
            best = max(reachable)[1]
            result[best]["healthy"] = True
            result[best]["reason"] = "degraded: no node is current, serving the most up-to-date one"

    # restart a local RPC node that stays stalled while the chain moves on
    for node in NODES:
        name = node["name"]
        info = result[name]
        moving = head_time is not None and now - head_time < MAX_AGE
        stuck = "height" in info and (info["behind"] > MAX_BEHIND or info["reason"].startswith("stalled")) and moving
        if not stuck:
            stalled_since.pop(name, None)
            continue
        stalled_since.setdefault(name, now)
        if (name in LOCAL and RESTART_MINUTES > 0 and now - stalled_since[name] >= RESTART_MINUTES * 60
                and now - last_restart.get(name, 0) >= RESTART_MINUTES * 60):
            log("%s: stalled for %.0f min (%s), restarting %s" % (name, (now - stalled_since[name]) / 60, info["reason"], node["container"]))
            last_restart[name] = now
            stalled_since.pop(name, None)
            subprocess.run(["docker", "restart", node["container"]], check=False, timeout=180)

    with lock:
        for name, info in result.items():
            before = state.get(name, {})
            if before.get("healthy") != info["healthy"]:
                log("%s: %s (%s)" % (name, "healthy" if info["healthy"] else "UNHEALTHY", info["reason"]))
            state[name] = info


def loop():
    while True:
        try:
            check_once()
        except Exception as error:
            log("check failed: %s" % error)
        time.sleep(CHECK_SECONDS)


def handler_for(name):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            with lock:
                if name is None:
                    code, body = 200, json.dumps(state, indent=1)
                else:
                    info = state.get(name, {})
                    code, body = (200 if info.get("healthy") else 503), json.dumps(info)
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    return Handler


def main():
    if not NODES:
        sys.exit("RPC_NODES is empty")
    threading.Thread(target=loop, daemon=True).start()
    servers = [ThreadingHTTPServer(("127.0.0.1", n["port"]), handler_for(n["name"])) for n in NODES]
    servers.append(ThreadingHTTPServer(("127.0.0.1", STATUS_PORT), handler_for(None)))
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    log("checking %s every %ss (max age %ss, max behind %d, restart after %s min)" % (
        ", ".join(n["name"] for n in NODES), CHECK_SECONDS, MAX_AGE, MAX_BEHIND, RESTART_MINUTES))
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
