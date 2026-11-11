//! Signing policy, enforced independently by every node before it contributes a signature.
//! A compromised coordinator therefore cannot get arbitrary transactions signed.

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

use crate::eth::{self, TxIntent};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Policy {
    /// Only transactions for this chain id are signed.
    pub chain_id: u64,
    /// Upper bound on `value` (decimal or 0x quantity, wei).
    pub max_value_wei: String,
    /// Upper bound on the gas limit.
    pub max_gas: u64,
    /// If non-empty, only these destination addresses are allowed (contract creation is
    /// then also refused).
    #[serde(default)]
    pub allowed_to: Vec<String>,
    /// Refuse contract-creation transactions.
    #[serde(default)]
    pub deny_contract_creation: bool,
}

impl Policy {
    pub fn check(&self, tx: &TxIntent) -> Result<()> {
        ensure!(tx.chain_id == self.chain_id, "policy: chain id {} not allowed", tx.chain_id);
        ensure!(tx.gas <= self.max_gas, "policy: gas {} above limit {}", tx.gas, self.max_gas);
        let max = eth::parse_quantity(&self.max_value_wei)?;
        ensure!(
            eth::cmp_quantity(&tx.value, &max) != std::cmp::Ordering::Greater,
            "policy: value above limit"
        );
        match &tx.to {
            None => {
                ensure!(!self.deny_contract_creation, "policy: contract creation not allowed");
                ensure!(self.allowed_to.is_empty(), "policy: contract creation not allowed with an allowlist");
            }
            Some(to) => {
                if !self.allowed_to.is_empty() {
                    let ok = self
                        .allowed_to
                        .iter()
                        .filter_map(|a| eth::parse_address(a).ok())
                        .any(|a| &a == to);
                    ensure!(ok, "policy: destination {} not in allowlist", eth::address_hex(to));
                }
            }
        }
        Ok(())
    }
}
