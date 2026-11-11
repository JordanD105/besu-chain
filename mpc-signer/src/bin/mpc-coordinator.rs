//! Stateless coordinator. Holds NO key material.
//!
//! * WebSocket relay for MPC protocol messages (end-to-end signed/encrypted by the nodes)
//! * Presignature pool per key, refilled in the background
//! * Web3Signer-compatible JSON-RPC (`eth_accounts`, `eth_signTransaction`, `eth_sendTransaction`;
//!   every other method is proxied to Besu) so existing clients switch by changing a URL
//! * Admin API: aux-info generation, key generation, pool status

use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cggmp24::{generic_ec::Point, PartialSignature, Signature};
use clap::Parser;
use futures::{future::join_all, SinkExt, StreamExt};
use mpc_signer::{api::*, cluster::ClusterConfig, eth, transport::Envelope, E};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};

#[derive(Parser, Clone)]
#[command(about = "MPC signing coordinator (no key material)")]
struct Cli {
    #[arg(long, env = "MPC_CLUSTER")]
    cluster: PathBuf,
    #[arg(long, env = "MPC_LISTEN", default_value = "127.0.0.1:9100")]
    listen: SocketAddr,
    /// Relay URL as reachable by the nodes, e.g. ws://10.0.0.5:9100/relay
    #[arg(long, env = "MPC_RELAY_URL", default_value = "ws://127.0.0.1:9100/relay")]
    relay_url: String,
    /// Token presented to nodes.
    #[arg(long, env = "MPC_NODE_TOKEN", hide_env_values = true)]
    node_token: String,
    /// Token required on /admin endpoints.
    #[arg(long, env = "MPC_ADMIN_TOKEN", hide_env_values = true)]
    admin_token: String,
    /// Besu JSON-RPC endpoint (downstream).
    #[arg(long, env = "MPC_BESU_RPC", default_value = "http://127.0.0.1:8545")]
    besu_rpc: String,
    /// Presignatures kept ready per key.
    #[arg(long, env = "MPC_POOL_TARGET", default_value_t = 200)]
    pool_target: usize,
    /// Concurrent presign sessions (cluster wide).
    #[arg(long, env = "MPC_REFILL_CONCURRENCY", default_value_t = 4)]
    refill_concurrency: usize,
    /// When the pool is empty, run the full interactive (3+1 round) protocol instead of failing.
    #[arg(long, env = "MPC_COLD_FALLBACK", default_value_t = true, action = clap::ArgAction::Set)]
    cold_fallback: bool,
}

struct PoolEntry {
    presig_id: String,
    signers: Vec<u16>,
    public: PresigPublic,
}

#[derive(Default)]
struct KeyPool {
    ready: VecDeque<PoolEntry>,
    inflight: usize,
}

#[derive(Default)]
struct Stats {
    hot_signs: AtomicU64,
    cold_signs: AtomicU64,
    failed_signs: AtomicU64,
    presigs_generated: AtomicU64,
    presigs_failed: AtomicU64,
    presig_ms_total: AtomicU64,
}

struct Coord {
    cli: Cli,
    cluster: Arc<ClusterConfig>,
    http: reqwest::Client,
    keys: Mutex<HashMap<String, KeyInfo>>, // address (lowercase) -> key
    pools: Mutex<HashMap<String, KeyPool>>,
    pool_target: AtomicUsize,
    refill: Arc<Semaphore>,
    rotation: AtomicUsize,
    node_down_until: Mutex<HashMap<u16, Instant>>,
    relay: Mutex<HashMap<String, RelaySession>>,
    stats: Stats,
    chain_id: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    ensure!(cli.node_token.len() >= 16 && cli.admin_token.len() >= 16, "tokens must be at least 16 characters");
    let cluster = Arc::new(ClusterConfig::load(&cli.cluster)?);
    let http = reqwest::Client::builder()
        .pool_max_idle_per_host(512)
        .tcp_nodelay(true)
        .timeout(Duration::from_secs(900))
        .build()?;
    let coord = Arc::new(Coord {
        chain_id: cluster.policy.chain_id,
        pool_target: AtomicUsize::new(cli.pool_target),
        refill: Arc::new(Semaphore::new(cli.refill_concurrency.max(1))),
        cli: cli.clone(),
        cluster,
        http,
        keys: Mutex::new(HashMap::new()),
        pools: Mutex::new(HashMap::new()),
        rotation: AtomicUsize::new(0),
        node_down_until: Mutex::new(HashMap::new()),
        relay: Mutex::new(HashMap::new()),
        stats: Stats::default(),
    });

    let app = Router::new()
        .route("/", post(jsonrpc))
        .route("/health", get(|| async { "ok" }))
        .route("/upcheck", get(|| async { "OK" }))
        .route("/relay/:session", get(relay_ws))
        .route("/admin/aux", post(admin_aux))
        .route("/admin/keys", post(admin_keygen).get(admin_keys))
        .route("/admin/pool", get(admin_pool))
        .route("/admin/pool/target", post(admin_pool_target))
        .route("/admin/pool/clear", post(admin_pool_clear))
        .with_state(coord.clone());

    // load keys once the HTTP server (and so the relay) is up
    {
        let c = coord.clone();
        tokio::spawn(async move {
            loop {
                match c.refresh_keys().await {
                    Ok(n) => {
                        tracing::info!(keys = n, "keys loaded from nodes");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("waiting for nodes: {e:#}");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });
    }
    tokio::spawn(refill_loop(coord.clone()));

    let listener = tokio::net::TcpListener::bind(cli.listen).await?;
    tracing::info!(listen = %cli.listen, "coordinator listening");
    axum::serve(listener, app).await?;
    Ok(())
}

// ============================================================ node client

impl Coord {
    async fn node_post<Req: serde::Serialize, Resp: serde::de::DeserializeOwned>(
        &self,
        id: u16,
        path: &str,
        body: &Req,
    ) -> Result<Resp> {
        let url = format!("{}{}", self.cluster.party(id)?.url.trim_end_matches('/'), path);
        let r = self
            .http
            .post(&url)
            .bearer_auth(&self.cli.node_token)
            .json(body)
            .send()
            .await
            .with_context(|| format!("node {id} unreachable"));
        let r = match r {
            Ok(r) => r,
            Err(e) => {
                self.mark_down(id);
                return Err(e);
            }
        };
        let status = r.status();
        let bytes = r.bytes().await?;
        if !status.is_success() {
            let msg = serde_json::from_slice::<ErrorResp>(&bytes)
                .map(|e| e.error)
                .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string());
            bail!("node {id}: {msg}");
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn node_get<Resp: serde::de::DeserializeOwned>(&self, id: u16, path: &str) -> Result<Resp> {
        let url = format!("{}{}", self.cluster.party(id)?.url.trim_end_matches('/'), path);
        let r = self.http.get(&url).bearer_auth(&self.cli.node_token).send().await?;
        ensure!(r.status().is_success(), "node {id}: HTTP {}", r.status());
        Ok(r.json().await?)
    }

    fn mark_down(&self, id: u16) {
        self.node_down_until.lock().insert(id, Instant::now() + Duration::from_secs(5));
    }

    fn is_up(&self, id: u16) -> bool {
        self.node_down_until.lock().get(&id).map(|t| Instant::now() >= *t).unwrap_or(true)
    }

    /// Next signer subset (size = threshold) of healthy nodes, rotating to spread load.
    fn pick_signers(&self) -> Result<Vec<u16>> {
        let combos = combinations(self.cluster.n(), self.cluster.threshold);
        let start = self.rotation.fetch_add(1, Relaxed);
        for k in 0..combos.len() {
            let c = &combos[(start + k) % combos.len()];
            if c.iter().all(|i| self.is_up(*i)) {
                return Ok(c.clone());
            }
        }
        bail!("not enough healthy nodes to reach threshold {}", self.cluster.threshold)
    }

    /// Keys must be identical on every node.
    async fn refresh_keys(&self) -> Result<usize> {
        let mut views = vec![];
        for id in 0..self.cluster.n() {
            views.push(self.node_get::<Vec<KeyInfo>>(id, "/v1/keys").await?);
        }
        let first = views[0].clone();
        ensure!(views.iter().all(|v| *v == first), "nodes disagree on the key set");
        let mut keys = self.keys.lock();
        keys.clear();
        for k in first {
            keys.insert(k.address.to_lowercase(), k);
        }
        let mut pools = self.pools.lock();
        for k in keys.keys() {
            pools.entry(k.clone()).or_default();
        }
        Ok(keys.len())
    }

    fn key(&self, address: &str) -> Result<KeyInfo> {
        self.keys
            .lock()
            .get(&address.to_lowercase())
            .cloned()
            .ok_or_else(|| anyhow!("account {address} is not managed by this signer"))
    }
}

fn combinations(n: u16, k: u16) -> Vec<Vec<u16>> {
    fn rec(start: u16, n: u16, k: u16, cur: &mut Vec<u16>, out: &mut Vec<Vec<u16>>) {
        if cur.len() == k as usize {
            out.push(cur.clone());
            return;
        }
        for i in start..n {
            cur.push(i);
            rec(i + 1, n, k, cur, out);
            cur.pop();
        }
    }
    let mut out = vec![];
    rec(0, n, k, &mut vec![], &mut out);
    out
}

fn new_session() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// ============================================================ presignature pool

async fn refill_loop(c: Arc<Coord>) {
    loop {
        let target = c.pool_target.load(Relaxed);
        let mut wanted: Vec<String> = vec![];
        {
            let mut pools = c.pools.lock();
            // round-robin one job per key per pass, so many keys share capacity fairly
            for (key, p) in pools.iter_mut() {
                if p.ready.len() + p.inflight < target && c.refill.available_permits() > wanted.len() {
                    p.inflight += 1;
                    wanted.push(key.clone());
                }
            }
        }
        if wanted.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        }
        for key in wanted {
            let permit = c.refill.clone().acquire_owned().await.expect("semaphore open");
            let c2 = c.clone();
            tokio::spawn(async move {
                let t0 = Instant::now();
                let r = generate_presig(&c2, &key).await;
                let failed = {
                    let mut pools = c2.pools.lock();
                    let p = pools.entry(key.clone()).or_default();
                    p.inflight -= 1;
                    match r {
                        Ok(e) => {
                            p.ready.push_back(e);
                            c2.stats.presigs_generated.fetch_add(1, Relaxed);
                            c2.stats.presig_ms_total.fetch_add(t0.elapsed().as_millis() as u64, Relaxed);
                            false
                        }
                        Err(e) => {
                            c2.stats.presigs_failed.fetch_add(1, Relaxed);
                            tracing::warn!(key = %key, "presign failed: {e:#}");
                            true
                        }
                    }
                };
                if failed {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                drop(permit);
            });
        }
    }
}

async fn generate_presig(c: &Coord, address: &str) -> Result<PoolEntry> {
    let key = c.key(address)?;
    let signers = c.pick_signers()?;
    let session = new_session();
    let req = PresignReq {
        session: session.clone(),
        relay_url: c.cli.relay_url.clone(),
        key_id: key.key_id.clone(),
        signers: signers.clone(),
    };
    let results = join_all(signers.iter().map(|id| c.node_post::<_, PresignResp>(*id, "/v1/presign", &req))).await;
    let mut publics = vec![];
    for r in results {
        publics.push(r?.public);
    }
    ensure!(publics.windows(2).all(|w| w[0] == w[1]), "signers disagree on presignature public data");
    Ok(PoolEntry { presig_id: session, signers, public: publics.remove(0) })
}

// ============================================================ signing

struct Signed {
    raw: Vec<u8>,
    hot: bool,
}

async fn sign_tx(c: &Coord, key: &KeyInfo, tx: &eth::TxIntent) -> Result<Signed> {
    // Local policy pre-check gives a clean error and avoids burning a presignature.
    c.cluster.policy.check(tx)?;
    let pk_bytes = hex::decode(&key.public_key)?;
    let pk = Point::<E>::from_bytes(&pk_bytes).map_err(|_| anyhow!("bad public key"))?;
    let data = mpc_signer::data_to_sign(tx);

    for _attempt in 0..3 {
        let entry = c.pools.lock().get_mut(&key.address).and_then(|p| p.ready.pop_front());
        let Some(entry) = entry else { break };
        let req = PartialReq { key_id: key.key_id.clone(), presig_id: entry.presig_id.clone(), tx: tx.clone() };
        let parts = join_all(entry.signers.iter().map(|id| c.node_post::<_, PartialResp>(*id, "/v1/partial", &req))).await;
        let mut partials = vec![];
        let mut failed = None;
        for p in parts {
            match p.and_then(|p| {
                let b = hex::decode(p.sigma)?;
                let sigma = cggmp24::generic_ec::Scalar::<E>::from_be_bytes(&b).map_err(|_| anyhow!("bad sigma"))?;
                Ok(PartialSignature::<E> { sigma })
            }) {
                Ok(p) => partials.push(p),
                Err(e) => failed = Some(e),
            }
        }
        if let Some(e) = failed {
            // a policy refusal is final; anything else: try the next presignature
            if format!("{e:#}").contains("policy:") {
                return Err(e);
            }
            tracing::warn!("partial signing failed, retrying with another presignature: {e:#}");
            continue;
        }
        let public = entry.public.to_data()?;
        let sig = PartialSignature::combine(&partials, &public, data)
            .ok_or_else(|| anyhow!("partial signatures failed verification"))?;
        sig.verify(&pk, &data).map_err(|_| anyhow!("combined signature invalid"))?;
        c.stats.hot_signs.fetch_add(1, Relaxed);
        return Ok(Signed { raw: finish(tx, &pk_bytes, &sig)?, hot: true });
    }

    ensure!(c.cli.cold_fallback, "presignature pool empty for {}", key.address);
    // Cold path: full interactive signing.
    let signers = c.pick_signers()?;
    let req = FullSignReq {
        session: new_session(),
        relay_url: c.cli.relay_url.clone(),
        key_id: key.key_id.clone(),
        signers: signers.clone(),
        tx: tx.clone(),
    };
    let results = join_all(signers.iter().map(|id| c.node_post::<_, FullSignResp>(*id, "/v1/sign", &req))).await;
    let first = results.into_iter().next().ok_or_else(|| anyhow!("no signers"))??;
    let r = cggmp24::generic_ec::Scalar::<E>::from_be_bytes(&hex::decode(&first.r)?).map_err(|_| anyhow!("bad r"))?;
    let s = cggmp24::generic_ec::Scalar::<E>::from_be_bytes(&hex::decode(&first.s)?).map_err(|_| anyhow!("bad s"))?;
    let sig = Signature::<E>::from_raw_parts(
        cggmp24::generic_ec::NonZero::from_scalar(r).ok_or_else(|| anyhow!("r=0"))?,
        cggmp24::generic_ec::NonZero::from_scalar(s).ok_or_else(|| anyhow!("s=0"))?,
    )
    .normalize_s();
    sig.verify(&pk, &data).map_err(|_| anyhow!("signature invalid"))?;
    c.stats.cold_signs.fetch_add(1, Relaxed);
    Ok(Signed { raw: finish(tx, &pk_bytes, &sig)?, hot: false })
}

fn finish(tx: &eth::TxIntent, pk_sec1: &[u8], sig: &Signature<E>) -> Result<Vec<u8>> {
    let r: [u8; 32] = sig.r.to_be_bytes().as_bytes().try_into()?;
    let s: [u8; 32] = sig.s.to_be_bytes().as_bytes().try_into()?;
    let recid = eth::recovery_id(pk_sec1, &tx.signing_hash(), &r, &s)?;
    Ok(tx.encode_signed(recid, &r, &s))
}

// ============================================================ JSON-RPC (Web3Signer-compatible)

#[derive(Deserialize)]
struct RpcTx {
    from: String,
    to: Option<String>,
    gas: Option<String>,
    #[serde(rename = "gasPrice")]
    gas_price: Option<String>,
    value: Option<String>,
    data: Option<String>,
    input: Option<String>,
    nonce: Option<String>,
}

async fn besu(c: &Coord, method: &str, params: Value) -> Result<Value> {
    let r: Value = c
        .http
        .post(&c.cli.besu_rpc)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await?
        .json()
        .await?;
    if let Some(e) = r.get("error") {
        bail!("besu {method}: {}", e.get("message").and_then(|m| m.as_str()).unwrap_or("error"));
    }
    Ok(r.get("result").cloned().unwrap_or(Value::Null))
}

async fn build_intent(c: &Coord, t: &RpcTx) -> Result<eth::TxIntent> {
    let q = |v: &Value| -> Result<Vec<u8>> { eth::parse_quantity(v.as_str().unwrap_or("0x0")) };
    let data_hex = t.data.as_deref().or(t.input.as_deref()).unwrap_or("0x");
    let data = hex::decode(data_hex.trim_start_matches("0x"))?;
    let to = match t.to.as_deref() {
        None | Some("") | Some("0x") => None,
        Some(a) => Some(eth::parse_address(a)?),
    };
    let nonce = match &t.nonce {
        Some(n) => eth::quantity_to_u64(&eth::parse_quantity(n)?)?,
        None => eth::quantity_to_u64(&q(&besu(c, "eth_getTransactionCount", json!([t.from, "pending"])).await?)?)?,
    };
    let gas_price = match &t.gas_price {
        Some(g) => eth::parse_quantity(g)?,
        None => q(&besu(c, "eth_gasPrice", json!([])).await?)?,
    };
    let value = eth::parse_quantity(t.value.as_deref().unwrap_or("0x0"))?;
    let gas = match &t.gas {
        Some(g) => eth::quantity_to_u64(&eth::parse_quantity(g)?)?,
        None => {
            let mut call = json!({"from": t.from, "data": data_hex, "value": format!("0x{}", hex::encode(&value))});
            if let Some(to) = &t.to {
                call["to"] = json!(to);
            }
            eth::quantity_to_u64(&q(&besu(c, "eth_estimateGas", json!([call])).await?)?)?
        }
    };
    Ok(eth::TxIntent { chain_id: c.chain_id, nonce, gas_price, gas, to, value, data })
}

async fn handle_rpc(c: &Arc<Coord>, req: Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(json!([]));
    let res: Result<Value> = async {
        match method.as_str() {
            "eth_accounts" => {
                let mut v: Vec<String> = c.keys.lock().keys().cloned().collect();
                v.sort();
                Ok(json!(v))
            }
            "eth_signTransaction" | "eth_sendTransaction" => {
                let t: RpcTx = serde_json::from_value(params.get(0).cloned().ok_or_else(|| anyhow!("missing tx"))?)?;
                let key = c.key(&t.from)?;
                let tx = build_intent(c, &t).await?;
                let signed = sign_tx(c, &key, &tx).await.inspect_err(|_| {
                    c.stats.failed_signs.fetch_add(1, Relaxed);
                })?;
                tracing::debug!(hot = signed.hot, "signed");
                let raw = format!("0x{}", hex::encode(&signed.raw));
                if method == "eth_signTransaction" {
                    Ok(json!(raw))
                } else {
                    besu(c, "eth_sendRawTransaction", json!([raw])).await
                }
            }
            _ => {
                // transparent proxy, like Web3Signer
                let r: Value = c.http.post(&c.cli.besu_rpc).json(&req).send().await?.json().await?;
                return Ok(json!({"__raw": r}));
            }
        }
    }
    .await;
    match res {
        Ok(v) if v.get("__raw").is_some() => v["__raw"].clone(),
        Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
        Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":format!("{e:#}")}}),
    }
}

async fn jsonrpc(State(c): State<Arc<Coord>>, Json(body): Json<Value>) -> Json<Value> {
    match body {
        Value::Array(reqs) => Json(Value::Array(join_all(reqs.into_iter().map(|r| handle_rpc(&c, r))).await)),
        r => Json(handle_rpc(&c, r).await),
    }
}

// ============================================================ relay

struct RelaySession {
    participants: Vec<u16>,
    peers: HashMap<u16, RelayPeer>,
    created: Instant,
}

#[derive(Default)]
struct RelayPeer {
    tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
    backlog: Vec<Vec<u8>>,
    done: bool,
}

#[derive(Deserialize)]
struct RelayQuery {
    party: u16,
    parties: String,
}

async fn relay_ws(
    State(c): State<Arc<Coord>>,
    Path(session): Path<String>,
    Query(q): Query<RelayQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let parties: Result<Vec<u16>, _> = q.parties.split(',').map(|p| p.parse::<u16>()).collect();
    let Ok(parties) = parties else { return StatusCode::BAD_REQUEST.into_response() };
    if !parties.contains(&q.party) || parties.iter().any(|p| *p >= c.cluster.n()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    ws.max_message_size(64 << 20).on_upgrade(move |sock| relay_conn(c, session, q.party, parties, sock))
}

async fn relay_conn(c: Arc<Coord>, session: String, me: u16, parties: Vec<u16>, sock: WebSocket) {
    let (mut ws_tx, mut ws_rx) = sock.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let mut relay = c.relay.lock();
        relay.retain(|_, s| s.created.elapsed() < Duration::from_secs(1800));
        let s = relay.entry(session.clone()).or_insert_with(|| RelaySession {
            participants: parties.clone(),
            peers: HashMap::new(),
            created: Instant::now(),
        });
        if s.participants != parties {
            return;
        }
        let peer = s.peers.entry(me).or_default();
        for m in peer.backlog.drain(..) {
            let _ = tx.send(m);
        }
        peer.tx = Some(tx);
    }
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if ws_tx.send(Message::Binary(m)).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = ws_rx.next().await {
        let bytes = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue,
        };
        // Route on the (signed) header. The relay cannot read p2p bodies nor forge envelopes.
        let Ok(env) = Envelope::decode(&bytes) else { break };
        if env.from != me || env.session != session {
            break;
        }
        let targets: Vec<u16> = match env.to {
            Some(t) => vec![t],
            None => parties.iter().copied().filter(|p| *p != me).collect(),
        };
        let mut relay = c.relay.lock();
        let Some(s) = relay.get_mut(&session) else { break };
        for t in targets {
            if !s.participants.contains(&t) {
                continue;
            }
            let peer = s.peers.entry(t).or_default();
            match &peer.tx {
                Some(tx) => {
                    let _ = tx.send(bytes.clone());
                }
                None => peer.backlog.push(bytes.clone()),
            }
        }
    }
    {
        let mut relay = c.relay.lock();
        if let Some(s) = relay.get_mut(&session) {
            if let Some(p) = s.peers.get_mut(&me) {
                p.tx = None;
                p.done = true;
            }
            if s.participants.iter().all(|p| s.peers.get(p).map(|x| x.done).unwrap_or(false)) {
                relay.remove(&session);
            }
        }
    }
    writer.abort();
}

// ============================================================ admin

fn admin_ok(c: &Coord, h: &HeaderMap) -> Result<(), (StatusCode, String)> {
    let ok = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.len() == c.cli.admin_token.len() && t.bytes().zip(c.cli.admin_token.bytes()).all(|(a, b)| a == b))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "unauthorized".into()))
    }
}

fn err500(e: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
}

async fn admin_aux(State(c): State<Arc<Coord>>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    let req = AuxReq { session: new_session(), relay_url: c.cli.relay_url.clone() };
    let t0 = Instant::now();
    let rs = join_all((0..c.cluster.n()).map(|id| c.node_post::<_, Value>(id, "/v1/aux", &req))).await;
    let rs: Vec<Value> = rs.into_iter().collect::<Result<_>>().map_err(err500)?;
    Ok(Json(json!({"nodes": rs, "seconds": t0.elapsed().as_secs_f64()})))
}

async fn admin_keygen(State(c): State<Arc<Coord>>, h: HeaderMap) -> Result<Json<KeyInfo>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    let req = KeygenReq { session: new_session(), relay_url: c.cli.relay_url.clone() };
    let rs = join_all((0..c.cluster.n()).map(|id| c.node_post::<_, KeyInfo>(id, "/v1/keygen", &req))).await;
    let rs: Vec<KeyInfo> = rs.into_iter().collect::<Result<_>>().map_err(err500)?;
    if !rs.windows(2).all(|w| w[0] == w[1]) {
        return Err(err500(anyhow!("nodes derived different public keys")));
    }
    c.refresh_keys().await.map_err(err500)?;
    Ok(Json(rs[0].clone()))
}

async fn admin_keys(State(c): State<Arc<Coord>>) -> Json<Vec<KeyInfo>> {
    let mut v: Vec<KeyInfo> = c.keys.lock().values().cloned().collect();
    v.sort_by(|a, b| a.address.cmp(&b.address));
    Json(v)
}

async fn admin_pool(State(c): State<Arc<Coord>>) -> Json<Value> {
    let pools: HashMap<String, Value> = c
        .pools
        .lock()
        .iter()
        .map(|(k, p)| (k.clone(), json!({"ready": p.ready.len(), "inflight": p.inflight})))
        .collect();
    let s = &c.stats;
    let gen = s.presigs_generated.load(Relaxed);
    Json(json!({
        "target": c.pool_target.load(Relaxed),
        "pools": pools,
        "stats": {
            "hot_signs": s.hot_signs.load(Relaxed),
            "cold_signs": s.cold_signs.load(Relaxed),
            "failed_signs": s.failed_signs.load(Relaxed),
            "presigs_generated": gen,
            "presigs_failed": s.presigs_failed.load(Relaxed),
            "avg_presign_ms": if gen > 0 { s.presig_ms_total.load(Relaxed) as f64 / gen as f64 } else { 0.0 },
        }
    }))
}

#[derive(Deserialize)]
struct TargetReq {
    target: usize,
}

async fn admin_pool_target(
    State(c): State<Arc<Coord>>,
    h: HeaderMap,
    Json(t): Json<TargetReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    c.pool_target.store(t.target, Relaxed);
    Ok(Json(json!({"target": t.target})))
}

/// Drop every ready presignature (coordinator and nodes). Used to force the cold path.
async fn admin_pool_clear(State(c): State<Arc<Coord>>, h: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    let mut by_node: HashMap<u16, Vec<String>> = HashMap::new();
    let mut cleared = 0usize;
    for p in c.pools.lock().values_mut() {
        for e in p.ready.drain(..) {
            cleared += 1;
            for s in &e.signers {
                by_node.entry(*s).or_default().push(e.presig_id.clone());
            }
        }
    }
    for (id, ids) in by_node {
        let _ = c.node_post::<_, Value>(id, "/v1/presign/discard", &json!({ "ids": ids })).await;
    }
    Ok(Json(json!({ "cleared": cleared })))
}
