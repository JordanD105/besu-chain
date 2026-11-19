# Self-hosted Remix IDE

[Remix](https://remix.ethereum.org) served from the monitoring host, `http://<monitoring host>:30200`,
for writing, compiling and testing contracts in the browser. Nothing is downloaded from the
internet at use time: the compilers come from a mirror inside the image.

| | |
|---|---|
| Remix | the prebuilt site of `github.com/remix-project-org/remix-live` (branch `gh-pages`, what remix.ethereum.org serves), pinned by commit: `remix_commit` in `ansible/group_vars/all/settings.yml` (Remix 2.6.15) |
| Compilers | `remix_solc_versions` (default `0.8.28`) plus the version Remix selects by default (0.8.34 in 2.6.15), from the npm package `solc` (the official Emscripten builds), served at `/solc-bin/` with a `list.json` like binaries.soliditylang.org |
| Server | `serve.js`, a small static server on `node:22-alpine` (the base image the proxy and chainlens already use) |
| Access | the operator (`operator_ip`) and `remix_ips`; everyone else is blocked by the firewall |

## Deployment

Ansible does it all when `remix_enabled: true` (the default):

- `02-images.yml` fetches the pinned Remix site on the operator **once per commit** (`git fetch
  --depth 1`, about 400 MB, into `state/build/remix/remix-live`; the operator needs github.com for
  this) and builds `localhost/besu-remix/remix`. Like the other images it is built once and copied to
  the host, and `save-images.yml` saves it as `remix-docker.tar`.
- `09-monitoring.yml` starts it on the monitoring host and checks the compiler list.
- `ha/firewall-layout.sh` opens port 30200 on the monitoring host for `operator_ip` and `remix_ips`.

To add compilers, change `remix_solc_versions` (e.g. `["0.8.24", "0.8.28"]`) and run
`ansible-playbook 02-images.yml 09-monitoring.yml`. To update Remix, set `remix_commit` to a newer
commit of `remix-live` (its commit message names the Remix version) and run the same. Turn it off with
`remix_enabled: false`.

By hand, on a host with internet access:

```bash
git clone --depth 1 https://github.com/remix-project-org/remix-live.git remix/remix-live
```

```bash
cd remix && SOLC_VERSIONS="0.8.28" docker compose build && docker compose up -d
```

## Using it with this chain

1. **Compiler:** pick a mirrored version (`0.8.28`). **Settings → EVM version: `cancun`.** Remix 2.6.15
   defaults to `osaka`; this chain (and the Besu version here) has no Prague/Osaka opcodes, so code
   compiled for them can fail on chain. Turn the optimizer on (200 runs) for deployment builds.
2. **Test** in *Deploy & run → Remix VM (Cancun)*: an in-browser chain, nothing leaves the browser.
3. **Export the artifact:** Remix writes `contracts/artifacts/<Name>.json` (ABI + bytecode) when
   *Settings → Generate contract metadata* is on. Download it, together with the source.
4. **Deploy to production** from the operator with
   [`besu-production/operator/deploy-contract.js`](../besu-production/README.md#deploying-a-contract),
   signed by an MPC account. Remix itself never connects to the production chain and holds no keys.
   The record it writes makes the contract readable in chainlens.

Remix keeps files in the browser (IndexedDB) of each user: save the sources in git.

Features that need Remix's cloud services do nothing here: RemixAI, the plugin directory, GitHub/Gist
import and sharing, and the compiler versions that are not mirrored. Remix tries to reach them from the
user's browser; with no internet access, they fail quietly.
