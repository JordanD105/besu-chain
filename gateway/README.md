# Section gateway

The optimistic gateway of one section, next to its application: it speaks the proxy's application
API with the section's key, keeps a local ledger, answers by itself while the proxy cannot be
reached, and sends the queued requests when the link is back.

- Program: `gateway.js` (Node.js 22, no npm packages: `node:http`, `node:sqlite`, `fetch`)
- Deployed by `ansible/14-gateway.yml` on the hosts of the `gateway_hosts` group
- Documentation: [docs/components/gateway.md](../docs/components/gateway.md)
