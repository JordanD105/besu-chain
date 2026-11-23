# 문제 해결

> **내용:** 나타날 수 있는 증상, 일반적인 원인, 확인 방법과 해결 방법입니다. 증상별로 정리되어 있습니다.
>
> **대상:** 당직 운영자.
>
> **관련 문서:** [알림](alerts.md) · [Grafana 대시보드](dashboards.md) · [재해 복구](disaster-recovery.md) · [아키텍처](../overview/architecture.md)

**목차**

- [첫 점검](#first-checks)
- [체인](#chain)
- [RPC와 RPC VIP](#rpc-and-the-rpc-vip)
- [서명과 계정](#signing-and-accounts)
- [프록시와 트랜잭션](#proxy-and-transactions)
- [섹션과 NFT](#sections-and-nfts)
- [호스트](#hosts)
- [배포 (Ansible)](#deployment-ansible)
- [정보 수집](#collecting-information)

---

## 첫 점검 {#first-checks}

1. **Grafana → Besu production → Alerts:** **critical** 알림부터 시작한 다음, 나머지를 설명하는
   `HostDown` 또는 `BesuNodeDown`을 찾으십시오([장애 상황 읽기](alerts.md#reading-an-incident)).
2. **Nodes 표:** 모든 노드가 UP, IN SYNC, 피어 5개, 마지막 블록 경과 시간 1 s 미만이어야 합니다.
3. **VIP는 어디에 있습니까?** h135와 h136에서: `ip -br a | grep -E '192\.168\.68\.15[01]'` (한 호스트가 둘 다 가집니다).
4. **HAProxy가 보는 RPC 노드** (h135 또는 h136): `curl -s http://127.0.0.1:8410/`.

## 체인 {#chain}

| 증상 | 가능한 원인 | 확인 | 해결 |
|---|---|---|---|
| 새 블록 없음 (`BesuNoNewBlocks`) | 온라인 검증자가 3개 미만 | Nodes 표, `BesuValidatorQuorumLost` | 검증자를 복구합니다. 3개 이상이 가동된 후에도 블록이 재개되지 않으면 모든 검증자를 함께 재시작합니다([Besu 수동 설정](../deployment/besu-manual.md)) |
| 한 노드의 높이만 그대로이고 다른 노드는 증가함 (`BesuNodeStalled`, Sync **STALLED**) | 블록 가져오기를 중단함: 피어 연결이 끊기거나 손상됨. 여전히 "in sync"로 표시될 수 있음 | Nodes 표: Behind, Last block age, Peers | RPC 노드: 5분 후 자동으로 재시작됩니다. 그 외에는 `docker restart besu-<node>-besu-1` |
| 노드의 피어가 0–1개 (`BesuPeersLow`) | 호스트 간 네트워크 또는 방화벽 문제, 또는 다른 호스트가 다운됨 | 해당 노드의 `net_peerCount`를 `curl`로 조회, 방화벽 규칙(`firewall-cmd --list-rich-rules`) | 네트워크를 수정합니다. 피어는 저절로 다시 연결됩니다(정적 노드) |
| `BesuUnpermittedPeers` | `permissions_config.toml`에 없는 노드가 연결을 시도함 | 노드 로그 | 알 수 없는 머신이면 무시합니다. 자체 노드라면 키 / IP를 확인합니다 |

## RPC와 RPC VIP {#rpc-and-the-rpc-vip}

| 증상 | 가능한 원인 | 확인 | 해결 |
|---|---|---|---|
| 애플리케이션이나 chainlens에 오래된 잔액 또는 블록이 보임 | RPC VIP가 정지된 노드를 서비스함 | h135 / h136에서 `curl -s http://127.0.0.1:8410/` | 상태 점검이 정지된 노드를 제거합니다. 두 RPC 노드가 모두 정지되면 가장 최신 노드가 계속 서비스합니다(성능 저하). 재시작하십시오 |
| `.150:8545`로의 `curl`이 멈춤 | HAProxy가 실행되지 않거나, VIP를 가진 호스트가 없음 | `systemctl status haproxy keepalived`; `journalctl -u keepalived` | 시작합니다. `ansible-playbook 07-ha.yml` |
| `besu-rpc-health`가 응답하지 않음 | 서비스가 중지됨 | `systemctl status besu-rpc-health`; `journalctl -u besu-rpc-health` | `systemctl restart besu-rpc-health` |

## 서명과 계정 {#signing-and-accounts}

| 증상 | 가능한 원인 | 확인 | 해결 |
|---|---|---|---|
| `/createaccount` 또는 "create section"이 실패함 | 키 생성에는 MPC 노드 **3개 모두**가 필요함 | `MpcNodeDown`, MPC 서명기 대시보드 | 누락된 MPC 노드를 복구하고 다시 시도합니다 |
| 모든 서명이 실패함 (`MpcBelowThreshold`) | 연결 가능한 MPC 노드가 2개 미만 | MPC 서명기 대시보드 | MPC 노드를 복구합니다 |
| 서명이 느림(초 단위) | 재시작이나 요청 급증 후 사전 서명 풀이 비어 있음 (`MpcPoolEmpty`) | Pools 패널 | 다시 채워질 때까지 기다립니다. 계속되면 CPU를 늘리거나 보충 동시성을 높입니다 |
| 트랜잭션이 거부됨 (`MpcPolicyRefusals`) | MPC 노드의 정책(값, 가스, 체인 ID, 대상)을 벗어남 | 코디네이터 로그 | 호출자를 수정하거나, 트랜잭션이 정당하면 정책을 수정합니다 |
| 재시작 후 `MpcPresignFailing` | 노드가 아직 로딩 중 | 코디네이터 로그 | 몇 분 안에 저절로 해제됩니다 |

## 프록시와 트랜잭션 {#proxy-and-transactions}

| 증상 | 가능한 원인 | 확인 | 해결 |
|---|---|---|---|
| 애플리케이션에 연결 오류가 발생함 | 프록시 다운, VIP .151 이동 중 | `ProxyDown`, VIP 호스트에서 `docker ps` | keepalived가 다른 프록시를 시작합니다. `journalctl -u keepalived`를 확인합니다 |
| **대기** 호스트의 프록시 컨테이너가 `Exited (137)`로 표시됨 | 정상: keepalived는 VIP가 없는 호스트의 프록시를 중지합니다(Docker가 부팅 시 다시 시작함) | `journalctl -u keepalived` ("proxy running without the proxy VIP") | 조치할 필요 없음 |
| 트랜잭션을 보냈지만 채굴되지 않음 (`ProxySenderStalled`) | 검증자의 풀에 해당 트랜잭션이 없음 | Proxy & Redis → *Senders needing attention* | 검증자 **하나**를 재시작합니다 |
| 발신자의 트랜잭션이 대기함 (`ProxyNonceGap`) | 누락된 논스 | `GET /status/senders`, 프록시 로그 | 프록시가 약 30 s 안에 복구합니다. 그렇지 않으면 로그를 확인합니다 |
| 프록시 로그에 `redis unavailable` | 시작 시 Redis가 준비되지 않았거나 다운됨 | `ProxyRedisDisconnected` | 정확성에는 영향이 없습니다. Redis를 재시작합니다 |

## 섹션과 NFT {#sections-and-nfts}

| 증상 | 가능한 원인 | 해결 |
|---|---|---|
| `401 X-Section-Key is required` | 호출에 섹션 키가 필요함 | `X-Section-Key: sk_…`를 보냅니다 |
| `403 … is not an account of section "…"` | 계정이 다른 섹션에 속함(또는 어느 섹션에도 속하지 않음) | 해당 섹션의 키로 생성한 계정을 사용합니다 |
| `403 section "…" is disabled` | 섹션이 비활성화됨 | chainlens Sections 페이지에서 활성화합니다 |
| 섹션이 계정을 생성할 수 없음 (`SectionUpfrontEmpty` / `Low`) | 선지급 계정이 비어 있음 | Sections 페이지에서 충전합니다 |
| NFT 판매: `wrong price` / 잔액 부족 | 구매자의 잔액이 가격 + 가스보다 적음 | 구매자에게 ETH를 보냅니다(−x) |
| `not minter` | `/contract/send`로 `mint`를 보냈거나, 컬렉션이 컨트랙트 계정 센터에서 배포되지 않음 | `POST /admin/contract/send`로 민팅합니다. 컬렉션은 chainlens 또는 `nft-collection` 템플릿으로 배포합니다 |
| `410 … was removed: use …` | 이전 `/nft/*`, `/nickname/*` 또는 `/admin/nickname/*` 라우트 | 메시지가 알려 주는 호출을 사용합니다([제거된 라우트](../reference/proxy-api.md#removed-routes)) |

## 호스트 {#hosts}

| 증상 | 확인 | 해결 |
|---|---|---|
| `HostMemoryHigh` | `free -m`; `docker stats --no-stream`; `ps aux --sort=-rss \| head` | 프로세스를 찾습니다. 각 Besu 노드는 힙을 `besu_java_opts`(`-Xmx`)까지 늘릴 수 있습니다 |
| `HostDiskFull` | `df -h`; `docker system df` | `docker image prune`, 오래된 로그 정리, 디스크 확장(디스크가 가득 차면 Besu가 멈춤) |
| `HostClockNotSynced` | `chronyc tracking` | NTP를 수정합니다(설정의 `ntp_servers`) |
| 호스트 재시작 후: 백업 알림 (`…BackupMissing`, `…TooOld`) | 호스트의 백업 기록에 연결할 수 없었음 | 다음 백업 실행 후 해제됩니다(MPC 키 조각은 매시간) |

## 배포 (Ansible) {#deployment-ansible}

| 증상 | 원인 | 해결 |
|---|---|---|
| "hosts have older code than this checkout" | `git pull` 후 단계 01 없이 다른 단계를 실행함 | 먼저 `01-hosts.yml`을 실행합니다 |
| 이미지 누락 / `Unable to find image` | 이미지가 빌드되지 않았거나 아카이브가 없음 | `02-images.yml`을 실행합니다. `image_archives_dir`를 사용하는 경우 아카이브를 추가합니다(`save-images.yml`) |
| 호스트 재시작 직후 단계가 실패함 | 서비스가 아직 시작 중 | 단계를 다시 실행합니다 |

## 정보 수집 {#collecting-information}

```bash
docker ps -a --format '{{.Names}} {{.Status}}'           # what runs on a host
docker logs --since 30m <container> 2>&1 | grep -iE "error|fail|exception" | tail -50
journalctl -u keepalived -u haproxy -u besu-rpc-health --since "30 min ago" --no-pager
free -m; df -h
```

이 결과를 문제가 발생한 시간(UTC, 또는 시간대를 명시)과 함께 보내십시오. Grafana는 현지 시간을 표시합니다.
