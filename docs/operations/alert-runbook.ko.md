# 알림 런북

> **내용:** 모든 알림의 해결 방법을 단계별로 설명합니다: 확인, 조치(명령 포함), 해제 확인. 알림마다
> 그 이름을 딴 절이 하나씩 있습니다.
>
> **대상:** 당직 운영자.
>
> **관련 문서:** [알림](alerts.md) (각 알림의 발생 시점) · [Grafana 대시보드](dashboards.md) ·
> [문제 해결](troubleshooting.md) · [재해 복구](disaster-recovery.md)

**목차**

- [시작하기 전에](#before-you-start)
- [Besu](#besu): [BesuValidatorQuorumLost](#besuvalidatorquorumlost) · [BesuNoNewBlocks](#besunonewblocks) · [BesuNodeDown](#besunodedown) · [BesuNodeStalled](#besunodestalled) · [BesuNotInSync](#besunotinsync) · [BesuPeersMissing](#besupeersmissing) · [BesuPeersLow](#besupeerslow) · [BesuTxPoolGrowing](#besutxpoolgrowing) · [BesuHeapHigh](#besuheaphigh) · [BesuUnpermittedPeers](#besuunpermittedpeers)
- [MPC 서명기](#mpc-signer): [MpcBelowThreshold](#mpcbelowthreshold) · [MpcCoordinatorDown](#mpccoordinatordown) · [MpcNodeDown](#mpcnodedown) · [MpcPoolEmpty](#mpcpoolempty) · [MpcSmallPoolsEmpty](#mpcsmallpoolsempty) · [MpcPresignFailing](#mpcpresignfailing) · [MpcSignErrors](#mpcsignerrors) · [MpcPolicyRefusals](#mpcpolicyrefusals)
- [프록시와 Redis](#proxy-and-redis): [ProxyDown](#proxydown) · [ProxySenderStalled](#proxysenderstalled) · [ProxyNonceGap](#proxynoncegap) · [ProxyNonceRepaired](#proxynoncerepaired) · [ProxySenderCheckFailing](#proxysendercheckfailing) · [ProxyHttpErrors](#proxyhttperrors) · [ProxySlow](#proxyslow) · [ProxyEventLoopBlocked](#proxyeventloopblocked) · [ProxyRedisDisconnected](#proxyredisdisconnected) · [RedisDown](#redisdown) · [RedisMemoryHigh](#redismemoryhigh)
- [섹션](#sections): [SectionUpfrontEmpty](#sectionupfrontempty) · [SectionUpfrontLow](#sectionupfrontlow) · [Sender01Low](#sender01low) · [SectionMetricsFailing](#sectionmetricsfailing)
- [섹션 게이트웨이](#section-gateways): [GatewayOffline](#gatewayoffline) · [GatewayDrainingLong](#gatewaydraininglong) · [GatewayQueueOld](#gatewayqueueold) · [GatewaySparesLow](#gatewayspareslow) · [GatewayConflicts](#gatewayconflicts) · [GatewayCorrectionsOpen](#gatewaycorrectionsopen) · [GatewayDown](#gatewaydown)
- [호스트](#hosts): [HostDown](#hostdown) · [HostMemoryHigh](#hostmemoryhigh) · [HostDiskFull](#hostdiskfull) · [HostClockNotSynced](#hostclocknotsynced)
- [백업](#backups): [BackupFailed](#backupfailed) · [ChainSnapshotTooOld](#chainsnapshottooold) · [ChainSnapshotMissing](#chainsnapshotmissing) · [MpcShareBackupTooOld](#mpcsharebackuptooold) · [MpcShareBackupMissing](#mpcsharebackupmissing) · [ValidatorKeyBackupMissing](#validatorkeybackupmissing)

---

## 시작하기 전에 {#before-you-start}

1. **발생 중인 모든 알림을 함께 보십시오**(Grafana, 모든 대시보드 상단). 원인 하나가 여러 알림을
   발생시키는 경우가 많으므로 **원인**을 먼저 해결하십시오. `HostDown`은 보통 같은 호스트의 다른 모든
   알림을 설명합니다([장애 상황 읽기](alerts.md#reading-an-incident)).
2. **critical을 먼저** 처리하고, 그다음 warning, 그다음 info를 처리하십시오.
3. **시간을 기록하십시오.** Grafana는 현지 시간을 표시하며, 호스트의 로그는 UTC일 수 있습니다.

아래에서 사용하는 이름(프로덕션 기본값):

| 항목 | 이름 / 위치 |
|---|---|
| Besu 노드 `<node>` (val1–val4, rpc1, rpc2) | 디렉터리 `/opt/besu-<node>`, 컨테이너 `besu-<node>-besu-1` |
| 호스트 | h135 val1, rpc1, coord1, mpc1, 프록시 · h136 val2, rpc2, coord2, 프록시(대기) · h137 val3, mpc2 · h138 val4, mpc3 · h139 모니터링, chainlens, Remix, 문서 |
| 코디네이터 | `/opt/mpc-coordinator`, 컨테이너 `mpc-coordinator-mpc-coordinator-1`, 포트 9100 |
| MPC 노드 | `/opt/besu-chain/mpc-signer/deploy/node` (`mpc_node_dir`), 컨테이너 `node-mpc-node-1`, 포트 7000 |
| 프록시, Redis | `/opt/besu-chain/proxy`, 컨테이너 `proxy-proxy-1`, `proxy-redis-1`. VIP `.151`을 가진 호스트에서 실행됩니다 |
| 모니터링 | h139의 `/opt/monitoring`(그곳의 Prometheus는 `127.0.0.1:9090`) |
| Ansible | 운영자 머신의 `ansible/`에서 실행합니다 |

어디서나 유용한 명령:

```bash
docker ps -a --format '{{.Names}} {{.Status}}'
```

```bash
docker logs --since 30m <container> 2>&1 | grep -iE "error|fail|exception|warn" | tail -50
```

---

## Besu {#besu}

### BesuValidatorQuorumLost {#besuvalidatorquorumlost}

**Critical.** 온라인 검증자 수가 QBFT에 필요한 수(4개 중 3개)보다 적습니다: 블록이 생성되지 않습니다.

1. **확인:** Besu production → *Validators up*. Nodes 표에서 어떤 노드가 DOWN인지 확인합니다.
2. **조치:** 검증자를 한 번에 하나씩, 해당 호스트에서 복구하십시오:
   ```bash
   docker start besu-<node>-besu-1
   ```
   호스트가 다운되었으면 [HostDown](#hostdown)을 참조하십시오. 컨테이너가 다시 종료되면 로그를
   확인하십시오(디스크 가득 참, 손상된 데이터베이스: [재해 복구](disaster-recovery.md)).
3. **해제 확인:** *Validators up* ≥ 3이고 *Seconds since last block*이 다시 1 s 미만이어야 합니다. 쿼럼이
   복구된 후 1분 안에 블록 생성이 재개되지 않으면 [BesuNoNewBlocks](#besunonewblocks)를 참조하십시오.

### BesuNoNewBlocks {#besunonewblocks}

**Critical.** 블록 주기의 3배 + 5 s 동안 블록이 없습니다.

1. **확인:** *Seconds since last block*이 계속 증가합니까? `BesuValidatorQuorumLost`도 발생하고 있습니까?
2. **조치:**
   - 쿼럼 상실: 그것을 먼저 해결하십시오([BesuValidatorQuorumLost](#besuvalidatorquorumlost)).
   - 쿼럼은 복구되었지만 여전히 블록이 없는 경우(검증자의 라운드가 어긋남): **모든 검증자를 함께**
     재시작하십시오. h135–h138 각각에서 동시에 실행합니다:
     ```bash
     docker restart besu-val<N>-besu-1
     ```
     자세한 내용: [Besu 수동 설치](../deployment/besu-manual.md)의 *Chain halted*.
   - 시계도 확인하십시오([HostClockNotSynced](#hostclocknotsynced)).
3. **해제 확인:** 다시 매초 블록이 생성됩니다. 이후 RPC 노드는 스스로 따라잡습니다.

### BesuNodeDown {#besunodedown}

**Warning.** Besu 노드의 메트릭이 1분 동안 응답하지 않습니다.

1. **확인:** 알림에 노드 이름이 표시됩니다. 호스트가 가동 중입니까(`HostDown`)?
2. **조치:** 해당 호스트에서:
   ```bash
   docker ps -a --filter name=besu-<node>
   ```
   ```bash
   docker logs --tail 100 besu-<node>-besu-1
   ```
   재시작을 반복합니까? 로그를 확인하십시오: 디스크 가득 참([HostDiskFull](#hostdiskfull)), 메모리 부족
   ([HostMemoryHigh](#hostmemoryhigh)), 데이터베이스 오류([재해 복구](disaster-recovery.md)).
   중지된 경우:
   ```bash
   docker start besu-<node>-besu-1
   ```
   Ansible로 다시 배포하려면: `ansible-playbook 05-besu.yml --limit <host>`.
3. **해제 확인:** Nodes 표에서 UP, 그리고 1–2분 안에 IN SYNC가 되어야 합니다.

### BesuNodeStalled {#besunodestalled}

**Warning.** 체인은 최신인데 노드의 최신 블록이 60 s 이상 오래되었습니다: 여전히 "in sync"로 표시되더라도
노드가 블록 가져오기를 중단한 것입니다.

1. **확인:** Nodes 표: Sync가 **STALLED**, Last block age가 증가, Behind가 커집니다. 해당 노드의
   Peers도 확인하십시오(낮은 경우가 많습니다).
2. **조치:**
   - **RPC 노드(rpc1, rpc2):** 이미 RPC VIP에서 빠져 있으며, 5분 후 `besu-rpc-health`가 재시작합니다.
     지금 바로 재시작하려면 해당 호스트에서:
     ```bash
     docker restart besu-<node>-besu-1
     ```
   - **검증자:** 같은 방법으로 재시작하십시오(나머지 검증자가 블록 생성을 계속합니다).
   - 그다음 원인을 찾으십시오: 피어 끊김(네트워크, 방화벽 재로드), 호스트의 메모리 부족:
     ```bash
     docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -viE "Imported|pending blocks" | tail -50
     ```
3. **해제 확인:** IN SYNC, Behind가 다시 ~0. h135 / h136에서 `curl -s http://127.0.0.1:8410/`가
   RPC 노드가 정상임을 보여 주어야 합니다.

### BesuNotInSync {#besunotinsync}

**Warning.** 노드가 5분 동안 동기화 중이라고 보고하거나, 알고 있는 최고 블록보다 10블록 이상
뒤처져 있습니다.

1. **확인:** Nodes 표(SYNCING / BEHIND), *Blocks behind* 차트. 재시작 직후 몇 분 동안은
   정상입니다.
2. **조치:** 줄어들지 않으면 피어([BesuPeersLow](#besupeerslow))와 로그를 확인하십시오. 높이가 전혀
   변하지 않으면 [BesuNodeStalled](#besunodestalled)로 처리하십시오.
3. **해제 확인:** Blocks behind 0, Sync IN SYNC.

### BesuPeersMissing {#besupeersmissing}

**Warning.** 노드의 피어 수가 5분 동안 (가동 중인 노드 수 − 1)보다 적습니다.

1. **확인:** *Peers* 차트: 어떤 노드인지, 언제부터인지 확인합니다.
2. **조치:** 해당 노드의 호스트에서 다른 노드의 P2P 포트를 테스트하십시오(검증자 30303, RPC 노드
   30304):
   ```bash
   nc -zv 192.168.68.137 30303
   ```
   연결이 거부되거나 시간 초과되면: 방화벽(`01-hosts.yml` 재실행) 또는 상대 노드의 다운입니다. 새 키나
   주소로 다시 생성된 노드는 모든 노드의 `static-nodes.json`과
   `permissions_config.toml`에 있어야 합니다([Besu 수동 설치](../deployment/besu-manual.md)).
3. **해제 확인:** 모든 노드의 피어가 5개입니다.

### BesuPeersLow {#besupeerslow}

**Warning.** 노드의 피어가 2분 동안 2개 미만입니다: 연결 하나만 끊겨도 고립되며 정지될 수
있습니다.

1. **확인 및 조치:** [BesuPeersMissing](#besupeersmissing)과 같습니다. 피어가 돌아오지 않으면
   노드를 재시작하십시오(정적 피어에 다시 연결합니다):
   ```bash
   docker restart besu-<node>-besu-1
   ```
2. **해제 확인:** Peers ≥ 2(보통 5). [BesuNodeStalled](#besunodestalled)가 발생하는지 지켜보십시오.

### BesuTxPoolGrowing {#besutxpoolgrowing}

**Warning.** 노드에 대기 중인 트랜잭션이 10분 동안 1,000개를 넘습니다.

1. **확인:** *Transaction pool* 차트. Proxy & Redis → *Senders needing attention*(STALLED, NONCE GAP).
2. **조치:**
   - 발신자가 STALLED인 경우: [ProxySenderStalled](#proxysenderstalled).
   - 논스 공백: [ProxyNonceGap](#proxynoncegap).
   - 실제 부하가 처리 용량을 넘는 경우: 블록이 가득 찹니다(*Gas used per block*이 한도에 가까움).
     클라이언트의 전송 속도를 낮추십시오. 풀은 저절로 비워집니다.
3. **해제 확인:** 풀이 다시 ~0으로 줄어듭니다.

### BesuHeapHigh {#besuheaphigh}

**Warning.** Java 힙이 10분 동안 최대치의 90 %를 넘습니다.

1. **확인:** *JVM heap used*가 녹색 최대선에 가깝고 *GC time*이 증가합니다.
2. **조치:** 단기적으로는 노드를 재시작하십시오(`docker restart besu-<node>-besu-1`). 다시 발생하면:
   호스트에 메모리가 있는 경우에만 `settings.yml`에서 `besu_java_opts`(예: `-Xmx6g`)를 늘린 다음
   `ansible-playbook 05-besu.yml`을 실행하십시오.
3. **해제 확인:** 최대치보다 한참 아래에서 톱니 모양을 그립니다.

### BesuUnpermittedPeers {#besuunpermittedpeers}

**Info.** `permissions_config.toml`에 없는 노드의 연결을 노드가 거부했습니다.

1. **확인:** 누구였는지 확인합니다:
   ```bash
   docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -i "not permitted\|unpermitted" | tail
   ```
2. **조치:** 알 수 없는 머신이면 방화벽에서 차단하고 조사하십시오. 새 키나 주소를 가진 자체 노드이면
   모든 노드의 `permissions_config.toml`과 `static-nodes.json`에 추가하십시오
   ([Besu 수동 설치](../deployment/besu-manual.md)).

---

## MPC 서명기 {#mpc-signer}

### MpcBelowThreshold {#mpcbelowthreshold}

**Critical.** 연결 가능한 MPC 노드 수가 임계값(3개 중 2개)보다 적습니다: **서명이 불가능합니다**.

1. **확인:** MPC signer → *MPC nodes up*, *MPC nodes* 표(어떤 노드가, 어느 코디네이터에서
   보이는지).
2. **조치:** MPC 노드를 복구하십시오. 각 노드는 해당 팀의 소관입니다. 해당 호스트에서:
   ```bash
   cd /opt/besu-chain/mpc-signer/deploy/node && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 node-mpc-node-1
   ```
   키 조각의 봉인을 해제하지 못하는 노드에는 `MPC_NODE_PASSPHRASE`(팀이 보관한 사본)가 필요합니다.
   키 조각을 잃은 경우: [운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md)(복원).
3. **해제 확인:** *MPC nodes up* ≥ 2이고, 서명이 다시 처리됩니다.

### MpcCoordinatorDown {#mpccoordinatordown}

**Critical.** 코디네이터의 `/metrics`가 응답하지 않습니다(또는 메트릭 토큰이 일치하지 않습니다).
다른 코디네이터가 VIP를 통해 서명을 계속합니다.

1. **확인:** 다운된 것입니까, 아니면 메트릭 토큰만의 문제입니까?
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.135:9100/health
   ```
   200 = 가동 중: `/opt/monitoring/secrets/mpc-metrics-token`의 토큰이 코디네이터의
   `MPC_METRICS_TOKEN`과 일치하지 않습니다(`09-monitoring.yml` 재실행).
2. **조치**(다운된 경우), 해당 호스트에서:
   ```bash
   cd /opt/mpc-coordinator && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 mpc-coordinator-mpc-coordinator-1
   ```
   Ansible 사용 시: `ansible-playbook 04-coordinators.yml --limit <host>`.
3. **해제 확인:** MPC signer 대시보드에서 Coordinator가 UP입니다.

### MpcNodeDown {#mpcnodedown}

**Warning.** 코디네이터가 1분 동안 MPC 노드에 연결할 수 없습니다. 서명은 3개 중 2개로 가능하지만,
**계정과 섹션 생성은 불가능합니다**(3개 모두 필요).

1. **확인:** *MPC nodes* 표: **두** 코디네이터 모두에서 다운이면 노드 문제이고, **한** 코디네이터에서만
   다운이면 두 호스트 사이의 네트워크 문제입니다.
2. **조치:** 노드 다운: [MpcBelowThreshold](#mpcbelowthreshold) 2단계와 같습니다(해당 노드의 팀).
   네트워크: 코디네이터의 호스트에서 테스트하십시오:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.137:7000/health
   ```
   시간 초과: 방화벽(`01-hosts.yml`) 또는 네트워크 문제입니다.
3. **해제 확인:** 두 코디네이터 모두에서 UP. 실패한 계정 또는 섹션 생성을 다시 시도하십시오.

### MpcPoolEmpty {#mpcpoolempty}

**Warning.** 큰(핫) 키에 준비된 사전 서명이 2분 동안 없습니다: 서명이 느린 경로로 전환됩니다
(서명당 ~0.6 s).

1. **확인:** MPC signer → *Keys needing attention*(어느 키, 어느 코디네이터), *Big keys: the 10 lowest pools*, *Presignatures generated per second*. MPC 노드나
   코디네이터를 재시작한 후 몇 분 동안은 정상입니다.
2. **조치:** 계속되는 경우:
   - 3개 노드 중 하나가 다운되면 사전 서명 생성이 느려집니다: [MpcNodeDown](#mpcnodedown).
   - 서명이 사전 서명 생성보다 빠른 경우(지속적인 부하): MPC 노드에 CPU를 추가하거나, 코디네이터의
     `MPC_REFILL_CONCURRENCY`를 늘리십시오([MPC 서명기](../components/mpc-signer.md)).
   - 사전 서명이 많이 실패한 노드 재시작 후에는, 깨끗하게 다시 채워지도록 두 코디네이터의 풀을
     비우십시오([MPC 서명기 업그레이드](mpc-signer-upgrade.md)).
3. **해제 확인:** 풀이 다시 목표치를 향해 증가합니다.

### MpcSmallPoolsEmpty {#mpcsmallpoolsempty}

**Warning.** 작은 풀(`/createaccount`로 만든 계정)의 절반 이상이 15분 동안 비어 있습니다.

1. **확인:** *Pools of small keys*가 전체 목표치보다 한참 낮습니다. *Keys per pool class*.
2. **조치:** 작은 키가 사전 서명 생성 용량에 비해 너무 많습니다:
   - 거의 사용하지 않는 계정을 `none`으로 옮기십시오: `POST /account/pool {"address": "0x…", "pool": "none"}`
     ([프록시 API](../reference/proxy-api.md)).
   - `MPC_POOL_TARGET_SMALL`을 낮추거나, `MPC_REFILL_CONCURRENCY` / `MPC_COMPUTE_THREADS`와
     MPC 노드의 CPU를 늘리십시오.
3. **해제 확인:** 비어 있는 작은 풀이 줄어듭니다.

### MpcPresignFailing {#mpcpresignfailing}

**Warning.** 10분 동안 사전 서명 세션이 5회 넘게 실패했습니다.

1. **확인:** 보통 MPC 노드나 코디네이터를 재시작한 직후입니다(몇 분 안에 저절로 해제됩니다).
   그렇지 않으면 코디네이터 로그를 확인하십시오:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "presign|fail|error" | tail -30
   ```
2. **조치:** 노드 시간 초과: [MpcNodeDown](#mpcnodedown). MPC 호스트 간 네트워크. 업그레이드 후
   클러스터 설정이 다른 노드([MPC 서명기 업그레이드](mpc-signer-upgrade.md)).
3. **해제 확인:** 마지막 실패 후 10분이 지나면 알림이 해제됩니다.

### MpcSignErrors {#mpcsignerrors}

**Warning.** 정책 이외의 이유로 서명 요청이 실패했습니다.

1. **확인:** MPC signer → *Failures*. 코디네이터 로그:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "sign|error" | tail -30
   ```
2. **조치:** 원인별로: 알 수 없는 키(계정이 이 클러스터에 없음), 노드 시간 초과
   ([MpcNodeDown](#mpcnodedown)), `eth_sendTransaction`에 Besu가 응답하지 않음
   ([BesuNodeDown](#besunodedown), RPC VIP).
3. **해제 확인:** *Failures*가 다시 0입니다.

### MpcPolicyRefusals {#mpcpolicyrefusals}

**Warning.** MPC 노드의 정책(값, 가스, 체인 ID 또는 대상)에 의해 트랜잭션이 거부되었습니다.

1. **확인:** 무엇이 거부되었는지 확인합니다:
   ```bash
   docker logs --since 1h mpc-coordinator-mpc-coordinator-1 2>&1 | grep -i policy | tail -20
   ```
2. **조치:** 호출자의 버그(잘못된 체인 ID, 너무 큰 금액): 호출자를 수정하십시오. 한도를 넘는 정당한
   트랜잭션: 각 팀이 `cluster.json`의 정책을 변경합니다
   ([운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md)). 원인이 설명되지 않는 거부 때문에
   정책을 완화하지 마십시오: 공격일 수 있습니다.
3. **해제 확인:** 새 거부가 없습니다.

---

## 프록시와 Redis {#proxy-and-redis}

### ProxyDown {#proxydown}

**Critical.** 활성 프록시(VIP `.151` 경유)가 응답하지 않습니다: 애플리케이션이 전송할 수 없습니다.

1. **확인:** VIP가 어디에 있고, 그곳에서 프록시가 실행 중입니까?
   ```bash
   ip -br a | grep 192.168.68.151
   ```
   ```bash
   docker ps --filter name=proxy-proxy
   ```
2. **조치:**
   - keepalived가 VIP를 다른 호스트로 옮기고 그곳의 프록시를 시작했어야 합니다: 두 호스트 모두에서
     `journalctl -u keepalived --since "15 min ago"`를 확인하십시오.
   - 프록시 컨테이너가 VIP 호스트에 있지만 종료되는 경우: `docker logs --tail 100 proxy-proxy-1`
     (잘못된 `.env`, 시작 시 서명기 또는 Besu에 연결 불가).
   - 모든 것을 올바른 순서로 복구하려면: `ansible-playbook 07-ha.yml`.
3. **해제 확인:** `curl -s http://192.168.68.151:30000/status/senders`가 응답하고, *Proxy*가 UP입니다.

### ProxySenderStalled {#proxysenderstalled}

**Critical.** 발신자의 트랜잭션이 RPC 노드의 풀에 준비되어 있지만, 블록이 계속 생성되는데도
포함되지 않습니다: 검증자에게 해당 트랜잭션이 없습니다.

1. **확인:** Proxy & Redis → *Senders needing attention*: 해당 발신자가 **STALLED**입니다.
2. **조치:** 검증자 **하나**를 재시작하십시오(풀을 다시 가져와 트랜잭션을 포함합니다). 예를 들어
   h137에서:
   ```bash
   docker restart besu-val3-besu-1
   ```
   검증자에 `tx-pool-max-future-by-sender=2000`이 설정되어 있는지 확인하십시오.
3. **해제 확인:** Mined가 OK이고, In flight가 다시 0으로 떨어집니다.

### ProxyNonceGap {#proxynoncegap}

**Warning.** 논스가 2분 넘게 누락되어 있습니다. 해당 발신자의 이후 트랜잭션이 대기합니다.

1. **확인:**
   ```bash
   curl -s http://192.168.68.151:30000/status/senders
   ```
   (해당 발신자의 `gap`과 대기 중인 트랜잭션).
2. **조치:** 프록시는 공백을 스스로 복구합니다(재전송하거나 채움 트랜잭션을 보냅니다). 복구되지 않으면
   체인이나 서명기가 막고 있는 것입니다: `docker logs --since 15m proxy-proxy-1`을 확인하고,
   [MpcBelowThreshold](#mpcbelowthreshold)와 [BesuNoNewBlocks](#besunonewblocks)를 확인하십시오.
3. **해제 확인:** *Nonce gap since*가 다시 0입니다.

### ProxyNonceRepaired {#proxynoncerepaired}

**Info.** 프록시가 공백을 복구했습니다: 트랜잭션이 손실되었거나, 채움 트랜잭션이 전송되었습니다.

1. **경위 확인:** `docker logs --since 1h proxy-proxy-1 2>&1 | grep -i -E "repair|filler|gap"`.
2. **조치:** 반복될 때만 조치하십시오: 트랜잭션 손실을 나타냅니다(트랜잭션을 버린 RPC 노드, 전송 도중의
   재시작).

### ProxySenderCheckFailing {#proxysendercheckfailing}

**Warning.** 프록시의 백그라운드 점검이 2분 동안 발신자 정보를 Besu에서 읽을 수 없습니다.

1. **확인:** 프록시 호스트에서 RPC VIP를 확인합니다:
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://192.168.68.150:8545
   ```
2. **조치:** 응답이 없으면: HAProxy와 RPC 노드를 확인하십시오(h135 / h136에서 `curl -s http://127.0.0.1:8410/`.
   [BesuNodeDown](#besunodedown)).
3. **해제 확인:** 알림이 해제되고, Proxy & Redis → *All senders*에서 해당 발신자가 다시 OK입니다.

### ProxyHttpErrors {#proxyhttperrors}

**Warning.** 5분 동안 응답의 5 % 이상이 5xx입니다.

1. **확인:** Proxy & Redis → *Errors per second*: 어떤 경로, 어떤 코드인지 확인합니다.
2. **조치:** 오류를 확인하십시오:
   ```bash
   docker logs --since 15m proxy-proxy-1 2>&1 | grep -iE "error|fail" | tail -30
   ```
   일반적인 원인: 서명기 다운 또는 지연(MPC 알림), Besu 무응답(RPC VIP), 섹션 호출에 레지스트리가
   응답하지 않음.
3. **해제 확인:** *5xx errors*가 다시 0 %입니다.

### ProxySlow {#proxyslow}

**Warning.** 95번째 백분위 응답 시간이 10분 동안 5 s를 넘습니다(`/createaccount`와
`/admin` 제외).

1. **확인:** Proxy & Redis → *95th percentile by route*: 어떤 경로인지 확인합니다.
2. **조치:** 이체와 아바타 판매가 느린 경우: 콜드 경로로 서명([MpcPoolEmpty](#mpcpoolempty)) 또는
   느린 RPC 노드(Besu → *JSON-RPC latency*). 모든 것이 느린 경우: 프록시 자체
   ([ProxyEventLoopBlocked](#proxyeventloopblocked)) 또는 호스트([HostMemoryHigh](#hostmemoryhigh)).
3. **해제 확인:** *Latency p95*가 다시 1–2 s 미만입니다.

### ProxyEventLoopBlocked {#proxyeventloopblocked}

**Warning.** 프록시의 단일 Node.js 스레드가 5분 동안 1 s 넘게 차단되었습니다.

1. **확인:** Proxy & Redis의 *Event-loop delay*와 *Memory*, Hosts의 호스트 CPU.
2. **조치:** 호스트의 CPU나 메모리가 부족하면 그것을 해결하십시오([HostMemoryHigh](#hostmemoryhigh)). 프록시의
   메모리가 꾸준히 증가하면 VIP 호스트에서 재시작하십시오(몇 초 동안 요청이 실패합니다):
   ```bash
   cd /opt/besu-chain/proxy && docker compose restart proxy
   ```
3. **해제 확인:** 이벤트 루프 지연이 0.1 s 미만입니다.

### ProxyRedisDisconnected {#proxyredisdisconnected}

**Warning.** 활성 프록시에 5분 동안 Redis 연결이 없습니다. 프록시는 계속 작동하지만(메모리 +
체인), 재시작하면 논스 캐시를 잃습니다.

1. **확인:** VIP 호스트에서: `docker ps --filter name=proxy-redis`.
2. **조치:**
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis
   ```
   프록시는 스스로 다시 연결합니다(로그에 "redis available again").
3. **해제 확인:** Proxy & Redis → *Redis link*가 CONNECTED입니다.

### RedisDown {#redisdown}

**Warning.** 활성 프록시의 Redis(또는 그 익스포터)가 2분 동안 응답하지 않습니다.

1. **확인:** Redis 문제입니까, 익스포터만의 문제입니까?
   ```bash
   docker ps --filter name=proxy-redis
   ```
2. **조치:** Redis가 중지된 경우: [ProxyRedisDisconnected](#proxyredisdisconnected)와 같습니다. 익스포터만의 경우:
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis-exporter
   ```
3. **해제 확인:** Proxy & Redis → *Redis*가 UP입니다.

### RedisMemoryHigh {#redismemoryhigh}

**Warning.** Redis가 10분 동안 `maxmemory`의 90 %를 넘습니다(최대값이 설정된 경우에만).

1. **확인:** *Memory and keys*.
2. **조치:** `maxmemory`를 늘리거나, 무엇이 증가하는지 찾으십시오(`docker exec proxy-redis-1 redis-cli --bigkeys`).
   프록시의 키는 작으므로 꾸준한 증가는 이례적입니다: 보고하십시오.
3. **해제 확인:** 메모리가 기준선 아래에 있습니다.

---

## 섹션 {#sections}

### SectionUpfrontEmpty {#sectionupfrontempty}

**Critical.** 활성화된 섹션의 선지급 계정이 0입니다: 계정을 생성하거나 −x 송금을 지불할 수 없습니다.

1. **확인:** Sections 대시보드 → *Upfront accounts*. chainlens **Sections** 페이지.
2. **조치:** SENDER01에서 충전하십시오: chainlens Sections 페이지 → 해당 섹션 → **Top up**, 또는:
   ```bash
   curl -s -X POST http://192.168.68.151:30000/admin/sections/<id>/topup \
     -H "Authorization: Bearer $(cat state/secrets/proxy_admin_token)" \
     -H 'Content-Type: application/json' -d '{"amount":"500"}'
   ```
   (운영자 머신의 `ansible/`에서 실행). SENDER01도 부족하면: [Sender01Low](#sender01low).
3. **해제 확인:** 잔액이 `upfront_low_balance_eth`보다 높습니다.

### SectionUpfrontLow {#sectionupfrontlow}

**Warning.** 활성화된 섹션의 선지급 잔액이 `upfront_low_balance_eth` 미만입니다.

1. **조치:** 소진되기 전에 [SectionUpfrontEmpty](#sectionupfrontempty)와 같이 충전하십시오. 임계값을
   변경하려면: `settings.yml`의 `upfront_low_balance_eth`를 수정한 다음
   `ansible-playbook 06-proxy.yml`을 실행하십시오(0이면 알림이 꺼집니다).

### Sender01Low {#sender01low}

**Warning.** SENDER01이 `sender01_low_balance_eth` 미만입니다. SENDER01은 모든 충전 자금을 제공합니다.

1. **조치:** 섹션의 자금을 회수하십시오: chainlens Sections 페이지에서 각 섹션에 대해 **Sweep**
   (소비 → 결제) 후 **Pay back**(결제 → SENDER01)을 실행합니다. 그렇지 않으면 자금 보유 계정에서
   SENDER01에 자금을 보충하십시오.
2. **해제 확인:** Sections 대시보드 → *SENDER01*이 임계값보다 높습니다.

### SectionMetricsFailing {#sectionmetricsfailing}

**Warning.** 프록시가 10분 동안 섹션 잔액을 읽을 수 없습니다. 잔액 알림이 작동하지 않는 상태입니다.

1. **확인:** VIP 호스트에서 `docker logs --since 15m proxy-proxy-1 2>&1 | grep -i section | tail`.
2. **조치:** SectionRegistry 또는 Besu가 프록시에 응답하지 않습니다: RPC VIP
   ([ProxySenderCheckFailing](#proxysendercheckfailing) 1단계)와
   `/opt/besu-chain/proxy/.env`의 `REGISTRY_CONTRACT`를 확인하십시오(`06-proxy.yml` 재실행).
3. **해제 확인:** Sections 대시보드가 다시 갱신됩니다.

---

## 섹션 게이트웨이 {#section-gateways}

섹션 게이트웨이를 사용할 때만 해당합니다([섹션 게이트웨이](../components/gateway.md)). 명령은 게이트웨이
호스트의 `/opt/besu-chain/gateway`에서 실행합니다. `<gateway host>`는 그 주소이며 포트는 30010입니다.

### GatewayOffline {#gatewayoffline}

**Warning.** 섹션의 게이트웨이가 1분 동안 프록시에 연결할 수 없습니다. 애플리케이션은 게이트웨이의
원장으로 계속 동작하고 쓰기는 큐에 저장됩니다.

1. **관리자에게 알리기:** 복구될 때까지 그 섹션에 쓰기(이체, 충전, 스윕, 반환, 계정 교체)를 하지 마십시오
   ([단일 작성자 규칙](../components/gateway.md#the-single-writer-rule)). chainlens Sections 페이지에도 같은
   안내가 표시됩니다.
2. **확인:** `curl -s http://<gateway host>:30010/gateway/status` → `mode`, `since`, `queue`, `offlineEth`.
   게이트웨이 호스트에서:
   ```bash
   curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://192.168.68.151:30000/contract/list?type=none   # 프록시 VIP
   curl -s -m 5 -X POST http://192.168.68.150:8545 -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'                           # RPC VIP
   ```
3. **조치:** 게이트웨이 호스트와 VIP 사이의 네트워크(스위치, 라우팅, 방화벽: HA 쌍에서
   `firewall-cmd --list-all`, `PROXY_CLIENTS`에 게이트웨이 호스트 포함 여부). 프록시 자체가 다운되었으면:
   [ProxyDown](#proxydown).
4. **해제 확인:** 모드가 `draining`을 거쳐 `online`이 됩니다. 그다음 [GatewayConflicts](#gatewayconflicts)를
   지켜보십시오.

### GatewayDrainingLong {#gatewaydraininglong}

**Warning.** 게이트웨이가 15분 동안 큐를 전송하고 있습니다.

1. **확인:** `GET /gateway/status`(`queue`가 줄지 않음)와 로그:
   `docker compose logs --since 20m gateway | tail -50`.
2. **조치:** 5xx로 응답받은 요청은 `uncertain`으로 남아 라운드마다 재시도됩니다. 로그에서 프록시의 오류를
   읽고 그것을 해결하십시오([ProxyHttpErrors](#proxyhttperrors), [MpcBelowThreshold](#mpcbelowthreshold)).
   요청 하나: `GET /gateway/request/<id>`(섹션 키 필요).
3. **해제 확인:** `queue` 0, `mode` `online`.

### GatewayQueueOld {#gatewayqueueold}

**Warning.** 큐 요청이 1시간보다 오래되었습니다. 긴 단절이거나, 전송할 수 없는 큐입니다.

1. **확인:** `GET /gateway/status` → `oldestSeconds`, `mode`.
2. **조치:** [GatewayOffline](#gatewayoffline)(offline) 또는 [GatewayDrainingLong](#gatewaydraininglong)
   (draining)과 같습니다. 단절이 길수록 끝나는 취소 기간과 이후의 충돌이 늘어납니다. `offline_max_hours`(24)
   이후에는 게이트웨이가 오프라인 응답을 멈춥니다(503).
3. **해제 확인:** 큐가 전송되면 알림이 해제됩니다.

### GatewaySparesLow {#gatewayspareslow}

**Warning.** 30분 동안 예비 계정이 `spare_alert_below`보다 적습니다. 오프라인 `/createaccount`가 예비 계정을
사용하며, 하나도 없으면 503으로 응답합니다.

1. **확인:** `GET /gateway/status` → `spares`. 로그: `docker compose logs gateway | grep -i spare | tail`.
2. **조치:** 새 예비 계정은 **온라인이고 큐가 비어 있을 때**, **3개 MPC 노드가 모두** 있을 때만 만들어집니다.
   [MpcNodeDown](#mpcnodedown)과 섹션의 선지급 계정이 비어 있지 않은지 확인하십시오.
3. **해제 확인:** `spares`가 `spare_accounts`까지 다시 늘어납니다(라운드마다 하나).

### GatewayConflicts {#gatewayconflicts}

**Warning.** 재연결 후 체인이 큐 요청을 거부했습니다(지난 1시간): 정정입니다.

1. **읽기:** chainlens → **Sections** → 해당 섹션 → **Gateway** 카드(종류, 요청, 계정, 돌려준 ETH, 이유,
   취소된 요청), 또는 Grafana → Sections → **Gateways**. 운영자 머신에서:
   ```bash
   curl -s "http://<gateway host>:30010/gateway/report?open=1" -H "Authorization: Bearer $(cat state/secrets/gateway_report_token)"
   ```
2. **조치:** 체인에서 할 일은 없습니다(자금은 움직이지 않았습니다). 섹션 팀에 사용자에게 무엇이 바뀌었는지
   알린 뒤 chainlens에서 각 정정을 **Acknowledge** 하십시오. 차이가 있는 `reconcile` 항목은 단절 중 메인 측에서
   그 섹션에 쓰기가 있었다는 뜻입니다.
3. **해제 확인:** 마지막 정정 1시간 후 알림이 해제됩니다.

### GatewayCorrectionsOpen {#gatewaycorrectionsopen}

**Warning.** 1시간 동안 확인(Acknowledge)되지 않은 정정이 있습니다.

1. **확인:** chainlens → Sections → 해당 섹션 → Gateway, *Open only*. 또는 지표 `gateway_corrections_open`.
2. **조치:** 섹션 팀과 각 정정을 처리한 뒤([GatewayConflicts](#gatewayconflicts) 참고) **Acknowledge**를
   누르십시오. chainlens에 *GATEWAY_REPORT_TOKEN is not set* 또는 502가 보이면
   `ansible-playbook 14-gateway.yml 11-chainlens.yml`을 다시 실행하십시오. `correction_webhook`을 쓰면
   `gateway_corrections_undelivered`도 확인하십시오.
3. **해제 확인:** `gateway_corrections_open`이 0입니다.

### GatewayDown {#gatewaydown}

**Critical.** Prometheus가 2분 동안 게이트웨이를 수집할 수 없습니다. 섹션의 애플리케이션이 동작할 수 없습니다.

1. **확인:** 게이트웨이 호스트에서 `docker compose ps`와 `docker compose logs --tail 50 gateway`.
2. **조치:** `docker compose up -d`, 또는 `ansible-playbook 14-gateway.yml` 재실행(`ansible/`에서). 원장과 큐는
   디스크(`/var/lib/besu-gateway`)에 있으므로 유지됩니다. Prometheus만 연결할 수 없다면: 방화벽(모니터링
   호스트에서 포트 30010, `01-hosts.yml`).
3. **해제 확인:** `GET /gateway/status`가 응답하고, Prometheus 대상 `gateway-<id>`가 UP입니다.

---

## 호스트 {#hosts}

### HostDown {#hostdown}

**Warning.** 호스트의 node-exporter가 2분 동안 응답하지 않습니다. 보통 호스트 전체가 다운된 것이며,
해당 호스트의 다른 알림이 뒤따릅니다.

1. **확인:** 호스트에 ping과 SSH를 시도하십시오. 호스트는 가동 중인데 node-exporter만 다운된 경우:
   ```bash
   docker ps -a --filter name=node-exporter
   ```
2. **조치:** 전원을 켜거나, node-exporter를 시작하십시오(`ansible-playbook 01-hosts.yml --limit <host>`).
   이상 동작한 호스트를 재시작하기 전에, 사후 분석을 위해 로그(Besu와 MPC의 `docker logs`)를
   보관하십시오. 호스트가 복구되면 서비스를 순서대로 복구하십시오:
   ```bash
   ansible-playbook 01-hosts.yml 05-besu.yml 07-ha.yml --limit <host>
   ```
   (h135 / h136은 `04-coordinators.yml`도 실행). `MpcPoolEmpty`, `MpcPresignFailing` 및
   백업 알림은 1시간 안에 저절로 해제됩니다.
3. **해제 확인:** Hosts 표에서 UP. 해당 호스트의 모든 알림이 해제됩니다.

### HostMemoryHigh {#hostmemoryhigh}

**Warning.** 호스트 메모리의 90 % 이상이 10분 동안 실제로 사용 중입니다.

1. **확인:** 무엇이 사용하는지 확인합니다:
   ```bash
   free -m; docker stats --no-stream
   ```
   ```bash
   ps aux --sort=-rss | head -15
   ```
2. **조치:** 힙이 큰 Besu 노드: 각 노드는 `besu_java_opts`(`-Xmx`)까지 커질 수 있습니다. h135 / h136에는
   Besu 노드가 두 개씩 있으므로 이를 낮추고(예: `-Xmx2g`) `05-besu.yml`을 실행하십시오. 한없이 커지는
   프로세스: 재시작하고 보고하십시오. 장기적으로는 RAM을 늘리십시오.
3. **해제 확인:** 메모리가 90 % 미만입니다(Hosts 대시보드).

### HostDiskFull {#hostdiskfull}

**Warning.** 파일 시스템이 10분 동안 80 % 넘게 차 있습니다. 디스크가 가득 차면 Besu가 멈춥니다.

1. **확인:**
   ```bash
   df -h; docker system df
   ```
2. **조치:**
   ```bash
   docker image prune -f && docker builder prune -f
   ```
   오래된 로그(`/var/log`, `journalctl --vacuum-size=500M`), h137의 오래된 체인 스냅샷(`snapshot-chain.sh`의
   `KEEP`), h139의 Prometheus 데이터(`prometheus_retention_size`)를 정리하십시오. 그다음 필요하면
   디스크를 늘리십시오.
3. **해제 확인:** 80 % 미만입니다.

### HostClockNotSynced {#hostclocknotsynced}

**Warning.** 시계가 10분 동안 동기화되지 않았거나 100 ms 넘게 어긋나 있습니다.

1. **확인:**
   ```bash
   chronyc tracking; chronyc sources
   ```
2. **조치:** NTP 서버에 연결할 수 없는 경우: 방화벽 또는 `settings.yml`의 `ntp_servers`를 확인한 다음
   `ansible-playbook 01-hosts.yml --limit <host>`를 실행하십시오. 큰 오차를 지금 바로 맞추려면: `chronyc makestep`.
3. **해제 확인:** Hosts 표: Clock이 SYNCED, 오차가 50 ms 미만입니다.

---

## 백업 {#backups}

각 백업은 자신의 호스트의 node-exporter에 보고합니다. 따라서 해당 호스트가 다운되면 그 백업이
누락된 것처럼 보입니다. [HostDown](#hostdown)을 먼저 해결하십시오.

### BackupFailed {#backupfailed}

**Warning.** 백업의 마지막 실패가 마지막 성공보다 최근입니다.

1. **확인:** Hosts → *Backups*: 어떤 백업, 어떤 호스트인지 확인합니다(Last run FAILED).
2. **조치:** 수동으로 실행하고 오류를 확인하십시오:
   - 체인 스냅샷(h137): `cd /opt/besu-val3 && ./snapshot-chain.sh /backup/chain` (로그:
     `/var/log/besu-snapshot.log`)
   - MPC 키 조각(각 MPC 호스트): `/opt/besu-chain/mpc-signer/deploy/node/backup.sh /secure/mpc-backup`
     (로그: `/var/log/mpc-backup.log`)
   - 노드 키: `ansible-playbook 10-backups.yml`
   일반적인 원인: 디스크 가득 참, 복사 대상(`snapshot_copy_to`)에 연결 불가.
3. **해제 확인:** Last run이 OK입니다.

### ChainSnapshotTooOld {#chainsnapshottooold}

**Warning.** 2일 동안 체인 스냅샷이 없습니다.

1. **조치:** h137의 cron(`crontab -l | grep snapshot`)과 그 로그를 확인하고, [BackupFailed](#backupfailed)와
   같이 수동으로 실행하십시오. h137이 다운된 경우: 복구될 때까지 스냅샷이 생성되지 않습니다.

### ChainSnapshotMissing {#chainsnapshotmissing}

**Warning.** 체인 스냅샷이 한 번도 기록되지 않았습니다.

1. **조치:** `ansible-playbook 10-backups.yml`(일일 cron을 설치하고 첫 번째 스냅샷을 생성합니다.
   데이터를 보관하는 동안 val3가 잠시 중지되지만 체인은 계속됩니다).

### MpcShareBackupTooOld {#mpcsharebackuptooold}

**Warning.** MPC 노드의 키 조각 백업이 2시간 넘게 오래되었습니다(매시 :07에 실행).

1. **조치:** 호스트가 다운되었던 경우 다음 정시 실행 때 해제됩니다. 지금 해제하려면 해당 MPC 호스트에서
   백업을 실행하십시오([BackupFailed](#backupfailed)와 같음). 그렇지 않으면 cron
   (`crontab -l | grep mpc`)과 `/var/log/mpc-backup.log`를 확인하십시오.

### MpcShareBackupMissing {#mpcsharebackupmissing}

**Warning.** 키 조각 백업 기록이 있는 MPC 노드가 1시간 동안 3개 미만입니다.

1. **조치:** MPC 호스트 다운: [HostDown](#hostdown). 백업이 설정되지 않은 경우: 각 팀이 `backup.sh`를
   매시간 실행하거나, `mpc_backup_cron: true`로 설정하고 `ansible-playbook 10-backups.yml`을 실행하십시오.

### ValidatorKeyBackupMissing {#validatorkeybackupmissing}

**Warning.** 모든 검증자에 키 백업 기록이 있지는 않습니다. 검증자 키 4개 중 2개를 잃으면 체인이
영구히 끝납니다.

1. **조치:** 검증자 호스트 다운: [HostDown](#hostdown). 그렇지 않으면 `key_backup_gpg_public_key`를
   설정하고 `ansible-playbook 10-backups.yml`을 실행하십시오([GPG 키](../deployment/gpg-key.md)). 호스트를
   재구성한 후에는 `state/key-backups/`에서 이전 파일을 옮기고 `10-backups.yml`을 다시 실행하십시오.
2. **해제 확인:** Hosts → *Backups*에 val1–val4의 validator-key 백업이 표시됩니다.
