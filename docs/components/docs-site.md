# Documentation website

> **What:** this documentation as a self-hosted website: built from `docs/` with MkDocs (Material
> theme) into static HTML and served by nginx in Docker. Search, dark mode, no internet needed.
>
> **For:** operators (deploying it) and everyone (reading it).
>
> **Related:** [documentation map](../README.md) · [access control](../deployment/access-control.md) ·
> [Ansible](../deployment/ansible.md)

**Contents**

- [At a glance](#at-a-glance)
- [Production (Ansible)](#production-ansible)
- [Any Docker host](#any-docker-host)
- [How it is built](#how-it-is-built)
- [Writing documentation](#writing-documentation)

---

## At a glance

| | |
|---|---|
| **URL** | `http://192.168.68.139:30300` (production, monitoring host) |
| **Source** | `docs/` (the same Markdown that GitHub shows) |
| **Image** | `localhost/besu-docs/docs`: nginx with the built site, read-only container |
| **Who can open it** | `docs_ips` in `settings.yml`, and the operator |
| **Internet needed** | no: no external fonts or scripts; search runs in the browser |
| **Files** | `docs-site/` (`Dockerfile`, `mkdocs.yml`, `hooks.py`, `nginx.conf`, `docker-compose.yml`) |

The site has the same structure as `docs/`: tabs for Overview, Getting started, Deployment,
Components, Features, Operations, Reference and Development; full-text search; a light / dark switch;
a copy button on every code block.

## Production (Ansible)

On by default (`docs_site_enabled: true`). In `ansible/group_vars/all/settings.yml`:

```yaml
docs_site_enabled: true
docs_ips: [192.168.68.0/24]     # who may read it: addresses or networks
```

Apply (phase 01 copies the code and opens the firewall, 02 builds the image from the committed
`docs/`, 09 runs it on the monitoring host):

```bash
ansible-playbook 01-hosts.yml 02-images.yml 13-docs-site.yml
```

The site shows the **committed** documentation: commit your changes to `docs/` before running 02.
To turn it off, set `docs_site_enabled: false` and run `13-docs-site.yml` (it stops the container).

## Any Docker host

From the repository root:

```bash
docker compose -f docs-site/docker-compose.yml up -d --build
```

Then open `http://<host>:30300`. Settings in `docs-site/.env` (optional): `BIND_IP` (default all
addresses), `PORT` (default 30300). Rebuild after changing the documentation:

```bash
docker compose -f docs-site/docker-compose.yml up -d --build
```

## How it is built

1. **Build stage** (`python:3.12.8-slim`): installs `mkdocs 1.6.1` and `mkdocs-material 9.5.49`
   (from PyPI, at build time only), copies the repository (secrets, state and large files are
   excluded by `Dockerfile.dockerignore`) and runs `mkdocs build`.
2. **Links to source files:** the documents link to files outside `docs/` (contracts, playbooks,
   alert rules…). `hooks.py` points those links at `/_source/<path>` and copies the files there, so
   they open on the site as plain text (folders as a listing). `.env` files, binaries and files over
   2 MB are never copied.
3. **Serve stage** (`nginx:1.27.3-alpine`): the static site on port 30300, with `/_source/` served
   as `text/plain` only.

Heading anchors follow GitHub's rules, so the same links work on GitHub and on the site.

## Writing documentation

- Add a page under the right folder of `docs/`, then list it in `nav:` in `docs-site/mkdocs.yml`
  and in [`docs/README.md`](../README.md).
- Start it with the **What / For / Related** block, and a **Contents** list when it is long.
- Use relative links (`../features/sections.md`); links to code outside `docs/` are fine.
- Check the build locally (warnings list broken links and anchors):

```bash
pip install mkdocs==1.6.1 mkdocs-material==9.5.49
mkdocs build -f docs-site/mkdocs.yml -d /tmp/site
```
