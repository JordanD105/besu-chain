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
    /// Presignature pool class of the new key (see `POOL_CLASSES`); None = not set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyInfo {
    pub key_id: String,
    pub address: String,
    /// SEC1 compressed public key, hex.
    pub public_key: String,
    /// Presignature pool class stored with the key on the nodes (None = not set: the
    /// coordinator's MPC_POOL_KEYS rule applies). Older nodes don't send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<String>,
}

/// Presignature pool classes. Each coordinator sets the pool size of each class:
/// big = MPC_POOL_TARGET, small = MPC_POOL_TARGET_SMALL, none = no pool (cold signing).
pub const POOL_CLASSES: [&str; 3] = ["big", "small", "none"];

pub fn check_pool_class(pool: &str) -> Result<()> {
    if POOL_CLASSES.contains(&pool) {
        Ok(())
    } else {
        Err(anyhow!("pool must be one of {}, not {pool:?}", POOL_CLASSES.join(", ")))
    }
}

/// The pool class most nodes store for a key; a tie goes to the alphabetically first class
/// (deterministic on every coordinator). None when no node stores a class.
pub fn majority_class(votes: std::collections::HashMap<String, usize>) -> Option<String> {
    votes.into_iter().max_by(|x, y| x.1.cmp(&y.1).then(y.0.cmp(&x.0))).map(|(p, _)| p)
}

/// Set (or clear, with None) the pool class of a key on a node.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyPoolReq {
    pub key_id: String,
    #[serde(default)]
    pub pool: Option<String>,
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

#[cfg(test)]
mod pool_class_tests {
    use super::*;
    use std::collections::HashMap;

    fn votes(v: &[(&str, usize)]) -> HashMap<String, usize> {
        v.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    #[test]
    fn majority_wins_and_ties_are_deterministic() {
        assert_eq!(majority_class(votes(&[("small", 2), ("big", 1)])), Some("small".into()));
        assert_eq!(majority_class(votes(&[("big", 1), ("small", 1)])), Some("big".into()));
        assert_eq!(majority_class(votes(&[("none", 1), ("small", 1)])), Some("none".into()));
        assert_eq!(majority_class(HashMap::new()), None);
    }

    #[test]
    fn classes_are_checked() {
        for p in POOL_CLASSES {
            assert!(check_pool_class(p).is_ok());
        }
        assert!(check_pool_class("huge").is_err());
        assert!(check_pool_class("").is_err());
    }

    #[test]
    fn older_nodes_and_coordinators_stay_compatible() {
        // an older node sends no pool field
        let k: KeyInfo = serde_json::from_str(r#"{"key_id":"0xa","address":"0xa","public_key":"02"}"#).unwrap();
        assert_eq!(k.pool, None);
        // an older coordinator sends a keygen request without pool
        let r: KeygenReq = serde_json::from_str(r#"{"session":"s","relay_url":"ws://x"}"#).unwrap();
        assert_eq!(r.pool, None);
        // no class: the field is left out, so older peers see the format they know
        let out = serde_json::to_string(&KeyInfo { key_id: "0xa".into(), address: "0xa".into(), public_key: "02".into(), pool: None }).unwrap();
        assert!(!out.contains("pool"));
    }
}
