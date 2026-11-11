//! MPC message transport.
//!
//! Nodes exchange CGGMP24 protocol messages through a dumb relay hosted by the coordinator
//! (a WebSocket per (session, party)). The relay only routes; it cannot read or forge messages:
//!
//! * every envelope is signed with the sender's Ed25519 identity key and bound to the session id
//! * every point-to-point message is encrypted with ChaCha20-Poly1305 under a key derived from
//!   X25519(sender, recipient) and the session id
//!
//! This satisfies the library's requirement that "all messages must be authenticated and all
//! p2p messages must be encrypted".

use std::sync::Arc;

use anyhow::{anyhow, ensure, Context, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use ed25519_dalek::{Signer, Verifier};
use futures::{channel::mpsc, SinkExt, StreamExt};
use rand_core::{OsRng, RngCore};
use round_based::{Incoming, MessageDestination, MessageType, Outgoing};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::cluster::{ClusterConfig, Identity};

/// Wire envelope. Header fields are visible to the relay (needed for routing); the body of a
/// p2p message is ciphertext.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub session: String,
    pub from: u16,
    /// `None` = broadcast to every other session participant.
    pub to: Option<u16>,
    pub seq: u64,
    pub nonce: [u8; 12],
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
}

impl Envelope {
    fn header(&self) -> Vec<u8> {
        bincode::serialize(&(&self.session, self.from, self.to, self.seq, &self.nonce))
            .expect("serialize header")
    }

    fn signed_bytes(&self) -> Vec<u8> {
        let mut v = b"mpc-signer/envelope/v1".to_vec();
        v.extend_from_slice(&self.header());
        v.extend_from_slice(&(self.body.len() as u64).to_be_bytes());
        v.extend_from_slice(&self.body);
        v
    }

    pub fn encode(&self) -> Vec<u8> {
        bincode::serialize(self).expect("serialize envelope")
    }

    pub fn decode(b: &[u8]) -> Result<Self> {
        Ok(bincode::deserialize(b)?)
    }
}

fn p2p_cipher(me: &Identity, peer: &x25519_dalek::PublicKey, session: &str, from: u16, to: u16) -> ChaCha20Poly1305 {
    let shared = me.kx.diffie_hellman(peer);
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(session.as_bytes()), shared.as_bytes());
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    let info = [b"mpc-signer/p2p/v1".as_slice(), &from.to_be_bytes(), &to.to_be_bytes()].concat();
    hk.expand(&info, &mut key[..]).expect("len ok");
    ChaCha20Poly1305::new((&*key).into())
}

/// Per-session view: which cluster parties take part, and in which protocol-index order.
#[derive(Clone, Debug)]
pub struct SessionCtx {
    pub session: String,
    pub me: u16,
    /// Node ids of the participants. Protocol index `i` == position in this list.
    pub participants: Vec<u16>,
}

impl SessionCtx {
    pub fn my_index(&self) -> Result<u16> {
        self.participants
            .iter()
            .position(|p| *p == self.me)
            .map(|i| i as u16)
            .ok_or_else(|| anyhow!("this node is not a participant of the session"))
    }
}

#[derive(Debug, thiserror::Error)]
#[error("transport: {0}")]
pub struct TransportError(String);

pub type In<M> = mpsc::UnboundedReceiver<Result<Incoming<M>, TransportError>>;
pub type Out<M> = mpsc::UnboundedSender<Outgoing<M>>;

/// Connect to the relay for one protocol session.
///
/// Returns the (incoming, outgoing) pair for `round_based::MpcParty::connected`, plus a handle
/// that completes once every outgoing message has been flushed to the relay (await it after the
/// protocol finishes and the party has been dropped).
pub async fn connect<M>(
    relay_url: &str,
    ctx: SessionCtx,
    ident: Arc<Identity>,
    cluster: Arc<ClusterConfig>,
) -> Result<(In<M>, Out<M>, tokio::task::JoinHandle<()>)>
where
    M: Serialize + DeserializeOwned + Send + 'static,
{
    let parts: Vec<String> = ctx.participants.iter().map(|p| p.to_string()).collect();
    let url = format!(
        "{}/{}?party={}&parties={}",
        relay_url.trim_end_matches('/'),
        ctx.session,
        ctx.me,
        parts.join(",")
    );
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("connect relay {url}"))?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    let (in_tx, in_rx) = mpsc::unbounded::<Result<Incoming<M>, TransportError>>();
    let (out_tx, mut out_rx) = mpsc::unbounded::<Outgoing<M>>();

    // ---- reader: verify, decrypt, map node id -> protocol index
    {
        let ctx = ctx.clone();
        let ident = ident.clone();
        let cluster = cluster.clone();
        tokio::spawn(async move {
            let mut id: u64 = 0;
            while let Some(frame) = ws_rx.next().await {
                let bytes = match frame {
                    Ok(WsMessage::Binary(b)) => b,
                    Ok(WsMessage::Close(_)) => break,
                    Ok(_) => continue,
                    Err(e) => {
                        let _ = in_tx.unbounded_send(Err(TransportError(e.to_string())));
                        break;
                    }
                };
                let r = open_envelope::<M>(&bytes, &ctx, &ident, &cluster).map(|(sender, p2p, msg)| Incoming {
                    id: {
                        id += 1;
                        id
                    },
                    sender,
                    msg_type: if p2p { MessageType::P2P } else { MessageType::Broadcast },
                    msg,
                });
                let failed = r.is_err();
                if in_tx.unbounded_send(r.map_err(|e| TransportError(e.to_string()))).is_err() || failed {
                    break;
                }
            }
        });
    }

    // ---- writer: serialize, encrypt p2p, sign
    let writer = tokio::spawn(async move {
        let mut seq: u64 = 0;
        while let Some(out) = out_rx.next().await {
            seq += 1;
            match seal_envelope(out, seq, &ctx, &ident, &cluster) {
                Ok(env) => {
                    if ws_tx.send(WsMessage::Binary(env.encode().into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    tracing::error!("seal envelope: {e:#}");
                    break;
                }
            }
        }
        let _ = ws_tx.send(WsMessage::Close(None)).await;
    });

    Ok((in_rx, out_tx, writer))
}

fn seal_envelope<M: Serialize>(
    out: Outgoing<M>,
    seq: u64,
    ctx: &SessionCtx,
    ident: &Identity,
    cluster: &ClusterConfig,
) -> Result<Envelope> {
    let plain = serde_json::to_vec(&out.msg)?;
    let (to, nonce, body) = match out.recipient {
        MessageDestination::AllParties => (None, [0u8; 12], plain),
        MessageDestination::OneParty(idx) => {
            let to = *ctx
                .participants
                .get(idx as usize)
                .ok_or_else(|| anyhow!("recipient index {idx} out of range"))?;
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut nonce);
            let mut env = Envelope {
                session: ctx.session.clone(),
                from: ctx.me,
                to: Some(to),
                seq,
                nonce,
                body: vec![],
                sig: vec![],
            };
            let aad = env.header();
            let ct = p2p_cipher(ident, &cluster.kx_pk(to)?, &ctx.session, ctx.me, to)
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: &aad })
                .map_err(|_| anyhow!("encrypt"))?;
            env.body = ct;
            env.sig = ident.sign.sign(&env.signed_bytes()).to_bytes().to_vec();
            return Ok(env);
        }
    };
    let mut env = Envelope { session: ctx.session.clone(), from: ctx.me, to, seq, nonce, body, sig: vec![] };
    env.sig = ident.sign.sign(&env.signed_bytes()).to_bytes().to_vec();
    Ok(env)
}

fn open_envelope<M: DeserializeOwned>(
    bytes: &[u8],
    ctx: &SessionCtx,
    ident: &Identity,
    cluster: &ClusterConfig,
) -> Result<(u16, bool, M)> {
    let env = Envelope::decode(bytes)?;
    ensure!(env.session == ctx.session, "envelope for another session");
    ensure!(env.from != ctx.me, "envelope from self");
    let sender_index = ctx
        .participants
        .iter()
        .position(|p| *p == env.from)
        .ok_or_else(|| anyhow!("envelope from non-participant {}", env.from))? as u16;
    let sig = ed25519_dalek::Signature::from_slice(&env.sig).map_err(|_| anyhow!("bad signature encoding"))?;
    cluster
        .sign_pk(env.from)?
        .verify(&env.signed_bytes(), &sig)
        .map_err(|_| anyhow!("envelope signature invalid (from {})", env.from))?;
    let plain = match env.to {
        None => env.body.clone(),
        Some(to) => {
            ensure!(to == ctx.me, "p2p envelope for another party");
            let aad = env.header();
            p2p_cipher(ident, &cluster.kx_pk(env.from)?, &ctx.session, env.from, to)
                .decrypt(Nonce::from_slice(&env.nonce), Payload { msg: &env.body, aad: &aad })
                .map_err(|_| anyhow!("p2p decrypt failed"))?
        }
    };
    Ok((sender_index, env.to.is_some(), serde_json::from_slice(&plain)?))
}
