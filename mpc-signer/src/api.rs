//! Node API types (coordinator <-> node).

use anyhow::{anyhow, Result};
use cggmp24::generic_ec::{NonZero, Point};
use cggmp24::signing::{PresignatureCommitment, PresignaturePublicData};
use serde::{Deserialize, Serialize};

use crate::eth::TxIntent;
use crate::E;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuxReq {
    pub session: String,
    pub relay_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeygenReq {
    pub session: String,
    pub relay_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyInfo {
    pub key_id: String,
    pub address: String,
    /// SEC1 compressed public key, hex.
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresignReq {
    pub session: String,
    pub relay_url: String,
    pub key_id: String,
    /// Node ids taking part (exactly `threshold` of them), in protocol-index order.
    pub signers: Vec<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresignResp {
    pub presig_id: String,
    pub public: PresigPublic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartialReq {
    pub key_id: String,
    pub presig_id: String,
    pub tx: TxIntent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartialResp {
    /// Scalar, 32 bytes big-endian hex.
    pub sigma: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FullSignReq {
    pub session: String,
    pub relay_url: String,
    pub key_id: String,
    pub signers: Vec<u16>,
    pub tx: TxIntent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FullSignResp {
    pub r: String,
    pub s: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeInfo {
    pub id: u16,
    pub sign_pk: String,
    pub kx_pk: String,
    pub has_aux: bool,
    pub keys: Vec<KeyInfo>,
    pub presignatures: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ErrorResp {
    pub error: String,
}

/// Serializable form of `PresignaturePublicData` (public; lets the coordinator verify and
/// combine partial signatures).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresigPublic {
    pub gamma: String,
    pub commitments: Vec<(String, String)>,
}

fn p2h(p: &Point<E>) -> String {
    hex::encode(p.to_bytes(true))
}

fn h2p(s: &str) -> Result<Point<E>> {
    Point::<E>::from_bytes(hex::decode(s)?).map_err(|_| anyhow!("invalid point"))
}

impl PresigPublic {
    pub fn from_data(d: &PresignaturePublicData<E>) -> Self {
        PresigPublic {
            gamma: p2h(&d.Gamma),
            commitments: d.commitments.iter().map(|c| (p2h(&c.tilde_Delta), p2h(&c.tilde_S))).collect(),
        }
    }

    pub fn to_data(&self) -> Result<PresignaturePublicData<E>> {
        Ok(PresignaturePublicData {
            Gamma: NonZero::from_point(h2p(&self.gamma)?).ok_or_else(|| anyhow!("Gamma is zero"))?,
            commitments: self
                .commitments
                .iter()
                .map(|(d, s)| Ok(PresignatureCommitment { tilde_Delta: h2p(d)?, tilde_S: h2p(s)? }))
                .collect::<Result<_>>()?,
        })
    }
}
