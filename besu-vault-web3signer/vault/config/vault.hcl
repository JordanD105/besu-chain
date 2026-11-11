ui = true
disable_mlock = true

storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

# api_addr is supplied by VAULT_API_ADDR from .env (see docker-compose.yml).

