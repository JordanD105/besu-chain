# Shared by the dashboard generators (gen_*.py): the Alerts row every dashboard starts with.
DS = {"type": "prometheus", "uid": "prometheus"}

# What an alert is about: the first of these labels it has, the later ones winning
SUBJECT_LABELS = ["instance", "host", "address", "sender", "node", "section"]
FIRING = 'ALERTS{alertstate="firing"}'


def subject(expr):
    for label in SUBJECT_LABELS:
        expr = f'label_replace({expr}, "subject", "$1", "{label}", "(.+)")'
    return expr


def alerts_row(panels, nid, y):
    """Critical / warning counts and the table of every firing alert (all components). Returns the next y."""
    panels.append({"type": "row", "title": "Alerts", "id": nid(), "collapsed": False,
                   "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})
    y += 1

    def count(title, sev, color, desc, x):
        panels.append({
            "type": "stat", "title": title, "id": nid(), "datasource": DS, "description": desc,
            "gridPos": {"x": x, "y": y, "w": 4, "h": 6},
            "targets": [{"refId": "A", "expr": f'count(ALERTS{{alertstate="firing",severity="{sev}"}}) or vector(0)',
                         "legendFormat": "", "instant": True, "datasource": DS}],
            "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "background",
                        "graphMode": "none", "textMode": "auto", "justifyMode": "center"},
            "fieldConfig": {"defaults": {"unit": "none", "decimals": 0, "color": {"mode": "thresholds"}, "mappings": [],
                                         "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": color, "value": 1}]}},
                            "overrides": []}})

    count("Critical firing", "critical", "red",
          "Critical alerts firing now (all components). Details in the table and on Prometheus's Alerts page.", 0)
    count("Warnings firing", "warning", "orange", "Warning alerts firing now (all components).", 4)
    ranked = 'ALERTS{alertstate="firing",severity="critical"} * 3 or ALERTS{alertstate="firing",severity="warning"} * 2 or ALERTS{alertstate="firing"}'
    panels.append({
        "type": "table", "title": "Firing alerts", "id": nid(), "datasource": DS,
        "description": "Every alert firing now, critical first. 'Firing for' counts from when the condition started "
                       "(including the rule's wait time). History: the Alert log dashboard.",
        "gridPos": {"x": 8, "y": y, "w": 16, "h": 6},
        "targets": [
            {"refId": "A", "expr": f'max by (alertname, severity, subject) ({subject("(" + ranked + ")")})',
             "format": "table", "instant": True, "datasource": DS},
            {"refId": "B", "expr": f'max by (alertname, severity, subject) ((time() - {subject("ALERTS_FOR_STATE")}) and on(alertname, severity, subject) '
                                   f'{subject(FIRING)})',
             "format": "table", "instant": True, "datasource": DS}],
        "transformations": [{"id": "merge", "options": {}},
                            {"id": "organize", "options": {
                                "excludeByName": {"Time": True},
                                "renameByName": {"severity": "Severity", "alertname": "Alert", "subject": "Subject",
                                                 "Value #A": "rank", "Value #B": "Firing for"},
                                "indexByName": {"severity": 0, "alertname": 1, "subject": 2, "Value #B": 3, "Value #A": 4}}}],
        "options": {"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "rank", "desc": True}], "footer": {"show": False}},
        "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}, "noValue": "none firing"},
                        "overrides": [
                            {"matcher": {"id": "byName", "options": "rank"}, "properties": [{"id": "custom.hidden", "value": True}]},
                            {"matcher": {"id": "byName", "options": "Firing for"}, "properties": [{"id": "unit", "value": "s"}]},
                            {"matcher": {"id": "byName", "options": "Severity"}, "properties": [
                                {"id": "custom.width", "value": 100},
                                {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
                                {"id": "mappings", "value": [{"type": "value", "options": {
                                    "critical": {"text": "CRITICAL", "color": "red", "index": 0},
                                    "warning": {"text": "WARNING", "color": "orange", "index": 1},
                                    "info": {"text": "INFO", "color": "blue", "index": 2}}}]}]}]}})
    return y + 6
