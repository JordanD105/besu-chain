# On-premise Vault + Web3Signer for Hyperledger Besu

This Docker Compose bundle runs HashiCorp Vault and Web3Signer. It expects an
existing Besu node with JSON-RPC enabled. Applications send `eth_sendTransaction`
to Web3Signer on `127.0.0.1:9000`; Web3Signer signs and forwards the transaction
to Besu.

## Prerequisites

- Linux host with Docker Engine and Docker Compose v2
- Besu JSON-RPC reachable from Docker
- A funded secp256k1 sender account

## 1. Configure Besu connection

```bash
cp .env.example .env
```

Edit `.env` and set `HOST_IP` to the address clients use to reach this host.
Docker Compose uses it for Vault (`VAULT_ADDR` and `VAULT_API_ADDR`) and, unless
`BESU_RPC_HOST` is set, for the Besu RPC host. Besu must listen on an address
reachable from the container. Restrict the Besu RPC firewall to the Docker
host/network.

## 2. Start Vault

```bash
docker compose up -d vault
docker compose exec vault vault operator init
```

Record the unseal keys and initial root token offline. Never commit them.
Unseal Vault using three different unseal keys:

```bash
docker compose exec vault vault operator unseal
docker compose exec vault vault operator unseal
docker compose exec vault vault operator unseal
```

Check status:

```bash
docker compose exec vault vault status
```

Vault must be unsealed again after container or host restarts unless you
configure a supported auto-unseal mechanism.

## 3. Provision the signer

Copy the root token and sender private key into environment variables without
putting them directly in command history:

```bash
read -rsp "Vault root token: " VAULT_TOKEN; export VAULT_TOKEN; echo
read -rsp "Sender private key (without 0x): " SENDER_PRIVATE_KEY; export SENDER_PRIVATE_KEY; echo
sh scripts/provision.sh
unset VAULT_TOKEN SENDER_PRIVATE_KEY
```

The script creates a least-privilege Vault policy, stores the key, issues a
renewable service token, and creates the Web3Signer key configuration. The root
token is not stored by the bundle.

## 4. Start Web3Signer

```bash
docker compose up -d web3signer
docker compose logs -f web3signer
```

List signing accounts:

```bash
curl -s http://127.0.0.1:9000 \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}'
```

Send a transaction:

```bash
curl -s http://127.0.0.1:9000 \
  -H 'Content-Type: application/json' \
  --data '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"eth_sendTransaction",
    "params":[{
      "from":"0xSENDER_ADDRESS",
      "to":"0xRECIPIENT_ADDRESS",
      "value":"0x1",
      "gas":"0x5208"
    }]
  }'
```

## 5. Token renewal

The service token is renewable and initially has a 30-day TTL. Schedule renewal
well before expiry, for example weekly:

```bash
sh scripts/renew-token.sh
```

## Security boundaries

- Ports 8200 and 9000 bind only to localhost by default.
- The Web3Signer token can read only one Vault secret.
- Never commit `.secrets`, `.env`, or generated `sender.yaml`.
- The included Vault listener uses HTTP only inside the private Docker bridge.
  For multi-host or production deployments, enable TLS for Vault, Besu RPC, and
  Web3Signer and restrict them using a firewall.
- Vault KV protects the key at rest, but Web3Signer retrieves it into process
  memory. A root administrator of the Vault or signer host can potentially
  obtain it. For a non-exportable key, use a secp256k1-capable HSM/KMS signer.
- Revoke the initial root token after creating durable administrative policies
  and recovery procedures.

## Stop services

```bash
docker compose down
```

Do not run `docker compose down -v` unless you intentionally want to delete the
Vault data volume.

