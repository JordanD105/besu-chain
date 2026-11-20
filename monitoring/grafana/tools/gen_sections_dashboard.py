# Generates monitoring/grafana/dashboards/sections.json:
#   python3 monitoring/grafana/tools/gen_sections_dashboard.py monitoring/grafana/dashboards/sections.json
import json, sys

DS = {"type": "prometheus", "uid": "prometheus"}
panels = []
pid = [0]


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


def stat(title, expr, x, y, w=4, unit="none", steps=None, decimals=None, desc=""):
    panels.append({
        "type": "stat", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": 5},
        "targets": [target(expr, instant=True)],
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "background",
                    "graphMode": "none", "textMode": "auto", "justifyMode": "center"},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "thresholds"},
                                     "thresholds": {"mode": "absolute", "steps": steps or [{"color": "green", "value": None}]}, "mappings": []},
                        "overrides": []}})


def timeseries(title, targets, x, y, w=12, h=8, unit="none", desc="", overrides=None, bars=False):
    if bars:
        # one bar per distinct 5-minute bucket, so the legend's sum counts each operation once
        for t in targets:
            t["interval"] = "5m"
    panels.append({
        "type": "timeseries", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
        "options": {"legend": {"displayMode": "table", "placement": "right", "calcs": ["lastNotNull"] if not bars else ["sum"]},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"drawStyle": "bars" if bars else "line", "lineWidth": 2, "fillOpacity": 60 if bars else 10,
                                                               "showPoints": "never", "stacking": {"mode": "normal" if bars else "none"}},
                                     "color": {"mode": "palette-classic"}},
                        "overrides": overrides or []}})


def table(title, expr, x, y, w, h, row_field, col_field, unit="none", desc=""):
    panels.append({
        "type": "table", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [target(expr, instant=True, fmt="table")],
        "transformations": [{"id": "groupingToMatrix", "options": {"rowField": row_field, "columnField": col_field, "valueField": "Value", "emptyValue": "zero"}}],
        "options": {"showHeader": True, "cellHeight": "sm"},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": 2, "custom": {"align": "auto"}}, "overrides": []}})


SEL = 'section=~"$section"'
y = 0
row("Overview", y); y += 1
stat("Active sections", 'count(proxy_section_active == 1) or vector(0)', 0, y, decimals=0)
stat("Upfront below threshold", f'count(proxy_section_balance_eth{{role="upfront",active="1"}} < on() group_left() (proxy_section_low_balance_eth > 0)) or vector(0)', 4, y,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}], decimals=0,
     desc="Enabled sections whose upfront account is below upfront_low_balance_eth (alert SectionUpfrontLow)")
stat("Low-balance threshold", 'proxy_section_low_balance_eth', 8, y, unit="none", decimals=2, desc="upfront_low_balance_eth (ETH; 0 = off)")
stat("SENDER01", 'proxy_sender01_balance_eth', 12, y, unit="none", decimals=2,
     desc="SENDER01's balance (ETH): it funds every top-up")
stat("All upfront", 'sum(proxy_section_balance_eth{role="upfront"})', 16, y, decimals=2, desc="ETH in all upfront accounts")
stat("All consumption + payment", 'sum(proxy_section_balance_eth{role=~"consumption|payment"})', 20, y, decimals=2,
     desc="ETH collected by all sections (consumption and payment accounts)")
y += 5

row("Balances (ETH)", y); y += 1
table("Balances by section", f'max by (section, role) (proxy_section_balance_eth{{{SEL}}})', 0, y, 12, 9, "section", "role",
      desc="Current balances of each section's three accounts")
timeseries("Upfront accounts", [
    target(f'max by (section) (proxy_section_balance_eth{{role="upfront",{SEL}}})', "{{section}}"),
    target('proxy_section_low_balance_eth > 0', "threshold", ref="B")], 12, y, w=12, h=9,
    desc="Funds new accounts and -x transfers; top up before it reaches the threshold",
    overrides=[{"matcher": {"id": "byName", "options": "threshold"},
                "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}},
                               {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 10]}}]}])
y += 9
timeseries("Consumption accounts", [target(f'max by (section) (proxy_section_balance_eth{{role="consumption",{SEL}}})', "{{section}}")], 0, y,
           desc="Receives +x transfers and first NFT sales; sweep it to the payment account")
timeseries("Payment accounts", [target(f'max by (section) (proxy_section_balance_eth{{role="payment",{SEL}}})', "{{section}}")], 12, y,
           desc="Collects the swept money; pay it back to SENDER01")
y += 8

row("Activity (since the proxy started; resets on a proxy restart or failover)", y); y += 1
timeseries("Operations per 5 min", [target(f'sum by (section, op) (increase(proxy_section_operations_total{{{SEL}}}[5m]))', "{{section}} {{op}}")],
           0, y, bars=True, desc="create_account, transfer_in (+x), transfer_out (-x), nft_first_sale, nft_resale, topup, sweep, payback")
timeseries("ETH moved per 5 min", [target(f'sum by (op) (increase(proxy_section_amount_eth_total{{{SEL}}}[5m]))', "{{op}}")],
           12, y, bars=True, desc="ETH moved by each kind of operation (all selected sections)")
y += 8
table("ETH moved in the selected time range", f'sum by (section, op) (increase(proxy_section_amount_eth_total{{{SEL}}}[$__range]))', 0, y, 24, 8,
      "section", "op", desc="Per section and operation, over the dashboard's time range")
y += 8

dash = {
    "title": "Sections", "uid": "sections", "description": "Per-section balances, low-balance alerts and activity (docs/sections.md)",
    "tags": ["sections", "production"], "editable": True, "schemaVersion": 39, "version": 1, "refresh": "30s",
    "time": {"from": "now-6h", "to": "now"}, "timezone": "", "graphTooltip": 1,
    "templating": {"list": [{
        "name": "section", "label": "Section", "type": "query", "datasource": DS,
        "query": {"query": "label_values(proxy_section_balance_eth, section)", "refId": "v"},
        "definition": "label_values(proxy_section_balance_eth, section)", "refresh": 2,
        "includeAll": True, "multi": True, "allValue": ".*",
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]}, "sort": 1}]},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True,
         "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"},
        {"name": "Section alerts", "datasource": DS, "enable": True, "iconColor": "orange",
         "expr": 'ALERTS{alertstate="firing",alertname=~"Section.*|Sender01Low"}', "step": "30s",
         "titleFormat": "{{alertname}}", "textFormat": "{{section}}", "tagKeys": "severity", "useValueForTime": False}]},
    "panels": panels}
json.dump(dash, open(sys.argv[1], "w"), indent=2)
print(len(panels), "panels")
