# MPC signer upgrade

> **What:** Upgrading the MPC signer: ship the image, MPC nodes one at a time by their teams, then coordinators and proxy; rollback.
> **For:** MPC node teams, operators.
> **Related:** [MPC production](../deployment/mpc-signer-production.md) · [MPC signer](../components/mpc-signer.md)

**Contents**
- [1. Operator: build and ship the image (phases 00–02 only)](#1-operator-build-and-ship-the-image-phases-0002-only)
- [2. Each MPC team: upgrade its node, one node at a time](#2-each-mpc-team-upgrade-its-node-one-node-at-a-time)
- [3. Operator: upgrade everything else](#3-operator-upgrade-everything-else)
- [Rollback (if a node misbehaves on the new version)](#rollback-if-a-node-misbehaves-on-the-new-version)
- [Without Ansible](#without-ansible)
- [What's new in 1.3.0](#whats-new-in-130)

---

The order: **ship the image, upgrade the three MPC nodes one at a time (each by its own team),
then the coordinators and the proxy.** The commands use 1.3.0 and the Ansible deployment
([Ansible deployment](../deployment/ansible.md)). For another version, change the tag in
`ansible/group_vars/all/settings.yml` (`mpc_image`) first.

**Why nodes first:** a newer coordinator may use node features an older node doesn't have. For
1.3.0, coordinators on 1.3.0 with nodes still on 1.2.0 can't store presignature pool classes: new
accounts would get no pool, and changing an account's pool class fails.

**The node folder.** Below, `<node dir>` is the folder the team runs its node from:
`mpc_node_dir` in the Ansible settings, by default `/opt/besu-chain/mpc-signer/deploy/node` (the
node package in the repository copy). A node set up by hand from
[MPC signer in production](../deployment/mpc-signer-production.md) uses `/opt/mpc-node`.

## 1. Operator: build and ship the image (phases 00–02 only)

The node hosts need the image before the teams can switch to it. On the operator:

```bash
cd besu-chain && git pull && cd ansible
```

```bash
ansible-playbook 00-preflight.yml 01-hosts.yml 02-images.yml
```

This copies the current code to the hosts, builds `registry.example.com/mpc-signer:1.3.0` on the
operator (several minutes the first time; with `mpc_image_build: false` the hosts pull it from
your registry instead) and loads it on .135, .136, .137 and .138. It does not touch the running
nodes or the teams' `.env`, `cluster.json` and `node<ID>.json`.

**Don't run `site.yml` yet:** it would upgrade the coordinators before the nodes.

## 2. Each MPC team: upgrade its node, one node at a time

Order: mpc1 (.135), then mpc2 (.137), then mpc3 (.138). The next node starts only when the
previous one is back. On each node host:

1. Check the new image is there:

   ```bash
   docker images registry.example.com/mpc-signer
   ```

   It must list `1.3.0` (and the old `1.2.0`, kept for rollback).

2. Take a backup first (the team's usual backup location):

   ```bash
   <node dir>/backup.sh /secure/backup
   ```

3. Switch to 1.3.0 and restart:

   ```bash
   cd <node dir> && sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.3.0|' .env && docker compose up -d
   ```

4. Wait for the node to load. This takes about 15–30 s while it prepares its key material:

   ```bash
   docker compose logs -f --tail 5
   ```

   Wait for these two lines, then press Ctrl+C:
   - `node loaded party=<0|1|2> keys=<N> has_aux=true`. `keys` must be the same number as
     before the upgrade.
   - `node API listening`.

5. Check the running version:

   ```bash
   docker compose ps --format '{{.Image}} {{.Status}}'
   ```

6. Tell the operator. The presignatures this node held in memory are gone, so the operator clears
   the pools on **both** coordinators (otherwise signatures first try stale presignatures, then
   retry or fall back to the cold path):

   ```bash
   curl -s -X POST http://192.168.68.135:9100/admin/pool/clear -H "Authorization: Bearer $(cat state/secrets/mpc_admin_token)"
   ```

   ```bash
   curl -s -X POST http://192.168.68.136:9100/admin/pool/clear -H "Authorization: Bearer $(cat state/secrets/mpc_admin_token)"
   ```

7. Before the next team starts: in Grafana's **MPC signer** dashboard, the **MPC nodes** table must
   show this node **UP** from both coord1 and coord2.

**While a node restarts:** signing continues with the other two nodes. `/createaccount` fails for
those ~30 seconds, because creating a key needs all three.

## 3. Operator: upgrade everything else

Once all three nodes run 1.3.0:

```bash
ansible-playbook site.yml
```

`site.yml` checks that the three nodes answer, then upgrades the coordinators one at a time
(coord1 on .135, then coord2 on .136; HAProxy sends clients to the other one meanwhile), the
proxies, the monitoring (dashboards and alerts) and the rest. For 1.3.0, check that both
coordinators report the pool classes (`target_small`, and a `class` per key):

```bash
curl -s http://192.168.68.135:9100/admin/pool | head -c 400
```

```bash
curl -s http://192.168.68.136:9100/admin/pool | head -c 400
```

## Rollback (if a node misbehaves on the new version)

The old image is still on the host. In that node's folder:

```bash
cd <node dir> && sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.2.0|' .env && docker compose up -d
```

Then clear the pools on both coordinators (step 2.6). 1.2.0 ignores the pool-class files that
1.3.0 may have written, so rolling back is safe. While any node runs the old version, keep the
coordinators on it too: don't run `site.yml`.

## Without Ansible

1. Build and distribute the image as in
   [MPC signer in production](../deployment/mpc-signer-production.md#2-build-and-distribute-the-image-once-per-release-eg-in-ci).
2. Upgrade the nodes as in step 2 here.
3. Upgrade the coordinators one at a time (coord2 first, then coord1): the new `MPC_IMAGE` in
   their `.env`, then `docker compose up -d`.
4. Then the proxies.

## What's new in 1.3.0

Presignature pool classes per account (`big`, `small`, `none`), stored with the key on the MPC
nodes; `MPC_POOL_TARGET_SMALL` on the coordinators; `POST /admin/keys/<address>/pool`; the proxy's
`pool` field on `/createaccount` and `POST /account/pool`. Details: "Presignature pools" in
[MPC signer in production](../deployment/mpc-signer-production.md#presignature-pools-big-small-and-none).
