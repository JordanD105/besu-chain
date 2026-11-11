//! MPC signer node: holds ONE key share per key, never the key.
//!
//! * `mpc-node init` creates the node identity (sealed on disk) and prints its public keys
//! * `mpc-node run`  serves the node API used by the coordinator

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cggmp24::{
    key_share::{IncompleteKeyShare, Valid},
    ExecutionId, PregeneratedPrimes, Presignature,
};
use clap::{Parser, Subcommand};
use mpc_signer::{
    api::*,
    cluster::{ClusterConfig, Identity},
    eth,
    store::SecretStore,
    transport::{self, SessionCtx},
    AuxInfo, AuxMsg, KeyShare, KeygenMsg, SigningMsg, E, L,
};
use parking_lot::{Mutex, RwLock};
use rand_core::OsRng;
use round_based::MpcParty;

#[derive(Parser)]
#[command(about = "Threshold ECDSA signer node (one key share, never the key)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create this node's identity and print its public keys (for cluster.json).
    Init {
        #[arg(long, env = "MPC_DATA_DIR")]
        data_dir: PathBuf,
        #[arg(long, env = "MPC_NODE_PASSPHRASE", hide_env_values = true)]
        passphrase: String,
    },
    /// Run the node API.
    Run {
        #[arg(long, env = "MPC_DATA_DIR")]
        data_dir: PathBuf,
        #[arg(long, env = "MPC_NODE_PASSPHRASE", hide_env_values = true)]
        passphrase: String,
        #[arg(long, env = "MPC_CLUSTER")]
        cluster: PathBuf,
        /// This node's party id in cluster.json.
        #[arg(long, env = "MPC_NODE_ID")]
        id: u16,
        #[arg(long, env = "MPC_LISTEN", default_value = "127.0.0.1:7000")]
        listen: SocketAddr,
        /// Bearer token the coordinator must present.
        #[arg(long, env = "MPC_NODE_TOKEN", hide_env_values = true)]
        token: String,
        /// Worker threads reserved for heavy MPC computation (presigning, keygen).
        #[arg(long, env = "MPC_COMPUTE_THREADS", default_value_t = 2)]
        compute_threads: usize,
        /// Upper bound on presignatures held in memory.
        #[arg(long, env = "MPC_MAX_PRESIGS", default_value_t = 100_000)]
        max_presigs: usize,
        /// Timeout for one interactive protocol run.
        #[arg(long, env = "MPC_PROTOCOL_TIMEOUT_SECS", default_value_t = 600)]
        protocol_timeout_secs: u64,
    },
}

const IDENTITY: &str = "identity.seed";
const AUX: &str = "aux.json";

struct Node {
    me: u16,
    cluster: Arc<ClusterConfig>,
    ident: Arc<Identity>,
    store: SecretStore,
    token: String,
    compute: tokio::runtime::Handle,
    aux: RwLock<Option<AuxInfo>>,
    keys: RwLock<HashMap<String, (Arc<KeyShare>, KeyInfo)>>,
    /// Presignatures are kept ONLY in memory: a restart can never resurrect (and so never
    /// reuse) one. Consumption removes the entry before the partial signature is issued.
    presigs: Mutex<HashMap<String, (String, Presignature<E>, Instant)>>,
    max_presigs: usize,
    protocol_timeout: Duration,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { data_dir, passphrase } => {
            let store = SecretStore::open(&data_dir, passphrase)?;
            if store.exists(IDENTITY) {
                bail!("identity already exists in {}", data_dir.display());
            }
            let seed = Identity::generate_seed();
            store.put(IDENTITY, &seed[..])?;
            let id = Identity::from_seed(&seed);
            println!("{}", serde_json::json!({ "sign_pk": id.sign_pk_hex(), "kx_pk": id.kx_pk_hex() }));
            Ok(())
        }
        Cmd::Run { data_dir, passphrase, cluster, id, listen, token, compute_threads, max_presigs, protocol_timeout_secs } => {
            ensure!(token.len() >= 16, "node token must be at least 16 characters");
            let compute_rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(compute_threads.max(1))
                .thread_name("mpc-compute")
                .enable_all()
                .build()?;
            let api_rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            let compute = compute_rt.handle().clone();
            api_rt.block_on(async move {
                let node = Arc::new(load_node(data_dir, passphrase, cluster, id, token, compute, max_presigs, protocol_timeout_secs)?);
                serve(node, listen).await
            })?;
            drop(compute_rt);
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn load_node(
    data_dir: PathBuf,
    passphrase: String,
    cluster: PathBuf,
    me: u16,
    token: String,
    compute: tokio::runtime::Handle,
    max_presigs: usize,
    protocol_timeout_secs: u64,
) -> Result<Node> {
    let cluster = Arc::new(ClusterConfig::load(&cluster)?);
    let store = SecretStore::open(&data_dir, passphrase)?;
    let seed: [u8; 32] = store
        .get(IDENTITY)
        .context("identity missing: run `mpc-node init` first")?
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("identity seed corrupted"))?;
    let ident = Identity::from_seed(&seed);
    let party = cluster.party(me)?;
    ensure!(
        party.sign_pk == ident.sign_pk_hex() && party.kx_pk == ident.kx_pk_hex(),
        "cluster.json public keys for party {me} do not match this node's identity"
    );
    let aux = if store.exists(AUX) {
        let t0 = Instant::now();
        let aux = optimize_aux(serde_json::from_slice::<AuxInfo>(&store.get(AUX)?)?, me)?;
        tracing::info!(secs = t0.elapsed().as_secs_f32(), "aux info loaded and multiexp tables precomputed");
        Some(aux)
    } else {
        None
    };
    let mut keys = HashMap::new();
    for key_id in store.list_keys()? {
        let raw = store.get(&format!("keys/{key_id}.share"))?;
        let core: IncompleteKeyShare<E> = match serde_json::from_slice(&raw) {
            Ok(core) => core,
            // older layout stored the whole KeyShare; keep only the core share
            Err(_) => Valid::validate(serde_json::from_slice::<KeyShare>(&raw)?.into_inner().core)
                .map_err(|_| anyhow!("invalid key share {key_id}"))?,
        };
        let aux = aux.clone().ok_or_else(|| anyhow!("key {key_id} present but aux info missing"))?;
        let ks = KeyShare::from_parts((core, aux))?;
        let info = key_info(&ks)?;
        ensure!(info.key_id == key_id, "key file name mismatch for {key_id}");
        keys.insert(key_id, (Arc::new(ks), info));
    }
    tracing::info!(party = me, keys = keys.len(), has_aux = aux.is_some(), "node loaded");
    Ok(Node {
        me,
        cluster,
        ident: Arc::new(ident),
        store,
        token,
        compute,
        aux: RwLock::new(aux),
        keys: RwLock::new(keys),
        presigs: Mutex::new(HashMap::new()),
        max_presigs,
        protocol_timeout: Duration::from_secs(protocol_timeout_secs),
    })
}

/// Precompute ring-Pedersen multi-exponentiation tables (in memory only): makes presigning
/// and signing considerably faster. (CRT precomputation does not apply: in CGGMP24 the
/// ring-Pedersen modulus uses different primes from the Paillier key.)
fn optimize_aux(aux: AuxInfo, _me: u16) -> Result<AuxInfo> {
    let mut d = aux.into_inner();
    d.precompute_multiexp_tables().map_err(|e| anyhow!("multiexp tables: {e}"))?;
    Valid::validate(d).map_err(|_| anyhow!("aux info invalid after precomputation"))
}

fn key_info(ks: &KeyShare) -> Result<KeyInfo> {
    let pk = ks.shared_public_key;
    let uncompressed = pk.to_bytes(false);
    let address = eth::address_hex(&eth::address_from_uncompressed(&uncompressed)?);
    Ok(KeyInfo { key_id: address.clone(), address, public_key: hex::encode(pk.to_bytes(true)) })
}

async fn serve(node: Arc<Node>, listen: SocketAddr) -> Result<()> {
    let authed = Router::new()
        .route("/v1/info", get(info))
        .route("/v1/keys", get(keys))
        .route("/v1/aux", post(aux))
        .route("/v1/keygen", post(keygen))
        .route("/v1/presign", post(presign))
        .route("/v1/presign/discard", post(discard))
        .route("/v1/partial", post(partial))
        .route("/v1/sign", post(full_sign))
        .route_layer(middleware::from_fn_with_state(node.clone(), auth));
    let app = Router::new().route("/health", get(|| async { "ok" })).merge(authed).with_state(node);
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(%listen, "node API listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn auth(State(node): State<Arc<Node>>, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| constant_time_eq(t.as_bytes(), node.token.as_bytes()))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(ErrorResp { error: "unauthorized".into() })).into_response()
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

struct ApiError(anyhow::Error);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::warn!("request failed: {:#}", self.0);
        (StatusCode::BAD_REQUEST, Json(ErrorResp { error: format!("{:#}", self.0) })).into_response()
    }
}
impl<T: Into<anyhow::Error>> From<T> for ApiError {
    fn from(e: T) -> Self {
        ApiError(e.into())
    }
}
type ApiResult<T> = std::result::Result<Json<T>, ApiError>;

async fn info(State(node): State<Arc<Node>>) -> ApiResult<NodeInfo> {
    Ok(Json(NodeInfo {
        id: node.me,
        sign_pk: node.ident.sign_pk_hex(),
        kx_pk: node.ident.kx_pk_hex(),
        has_aux: node.aux.read().is_some(),
        keys: node.keys.read().values().map(|(_, i)| i.clone()).collect(),
        presignatures: node.presigs.lock().len(),
    }))
}

async fn keys(State(node): State<Arc<Node>>) -> ApiResult<Vec<KeyInfo>> {
    let mut v: Vec<KeyInfo> = node.keys.read().values().map(|(_, i)| i.clone()).collect();
    v.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    Ok(Json(v))
}

fn check_session_id(s: &str) -> Result<()> {
    ensure!(
        (16..=128).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "invalid session id"
    );
    Ok(())
}

fn check_signers(node: &Node, signers: &[u16]) -> Result<()> {
    ensure!(signers.len() == node.cluster.threshold as usize, "need exactly {} signers", node.cluster.threshold);
    let mut s = signers.to_vec();
    s.sort();
    s.dedup();
    ensure!(s.len() == signers.len(), "duplicate signer");
    ensure!(signers.iter().all(|i| *i < node.cluster.n()), "unknown signer");
    ensure!(signers.contains(&node.me), "this node is not among the signers");
    Ok(())
}

/// Run one interactive protocol on the compute runtime and flush outgoing messages.
async fn run_protocol<M, T, F, Fut>(node: &Arc<Node>, relay_url: &str, ctx: SessionCtx, f: F) -> Result<T>
where
    M: serde::Serialize + serde::de::DeserializeOwned + Send + 'static,
    T: Send + 'static,
    F: FnOnce(u16, MpcParty<M, (transport::In<M>, transport::Out<M>)>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T>> + Send + 'static,
{
    let i = ctx.my_index()?;
    let (incoming, outgoing, writer) =
        transport::connect::<M>(relay_url, ctx, node.ident.clone(), node.cluster.clone()).await?;
    let party = MpcParty::connected((incoming, outgoing));
    let task = node.compute.spawn(f(i, party));
    let out = tokio::time::timeout(node.protocol_timeout, task)
        .await
        .map_err(|_| anyhow!("protocol timed out"))?
        .map_err(|e| anyhow!("protocol task panicked: {e}"))?;
    // The party (and its outgoing sender) is dropped once the protocol future completes;
    // wait for the writer to push the final messages to the relay.
    let _ = tokio::time::timeout(Duration::from_secs(10), writer).await;
    out
}

async fn aux(State(node): State<Arc<Node>>, Json(req): Json<AuxReq>) -> ApiResult<serde_json::Value> {
    check_session_id(&req.session)?;
    if node.aux.read().is_some() {
        return Ok(Json(serde_json::json!({ "status": "exists" })));
    }
    let n = node.cluster.n();
    let t0 = Instant::now();
    tracing::info!("generating safe primes (slow)");
    let primes = node.compute.spawn_blocking(|| PregeneratedPrimes::<L>::generate(&mut OsRng)).await?;
    tracing::info!(secs = t0.elapsed().as_secs_f32(), "primes ready; running aux info protocol");
    let ctx = SessionCtx { session: req.session.clone(), me: node.me, participants: (0..n).collect() };
    let session = req.session.clone();
    let aux: AuxInfo = run_protocol::<AuxMsg, _, _, _>(&node, &req.relay_url, ctx, move |i, party| async move {
        let eid = ExecutionId::new(session.as_bytes());
        Ok(cggmp24::aux_info_gen(eid, i, n, primes).start(&mut OsRng, party).await?)
    })
    .await?;
    node.store.put(AUX, &serde_json::to_vec(&aux)?)?;
    let me = node.me;
    let aux = node.compute.spawn_blocking(move || optimize_aux(aux, me)).await??;
    *node.aux.write() = Some(aux);
    tracing::info!(secs = t0.elapsed().as_secs_f32(), "aux info generated");
    Ok(Json(serde_json::json!({ "status": "created" })))
}

async fn keygen(State(node): State<Arc<Node>>, Json(req): Json<KeygenReq>) -> ApiResult<KeyInfo> {
    check_session_id(&req.session)?;
    let aux = node.aux.read().clone().ok_or_else(|| anyhow!("aux info not generated yet"))?;
    let n = node.cluster.n();
    let t = node.cluster.threshold;
    let ctx = SessionCtx { session: req.session.clone(), me: node.me, participants: (0..n).collect() };
    let session = req.session.clone();
    let incomplete = run_protocol::<KeygenMsg, _, _, _>(&node, &req.relay_url, ctx, move |i, party| async move {
        let eid = ExecutionId::new(session.as_bytes());
        Ok(cggmp24::keygen::<E>(eid, i, n).set_threshold(t).start(&mut OsRng, party).await?)
    })
    .await?;
    let core_json = serde_json::to_vec(&incomplete)?;
    let ks = KeyShare::from_parts((incomplete, aux))?;
    let info = key_info(&ks)?;
    // persist only the core share; aux info is stored once and shared by all keys
    node.store.put(&format!("keys/{}.share", info.key_id), &core_json)?;
    node.keys.write().insert(info.key_id.clone(), (Arc::new(ks), info.clone()));
    tracing::info!(address = %info.address, "key generated (this node holds one share)");
    Ok(Json(info))
}

fn get_key(node: &Node, key_id: &str) -> Result<Arc<KeyShare>> {
    node.keys.read().get(key_id).map(|(k, _)| k.clone()).ok_or_else(|| anyhow!("unknown key {key_id}"))
}

async fn presign(State(node): State<Arc<Node>>, Json(req): Json<PresignReq>) -> ApiResult<PresignResp> {
    check_session_id(&req.session)?;
    check_signers(&node, &req.signers)?;
    if node.presigs.lock().len() >= node.max_presigs {
        return Err(anyhow!("presignature store full").into());
    }
    let ks = get_key(&node, &req.key_id)?;
    let ctx = SessionCtx { session: req.session.clone(), me: node.me, participants: req.signers.clone() };
    let session = req.session.clone();
    let signers = req.signers.clone();
    let (presig, public) = run_protocol::<SigningMsg, _, _, _>(&node, &req.relay_url, ctx, move |i, party| async move {
        let eid = ExecutionId::new(session.as_bytes());
        Ok(cggmp24::signing(eid, i, &signers, &ks).generate_presignature(&mut OsRng, party).await?)
    })
    .await?;
    let public = PresigPublic::from_data(&public);
    {
        let mut p = node.presigs.lock();
        if p.contains_key(&req.session) {
            return Err(anyhow!("presignature id collision").into());
        }
        p.insert(req.session.clone(), (req.key_id.clone(), presig, Instant::now()));
    }
    Ok(Json(PresignResp { presig_id: req.session, public }))
}

async fn partial(State(node): State<Arc<Node>>, Json(req): Json<PartialReq>) -> ApiResult<PartialResp> {
    // 1. policy first: a refused request must not burn the presignature
    node.cluster.policy.check(&req.tx)?;
    // 2. take the presignature out of the store: from here on it can never be used again
    let (key_id, presig, _) =
        node.presigs.lock().remove(&req.presig_id).ok_or_else(|| anyhow!("unknown or already used presignature"))?;
    if key_id != req.key_id {
        return Err(anyhow!("presignature belongs to another key").into());
    }
    // 3. the node hashes the full transaction itself (never signs a bare hash)
    let partial = presig.issue_partial_signature(mpc_signer::data_to_sign(&req.tx));
    Ok(Json(PartialResp { sigma: hex::encode(partial.sigma.to_be_bytes()) }))
}

async fn full_sign(State(node): State<Arc<Node>>, Json(req): Json<FullSignReq>) -> ApiResult<FullSignResp> {
    check_session_id(&req.session)?;
    check_signers(&node, &req.signers)?;
    node.cluster.policy.check(&req.tx)?;
    let ks = get_key(&node, &req.key_id)?;
    let ctx = SessionCtx { session: req.session.clone(), me: node.me, participants: req.signers.clone() };
    let session = req.session.clone();
    let signers = req.signers.clone();
    let tx = req.tx.clone();
    let sig = run_protocol::<SigningMsg, _, _, _>(&node, &req.relay_url, ctx, move |i, party| async move {
        let eid = ExecutionId::new(session.as_bytes());
        let data = mpc_signer::data_to_sign(&tx);
        Ok(cggmp24::signing(eid, i, &signers, &ks).sign(&mut OsRng, party, &data).await?)
    })
    .await?;
    Ok(Json(FullSignResp { r: hex::encode(sig.r.to_be_bytes()), s: hex::encode(sig.s.to_be_bytes()) }))
}

#[derive(serde::Deserialize)]
struct DiscardReq {
    ids: Vec<String>,
}

/// Destroy presignatures (never to be used).
async fn discard(State(node): State<Arc<Node>>, Json(req): Json<DiscardReq>) -> ApiResult<serde_json::Value> {
    let mut p = node.presigs.lock();
    let n = req.ids.iter().filter(|id| p.remove(*id).is_some()).count();
    Ok(Json(serde_json::json!({ "discarded": n })))
}
