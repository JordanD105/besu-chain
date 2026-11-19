# Upgrading the MPC signer (example: 1.3.0)

The order: **ship the image, upgrade the three MPC nodes one at a time (each by its own team),
then the coordinators and the proxy.** The commands use 1.3.0 and the Ansible deployment
([`../../ansible/`](../../ansible/README.md)); for another version, change the tag in
`ansible/group_vars/all/settings.yml` (`mpc_image`) first.

Why nodes first: a newer coordinator may use node features an older node doesn't have. For 1.3.0,
coordinators on 1.3.0 with nodes still on 1.2.0 can't store presignature pool classes: new
accounts would get no pool, and changing an account's pool class fails.

## 1. Operator: build and ship the image (phases 0–2 only)

The node hosts need the image before the teams can switch to it. On the operator:

```bash
cd besu-chain && git pull && cd ansible
```

```bash
ansible-playbook 00-preflight.yml 01-hosts.yml 02-images.yml
```

This builds `registry.example.com/mpc-signer:1.3.0` on the operator (several minutes the first
time) and loads it on .135, .136, .137 and .138. **Don't run `site.yml` yet**: it would upgrade
the coordinators before the nodes.

## 2. Each MPC team: upgrade its node, one node at a time

Order: mpc1 (.135), then mpc2 (.137), then mpc3 (.138). The next node starts only when the
previous one is back. On each node host:

1. Check the new image is there:

   ```bash
   docker images registry.example.com/mpc-signer
   ```

   It must list `1.3.0` (and the old `1.2.0`, kept for rollback).

2. Take a backup first (the team's usual backup):

   ```bash
   /opt/mpc-node/backup.sh /secure/backup
   ```

3. Switch to 1.3.0 and restart:

   ```bash
   cd /opt/mpc-node && sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.3.0|' .env && docker compose up -d
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

6. Before the next team starts: in Grafana's MPC dashboard, the **MPC nodes** table must show
   this node **UP** from both coord1 and coord2.

**While a node restarts:** signing continues with the other two nodes. `/createaccount` fails for
those ~30 seconds, because creating a key needs all three.

## 3. Operator: upgrade everything else

Once all three nodes run 1.3.0:

```bash
ansible-playbook site.yml
```

This upgrades coord2, then coord1, then the proxy, the dashboard and the alerts. For 1.3.0, check
that both coordinators report the pool classes (`target_small` and a `class` per key):

```bash
curl -s http://192.168.68.150:9100/admin/pool -H "Authorization: Bearer $(cat state/secrets/mpc_admin_token)" | head -c 400
```

## Rollback (if a node misbehaves on the new version)

The old image is still on the host. In that node's folder:

```bash
sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.2.0|' .env && docker compose up -d
```

1.2.0 ignores the pool-class files that 1.3.0 may have written, so rolling back is safe. While any
node runs the old version, keep the coordinators on it too: don't run `site.yml`.

## Notes

- A node that still runs from the repository folder (`/opt/besu-chain/mpc-signer/deploy/node`)
  instead of `/opt/mpc-node`: do step 2 in that folder, and move it to `/opt/mpc-node` afterwards.
- Without Ansible: build and distribute the image as in
  [`production.md`](production.md) section 2, upgrade the nodes as in step 2 here, then the
  coordinators (coord2 first, then coord1) with the new `MPC_IMAGE` in their `.env` and
  `docker compose up -d`.
- What's new in 1.3.0: presignature pool classes per account (big, small, none): "Presignature
  pools" in [`production.md`](production.md).
