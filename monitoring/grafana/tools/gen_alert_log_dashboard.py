# Generates monitoring/grafana/dashboards/alert-log.json:
#   python3 monitoring/grafana/tools/gen_alert_log_dashboard.py monitoring/grafana/dashboards/alert-log.json
# Every alert that fired, over any time range up to Prometheus's retention: when it started, how
# often, how long, whether it still fires. Reads ALERTS and the alert_log:* recording rules
# (monitoring/prometheus/rules/alert-log.yml). docs/operations/dashboards.md#alert-log
import json, sys

DS = {"type": "prometheus", "uid": "prometheus"}
EVAL_S = 15            # evaluation_interval in prometheus.yml: one alert_log sample per 15 s
F = 'severity=~"$severity",alertname=~"$alertname"'
G = "alertname, severity, subject, detail"
panels = []
pid = [0]


def nid():
    pid[0] += 1
    return pid[0]


def row(title, y):
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False,
                   "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})


def target(expr, legend="", instant=False, fmt=None, ref="A", interval=None):
    t = {"refId": ref, "expr": expr, "legendFormat": legend, "datasource": DS}
    if instant:
        t["instant"] = True
        t["range"] = False
    if fmt:
        t["format"] = fmt
    if interval:
        t["interval"] = interval
    return t


def subj(expr):
    """The same subject / detail labels as the alert_log:* recording rules, for queries on ALERTS."""
    for src in ("instance", "host", "address", "sender", "node", "section"):
        expr = f'label_replace({expr}, "subject", "$1", "{src}", "(.+)")'
    for src in ("kind", "class", "mountpoint"):
        expr = f'label_replace({expr}, "detail", "$1", "{src}", "(.+)")'
    return expr


SEV_COLORS = [("3", "critical", "red"), ("2", "warning", "orange"), ("1", "info", "blue")]


def stat(title, expr, x, y, w, unit="none", steps=None, desc=""):
    panels.append({
        "type": "stat", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": 5},
        "targets": [target(expr, instant=True)],
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "background",
                    "graphMode": "none", "textMode": "auto", "justifyMode": "center"},
        "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": "thresholds"},
                                     "thresholds": {"mode": "absolute", "steps": steps or [{"color": "blue", "value": None}]},
                                     "mappings": []}, "overrides": []}})


y = 0
row("Summary (selected time range)", y); y += 1
stat("Firing now", f'count(ALERTS{{alertstate="firing",{F}}}) or vector(0)', 0, y, 5,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
     desc="Alerts firing at this moment (all severities selected above).")
stat("Critical firing now", f'count(ALERTS{{alertstate="firing",severity="critical",alertname=~"$alertname"}}) or vector(0)', 5, y, 5,
     steps=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
     desc="Critical alerts firing at this moment: act now (docs/operations/alert-runbook.md).")
stat("Alerts that fired", f'count(max by ({G}) (max_over_time(alert_log:firing_seen{{{F}}}[$__range]))) or vector(0)', 10, y, 5,
     desc="Different alerts (name + subject + detail) that fired at least once in the selected time range: the rows of the log below.")
stat("Firing episodes", f'sum(max by ({G}) (changes(alert_log:firing_since{{{F}}}[$__range]) + 1)) or vector(0)', 15, y, 5,
     desc="How many times an alert started firing in the selected time range (each start of each alert counts once).")
stat("Time firing (sum)", f'sum(max by ({G}) (count_over_time(alert_log:firing_seen{{{F}}}[$__range]))) * {EVAL_S} or vector(0)', 20, y, 4,
     unit="dtdurations", desc="Sum of the time each alert spent firing in the selected time range (overlapping alerts add up).")
y += 5

row("Timeline", y); y += 1
panels.append({
    "type": "timeseries", "title": "Firing alerts by severity", "id": nid(), "datasource": DS,
    "description": "How many alerts were firing, per severity. Each bar covers one interval and counts an alert that fired at any moment in it.",
    "gridPos": {"x": 0, "y": y, "w": 24, "h": 7},
    "targets": [target(f'count by (severity) (max_over_time(ALERTS{{alertstate="firing",{F}}}[$__interval]))', "{{severity}}")],
    "interval": "1m",
    "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi", "sort": "desc"}},
    "fieldConfig": {"defaults": {"unit": "none", "decimals": 0, "min": 0,
                                 "custom": {"drawStyle": "bars", "fillOpacity": 70, "lineWidth": 1, "stacking": {"mode": "normal"},
                                            "showPoints": "never"},
                                 "color": {"mode": "palette-classic"}},
                    "overrides": [{"matcher": {"id": "byName", "options": name},
                                   "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": col}}]}
                                  for _, name, col in SEV_COLORS]}})
y += 7
rank = " or ".join(
    f'max_over_time(ALERTS{{alertstate="firing",severity="{sev}",{F}}}[$__interval]) * {v}' for v, sev, _ in SEV_COLORS)
panels.append({
    "type": "state-timeline", "title": "When each alert fired", "id": nid(), "datasource": DS,
    "description": "One line per alert (name, subject, detail): coloured while it fired (red critical, orange warning, blue info). "
                   "At long time ranges one cell covers an interval: a short alert shows as a whole cell.",
    "gridPos": {"x": 0, "y": y, "w": 24, "h": 14},
    "targets": [target(f'max by (alertname, subject, detail) ({subj("(" + rank + ")")})', "{{alertname}} {{subject}} {{detail}}")],
    "interval": "1m",
    "options": {"showValue": "never", "mergeValues": True, "rowHeight": 0.8, "alignValue": "left",
                "legend": {"showLegend": False}, "tooltip": {"mode": "single"}},
    "fieldConfig": {"defaults": {"custom": {"fillOpacity": 85, "lineWidth": 0},
                                 "color": {"mode": "thresholds"},
                                 "thresholds": {"mode": "absolute", "steps": [{"color": "blue", "value": None},
                                                                              {"color": "orange", "value": 2},
                                                                              {"color": "red", "value": 3}]},
                                 "mappings": [{"type": "value", "options": {v: {"text": t, "color": c, "index": i}}}
                                              for i, (v, t, c) in enumerate(SEV_COLORS)]},
                    "overrides": []}})
y += 14

row("Log", y); y += 1
q = [
    ("A", f'max by ({G}) (alert_log:firing_seen{{{F}}}) * 0 + 1'),                                            # firing now
    ("B", f'max by ({G}) (changes(alert_log:firing_since{{{F}}}[$__range]) + 1)'),                            # episodes
    ("C", f'min by ({G}) (min_over_time(alert_log:firing_since{{{F}}}[$__range])) * 1000'),                   # first start
    ("D", f'max by ({G}) (max_over_time(alert_log:firing_since{{{F}}}[$__range])) * 1000'),                   # last start
    ("E", f'max by ({G}) (max_over_time(alert_log:firing_seen{{{F}}}[$__range])) * 1000'),                    # last seen
    ("F", f'max by ({G}) (count_over_time(alert_log:firing_seen{{{F}}}[$__range])) * {EVAL_S}'),              # time firing
]
names = {"Value #A": "Now", "Value #B": "Times fired", "Value #C": "First started", "Value #D": "Last started",
         "Value #E": "Last seen firing", "Value #F": "Time firing", "alertname": "Alert", "severity": "Severity",
         "subject": "Subject", "detail": "Detail"}
order = ["Severity", "Alert", "Subject", "Detail", "Now", "Last started", "Last seen firing", "Times fired", "Time firing", "First started"]


def unit_override(name, props):
    return {"matcher": {"id": "byName", "options": name}, "properties": props}


panels.append({
    "type": "table", "title": "Alert log", "id": nid(), "datasource": DS,
    "description": "Every alert that fired in the selected time range, newest first. Now: FIRING or resolved. Last started / "
                   "First started: when its latest / earliest episode in the range began. Last seen firing: for a resolved "
                   "alert, about when it ended. Times fired: episodes in the range. Time firing: total.",
    "gridPos": {"x": 0, "y": y, "w": 24, "h": 18},
    "targets": [target(e, instant=True, fmt="table", ref=r) for r, e in q],
    "transformations": [
        {"id": "merge", "options": {}},
        {"id": "organize", "options": {"excludeByName": {"Time": True}, "renameByName": names,
                                       "indexByName": {n: i for i, n in enumerate(order)}}},
        {"id": "filterByValue", "options": {"filters": [{"fieldName": "Times fired", "config": {"id": "isNotNull", "options": {}}}],
                                            "type": "include", "match": "any"}},
        {"id": "sortBy", "options": {"sort": [{"field": "Last seen firing", "desc": True}]}},
    ],
    "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False},
                "sortBy": [{"displayName": "Last seen firing", "desc": True}]},
    "fieldConfig": {"defaults": {"custom": {"align": "auto", "filterable": True}, "mappings": []},
                    "overrides": [
                        unit_override("Severity", [
                            {"id": "custom.width", "value": 100},
                            {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                            {"id": "mappings", "value": [{"type": "value", "options": {
                                "critical": {"text": "CRITICAL", "color": "red", "index": 0},
                                "warning": {"text": "WARNING", "color": "orange", "index": 1},
                                "info": {"text": "INFO", "color": "blue", "index": 2}}}]}]),
                        unit_override("Alert", [{"id": "custom.width", "value": 230}]),
                        unit_override("Now", [
                            {"id": "custom.width", "value": 100},
                            {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                            {"id": "mappings", "value": [{"type": "value", "options": {"1": {"text": "FIRING", "color": "red", "index": 0}}},
                                                         {"type": "special", "options": {"match": "null", "result": {"text": "resolved", "color": "green", "index": 1}}}]}]),
                        unit_override("Last started", [{"id": "unit", "value": "dateTimeAsLocal"}]),
                        unit_override("First started", [{"id": "unit", "value": "dateTimeAsLocal"}]),
                        unit_override("Last seen firing", [{"id": "unit", "value": "dateTimeAsLocal"}]),
                        unit_override("Times fired", [{"id": "custom.width", "value": 110}]),
                        unit_override("Time firing", [{"id": "unit", "value": "dtdurations"}]),
                    ]}})
y += 18

dash = {
    "title": "Alert log", "uid": "alert-log",
    "description": "Every alert that fired since the deployment (up to Prometheus's retention): when, how often, how long (docs/operations/dashboards.md#alert-log)",
    "tags": ["alerts", "production"], "editable": True, "schemaVersion": 39, "version": 1, "refresh": "1m",
    "time": {"from": "now-30d", "to": "now"},
    "timepicker": {"refresh_intervals": ["30s", "1m", "5m", "15m"],
                   "quick_ranges": []},
    "templating": {"list": [
        {"name": "severity", "label": "Severity", "type": "custom", "query": "critical,warning,info",
         "multi": True, "includeAll": True, "allValue": ".*",
         "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
         "options": []},
        {"name": "alertname", "label": "Alert", "type": "query", "datasource": DS,
         "query": {"query": "label_values(ALERTS, alertname)", "refId": "alertname"},
         "definition": "label_values(ALERTS, alertname)", "refresh": 2, "sort": 1,
         "multi": True, "includeAll": True, "allValue": ".*",
         "current": {"selected": True, "text": ["All"], "value": ["$__all"]}},
    ]},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True,
         "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"}]},
    "links": [{"title": "Dashboards", "type": "dashboards", "tags": ["production"], "asDropdown": True, "keepTime": True,
               "includeVars": False, "icon": "external link", "targetBlank": False}],
    "panels": panels,
}
json.dump(dash, open(sys.argv[1], "w"), indent=2)
print("wrote", sys.argv[1], len(panels), "panels")
