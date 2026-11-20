# Generates monitoring/grafana/dashboards/proxy-redis.json:
#   python3 monitoring/grafana/tools/gen_proxy_dashboard.py monitoring/grafana/dashboards/proxy-redis.json
# The ACTIVE proxy and its Redis (jobs "proxy" and "redis", both scraped through the proxy VIP).
import json, sys

DS = {"type": "prometheus", "uid": "prometheus"}
panels = []
pid = [0]
SLOW = '/createaccount|/admin/.*'  # slow by design (MPC key generation): kept out of the overall latency


def nid():
    pid[0] += 1
    return pid[0]


def row(title, y):
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})


def target(expr, legend="", instant=False, fmt=None, ref="A"):
    t = {"refId": ref, "expr": expr, "legendFormat": legend, "datasource": DS}
    if instant:
        t["instant"] = True
        t["range"] = False
    if fmt:
        t["format"] = fmt
    return t


def stat(title, expr, x, y, w=4, unit="none", steps=None, decimals=None, desc="", mappings=None, color_mode="background"):
    panels.append({
        "type": "stat", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": 5},
        "targets": [target(expr, instant=True)],
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": color_mode,
                    "graphMode": "none", "textMode": "auto", "justifyMode": "center"},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "thresholds"},
                                     "thresholds": {"mode": "absolute", "steps": steps or [{"color": "green", "value": None}]},
                                     "mappings": mappings or []}, "overrides": []}})


def timeseries(title, targets, x, y, w=12, h=8, unit="none", desc="", stack=False, decimals=None, overrides=None):
    panels.append({
        "type": "timeseries", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
        "options": {"legend": {"displayMode": "table", "placement": "right", "calcs": ["lastNotNull", "max"]},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals,
                                     "custom": {"drawStyle": "line", "lineWidth": 2, "fillOpacity": 25 if stack else 8, "showPoints": "never",
                                                "stacking": {"mode": "normal" if stack else "none"}},
                                     "color": {"mode": "palette-classic"}},
                        "overrides": overrides or []}})


def table(title, targets, x, y, w, h, renames, units, desc=""):
    panels.append({
        "type": "table", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
        "transformations": [{"id": "merge", "options": {}},
                            {"id": "organize", "options": {"excludeByName": {"Time": True}, "renameByName": renames}}],
        "options": {"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "Requests", "desc": True}]},
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}},
                        "overrides": [{"matcher": {"id": "byName", "options": name},
                                       "properties": [{"id": "unit", "value": unit}, {"id": "decimals", "value": 2 if unit != "short" else 0}]}
                                      for name, unit in units.items()]}})


UPDOWN = [{"type": "value", "options": {"0": {"text": "DOWN", "color": "red"}, "1": {"text": "UP", "color": "green"}}}]
CONNECTED = [{"type": "value", "options": {"0": {"text": "NO REDIS", "color": "orange"}, "1": {"text": "CONNECTED", "color": "green"}}}]
RATE = "$__rate_interval"
# commands redis-exporter itself sends every scrape: left out so the charts show the proxy's traffic
EXPORTER_CMDS = 'cmd!~"info|config.*|client.*|latency.*|slowlog.*|hello|memory.*|select|ping|dbsize|keys|cluster.*|module.*|command.*|scan|type|strlen|pfcount|xinfo.*|ttl|llen|scard|zcard|hlen|lastsave"'

y = 0

# ---- Overview
row("Proxy (the active one, through the proxy VIP)", y); y += 1
stat("Proxy", 'max(up{job="proxy"}) or vector(0)', 0, y, w=3, mappings=UPDOWN,
     steps=[{"color": "red", "value": None}, {"color": "green", "value": 1}], desc="Prometheus reaches the proxy through the proxy VIP")
stat("Requests / s", f'sum(rate(proxy_http_requests_total[{RATE}])) or vector(0)', 3, y, w=4, unit="reqps", decimals=2, color_mode="value")
stat("5xx errors", f'(sum(rate(proxy_http_requests_total{{code=~"5.."}}[{RATE}])) or vector(0)) / clamp_min(sum(rate(proxy_http_requests_total[{RATE}])), 1e-9)',
     7, y, w=4, unit="percentunit", decimals=1,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 0.01}, {"color": "red", "value": 0.05}],
     desc="Share of answers with status 5xx (the proxy failed). 4xx are the caller's mistakes and are not counted here")
stat("Latency p95", f'histogram_quantile(0.95, sum by (le) (rate(proxy_http_request_duration_seconds_bucket{{route!~"{SLOW}"}}[{RATE}])))',
     11, y, w=4, unit="s", decimals=2,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 2}, {"color": "red", "value": 5}],
     desc="95th percentile answer time, without /createaccount and /admin (MPC key generation is slow by design)")
stat("In flight", 'max(proxy_http_in_flight) or vector(0)', 15, y, w=3, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 50}, {"color": "red", "value": 200}], desc="Requests being answered now")
stat("Redis link", 'max(proxy_redis_up)', 18, y, w=3, mappings=CONNECTED,
     steps=[{"color": "orange", "value": None}, {"color": "green", "value": 1}],
     desc="The proxy's connection to its Redis (nonce cache). Without it the proxy continues with memory + chain")
stat("Uptime", 'time() - max(proxy_process_start_time_seconds)', 21, y, w=3, unit="s", decimals=0, color_mode="value",
     desc="Since the proxy started: a reset means a restart or a failover to the other host")
y += 5

# ---- Requests
row("Requests", y); y += 1
timeseries("Requests per second by route", [target(f'sum by (route) (rate(proxy_http_requests_total[{RATE}]))', "{{route}}")],
           0, y, unit="reqps", stack=True, decimals=2, desc="Route patterns (e.g. /nft/:tokenId), all methods and status codes")
timeseries("Errors per second (4xx and 5xx)", [
    target(f'sum by (route, code) (rate(proxy_http_requests_total{{code=~"5..|aborted"}}[{RATE}]))', "{{route}} {{code}}"),
    target(f'sum by (route, code) (rate(proxy_http_requests_total{{code=~"4.."}}[{RATE}]))', "{{route}} {{code}}", ref="B")],
    12, y, unit="reqps", decimals=3,
    desc="5xx: the proxy failed. 4xx: refused (bad input, wrong key, not allowed). aborted: the client hung up before the answer")
y += 8
timeseries("Answer time (all routes except /createaccount and /admin)", [
    target(f'histogram_quantile(0.5, sum by (le) (rate(proxy_http_request_duration_seconds_bucket{{route!~"{SLOW}"}}[{RATE}])))', "p50"),
    target(f'histogram_quantile(0.95, sum by (le) (rate(proxy_http_request_duration_seconds_bucket{{route!~"{SLOW}"}}[{RATE}])))', "p95", ref="B"),
    target(f'histogram_quantile(0.99, sum by (le) (rate(proxy_http_request_duration_seconds_bucket{{route!~"{SLOW}"}}[{RATE}])))', "p99", ref="C")],
    0, y, unit="s", decimals=2)
timeseries("95th percentile by route", [
    target(f'histogram_quantile(0.95, sum by (route, le) (rate(proxy_http_request_duration_seconds_bucket[{RATE}])))', "{{route}}")],
    12, y, unit="s", decimals=2, desc="Includes /createaccount and /admin routes (MPC key generation)")
y += 8
table("Routes in the selected time range", [
    target('sum by (route) (increase(proxy_http_requests_total[$__range]))', instant=True, fmt="table"),
    target('sum by (route) (increase(proxy_http_requests_total{code=~"5..|aborted"}[$__range]))', instant=True, fmt="table", ref="B"),
    target('sum by (route) (increase(proxy_http_requests_total{code=~"4.."}[$__range]))', instant=True, fmt="table", ref="C"),
    target('histogram_quantile(0.95, sum by (route, le) (increase(proxy_http_request_duration_seconds_bucket[$__range])))', instant=True, fmt="table", ref="D"),
    target('sum by (route) (increase(proxy_http_request_duration_seconds_sum[$__range])) / sum by (route) (increase(proxy_http_request_duration_seconds_count[$__range]))',
           instant=True, fmt="table", ref="E")],
    0, y, 24, 9, {"route": "Route", "Value #A": "Requests", "Value #B": "5xx + aborted", "Value #C": "4xx", "Value #D": "p95", "Value #E": "Average"},
    {"Requests": "short", "5xx + aborted": "short", "4xx": "short", "p95": "s", "Average": "s"},
    desc="Per route over the dashboard's time range (counts are estimates from Prometheus increase())")
y += 9

# ---- Senders (nonces)
row("Senders and nonces", y); y += 1
timeseries("Transactions in flight per sender", [target('proxy_sender_inflight_transactions', "{{sender}}")], 0, y, w=8, decimals=0,
           desc="Sent by the proxy, not yet mined")
timeseries("Nonce gaps (seconds missing)", [target('proxy_sender_gap_seconds', "{{sender}}")], 8, y, w=8, unit="s",
           desc="How long a nonce has been missing; later transactions wait (alert ProxyNonceGap above 120 s)")
timeseries("Stalls and repairs", [
    target(f'sum by (sender) (increase(proxy_sender_stalls_total[{RATE}]))', "stall {{sender}}"),
    target(f'sum by (sender) (increase(proxy_sender_nonce_repairs_total[{RATE}]))', "repair {{sender}}", ref="B")],
    16, y, w=8, decimals=0, desc="Ready transactions not mined (stalls) and nonce gaps the proxy repaired")
y += 8

# ---- Process
row("Proxy process", y); y += 1
timeseries("Memory", [target('proxy_process_resident_memory_bytes', "resident"), target('proxy_process_heap_used_bytes', "heap used", ref="B")],
           0, y, w=8, unit="bytes")
timeseries("Event-loop delay", [target('proxy_event_loop_lag_p99_seconds', "p99"), target('proxy_event_loop_lag_max_seconds', "max", ref="B")],
           8, y, w=8, unit="s", decimals=3,
           desc="Time a ready callback waited for the single Node.js thread. Above ~0.1 s every request is delayed (alert above 1 s)")
timeseries("Requests in flight", [target('proxy_http_in_flight', "in flight")], 16, y, w=8, decimals=0)
y += 8

# ---- Redis
row("Redis (the active proxy's nonce cache)", y); y += 1
stat("Redis", '(max(redis_up{job="redis"}) or vector(0)) * (max(up{job="redis"}) or vector(0))', 0, y, w=3, mappings=UPDOWN,
     steps=[{"color": "red", "value": None}, {"color": "green", "value": 1}])
stat("Clients", 'max(redis_connected_clients{job="redis"})', 3, y, w=3, decimals=0, color_mode="value")
stat("Memory used", 'max(redis_memory_used_bytes{job="redis"})', 6, y, w=4, unit="bytes", color_mode="value")
stat("Keys", 'sum(redis_db_keys{job="redis"})', 10, y, w=3, decimals=0, color_mode="value")
stat("Hit ratio", f'sum(rate(redis_keyspace_hits_total{{job="redis"}}[{RATE}])) / clamp_min(sum(rate(redis_keyspace_hits_total{{job="redis"}}[{RATE}])) + sum(rate(redis_keyspace_misses_total{{job="redis"}}[{RATE}])), 1e-9)',
     13, y, w=4, unit="percentunit", decimals=1, color_mode="value", desc="Reads that found their key (nonces, pending transactions)")
stat("Last save", 'time() - max(redis_rdb_last_save_timestamp_seconds{job="redis"})', 17, y, w=4, unit="s", decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 3600}, {"color": "red", "value": 86400}],
     desc="Since Redis last wrote its snapshot to disk")
stat("Uptime", 'max(redis_uptime_in_seconds{job="redis"})', 21, y, w=3, unit="s", decimals=0, color_mode="value")
y += 5
timeseries("Commands per second (the proxy's)", [target(f'sum by (cmd) (rate(redis_commands_total{{job="redis",{EXPORTER_CMDS}}}[{RATE}]))', "{{cmd}}")], 0, y, w=8,
           unit="ops", stack=True, decimals=2)
timeseries("Average command time", [
    target(f'sum by (cmd) (rate(redis_commands_duration_seconds_total{{job="redis",{EXPORTER_CMDS}}}[{RATE}])) / sum by (cmd) (rate(redis_commands_total{{job="redis",{EXPORTER_CMDS}}}[{RATE}]))', "{{cmd}}")],
    8, y, w=8, unit="s", decimals=5)
timeseries("Memory and keys", [
    target('redis_memory_used_bytes{job="redis"}', "used"),
    target('redis_memory_max_bytes{job="redis"} > 0', "maxmemory", ref="B")],
    16, y, w=8, unit="bytes",
    overrides=[{"matcher": {"id": "byName", "options": "maxmemory"},
                "properties": [{"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 10]}}]}])
y += 8

dash = {
    "title": "Proxy & Redis", "uid": "proxy-redis",
    "description": "The active proxy (requests, errors, latency, senders, process) and its Redis (through the proxy VIP)",
    "links": [{"title": "Dashboards", "type": "dashboards", "tags": ["production"], "asDropdown": True, "keepTime": True, "includeVars": False, "icon": "external link", "targetBlank": False}],
    "tags": ["proxy", "redis", "production"], "editable": True, "schemaVersion": 39, "version": 1, "refresh": "30s",
    "time": {"from": "now-6h", "to": "now"}, "timezone": "", "graphTooltip": 1,
    "templating": {"list": []},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True,
         "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"},
        {"name": "Proxy and Redis alerts", "datasource": DS, "enable": True, "iconColor": "orange",
         "expr": 'ALERTS{alertstate="firing",alertname=~"Proxy.*|Redis.*"}', "step": "30s",
         "titleFormat": "{{alertname}}", "textFormat": "{{sender}}", "tagKeys": "severity", "useValueForTime": False}]},
    "panels": panels}
json.dump(dash, open(sys.argv[1], "w"), indent=2)
print(len(panels), "panels")
