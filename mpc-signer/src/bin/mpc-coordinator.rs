//! Stateless coordinator. Holds NO key material.
//!
//! * WebSocket relay for MPC protocol messages (end-to-end signed/encrypted by the nodes)
//! * Presignature pool per key, refilled in the background
//! * Ethereum signer JSON-RPC (`eth_accounts`, `eth_signTransaction`, `eth_sendTransaction`;
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
    /// Presignatures kept ready per key of pool class "big" (hot senders such as SENDER01).
    #[arg(long, env = "MPC_POOL_TARGET", default_value_t = 200)]
    pool_target: usize,
    /// Presignatures kept ready per key of pool class "small" (e.g. accounts created through the
    /// proxy: enough for a short burst without the cost of a big pool for every account).
    /// 0 = this coordinator keeps no small pools (e.g. on the standby coordinator).
    #[arg(long, env = "MPC_POOL_TARGET_SMALL", default_value_t = 20)]
    pool_target_small: usize,
    /// Concurrent presign sessions (cluster wide).
    #[arg(long, env = "MPC_REFILL_CONCURRENCY", default_value_t = 4)]
    refill_concurrency: usize,
    /// Comma-separated addresses of class "big" for keys without a pool class stored on the
    /// nodes (e.g. SENDER01 from the key ceremony). Empty = every such key is "big". Keys with a
    /// class (POST /admin/keys {"pool": ...}, POST /admin/keys/<address>/pool) follow their
    /// class; other keys are signed with the full interactive protocol (cold path).
    #[arg(long, env = "MPC_POOL_KEYS", default_value = "")]
    pool_keys: String,
    /// When the pool is empty, run the full interactive (3+1 round) protocol instead of failing.
    #[arg(long, env = "MPC_COLD_FALLBACK", default_value_t = true, action = clap::ArgAction::Set)]
    cold_fallback: bool,
    /// Bearer token Prometheus must send to GET /metrics. Empty = /metrics is open (it holds no
    /// secrets: counters, pool sizes, node reachability, hot-sender addresses).
    #[arg(long, env = "MPC_METRICS_TOKEN", default_value = "", hide_env_values = true)]
    metrics_token: String,
}

/// Seconds between background re-reads of the key list from the nodes.
const KEY_REFRESH_SECS: u64 = 30;

/// Latency histogram in Prometheus format (cumulative buckets, seconds).
const BUCKETS_MS: [u64; 12] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

#[derive(Default)]
struct Histogram {
    buckets: [AtomicU64; 12],
    count: AtomicU64,
    sum_ms: AtomicU64,
}

impl Histogram {
    fn observe(&self, d: Duration) {
        let ms = d.as_millis() as u64;
        for (i, b) in BUCKETS_MS.iter().enumerate() {
            if ms <= *b {
                self.buckets[i].fetch_add(1, Relaxed);
            }
        }
        self.count.fetch_add(1, Relaxed);
        self.sum_ms.fetch_add(ms, Relaxed);
    }

    fn render(&self, out: &mut String, name: &str, labels: &str) {
        for (i, b) in BUCKETS_MS.iter().enumerate() {
            out.push_str(&format!("{name}_bucket{{{labels},le=\"{}\"}} {}\n", *b as f64 / 1000.0, self.buckets[i].load(Relaxed)));
        }
        let n = self.count.load(Relaxed);
        out.push_str(&format!("{name}_bucket{{{labels},le=\"+Inf\"}} {n}\n"));
        out.push_str(&format!("{name}_sum{{{labels}}} {}\n", self.sum_ms.load(Relaxed) as f64 / 1000.0));
        out.push_str(&format!("{name}_count{{{labels}}} {n}\n"));
    }
}

/// Last health probe of one node (GET <node url>/health, every 10 s).
#[derive(Clone, Copy)]
struct NodeHealth {
    up: bool,
    seconds: f64,
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
    policy_refusals: AtomicU64,
    sign_hot: Histogram,
    sign_cold: Histogram,
}

struct Coord {
    cli: Cli,
    /// lowercase addresses of class "big" when the nodes store no class for them; None = all
    pool_keys: Option<std::collections::HashSet<String>>,
    /// pool class stored on the nodes per key (lowercase address -> big/small/none)
    classes: Mutex<HashMap<String, String>>,
    cluster: Arc<ClusterConfig>,
    http: reqwest::Client,
    keys: Mutex<HashMap<String, KeyInfo>>, // address (lowercase) -> key
    pools: Mutex<HashMap<String, KeyPool>>,
    pool_target: AtomicUsize,
    pool_target_small: AtomicUsize,
    refill: Arc<Semaphore>,
    rotation: AtomicUsize,
    node_down_until: Mutex<HashMap<u16, Instant>>,
    relay: Mutex<HashMap<String, RelaySession>>,
    stats: Stats,
    chain_id: u64,
    node_health: Mutex<HashMap<u16, NodeHealth>>,
    started: Instant,
    /// When the key list was last read from the nodes (None = never).
    keys_refreshed: Mutex<Option<Instant>>,
    /// Serialises refreshes, so a burst of unknown-account requests reads the nodes once.
    refresh_gate: tokio::sync::Mutex<()>,
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
    let pool_keys: std::collections::HashSet<String> = cli
        .pool_keys
        .split(',')
        .map(|a| a.trim().to_lowercase())
        .filter(|a| !a.is_empty())
        .collect();
    let coord = Arc::new(Coord {
        pool_keys: if pool_keys.is_empty() { None } else { Some(pool_keys) },
        chain_id: cluster.policy.chain_id,
        pool_target: AtomicUsize::new(cli.pool_target),
        pool_target_small: AtomicUsize::new(cli.pool_target_small),
        classes: Mutex::new(HashMap::new()),
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
        node_health: Mutex::new(HashMap::new()),
        started: Instant::now(),
        keys_refreshed: Mutex::new(None),
        refresh_gate: tokio::sync::Mutex::new(()),
    });

    let app = Router::new()
        .route("/", post(jsonrpc))
        .route("/health", get(|| async { "ok" }))
        .route("/upcheck", get(|| async { "OK" }))
        .route("/relay/:session", get(relay_ws))
        .route("/admin/aux", post(admin_aux))
        .route("/admin/keys", post(admin_keygen).get(admin_keys))
        .route("/admin/keys/:address/pool", post(admin_key_pool))
        .route("/admin/pool", get(admin_pool))
        .route("/admin/pool/target", post(admin_pool_target))
        .route("/admin/pool/clear", post(admin_pool_clear))
        .route("/metrics", get(metrics))
        .with_state(coord.clone());

    // load keys once the HTTP server (and so the relay) is up, then re-read them periodically:
    // another coordinator of the same cluster may have created keys (POST /admin/keys)
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
            loop {
                tokio::time::sleep(Duration::from_secs(KEY_REFRESH_SECS)).await;
                if let Err(e) = c.refresh_keys().await {
                    tracing::warn!("periodic key refresh failed: {e:#}");
                }
            }
        });
    }
    tokio::spawn(refill_loop(coord.clone()));
    tokio::spawn(health_loop(coord.clone()));

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

    /// The key's pool class: the one stored on the nodes, else MPC_POOL_KEYS (listed or empty
    /// list = "big", otherwise "none").
    fn class_of(&self, address: &str) -> String {
        if let Some(c) = self.classes.lock().get(address) {
            return c.clone();
        }
        if self.pool_keys.as_ref().map(|k| k.contains(address)).unwrap_or(true) { "big" } else { "none" }.to_string()
    }

    /// Presignatures this coordinator keeps ready for the key.
    fn target_for(&self, address: &str) -> usize {
        match self.class_of(address).as_str() {
            "big" => self.pool_target.load(Relaxed),
            "small" => self.pool_target_small.load(Relaxed),
            _ => 0,
        }
    }

    fn pooled(&self, address: &str) -> bool {
        self.target_for(address) > 0
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
    /// Read the key list from the nodes. A key is usable when at least `threshold` nodes hold it,
    /// so one node being down (or restored from an older backup) does not block the refresh.
    /// Keys are only ever added: a node that does not answer never removes a key.
    async fn refresh_keys(&self) -> Result<usize> {
        let _gate = self.refresh_gate.lock().await;
        let n = self.cluster.n();
        let views = join_all((0..n).map(|id| async move {
            tokio::time::timeout(Duration::from_secs(10), self.node_get::<Vec<KeyInfo>>(id, "/v1/keys"))
                .await
                .map_err(|_| anyhow!("node {id}: timeout"))
                .and_then(|r| r)
        }))
        .await;
        let answered: Vec<Vec<KeyInfo>> = views.into_iter().filter_map(|v| v.ok()).collect();
        let threshold = self.cluster.threshold as usize;
        ensure!(
            answered.len() >= threshold,
            "only {} of {n} nodes answered, {threshold} needed",
            answered.len()
        );
        let mut held: HashMap<String, (KeyInfo, usize)> = HashMap::new();
        let mut votes: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for view in &answered {
            for k in view {
                held.entry(k.address.to_lowercase()).or_insert_with(|| (k.clone(), 0)).1 += 1;
                if let Some(p) = &k.pool {
                    *votes.entry(k.address.to_lowercase()).or_default().entry(p.clone()).or_default() += 1;
                }
            }
        }
        // pool class: the one most nodes store (a node that missed a change is outvoted)
        let classes: HashMap<String, String> = votes
            .into_iter()
            .filter_map(|(a, v)| majority_class(v).map(|p| (a, p)))
            .collect();
        *self.classes.lock() = classes;
        let mut keys = self.keys.lock();
        let before = keys.len();
        for (address, (info, count)) in held {
            if count >= threshold {
                keys.entry(address).or_insert(info);
            }
        }
        let mut pools = self.pools.lock();
        for k in keys.keys() {
            if self.pooled(k) {
                pools.entry(k.clone()).or_default();
            }
        }
        if keys.len() > before && before > 0 {
            tracing::info!(new = keys.len() - before, total = keys.len(), "new keys found on the nodes");
        }
        *self.keys_refreshed.lock() = Some(Instant::now());
        Ok(keys.len())
    }

    /// Refresh unless the last refresh is more recent than `max_age`.
    async fn refresh_keys_if_older(&self, max_age: Duration) -> Result<()> {
        let fresh = self.keys_refreshed.lock().map(|t| t.elapsed() < max_age).unwrap_or(false);
        if !fresh {
            self.refresh_keys().await?;
        }
        Ok(())
    }

    fn key(&self, address: &str) -> Result<KeyInfo> {
        self.keys
            .lock()
            .get(&address.to_lowercase())
            .cloned()
            .ok_or_else(|| anyhow!("account {address} is not managed by this signer"))
    }

    /// Like key(), but an unknown account first triggers a refresh (at most once per second):
    /// it may have been created through another coordinator.
    async fn key_or_refresh(&self, address: &str) -> Result<KeyInfo> {
        if let Ok(k) = self.key(address) {
            return Ok(k);
        }
        if let Err(e) = self.refresh_keys_if_older(Duration::from_secs(1)).await {
            tracing::warn!("key refresh for {address} failed: {e:#}");
        }
        self.key(address)
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
        let mut wanted: Vec<String> = vec![];
        {
            let mut pools = c.pools.lock();
            // round-robin one job per key per pass, so many keys share capacity fairly
            for (key, p) in pools.iter_mut() {
                let target = c.target_for(key);
                if target == 0 {
                    continue;
                }
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

// ============================================================ JSON-RPC (Ethereum signer API)

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
                // clients (the proxy) decide from this list whether we sign for an account
                if let Err(e) = c.refresh_keys_if_older(Duration::from_secs(5)).await {
                    tracing::warn!("key refresh for eth_accounts failed: {e:#}");
                }
                let mut v: Vec<String> = c.keys.lock().keys().cloned().collect();
                v.sort();
                Ok(json!(v))
            }
            "eth_signTransaction" | "eth_sendTransaction" => {
                let t: RpcTx = serde_json::from_value(params.get(0).cloned().ok_or_else(|| anyhow!("missing tx"))?)?;
                let key = c.key_or_refresh(&t.from).await?;
                let tx = build_intent(c, &t).await?;
                let t0 = Instant::now();
                let signed = sign_tx(c, &key, &tx).await.inspect_err(|e| {
                    c.stats.failed_signs.fetch_add(1, Relaxed);
                    if format!("{e:#}").contains("policy:") {
                        c.stats.policy_refusals.fetch_add(1, Relaxed);
                    }
                })?;
                if signed.hot { &c.stats.sign_hot } else { &c.stats.sign_cold }.observe(t0.elapsed());
                tracing::debug!(hot = signed.hot, "signed");
                let raw = format!("0x{}", hex::encode(&signed.raw));
                if method == "eth_signTransaction" {
                    Ok(json!(raw))
                } else {
                    besu(c, "eth_sendRawTransaction", json!([raw])).await
                }
            }
            _ => {
                // transparent proxy to Besu
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

#[derive(Deserialize, Default)]
struct PoolBody {
    /// big, small or none
    #[serde(default)]
    pool: Option<String>,
}

fn bad_request(e: anyhow::Error) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, format!("{e:#}"))
}

/// POST /admin/keys, optional body {"pool": "big"|"small"|"none"}: the new key's pool class,
/// stored with the key on the nodes (no body: no class, MPC_POOL_KEYS decides).
async fn admin_keygen(
    State(c): State<Arc<Coord>>,
    h: HeaderMap,
    body: Option<Json<PoolBody>>,
) -> Result<Json<KeyInfo>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    let pool = body.map(|Json(b)| b.pool).unwrap_or_default();
    if let Some(p) = &pool {
        check_pool_class(p).map_err(bad_request)?;
    }
    let req = KeygenReq { session: new_session(), relay_url: c.cli.relay_url.clone(), pool };
    let rs = join_all((0..c.cluster.n()).map(|id| c.node_post::<_, KeyInfo>(id, "/v1/keygen", &req))).await;
    let rs: Vec<KeyInfo> = rs.into_iter().collect::<Result<_>>().map_err(err500)?;
    if !rs.windows(2).all(|w| w[0] == w[1]) {
        return Err(err500(anyhow!("nodes derived different public keys")));
    }
    c.refresh_keys().await.map_err(err500)?;
    Ok(Json(rs[0].clone()))
}

/// POST /admin/keys/<address>/pool {"pool": "big"|"small"|"none"} (null: clear, MPC_POOL_KEYS
/// decides): stored on every node that answers; needs at least `threshold` of them. Every
/// coordinator follows the new class at its next key refresh (this one at once).
async fn admin_key_pool(
    State(c): State<Arc<Coord>>,
    axum::extract::Path(address): axum::extract::Path<String>,
    h: HeaderMap,
    Json(b): Json<PoolBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    if let Some(p) = &b.pool {
        check_pool_class(p).map_err(bad_request)?;
    }
    let key = c.key_or_refresh(&address).await.map_err(|e| (StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let req = KeyPoolReq { key_id: key.key_id.clone(), pool: b.pool.clone() };
    let rs = join_all((0..c.cluster.n()).map(|id| c.node_post::<_, KeyInfo>(id, "/v1/keys/pool", &req))).await;
    let ok = rs.iter().filter(|r| r.is_ok()).count();
    let errors: Vec<String> = rs.iter().filter_map(|r| r.as_ref().err().map(|e| format!("{e:#}"))).collect();
    if ok < c.cluster.threshold as usize {
        return Err(err500(anyhow!(
            "pool class stored on {ok} nodes, {} needed (nodes must run a version with /v1/keys/pool): {}",
            c.cluster.threshold,
            errors.join("; ")
        )));
    }
    c.refresh_keys().await.map_err(err500)?;
    let addr = key.address.to_lowercase();
    Ok(Json(json!({"address": key.address, "pool": c.class_of(&addr), "target": c.target_for(&addr),
                   "nodes_updated": ok, "errors": errors})))
}

async fn admin_keys(State(c): State<Arc<Coord>>) -> Json<Vec<KeyInfo>> {
    let mut v: Vec<KeyInfo> = c
        .keys
        .lock()
        .iter()
        .map(|(a, k)| (a.clone(), k.clone()))
        .collect::<Vec<_>>()
        .into_iter()
        .map(|(a, mut k)| {
            k.pool = Some(c.class_of(&a));
            k
        })
        .collect();
    v.sort_by(|a, b| a.address.cmp(&b.address));
    Json(v)
}

async fn admin_pool(State(c): State<Arc<Coord>>) -> Json<Value> {
    let pools: HashMap<String, Value> = c
        .pools
        .lock()
        .iter()
        .map(|(k, p)| (k.clone(), json!({"ready": p.ready.len(), "inflight": p.inflight, "pooled": c.pooled(k),
                                             "class": c.class_of(k), "target": c.target_for(k)})))
        .collect();
    let s = &c.stats;
    let gen = s.presigs_generated.load(Relaxed);
    Json(json!({
        "target": c.pool_target.load(Relaxed),
        "target_small": c.pool_target_small.load(Relaxed),
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

/// Probe every node's /health so a node that is down shows up in monitoring before a
/// signature needs it. Prometheus only has to reach the coordinator, not the node hosts.
async fn health_loop(c: Arc<Coord>) {
    let probe = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client");
    loop {
        for p in &c.cluster.parties {
            let url = format!("{}/health", p.url.trim_end_matches('/'));
            let t0 = Instant::now();
            let up = matches!(probe.get(&url).send().await, Ok(r) if r.status().is_success());
            c.node_health.lock().insert(p.id, NodeHealth { up, seconds: t0.elapsed().as_secs_f64() });
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

/// Prometheus text exposition (version 0.0.4).
async fn metrics(State(c): State<Arc<Coord>>, h: HeaderMap) -> Response {
    if !c.cli.metrics_token.is_empty() {
        let ok = h
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t.len() == c.cli.metrics_token.len() && t.bytes().zip(c.cli.metrics_token.bytes()).all(|(a, b)| a == b))
            .unwrap_or(false);
        if !ok {
            return (StatusCode::UNAUTHORIZED, "metrics token required").into_response();
        }
    }
    let s = &c.stats;
    let mut o = String::with_capacity(4096);
    let mut metric = |name: &str, kind: &str, help: &str, rows: Vec<(String, f64)>| {
        o.push_str(&format!("# HELP {name} {help}\n# TYPE {name} {kind}\n"));
        for (labels, v) in rows {
            if labels.is_empty() {
                o.push_str(&format!("{name} {v}\n"));
            } else {
                o.push_str(&format!("{name}{{{labels}}} {v}\n"));
            }
        }
    };
    metric("mpc_up", "gauge", "Coordinator is running.", vec![(String::new(), 1.0)]);
    metric("mpc_uptime_seconds", "gauge", "Seconds since the coordinator started.", vec![(String::new(), c.started.elapsed().as_secs_f64())]);
    metric("mpc_threshold", "gauge", "Nodes needed per signature.", vec![(String::new(), c.cluster.threshold as f64)]);
    metric("mpc_nodes", "gauge", "Nodes in cluster.json.", vec![(String::new(), c.cluster.parties.len() as f64)]);
    let health = c.node_health.lock().clone();
    let mut ids: Vec<u16> = c.cluster.parties.iter().map(|p| p.id).collect();
    ids.sort();
    metric(
        "mpc_node_up",
        "gauge",
        "Last /health probe of the node succeeded (1) or failed (0).",
        ids.iter().filter_map(|id| health.get(id).map(|h| (format!("node=\"{id}\""), if h.up { 1.0 } else { 0.0 }))).collect(),
    );
    metric(
        "mpc_node_probe_seconds",
        "gauge",
        "Duration of the last /health probe of the node.",
        ids.iter().filter_map(|id| health.get(id).map(|h| (format!("node=\"{id}\""), h.seconds))).collect(),
    );
    metric("mpc_keys", "gauge", "Keys known to the coordinator.", vec![(String::new(), c.keys.lock().len() as f64)]);
    metric(
        "mpc_pool_target",
        "gauge",
        "Presignatures kept ready per key of the class.",
        vec![
            ("class=\"big\"".to_string(), c.pool_target.load(Relaxed) as f64),
            ("class=\"small\"".to_string(), c.pool_target_small.load(Relaxed) as f64),
        ],
    );
    let pools: Vec<(String, usize, usize)> = c
        .pools
        .lock()
        .iter()
        .filter(|(k, _)| c.pooled(k))
        .map(|(k, p)| (format!("{k}\",class=\"{}", c.class_of(k)), p.ready.len(), p.inflight))
        .collect();
    let mut per_class: HashMap<String, f64> = POOL_CLASSES.iter().map(|p| (p.to_string(), 0.0)).collect();
    for a in c.keys.lock().keys() {
        *per_class.entry(c.class_of(a)).or_default() += 1.0;
    }
    metric(
        "mpc_pool_keys",
        "gauge",
        "Keys per pool class.",
        per_class.into_iter().map(|(p, n)| (format!("class=\"{p}\""), n)).collect(),
    );
    metric("mpc_pool_ready", "gauge", "Presignatures ready for the key.", pools.iter().map(|(k, r, _)| (format!("address=\"{k}\""), *r as f64)).collect());
    metric("mpc_pool_inflight", "gauge", "Presign sessions running for the key.", pools.iter().map(|(k, _, i)| (format!("address=\"{k}\""), *i as f64)).collect());
    metric("mpc_relay_sessions", "gauge", "Open relay sessions (presign, keygen, cold sign).", vec![(String::new(), c.relay.lock().len() as f64)]);
    metric(
        "mpc_signs_total",
        "counter",
        "Signatures produced, by path (hot = from a presignature, cold = full protocol).",
        vec![("path=\"hot\"".into(), s.hot_signs.load(Relaxed) as f64), ("path=\"cold\"".into(), s.cold_signs.load(Relaxed) as f64)],
    );
    metric("mpc_sign_failures_total", "counter", "Signing requests that failed (policy refusals included).", vec![(String::new(), s.failed_signs.load(Relaxed) as f64)]);
    metric("mpc_policy_refusals_total", "counter", "Signing requests refused by the node policy.", vec![(String::new(), s.policy_refusals.load(Relaxed) as f64)]);
    metric("mpc_presigs_generated_total", "counter", "Presignatures generated.", vec![(String::new(), s.presigs_generated.load(Relaxed) as f64)]);
    metric("mpc_presigs_failed_total", "counter", "Presign sessions that failed.", vec![(String::new(), s.presigs_failed.load(Relaxed) as f64)]);
    metric("mpc_presign_seconds_total", "counter", "Total time spent generating presignatures.", vec![(String::new(), s.presig_ms_total.load(Relaxed) as f64 / 1000.0)]);
    o.push_str("# HELP mpc_sign_duration_seconds Signing latency (excludes nonce/gas lookups and sending).\n# TYPE mpc_sign_duration_seconds histogram\n");
    s.sign_hot.render(&mut o, "mpc_sign_duration_seconds", "path=\"hot\"");
    s.sign_cold.render(&mut o, "mpc_sign_duration_seconds", "path=\"cold\"");
    ([(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")], o).into_response()
}

#[derive(Deserialize)]
struct TargetReq {
    /// pool size of class "big"
    #[serde(default)]
    target: Option<usize>,
    /// pool size of class "small"
    #[serde(default)]
    small: Option<usize>,
}

async fn admin_pool_target(
    State(c): State<Arc<Coord>>,
    h: HeaderMap,
    Json(t): Json<TargetReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    admin_ok(&c, &h)?;
    if let Some(v) = t.target {
        c.pool_target.store(v, Relaxed);
    }
    if let Some(v) = t.small {
        c.pool_target_small.store(v, Relaxed);
    }
    Ok(Json(json!({"target": c.pool_target.load(Relaxed), "target_small": c.pool_target_small.load(Relaxed)})))
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
