# Generates monitoring/grafana/dashboards/proxy-redis.json:
#   python3 monitoring/grafana/tools/gen_proxy_dashboard.py monitoring/grafana/dashboards/proxy-redis.json
# The ACTIVE proxy and its Redis (jobs "proxy" and "redis", both scraped through the proxy VIP).
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import alerts_row  # noqa: E402

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
y = alerts_row(panels, nid, y)

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

# ---- Senders: every account the proxy sends from. Named by proxy_sender_info (SENDER01, "Shop B · upfront",
# "Shop B · user 0x51a9…"), filtered by the Kind / Section / Search variables; tables list the problems first
SEL = ('(max by (sender, account, kind, section) (proxy_sender_info{kind=~"$kind",section=~"$section",account=~"(?i).*$search.*"})'
       ' or max by (sender, account, kind, section) (proxy_sender_info{kind=~"$kind",section=~"$section",sender=~"(?i).*$search.*"}))')


def j(metric):
    """metric per sender, with the sender's name, kind and section, filtered by the variables"""
    return f'(max by (sender) ({metric}) * on(sender) group_left(account, kind, section) {SEL})'


def jr(counter):
    """increase of a per-sender counter over the selected time range, named and filtered"""
    return f'(sum by (sender) (increase({counter}[$__range])) * on(sender) group_left(account, kind, section) {SEL})'


STATE = (f'({j("proxy_sender_stalled")} == 1) * 0 + 4 or ({j("proxy_sender_check_error")} == 1) * 0 + 3'
         f' or ({j("proxy_sender_gap_seconds")} > 0) * 0 + 2 or ({j("proxy_sender_waiting_above_gap")} > 0) * 0 + 1')
STATE_MAP = [{"type": "value", "options": {
    "4": {"text": "STALLED", "color": "red", "index": 0}, "3": {"text": "CHECK FAILING", "color": "purple", "index": 1},
    "2": {"text": "NONCE GAP", "color": "orange", "index": 2}, "1": {"text": "WAITING", "color": "yellow", "index": 3},
    "0": {"text": "OK", "color": "green", "index": 4}}}]


def sender_table(title, state_expr, x, y, h, desc, only_problems):
    q = [("A", state_expr), ("B", j("proxy_sender_inflight_transactions")), ("C", j("proxy_sender_stall_seconds")),
         ("D", j("proxy_sender_gap_seconds")), ("E", j("proxy_sender_waiting_above_gap")),
         ("F", jr("proxy_sender_nonce_repairs_total")), ("G", jr("proxy_sender_filler_transactions_total")),
         ("H", jr("proxy_sender_stalls_total"))]
    names = {"Value #A": "State", "Value #B": "In flight", "Value #C": "Not mined for", "Value #D": "Nonce gap for",
             "Value #E": "Waiting above gap", "Value #F": "Repairs", "Value #G": "Fillers", "Value #H": "Stalls",
             "account": "Sender", "kind": "Kind", "section": "Section", "sender": "Address"}
    order = ["Sender", "State", "Kind", "Section", "In flight", "Not mined for", "Nonce gap for", "Waiting above gap",
             "Stalls", "Repairs", "Fillers", "Address"]
    transformations = [{"id": "merge", "options": {}},
                       {"id": "organize", "options": {"excludeByName": {"Time": True}, "renameByName": names,
                                                      "indexByName": {k: order.index(v) for k, v in names.items()}}}]
    if only_problems:
        transformations.append({"id": "filterByValue", "options": {
            "filters": [{"fieldName": "State", "config": {"id": "isNotNull", "options": {}}}], "type": "include", "match": "any"}})
    panels.append({
        "type": "table", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": 24, "h": h},
        "targets": [target(e, instant=True, fmt="table", ref=r) for r, e in q],
        "transformations": transformations,
        "options": {"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "State", "desc": True}],
                    "footer": {"show": False, "enablePagination": not only_problems}},
        "fieldConfig": {"defaults": {"custom": {"align": "auto", "filterable": True}, "noValue": "—" if not only_problems else "all senders OK"},
                        "overrides": [
                            {"matcher": {"id": "byName", "options": "State"}, "properties": [
                                {"id": "mappings", "value": STATE_MAP}, {"id": "custom.width", "value": 130},
                                {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}}]},
                            {"matcher": {"id": "byName", "options": "Sender"}, "properties": [{"id": "custom.width", "value": 260}]},
                            {"matcher": {"id": "byRegexp", "options": "Not mined for|Nonce gap for"}, "properties": [
                                {"id": "unit", "value": "s"},
                                {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                                {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                                    {"color": "text", "value": None}, {"color": "orange", "value": 30}, {"color": "red", "value": 120}]}}]},
                            {"matcher": {"id": "byRegexp", "options": "In flight|Waiting above gap|Repairs|Fillers|Stalls"},
                             "properties": [{"id": "decimals", "value": 0}]}]}})


row("Senders (every account the proxy sends from; filter with Kind, Section and Search above)", y); y += 1
stat("Senders", f'count({SEL}) or vector(0)', 0, y, w=3, decimals=0, color_mode="value",
     desc="Accounts the proxy sends from and watches (SENDER01, contract center, registry admin, section accounts, "
          "user accounts used in the last few minutes), matching the filters")
stat("Stalled", f'count({j("proxy_sender_stalled")} == 1) or vector(0)', 3, y, w=3, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
     desc="Ready transactions not mined while blocks are produced (alert ProxySenderStalled)")
stat("Nonce gaps", f'count({j("proxy_sender_gap_seconds")} > 0) or vector(0)', 6, y, w=3, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
     desc="A nonce is missing: later transactions wait (alert ProxyNonceGap after 120 s)")
stat("Check failing", f'count({j("proxy_sender_check_error")} == 1) or vector(0)', 9, y, w=3, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "purple", "value": 1}],
     desc="The proxy's chain check of the sender failed (alert ProxySenderCheckFailing)")
stat("In flight", f'sum({j("proxy_sender_inflight_transactions")}) or vector(0)', 12, y, w=3, decimals=0, color_mode="value",
     desc="Transactions sent and not mined yet, all matching senders")
stat("Waiting above gap", f'sum({j("proxy_sender_waiting_above_gap")}) or vector(0)', 15, y, w=3, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
     desc="Transactions in Besu's pool waiting for a missing nonce")
stat("Repairs (range)", f'round(sum({jr("proxy_sender_nonce_repairs_total")})) or vector(0)', 18, y, w=3, decimals=0, color_mode="value",
     desc="Nonce gaps the proxy repaired in the selected time range")
stat("Fillers (range)", f'round(sum({jr("proxy_sender_filler_transactions_total")})) or vector(0)', 21, y, w=3, decimals=0, color_mode="value",
     desc="0-value filler transactions sent to close gaps in the selected time range")
y += 5
sender_table("Senders needing attention", STATE, 0, y, 7,
             "Only the senders with a problem now: STALLED (ready transactions not mined), CHECK FAILING, NONCE GAP, "
             "WAITING (transactions above a gap). Empty = all senders OK. Times: how long it has lasted. Repairs, "
             "fillers, stalls: in the selected time range. Each column can be filtered (funnel) or sorted.", True)
y += 7
sender_table("All senders", f'{STATE} or {j("proxy_sender_stalled")} * 0', 0, y, 10,
             "Every sender matching the filters, problems first; pages at the bottom. Use Search above for a name, "
             "section or address part.", False)
y += 10
timeseries("In flight: top 10 senders", [target(f'topk(10, {j("proxy_sender_inflight_transactions")} > 0)', "{{account}}")],
           0, y, w=12, decimals=0, desc="The 10 senders with the most transactions not mined yet, at each moment")
timeseries("In flight by kind", [target(f'sum by (kind) ({j("proxy_sender_inflight_transactions")})', "{{kind}}")],
           12, y, w=12, decimals=0, stack=True, desc="Platform accounts, section accounts and users, added up")
y += 8
timeseries("Not mined / nonce gap: top 10 (seconds)", [
    target(f'topk(10, {j("proxy_sender_stall_seconds")} > 0)', "not mined {{account}}"),
    target(f'topk(10, {j("proxy_sender_gap_seconds")} > 0)', "gap {{account}}", ref="B")],
    0, y, w=12, unit="s", desc="Only senders where it is happening; the longest 10 (alert ProxyNonceGap above 120 s)")
timeseries("Stalls, repairs and fillers per hour, by kind", [
    target(f'sum by (kind) (increase(proxy_sender_stalls_total[1h]) * on(sender) group_left(kind) {SEL})', "stalls {{kind}}"),
    target(f'sum by (kind) (increase(proxy_sender_nonce_repairs_total[1h]) * on(sender) group_left(kind) {SEL})', "repairs {{kind}}", ref="B"),
    target(f'sum by (kind) (increase(proxy_sender_filler_transactions_total[1h]) * on(sender) group_left(kind) {SEL})', "fillers {{kind}}", ref="C")],
    12, y, w=12, decimals=1, desc="Counted over the hour before each point")
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
    "templating": {"list": [
        {"name": "kind", "label": "Kind", "type": "query", "datasource": DS,
         "query": {"query": "label_values(proxy_sender_info, kind)", "refId": "kind"},
         "definition": "label_values(proxy_sender_info, kind)", "refresh": 2, "sort": 1,
         "includeAll": True, "multi": True, "allValue": ".*", "current": {"selected": True, "text": ["All"], "value": ["$__all"]}},
        {"name": "section", "label": "Section", "type": "query", "datasource": DS,
         "query": {"query": "label_values(proxy_sender_info, section)", "refId": "section"},
         "definition": "label_values(proxy_sender_info, section)", "refresh": 2, "sort": 1,
         "includeAll": True, "multi": True, "allValue": ".*", "current": {"selected": True, "text": ["All"], "value": ["$__all"]}},
        {"name": "search", "label": "Search (name or address)", "type": "textbox", "query": "",
         "current": {"text": "", "value": ""}}]},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True,
         "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"},
        {"name": "Proxy and Redis alerts", "datasource": DS, "enable": True, "iconColor": "orange",
         "expr": 'ALERTS{alertstate="firing",alertname=~"Proxy.*|Redis.*"}', "step": "30s",
         "titleFormat": "{{alertname}}", "textFormat": "{{sender}}", "tagKeys": "severity", "useValueForTime": False}]},
    "panels": panels}
json.dump(dash, open(sys.argv[1], "w"), indent=2)
print(len(panels), "panels")
