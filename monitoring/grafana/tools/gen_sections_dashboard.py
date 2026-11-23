# Generates monitoring/grafana/dashboards/sections.json:
#   python3 monitoring/grafana/tools/gen_sections_dashboard.py monitoring/grafana/dashboards/sections.json
# Built for many sections: summary counts, the sections needing attention, one table with every section
# (sortable, filterable, paged), and top / bottom 10 charts instead of one line per section.
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import alerts_row  # noqa: E402

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


def stat(title, expr, x, y, w=3, unit="none", steps=None, decimals=None, desc="", color_mode="background"):
    panels.append({
        "type": "stat", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": 5},
        "targets": [target(expr, instant=True)],
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": color_mode,
                    "graphMode": "none", "textMode": "auto", "justifyMode": "center"},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "color": {"mode": "thresholds"},
                                     "thresholds": {"mode": "absolute", "steps": steps or [{"color": "blue", "value": None}]}, "mappings": []},
                        "overrides": []}})


def timeseries(title, targets, x, y, w=12, h=8, unit="none", desc="", overrides=None, bars=False, stack=False):
    if bars:
        # one bar per distinct period (the Period variable), so the legend's sum counts each operation once
        for t in targets:
            t["interval"] = "$period"
    panels.append({
        "type": "timeseries", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
        "options": {"legend": {"displayMode": "table", "placement": "right", "calcs": ["lastNotNull"] if not bars else ["sum"]},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"drawStyle": "bars" if bars else "line", "lineWidth": 2,
                                                               "fillOpacity": 60 if bars else (25 if stack else 10), "showPoints": "never",
                                                               "stacking": {"mode": "normal" if (bars or stack) else "none"}},
                                     "color": {"mode": "palette-classic"}},
                        "overrides": overrides or []}})


def bargauge(title, expr, x, y, w, h, unit="none", decimals=2, desc="", steps=None, no_value="none"):
    """one horizontal bar per section (top / bottom N), the section name on the left"""
    panels.append({
        "type": "bargauge", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [target(expr, "{{section}}", instant=True)],
        "options": {"orientation": "horizontal", "displayMode": "basic", "showUnfilled": True, "valueMode": "color",
                    "namePlacement": "left", "sizing": "manual", "minVizHeight": 18, "maxVizHeight": 26,
                    "text": {"titleSize": 13, "valueSize": 14},
                    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "min": 0, "color": {"mode": "thresholds"}, "noValue": no_value,
                                     "thresholds": {"mode": "absolute", "steps": steps or [{"color": "blue", "value": None}]}},
                        "overrides": []}})


def matrix_table(title, expr, x, y, w, h, row_field, col_field, unit="none", desc="", decimals=2):
    panels.append({
        "type": "table", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [target(expr, instant=True, fmt="table")],
        "transformations": [{"id": "groupingToMatrix", "options": {"rowField": row_field, "columnField": col_field, "valueField": "Value", "emptyValue": "zero"}}],
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False, "enablePagination": True}},
        "fieldConfig": {"defaults": {"unit": unit, "decimals": decimals, "custom": {"align": "auto", "filterable": True}}, "overrides": []}})


# The Section variable (one, several, all) and the Search box (part of a name)
SEL = 'section=~"$section",section=~"(?i).*$search.*"'
BAL = f'proxy_section_balance_eth{{{SEL}}}'
# ETH an upfront account pays out: -x transfers and the funding of new accounts
OUTFLOW = f'proxy_section_amount_eth_total{{op=~"transfer_out|create_account",{SEL}}}'
UPFRONT = f'max by (section) ({BAL[:-1]},role="upfront"}})'
SPEND_DAY = f'(sum by (section) (increase({OUTFLOW}[7d])) / 7)'
DAYS_LEFT = f'({UPFRONT} / on(section) ({SPEND_DAY} > 0))'
THRESHOLD = '(proxy_section_low_balance_eth > 0)'
ACTIVE = f'max by (section) (proxy_section_active{{{SEL}}})'
# user accounts: real ones and a gateway's spare accounts (made in advance for /createaccount offline, not given to a user yet).
# proxy_section_user_accounts counts both; the gateway's spares are matched by section id (its name label can be older)
SPARE_BY_ID = 'max by (section_id) (gateway_spare_accounts)'
REAL_USERS = (f'max by (section) (proxy_section_user_accounts{{{SEL}}} - on(section_id) group_left() {SPARE_BY_ID}'
              f' or proxy_section_user_accounts{{{SEL}}})')
SPARES = f'max by (section) (proxy_section_active{{{SEL}}} * 0 + on(section_id) group_left() {SPARE_BY_ID})'

y = 0
y = alerts_row(panels, nid, y)

row("Overview (filtered by Section and Search)", y); y += 1
stat("Active sections", f'count({ACTIVE} == 1) or vector(0)', 0, y, decimals=0, color_mode="value")
stat("Disabled", f'count({ACTIVE} == 0) or vector(0)', 3, y, decimals=0, color_mode="value",
     desc="Disabled sections (calls with their key are refused); archived sections are not listed")
stat("Upfront empty", f'count({BAL[:-1]},role="upfront",active="1"}} == 0 and on() {THRESHOLD}) or vector(0)', 6, y, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
     desc="Enabled sections whose upfront account is empty: new accounts and -x fail (alert SectionUpfrontEmpty)")
stat("Upfront low", f'count({BAL[:-1]},role="upfront",active="1"}} < on() group_left() {THRESHOLD}) or vector(0)', 9, y, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
     desc="Enabled sections below upfront_low_balance_eth (alert SectionUpfrontLow)")
stat("Runs out within 7 days", f'count({DAYS_LEFT} < 7) or vector(0)', 12, y, decimals=0,
     steps=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
     desc="Sections whose upfront account lasts less than 7 more days at the last 7 days' spending (-x and new-account funding)")
stat("SENDER01 (ETH)", 'proxy_sender01_balance_eth', 15, y, decimals=2, color_mode="value",
     desc="SENDER01's balance: it funds every top-up (alert Sender01Low)")
stat("All upfront (ETH)", f'sum({BAL[:-1]},role="upfront"}}) or vector(0)', 18, y, decimals=2, color_mode="value")
stat("Collected (ETH)", f'sum({BAL[:-1]},role=~"consumption|payment"}}) or vector(0)', 21, y, decimals=2, color_mode="value",
     desc="In all consumption and payment accounts: earned by the sections, not paid back yet")
y += 5
stat("User accounts", f'sum({REAL_USERS}) or vector(0)', 0, y, w=4, decimals=0, color_mode="value",
     desc="Accounts given to users (a gateway's spare accounts not counted)")
stat("Spare accounts", f'sum({SPARES}) or vector(0)', 4, y, w=4, decimals=0, color_mode="value",
     desc="Made in advance by the section gateways for /createaccount while offline; not given to a user yet")
timeseries("User and spare accounts", [target(f'sum({REAL_USERS})', "user accounts", ref="A"),
                                       target(f'sum({SPARES})', "spare accounts", ref="B")], 8, y, w=16, h=5,
           desc="Of the selected sections. A spare account becomes a user account when /createaccount hands it out.")
y += 5

# ---- the tables: one row per section
STATE = (f'(max by (section) ({BAL[:-1]},role="upfront",active="1"}}) == 0 and on() {THRESHOLD}) * 0 + 3'
         f' or (max by (section) ({BAL[:-1]},role="upfront",active="1"}}) < on() group_left() {THRESHOLD}) * 0 + 2'
         f' or ({DAYS_LEFT} < 7) * 0 + 1')
STATE_MAP = [{"type": "value", "options": {
    "3": {"text": "EMPTY", "color": "red", "index": 0}, "2": {"text": "LOW", "color": "orange", "index": 1},
    "1": {"text": "< 7 DAYS LEFT", "color": "yellow", "index": 2}, "0": {"text": "OK", "color": "green", "index": 3}}}]
PERIOD_OPS = [("I", "create_account", "operations_total", "New accounts"), ("J", "transfer_in", "amount_eth_total", "+x in"),
              ("K", "transfer_out", "amount_eth_total", "-x out"), ("L", "avatar_sale|nft_first_sale", "amount_eth_total", "Avatar sales"),
              ("M", "topup", "amount_eth_total", "Top-ups"), ("N", "sweep", "amount_eth_total", "Swept"),
              ("O", "payback", "amount_eth_total", "Paid back"), ("P", "nickname_sale", "amount_eth_total", "Nicknames"),
              ("Q", "level_upgrade|edge_upgrade", "amount_eth_total", "Level upgrades"),
              ("R", "avatar_undo|nickname_undo|level_undo", "amount_eth_total", "Undone")]


def section_table(title, state_expr, y, h, desc, only_problems):
    q = [("A", state_expr), ("B", ACTIVE),
         ("C", f'max by (section) ({BAL[:-1]},role="upfront"}})'), ("D", f'max by (section) ({BAL[:-1]},role="consumption"}})'),
         ("E", f'max by (section) ({BAL[:-1]},role="payment"}})'), ("F", DAYS_LEFT), ("G", SPEND_DAY),
         ("H", f'max by (section) (count by (section, role) ({BAL}))'), ("S", REAL_USERS), ("T", SPARES)]
    names = {"Value #A": "State", "Value #B": "Status", "Value #C": "Upfront", "Value #D": "Consumption", "Value #E": "Payment",
             "Value #F": "Days left", "Value #G": "Spend / day", "Value #S": "User accounts", "Value #T": "Spare accounts",
             "section": "Section"}
    if not only_problems:
        for ref, op, metric, label in PERIOD_OPS:
            q.append((ref, f'round(sum by (section) (increase(proxy_section_{metric}{{op=~"{op}",{SEL}}}[$period])), 0.01)'))
            names[f"Value #{ref}"] = f"{label} ($period)"
    order = ["Section", "State", "Status", "Upfront", "Days left", "Spend / day", "Consumption", "Payment",
             "User accounts", "Spare accounts"] + \
            [f"{label} ($period)" for _, _, _, label in PERIOD_OPS]
    transformations = [{"id": "merge", "options": {}},
                       {"id": "organize", "options": {"excludeByName": {"Time": True, "Value #H": True}, "renameByName": names,
                                                      "indexByName": {k: order.index(v) for k, v in names.items() if v in order}}}]
    transformations.append({"id": "filterByValue", "options": {
        "filters": [{"fieldName": "State" if only_problems else "Status", "config": {"id": "isNotNull", "options": {}}}],
        "type": "include", "match": "any"}})
    panels.append({
        "type": "table", "title": title, "id": nid(), "description": desc, "datasource": DS,
        "gridPos": {"x": 0, "y": y, "w": 24, "h": h},
        "targets": [target(e, instant=True, fmt="table", ref=r) for r, e in q],
        "transformations": transformations,
        "options": {"showHeader": True, "cellHeight": "sm",
                    "sortBy": [{"displayName": "State", "desc": True}] if only_problems else [{"displayName": "Upfront", "desc": False}],
                    "footer": {"show": False, "enablePagination": not only_problems}},
        "fieldConfig": {"defaults": {"decimals": 2, "custom": {"align": "auto", "filterable": True},
                                     "noValue": "all sections OK" if only_problems else "—"},
                        "overrides": [
                            {"matcher": {"id": "byName", "options": "State"}, "properties": [
                                {"id": "mappings", "value": STATE_MAP}, {"id": "custom.width", "value": 130},
                                {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}}]},
                            {"matcher": {"id": "byName", "options": "Status"}, "properties": [
                                {"id": "custom.width", "value": 95}, {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                                {"id": "mappings", "value": [{"type": "value", "options": {
                                    "1": {"text": "active", "color": "green", "index": 0}, "0": {"text": "disabled", "color": "orange", "index": 1}}}]}]},
                            {"matcher": {"id": "byName", "options": "Section"}, "properties": [{"id": "custom.width", "value": 200}]},
                            {"matcher": {"id": "byName", "options": "Days left"}, "properties": [
                                {"id": "decimals", "value": 1}, {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                                {"id": "noValue", "value": "no spending"},
                                {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                                    {"color": "red", "value": None}, {"color": "orange", "value": 3}, {"color": "green", "value": 7}]}}]},
                            {"matcher": {"id": "byName", "options": "New accounts ($period)"}, "properties": [{"id": "decimals", "value": 0}]},
                            {"matcher": {"id": "byName", "options": "User accounts"}, "properties": [{"id": "decimals", "value": 0}]},
                            {"matcher": {"id": "byName", "options": "Spare accounts"}, "properties": [
                                {"id": "decimals", "value": 0}, {"id": "noValue", "value": "no gateway"}]}]}})


row("Sections (one row per section; filter with Section and Search above)", y); y += 1
section_table("Sections needing attention", STATE, y, 7,
              "Only the sections with a problem now: EMPTY (upfront at 0: new accounts and -x fail), LOW (upfront below "
              "upfront_low_balance_eth), < 7 DAYS LEFT (at the last 7 days' spending). Top up on the chainlens Sections page. "
              "Empty table = all sections OK.", True)
y += 7
section_table("All sections", f'{STATE} or {ACTIVE} * 0', y, 11,
              "Every section: balances now (ETH), days the upfront account lasts at the last 7 days' spending (-x and "
              "new-account funding), and the activity of the last $period. Sorted by upfront (lowest first); click a "
              "title to sort, the funnel to filter; pages at the bottom.", False)
y += 11

row("Balances (ETH)", y); y += 1
bargauge("Lowest upfront: 10 sections", f'bottomk(10, max by (section) ({BAL[:-1]},role="upfront",active="1"}}))', 0, y, 8, 10,
         desc="The 10 enabled sections with the least money left to fund accounts and -x (red below upfront_low_balance_eth)",
         steps=[{"color": "red", "value": None}, {"color": "orange", "value": 0.000001}, {"color": "green", "value": 100}])
bargauge("Fewest days left: 10 sections", f'bottomk(10, {DAYS_LEFT})', 8, y, 8, 10, decimals=1,
         desc="Days the upfront account lasts at the last 7 days' spending (sections that spend nothing are not listed)",
         steps=[{"color": "red", "value": None}, {"color": "orange", "value": 3}, {"color": "green", "value": 7}],
         no_value="no section spent from its upfront account in the last 7 days")
bargauge("Most collected: 10 sections", f'topk(10, sum by (section) ({BAL[:-1]},role=~"consumption|payment"}}))', 16, y, 8, 10,
         desc="ETH in each section's consumption + payment accounts (earned, not paid back yet)")
y += 10
timeseries("All sections, by account role", [target(f'sum by (role) ({BAL})', "{{role}}")], 0, y, stack=True,
           desc="Upfront, consumption and payment balances of the selected sections, added up")
timeseries("Lowest upfront over time: 10 sections", [
    target(f'bottomk(10, max by (section) ({BAL[:-1]},role="upfront",active="1"}}))', "{{section}}"),
    target('proxy_section_low_balance_eth > 0', "threshold", ref="B")], 12, y,
    desc="At each moment the 10 enabled sections with the least upfront money; the dashed line is upfront_low_balance_eth",
    overrides=[{"matcher": {"id": "byName", "options": "threshold"},
                "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}},
                               {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 10]}}]}])
y += 8

row("Activity per $period (Period: Day, Week, Month = 30 days, Quarter = 90 days, Year = 365 days)", y); y += 1
NOTE = (" One bar per period. Choose a time range holding several periods (Day: last 14-30 days; Year: several years)."
        " Prometheus keeps prometheus_retention (settings.yml).")
stat("New accounts, last $period", f'round(sum(increase(proxy_section_operations_total{{op="create_account",{SEL}}}[$period]))) or vector(0)', 0, y, w=6, decimals=0,
     color_mode="value", desc="Accounts created by the selected sections in the last period")
stat("+x from users, last $period (ETH)", f'sum(increase(proxy_section_amount_eth_total{{op="transfer_in",{SEL}}}[$period])) or vector(0)', 6, y, w=6, decimals=2,
     color_mode="value", desc="Paid by users into the consumption accounts (+x)")
stat("Avatar sales, last $period (ETH)", f'sum(increase(proxy_section_amount_eth_total{{op=~"avatar_sale|nft_first_sale",{SEL}}}[$period])) or vector(0)', 12, y, w=6, decimals=2,
     color_mode="value", desc="First avatar sales, paid into the consumption accounts (avatar_sale; nft_first_sale before the rename)")
stat("Top-ups, last $period (ETH)", f'sum(increase(proxy_section_amount_eth_total{{op="topup",{SEL}}}[$period])) or vector(0)', 18, y, w=6, decimals=2,
     color_mode="value", desc="SENDER01 -> upfront accounts")
y += 5
# income: +x and every item payment, minus the undone (refunded) ones; older op names keep their history
IN_OPS = "transfer_in|avatar_sale|nft_first_sale|nickname_sale|level_upgrade|edge_upgrade"
UNDO_OPS = "avatar_undo|nickname_undo|level_undo|transfer_in_undo"
# (every op counter exists from the start at 0 for each section, so the subtraction always matches)
def income(offset=""):
    return (f'(sum by (section) (increase(proxy_section_amount_eth_total{{op=~"{IN_OPS}",{SEL}}}[$period]{offset}))'
            f' - sum by (section) (increase(proxy_section_amount_eth_total{{op=~"{UNDO_OPS}",{SEL}}}[$period]{offset})))')


INCOME = income()
bargauge("Most income, last $period: 10 sections", f'topk(10, {INCOME} > 0)', 0, y, 8, 10,
         desc="+x from users, avatar and nickname sales and level upgrades, minus undone (refunded) payments, per section, in the last period")
bargauge("Most new accounts, last $period: 10 sections",
         f'topk(10, round(sum by (section) (increase(proxy_section_operations_total{{op="create_account",{SEL}}}[$period]))) > 0)', 8, y, 8, 10,
         decimals=0, desc="Accounts created per section in the last period")
bargauge("Most spent, last $period: 10 sections",
         f'topk(10, sum by (section) (increase({OUTFLOW}[$period])) > 0)', 16, y, 8, 10,
         desc="Paid out of the upfront account (-x and new-account funding) per section in the last period")
y += 10
# each bar counts the period that STARTS at its time (offset -$period), so today's bar shows today so far
timeseries("Operations per $period", [target(f'sum by (op) (increase(proxy_section_operations_total{{{SEL}}}[$period] offset -$period))', "{{op}}")],
           0, y, bars=True, desc="All selected sections, per kind of operation: create_account, transfer_in (+x), transfer_out (-x), "
                                 "transfer_in_undo, transfer_out_undo, avatar_sale, avatar_undo, nickname_sale, nickname_undo, level_upgrade, level_undo, topup, sweep, payback "
                                 "(older names kept for history: nft_first_sale, nft_resale, avatar_resale, edge_upgrade)." + NOTE)
timeseries("ETH moved per $period", [target(f'sum by (op) (increase(proxy_section_amount_eth_total{{{SEL}}}[$period] offset -$period))', "{{op}}")],
           12, y, bars=True, desc="ETH moved by each kind of operation (all selected sections)." + NOTE)
y += 8
timeseries("Income per $period: top 10 sections", [
    target(f'topk(10, {income(" offset -$period")})', "{{section}}")],
    0, y, w=24, bars=True, desc="+x, avatar and nickname sales and level upgrades, minus undos; the 10 sections with the most income in each period." + NOTE)
y += 8
matrix_table("ETH moved in the selected time range", f'sum by (section, op) (increase(proxy_section_amount_eth_total{{{SEL}}}[$__range]))', 0, y, 24, 9,
             "section", "op", desc="Per section and operation, over the dashboard's time range; pages at the bottom")
y += 9

# Section gateways (docs/components/gateway.md): one per section that has one; the Section filter applies
GW = 'section=~"$section",section=~"(?i).*$search.*"'
row("Gateways (sections whose application calls a gateway)", y); y += 1
panels.append({
    "type": "table", "title": "Gateways now", "id": nid(), "datasource": DS,
    "description": "Answers: Prometheus can read the gateway (DOWN = alert GatewayDown; a gateway missing from this table is not "
                   "monitored: run ansible-playbook 09-monitoring.yml after adding it). Sync: its last read of the chain (balances, "
                   "items, new accounts) worked; FAILING = alert GatewaySyncFailing, see its log. "
                   "Mode: online, offline (answers from its ledger, queues the writes) or draining (sending the queue). "
                   "Open corrections: queued requests the chain refused after a cut, not acknowledged yet in chainlens (Sections, Gateway).",
    "gridPos": {"x": 0, "y": y, "w": 24, "h": 7},
    "targets": [target(f'max by (section) (gateway_mode{{{GW}}})', instant=True, fmt="table", ref="A"),
                target(f'max by (section) (gateway_queue_length{{{GW}}})', instant=True, fmt="table", ref="B"),
                target(f'max by (section) (gateway_queue_oldest_seconds{{{GW}}})', instant=True, fmt="table", ref="C"),
                target(f'max by (section) (gateway_spare_accounts{{{GW}}})', instant=True, fmt="table", ref="D"),
                target(f'max by (section) (gateway_corrections_open{{{GW}}})', instant=True, fmt="table", ref="E"),
                target(f'max by (section) (gateway_corrections_undelivered{{{GW}}})', instant=True, fmt="table", ref="F"),
                target(f'max by (section) (gateway_cuts_total{{{GW}}})', instant=True, fmt="table", ref="G"),
                target(f'max by (section) (gateway_offline_seconds_total{{{GW}}})', instant=True, fmt="table", ref="H"),
                target(f'max by (section) (gateway_sync_failing{{{GW}}})', instant=True, fmt="table", ref="I"),
                target(f'max by (section) (time() - gateway_last_sync_timestamp_seconds{{{GW}}})', instant=True, fmt="table", ref="J"),
                target(f'max by (section) (label_replace(up{{job="gateway"}}, "section", "$1", "name", "gateway-(.*)"))', instant=True, fmt="table", ref="K")],
    "transformations": [{"id": "merge", "options": {}},
                        {"id": "organize", "options": {"excludeByName": {"Time": True},
                         "renameByName": {"section": "Section", "Value #A": "Mode", "Value #B": "Queued", "Value #C": "Oldest queued",
                                          "Value #D": "Spare accounts", "Value #E": "Open corrections", "Value #F": "Undelivered (webhook)",
                                          "Value #G": "Cuts", "Value #H": "Time offline", "Value #I": "Sync", "Value #J": "Last sync",
                                          "Value #K": "Answers"},
                         "indexByName": {"section": 0, "Value #K": 1, "Value #A": 2, "Value #I": 3, "Value #J": 4}}}],
    "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": [
        {"matcher": {"id": "byName", "options": "Mode"}, "properties": [
            {"id": "mappings", "value": [{"type": "value", "options": {"0": {"text": "online", "color": "green"}, "1": {"text": "offline", "color": "red"},
                                                                         "2": {"text": "draining", "color": "orange"}}}]},
            {"id": "custom.cellOptions", "value": {"type": "color-background"}}]},
        {"matcher": {"id": "byName", "options": "Answers"}, "properties": [
            {"id": "mappings", "value": [{"type": "value", "options": {"1": {"text": "yes", "color": "green"}, "0": {"text": "DOWN", "color": "red"}}}]},
            {"id": "custom.cellOptions", "value": {"type": "color-background"}}]},
        {"matcher": {"id": "byName", "options": "Sync"}, "properties": [
            {"id": "mappings", "value": [{"type": "value", "options": {"0": {"text": "ok", "color": "green"}, "1": {"text": "FAILING", "color": "red"}}}]},
            {"id": "custom.cellOptions", "value": {"type": "color-background"}}]},
        {"matcher": {"id": "byName", "options": "Last sync"}, "properties": [{"id": "unit", "value": "s"}]},
        {"matcher": {"id": "byName", "options": "Oldest queued"}, "properties": [{"id": "unit", "value": "s"}]},
        {"matcher": {"id": "byName", "options": "Time offline"}, "properties": [{"id": "unit", "value": "s"}]},
        {"matcher": {"id": "byName", "options": "Open corrections"}, "properties": [
            {"id": "thresholds", "value": {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "orange", "value": 1}]}},
            {"id": "custom.cellOptions", "value": {"type": "color-background"}}]}]}})
y += 7
timeseries("Gateway mode and queue", [
    target(f'max by (section) (gateway_mode{{{GW}}})', "{{section}} mode (1 offline, 2 draining)", ref="A"),
    target(f'max by (section) (gateway_queue_length{{{GW}}})', "{{section}} queued", ref="B")],
    0, y, w=8, desc="Mode 0 online, 1 offline, 2 draining; the queue grows while offline and empties while draining.")
timeseries("Corrections per $period, by kind", [
    target(f'sum by (section, kind) (increase(gateway_corrections_total{{{GW}}}[$period] offset -$period))', "{{section}} {{kind}}")],
    8, y, w=8, bars=True, desc="already_sold, price_changed, level, undo_period_over, balance, other." + NOTE)
timeseries("ETH given back by corrections per $period", [
    target(f'sum by (section) (increase(gateway_corrections_refunded_eth_total{{{GW}}}[$period] offset -$period))', "{{section}}")],
    16, y, w=8, bars=True, desc="The ETH the gateway had taken in its ledger for requests the chain then refused." + NOTE)
y += 8
timeseries("Spare accounts", [
    target(f'max by (section) (gateway_spare_accounts{{{GW}}})', "{{section}}", ref="A"),
    target(f'max by (section) (gateway_spare_alert_below{{{GW}}})', "{{section}} alert below", ref="B")],
    0, y, w=8, desc="Accounts made in advance for /createaccount while offline (spare_accounts); GatewaySparesLow below spare_alert_below.")
timeseries("Cuts per $period", [
    target(f'sum by (section) (increase(gateway_cuts_total{{{GW}}}[$period] offset -$period))', "{{section}}")],
    8, y, w=8, bars=True, desc="Times each gateway went offline." + NOTE)
timeseries("Open and undelivered corrections", [
    target(f'max by (section) (gateway_corrections_open{{{GW}}})', "{{section}} open", ref="A"),
    target(f'max by (section) (gateway_corrections_undelivered{{{GW}}})', "{{section}} undelivered", ref="B")],
    16, y, w=8, desc="Open: not acknowledged in chainlens (GatewayCorrectionsOpen after 1 h). Undelivered: the correction_webhook has not taken them (0 without a webhook).")
y += 8

dash = {
    "title": "Sections", "uid": "sections", "description": "Per-section balances, low-balance alerts and activity (docs/features/sections.md)",
    "links": [{"title": "Dashboards", "type": "dashboards", "tags": ["production"], "asDropdown": True, "keepTime": True, "includeVars": False, "icon": "external link", "targetBlank": False}],
    "tags": ["sections", "production"], "editable": True, "schemaVersion": 39, "version": 1, "refresh": "30s",
    "time": {"from": "now-30d", "to": "now"}, "timezone": "", "graphTooltip": 1,
    "templating": {"list": [{
        "name": "section", "label": "Section", "type": "query", "datasource": DS,
        "query": {"query": "label_values(proxy_section_balance_eth, section)", "refId": "v"},
        "definition": "label_values(proxy_section_balance_eth, section)", "refresh": 2,
        "includeAll": True, "multi": True, "allValue": ".*",
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]}, "sort": 1},
        {"name": "search", "label": "Search (part of a name)", "type": "textbox", "query": "", "current": {"text": "", "value": ""}},
        {"name": "period", "label": "Period", "type": "custom",
         "query": "Day : 1d,Week : 1w,Month : 30d,Quarter : 90d,Year : 365d",
         "options": [{"text": text, "value": value, "selected": value == "1d"} for text, value in
                     [("Day", "1d"), ("Week", "1w"), ("Month", "30d"), ("Quarter", "90d"), ("Year", "365d")]],
         "current": {"selected": True, "text": "Day", "value": "1d"}, "multi": False, "includeAll": False}]},
    "annotations": {"list": [
        {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True, "hide": True,
         "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts", "type": "dashboard"},
        {"name": "Section alerts", "datasource": DS, "enable": True, "iconColor": "orange",
         "expr": 'ALERTS{alertstate="firing",alertname=~"Section.*|Sender01Low"}', "step": "30s",
         "titleFormat": "{{alertname}}", "textFormat": "{{section}}", "tagKeys": "severity", "useValueForTime": False}]},
    "panels": panels}
json.dump(dash, open(sys.argv[1], "w"), indent=2)
print(len(panels), "panels")
