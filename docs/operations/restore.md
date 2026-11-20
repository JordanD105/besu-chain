# Restore with Ansible

> **What:** Rebuilding the whole site from the backups with Ansible: prepare the hosts, restore node keys, chain snapshot and MPC shares, then deploy.
> **For:** operators.
> **Related:** [disaster recovery](disaster-recovery.md) · [GPG key](../deployment/gpg-key.md) · [operator guide](../deployment/operator-guide.md)

**Contents**
- [What you need](#what-you-need)
- [1. Operator machine and hosts](#1-operator-machine-and-hosts)
- [2. Besu nodes: key and chain, before anything starts them](#2-besu-nodes-key-and-chain-before-anything-starts-them)
- [3. MPC nodes: each team, on its own host](#3-mpc-nodes-each-team-on-its-own-host)
- [4. Everything else: Ansible](#4-everything-else-ansible)
- [5. Check, then reconcile](#5-check-then-reconcile)

---

Every host is rebuilt and the deployment comes back from the backups. This is section 6.7 of
[Disaster recovery](disaster-recovery.md), adapted to the Ansible deployment.
For a single lost host or node, use the runbook's other sections instead.

> **The one trap:** don't run `site.yml` on empty hosts before the node keys and the chain
> snapshot are restored. On a host with no key, phase 05 would create a **new** node key and start
> an **empty** chain from block 0: a different chain from yours. So: Ansible prepares the hosts
> (step 1), you restore the data (steps 2–3), then Ansible does the rest (step 4).

## What you need

| Backup | From |
|---|---|
| `ansible/state/` (tokens, `network/`, `cluster.json`, `sender01`, `key-backups/*.key.gpg`) | operator vault |
| GPG **private** key + passphrase (decrypts the node keys, [GPG key for the node-key backups](../deployment/gpg-key.md)) | offline vault |
| Latest chain snapshot `besu-chain-val3-<time>-b<block>.tgz` **and its `.json`** | `/backup/chain` copy or off-site (`snapshot_copy_to`) |
| Each MPC node's `mpc-node<N>-<time>.tgz` + its `.env` (with `MPC_NODE_PASSPHRASE`) | each team's own vault |

## 1. Operator machine and hosts

Rebuild the 5 hosts with the **same IPs** (the node addresses in the network files contain them).
On the operator: clone the repository, put `ansible/state/` back, then run **only** the
preparation phases:

```bash
cd besu-chain/ansible && ansible-playbook 00-preflight.yml 01-hosts.yml 02-images.yml
```

That gives Docker, the firewall, the repository in `/opt/besu-chain`, node-exporter and all the
images on the hosts.

## 2. Besu nodes: key and chain, before anything starts them

For each node: val1 and rpc1 on .135, val2 and rpc2 on .136, val3 on .137, val4 on .138. The
example is val1.

1. Node folder:

   ```bash
   cp -r /opt/besu-chain/besu-production/node /opt/besu-val1
   ```

2. Its `.env`: exactly the values of [Production layout](../overview/production-layout.md)
   section 4.6 for that node (`chmod 600 .env`). The `.env` Ansible writes in step 4 is the same.

3. Network files, from the operator:

   ```bash
   scp ansible/state/network/* root@192.168.68.135:/opt/besu-val1/network/
   ```

4. Its key: decrypt it on the machine holding the GPG private key ([GPG key for the node-key backups](../deployment/gpg-key.md)
   step 5), copy it to the host over SSH, restore it, then shred every plain copy:

   ```bash
   gpg --pinentry-mode loopback --decrypt val1.key.gpg > val1.key
   ```

   On the host, in `/opt/besu-val1`:

   ```bash
   ./restore-key.sh /root/val1.key && shred -u /root/val1.key
   ```

   It must print `OK: … in static-nodes.json`.

5. The chain snapshot: copy the same `.tgz` **and** `.json` to each host, then in each node
   folder (it checks the archive and the genesis, keeps the node's key, and starts the node):

   ```bash
   ./restore-chain.sh --yes /backup/chain/besu-chain-val3-<time>-b<block>.tgz
   ```

   Validators first (val1–val4), then rpc1 and rpc2.

6. Blocks, on .137:

   ```bash
   cd /opt/besu-val3 && /opt/besu-chain/besu-production/operator/qbft.sh health
   ```

   The height must be above the snapshot's block and rising. If no new block comes within a few
   minutes, restart the four validators together (runbook 6.3 step 3). After a full stop, QBFT can
   take about 3 minutes of round changes before blocks resume.

## 3. MPC nodes: each team, on its own host

In the node folder (`mpc_node_dir`, default `/opt/besu-chain/mpc-signer/deploy/node`):

1. Put back the team's `.env` (the same one: same passphrase) and `cluster.json` (from
   `ansible/state/cluster.json`).
2. Restore the backup and start:

   ```bash
   docker compose down; ./restore.sh /secure/mpc-backup/mpc-node<N>-<time>.tgz && docker compose up -d
   ```

3. The logs must show `node loaded … keys=<same number as before>`:

   ```bash
   docker compose logs --tail 5
   ```

Signing works again once 2 of the 3 nodes are back; account creation needs all 3.

## 4. Everything else: Ansible

```bash
ansible-playbook site.yml
```

Now it's safe:
- phase 03 finds the MPC nodes up;
- phase 04 starts the coordinators, with no new key ceremony (`state/sender01` exists);
- phase 05 keeps the restored keys (`init.sh` never replaces an existing key), reuses the genesis
  from `state/network` and leaves the running nodes alone;
- phases 06–10 bring back the proxy, HAProxy + keepalived, monitoring, chainlens and the backup
  crons.

## 5. Check, then reconcile

- The checklist in section 7 of the runbook: no firing alerts, 4 validators, MPC 3/3, proxy
  `/status/senders`, one test transfer.
- **The chain is back at the snapshot's block.** Transactions after it are **gone**: transfers,
  mints, account fundings. Compare with your business records and redo what's needed.
- MPC accounts created after the snapshot still have their keys (if the MPC backups are newer),
  but their funding is gone.
- **Take fresh backups at once:** a chain snapshot, the MPC backups, the key backups of any new
  node (`ansible-playbook 10-backups.yml`).

**Practice it before you need it** (runbook section 8): rebuild on spare hosts, time each step and
write the times into the runbook.
