import sys
# Regenerate: python3 docs/tools/gen_deployment_diagram.py docs/deployment-3-sites.svg
W,H=1600,1300
o=[]
def esc(t): return t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
def text(x,y,t,size=12.5,fill="#334155",weight=None,anchor=None,ls=None):
    a=f' font-weight="{weight}"' if weight else ''
    a+=f' text-anchor="{anchor}"' if anchor else ''
    a+=f' letter-spacing="{ls}"' if ls else ''
    o.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}"{a}>{esc(t)}</text>')
def rect(x,y,w,h,fill="#fff",stroke="#94a3b8",sw=1.5,rx=10,dash=None,shadow=True):
    d=f' stroke-dasharray="{dash}"' if dash else ''
    r=f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>'
    o.append(f'<g filter="url(#sh)">{r}</g>' if shadow else r)
def box(x,y,w,h,title,lines,stroke,fill="#ffffff",tcol="#0f172a",sub=None,subcol="#64748b",ts=14):
    rect(x,y,w,h,fill=fill,stroke=stroke)
    text(x+12,y+21,title,ts,tcol,"700")
    yy=y+21
    if sub: yy+=18; text(x+12,yy,sub,11.5,subcol)
    for l in lines:
        yy+=18
        if isinstance(l,tuple): text(x+12,yy,l[0],l[1],l[2])
        else: text(x+12,yy,l,12)
def line(x1,y1,x2,y2,col="#334155",sw=2,dash=None,m1=None,m2=None):
    d=f' stroke-dasharray="{dash}"' if dash else ''
    a=(f' marker-start="url(#{m1})"' if m1 else '')+(f' marker-end="url(#{m2})"' if m2 else '')
    o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{col}" stroke-width="{sw}"{d}{a}/>')

o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Inter, \'Segoe UI\', Helvetica, Arial, sans-serif">')
o.append('''<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker>
<marker id="g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#059669"/></marker>
<marker id="p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7c3aed"/></marker>
<marker id="b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2563eb"/></marker>
<filter id="sh" x="-5%" y="-5%" width="110%" height="115%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.10"/></filter>
</defs>''')
o.append(f'<rect width="{W}" height="{H}" fill="#f8fafc"/>')
text(40,50,"besu-chain: deployment across 3 sites",30,"#0f172a","700")
text(40,80,"① Center (primary) · ② Subsidiary 1 (DR / secondary) · ③ Subsidiary 2 (tie-breaker): any ONE whole site can fail; chain, signing and Redis failover keep working",15.5,"#475569")

# top: clients + GSLB
rect(40,100,230,52,stroke="#94a3b8")
text(56,122,"Clients",14,"#0f172a","700"); text(56,141,"apps · partners · browsers",12,"#475569")
line(270,126,316,126,m2="a")
rect(320,100,1240,52,stroke="#64748b")
text(336,122,"DNS / GSLB (global load balancing, health-checked)",14,"#0f172a","700")
text(336,141,"normal: all traffic → ① Center gateway · on Center outage: automatic failover → ② Subsidiary 1 gateway (low DNS TTL, e.g. 30 s)",12,"#475569")

# columns
cols=[(40,560,"① CENTER (HQ)","primary · active","#1e3a8a","#dbeafe"),
      (620,470,"② SUBSIDIARY 1","DR / secondary · warm standby","#065f46","#d1fae5"),
      (1110,450,"③ SUBSIDIARY 2","tie-breaker · no public entry","#7c2d12","#ffedd5")]
top,bot=172,1000
for x,w,name,role,c,f in cols:
    o.append(f'<rect x="{x}" y="{top}" width="{w}" height="{bot-top}" rx="16" fill="#ffffff" stroke="{c}" stroke-width="2"/>')
    o.append(f'<rect x="{x}" y="{top}" width="{w}" height="44" rx="16" fill="{f}"/>')
    o.append(f'<rect x="{x}" y="{top+28}" width="{w}" height="16" fill="{f}"/>')
    text(x+16,top+28,name,17,c,"700"); text(x+w-16,top+28,role,13,c,anchor="end")

# bands (light horizontal stripes inside columns) + labels
bands=[("EDGE",224,74,"#f1f5f9","#475569"),("APP",306,182,"#eff6ff","#1d4ed8"),
       ("SIGNING",496,170,"#ecfdf5","#047857"),("CHAIN",674,196,"#faf5ff","#6d28d9"),
       ("OPS",878,114,"#fffbeb","#92400e")]
for name,y,h,f,c in bands:
    for x,w,*_ in cols:
        o.append(f'<rect x="{x+8}" y="{y}" width="{w-16}" height="{h}" rx="10" fill="{f}"/>')
        o.append(f'<text x="{x+w-16}" y="{y+16}" font-size="10.5" font-weight="700" fill="{c}" text-anchor="end" letter-spacing="1">{name}</text>')

# GSLB arrows
line(300,152,300,232,m2="a")
line(860,152,860,232,dash="6 4",m2="a")

# ---------- EDGE
box(56,232,470,58,"API gateway / L7 LB (HA pair) · ACTIVE",["TLS 1.3 · client auth · rate limits · WAF"],"#64748b")
box(636,232,400,58,"API gateway (HA pair) · STANDBY",["same config; receives traffic only on failover"],"#64748b")
text(1126,262,"no public entry point",13,"#7c2d12","700")
text(1126,282,"(internal services only)",12,"#64748b")

# ---------- APP
box(56,326,220,154,"proxy × N · active",["stateless, autoscaled","Redis sender lock +","nonce INCR","→ coordinator (local)"],"#2563eb",tcol="#1e3a8a")
box(286,326,150,154,"Redis primary",["AOF, AUTH+TLS","nonces, locks,","pending, NFT data",("+ Sentinel #1",12,"#1d4ed8")],"#2563eb",tcol="#1e3a8a")
box(446,326,140,154,"chainlens × 2",["explorer, read-","only; own read","RPC node",("auth via gateway",11.5,"#64748b")],"#0891b2",tcol="#155e75")
box(636,326,180,154,"proxy × N · standby",["scaled down (0–1)","scale up on failover","nonces resync from","chain on promotion"],"#2563eb",tcol="#1e3a8a")
box(826,326,140,154,"Redis replica",["async replica","of Center","promoted by",("Sentinel #2",12,"#1d4ed8")],"#2563eb",tcol="#1e3a8a")
box(976,326,100,154,"chainlens",["× 1","standby"],"#0891b2",tcol="#155e75")
box(1126,326,200,96,"Redis Sentinel #3",["no data, votes only","2 of 3 sentinels agree","before any failover"],"#2563eb",tcol="#1e3a8a")
o.append('<path d="M 361 480 L 361 492 L 896 492 L 896 484" stroke="#2563eb" stroke-width="2" stroke-dasharray="6 4" fill="none" marker-end="url(#b)"/>')
text(640,506,"Redis replication :6379",11.5,"#1d4ed8")

# ---------- SIGNING
box(56,512,230,140,"mpc-coordinator × 2",["active · internal LB","no keys · presig pool","relay :9100 (WebSocket)",("hot sign = local node 0",11.5,"#64748b"),("+ 1 remote node (1 WAN RTT)",11.5,"#64748b")],"#059669",tcol="#064e3b")
box(296,512,290,140,"mpc-node 0 · share x₀",["operated by Center team","sealed share; passphrase from","Center secret store / TPM","policy: chain id, limits, allowlist",("backup → Center team only",11.5,"#92400e")],"#059669",tcol="#064e3b")
box(636,512,170,140,"mpc-coordinator",["× 1 · standby","takes over with","nodes 1 + 2 if","Center is down"],"#059669",tcol="#064e3b")
box(816,512,260,140,"mpc-node 1 · share x₁",["operated by Subsidiary 1 team","sealed share; S1 secret store","policy: same rules",("backup → S1 team only",11.5,"#92400e")],"#059669",tcol="#064e3b")
box(1126,512,420,140,"mpc-node 2 · share x₂",["operated by Subsidiary 2 team","sealed share; passphrase from S2 secret store / TPM","policy: same rules, enforced independently",("backup → S2 team only",11.5,"#92400e"),("any 2 of 3 nodes sign → one site can be down",11.5,"#047857")],"#059669",tcol="#064e3b")
line(286,582,292,582,col="#059669",m2="g")
o.append('<path d="M 171 652 L 171 662 L 1336 662 L 1336 656" stroke="#059669" stroke-width="2" stroke-dasharray="6 4" fill="none" marker-end="url(#g)"/>')
o.append('<path d="M 946 662 L 946 656" stroke="#059669" stroke-width="2" fill="none" marker-end="url(#g)"/>')
text(186,677,"mTLS over VPN · node API :7000 · relay :9100",11.5,"#047857")

# ---------- CHAIN
def vals(x,y,a,b):
    for i,(n) in enumerate((a,b)):
        xx=x+i*124
        o.append(f'<rect x="{xx}" y="{y}" width="112" height="40" rx="8" fill="#7c3aed"/>')
        o.append(f'<text x="{xx+56}" y="{y+25}" font-size="13" font-weight="600" fill="#ffffff" text-anchor="middle">validator {n}</text>')
rect(56,690,280,110,stroke="#7c3aed")
text(68,711,"QBFT validators (2 at this site)",14,"#4c1d95","700")
vals(68,722,1,2)
text(68,786,"p2p only · keys from Center secret store",12)
box(346,690,240,110,"RPC node (local) + read RPC",["proxy / coordinator use local","RPC, fail over to remote","read-only RPC for chainlens",("ETH, NET, WEB3, TXPOOL only",11.5,"#64748b")],"#7c3aed",tcol="#4c1d95")
rect(636,690,280,110,stroke="#7c3aed")
text(648,711,"QBFT validators (2 at this site)",14,"#4c1d95","700")
vals(648,722,3,4)
text(648,786,"p2p only · keys from S1 secret store",12)
box(926,690,150,110,"RPC node",["local, for S1","services on","failover"],"#7c3aed",tcol="#4c1d95")
rect(1126,690,280,110,stroke="#7c3aed")
text(1138,711,"QBFT validators (2 at this site)",14,"#4c1d95","700")
vals(1138,722,5,6)
text(1138,786,"p2p only · keys from S2 secret store",12)
box(1416,690,130,110,"RPC node",["local, for","S2 internal","tooling"],"#7c3aed",tcol="#4c1d95")
o.append('<path d="M 196 800 L 196 818 L 1266 818 L 1266 800" stroke="#7c3aed" stroke-width="2" fill="none" marker-start="url(#p)" marker-end="url(#p)"/>')
o.append('<path d="M 776 800 L 776 818" stroke="#7c3aed" stroke-width="2" fill="none" marker-start="url(#p)"/>')
text(212,836,"Besu p2p :30303 mesh · 6 validators, quorum 4",12,"#5b21b6","600")
text(212,854,"→ any one site (2 validators) can be lost",11.5,"#5b21b6")

# ---------- OPS
box(56,886,530,100,"Monitoring (primary) + bastion + secret store C",["Prometheus → Alertmanager → on-call · Grafana · Loki · Tempo","scrapes / receives from all 3 sites over VPN","bastion + MFA (Center admins) · backups: Besu snapshots, MPC share x₀"],"#f59e0b",tcol="#92400e")
box(636,886,440,100,"Monitoring replica + bastion + secret store S1",["Prometheus / Loki copy for DR (remote write)","bastion + MFA (S1 admins)","backups: Besu snapshots, MPC share x₁"],"#f59e0b",tcol="#92400e")
box(1126,886,420,100,"Agents + bastion + secret store S2",["Alloy + exporters → Center (and S1 copy)","bastion + MFA (S2 admins)","backups: Besu snapshots, MPC share x₂"],"#f59e0b",tcol="#92400e")

# ---------- bottom: inter-site links + failure table
rect(40,1020,740,260,stroke="#cbd5e1",shadow=False)
text(60,1048,"Inter-site links (site-to-site VPN / private WAN; mTLS on top)",15,"#0f172a","700")
rows=[("Besu p2p","TCP/UDP 30303","all validators + RPC nodes, all sites (mesh)"),
      ("MPC node API","TCP 7000","coordinators (C, S1) → nodes 0, 1, 2"),
      ("MPC relay","TCP 9100 (WSS)","nodes 0, 1, 2 → active coordinator"),
      ("Redis","TCP 6379 / 26379","replication C → S1 · Sentinels on all 3 sites"),
      ("Observability","9090 / 3100 / 4317","agents at S1, S2 → Center (+ S1 replica)"),
      ("Admin","SSH via bastion","each site only by its own team (no shared admin)")]
y=1076
text(60,y,"Flow",12,"#475569","700"); text(200,y,"Port",12,"#475569","700"); text(360,y,"Between",12,"#475569","700")
for a,b,c in rows:
    y+=28
    o.append(f'<line x1="60" y1="{y-19}" x2="760" y2="{y-19}" stroke="#e2e8f0"/>')
    text(60,y,a,12.5,"#0f172a","600"); text(200,y,b,12.5); text(360,y,c,12.5)
text(60,1266,"WAN latency: QBFT blockperiodseconds ≥ 2 and requesttimeoutseconds ≥ 4 × inter-site RTT; permission all 6 validators + RPC nodes",11,"#64748b")

rect(800,1020,760,260,stroke="#cbd5e1",shadow=False)
text(820,1048,"What happens when a whole site is down",15,"#0f172a","700")
rows=[("① Center down","GSLB → S1 gateway; Sentinels #2 + #3 promote S1 Redis;","S1 coordinator signs with nodes 1 + 2; chain: 4 of 6 validators = quorum","#b91c1c"),
      ("② Subsidiary 1 down","no user impact: Center signs with nodes 0 + 2;","chain 4 of 6 · DR capacity lost until S1 returns","#b45309"),
      ("③ Subsidiary 2 down","no user impact: Center signs with nodes 0 + 1;","chain 4 of 6 · Redis keeps quorum (Sentinel #1 + #2)","#b45309"),
      ("Two sites down","by design: signing stops (1 of 3 shares) and chain halts","(2 of 6 < quorum). No single site can sign or produce blocks alone.","#475569")]
y=1052
for a,b,c,col in rows:
    y+=28
    text(820,y,a,13,col,"700"); text(990,y,b,12.5); text(990,y+18,c,12.5)
    y+=26
o.append('</svg>')
open(sys.argv[1],'w').write("\n".join(o))
