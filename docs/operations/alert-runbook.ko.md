# 알림 런북

> **내용:** 모든 알림의 단계별 해결 방법: 확인, 해결(명령 포함), 해제 확인. 알림마다 그 이름을 딴
> 절이 하나씩 있습니다.
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
- [호스트](#hosts): [HostDown](#hostdown) · [HostMemoryHigh](#hostmemoryhigh) · [HostDiskFull](#hostdiskfull) · [HostClockNotSynced](#hostclocknotsynced)
- [백업](#backups): [BackupFailed](#backupfailed) · [ChainSnapshotTooOld](#chainsnapshottooold) · [ChainSnapshotMissing](#chainsnapshotmissing) · [MpcShareBackupTooOld](#mpcsharebackuptooold) · [MpcShareBackupMissing](#mpcsharebackupmissing) · [ValidatorKeyBackupMissing](#validatorkeybackupmissing)

---

## 시작하기 전에 {#before-you-start}

1. **발생 중인 모든 알림을 함께 보십시오**(Grafana, 모든 대시보드 상단). 원인 하나가 여러 알림을
   발생시키는 경우가 많으므로 **원인**을 먼저 해결하십시오. `HostDown`은 보통 같은 호스트의 다른 모든
   알림을 설명합니다([장애 상황 읽기](alerts.md#reading-an-incident)).
2. **critical부터**, 그다음 warning, 그다음 info 순서로 처리하십시오.
3. **시간을 기록하십시오.** Grafana는 현지 시간을 표시하며, 호스트의 로그는 UTC일 수 있습니다.

아래에서 사용하는 이름(프로덕션 기본값):

| 대상 | 이름 / 위치 |
|---|---|
| Besu 노드 `<node>` (val1–val4, rpc1, rpc2) | 디렉터리 `/opt/besu-<node>`, 컨테이너 `besu-<node>-besu-1` |
| 호스트 | h135 val1, rpc1, coord1, mpc1, 프록시 · h136 val2, rpc2, coord2, 프록시(대기) · h137 val3, mpc2 · h138 val4, mpc3 · h139 모니터링, chainlens, Remix, 문서 |
| 코디네이터 | `/opt/mpc-coordinator`, 컨테이너 `mpc-coordinator-mpc-coordinator-1`, 포트 9100 |
| MPC 노드 | `/opt/besu-chain/mpc-signer/deploy/node` (`mpc_node_dir`), 컨테이너 `node-mpc-node-1`, 포트 7000 |
| 프록시, Redis | `/opt/besu-chain/proxy`, 컨테이너 `proxy-proxy-1`, `proxy-redis-1`. VIP `.151`을 가진 호스트에서 실행됩니다 |
| 모니터링 | h139의 `/opt/monitoring`(그곳의 Prometheus는 `127.0.0.1:9090`) |
| Ansible | 운영자 머신의 `ansible/`에서 실행 |

어디서나 유용한 명령:

```bash
docker ps -a --format '{{.Names}} {{.Status}}'
```

```bash
docker logs --since 30m <container> 2>&1 | grep -iE "error|fail|exception|warn" | tail -50
```

---

## Besu {#besu}

### BesuValidatorQuorumLost

**Critical.** 온라인 검증자가 QBFT에 필요한 수(4개 중 3개)보다 적습니다: 블록이 없습니다.

1. **확인:** Besu production → *Validators up*. Nodes 표에서 어느 노드가 DOWN인지 볼 수 있습니다.
2. **해결:** 해당 호스트에서 검증자를 하나씩 복구합니다:
   ```bash
   docker start besu-<node>-besu-1
   ```
   호스트가 다운되었다면 [HostDown](#hostdown)을 참조하십시오. 컨테이너가 다시 종료되면 로그를
   확인하십시오(디스크 가득 참, 손상된 데이터베이스: [재해 복구](disaster-recovery.md)).
3. **점검:** *Validators up* ≥ 3이고 *Seconds since last block*이 다시 1 s 미만이어야 합니다. 쿼럼이
   복구된 후 1분 안에 블록이 재개되지 않으면 [BesuNoNewBlocks](#besunonewblocks)를 참조하십시오.

### BesuNoNewBlocks

**Critical.** 블록 주기의 3배 + 5 s 동안 블록이 없습니다.

1. **확인:** *Seconds since last block*이 증가합니다. `BesuValidatorQuorumLost`도 발생 중입니까?
2. **해결:**
   - 쿼럼 손실: 먼저 그것을 해결하십시오([BesuValidatorQuorumLost](#besuvalidatorquorumlost)).
   - 쿼럼은 복구되었지만 여전히 블록이 없음(검증자의 라운드가 어긋남): h135–h138 각각에서 동시에
     **모든 검증자를 함께** 재시작하십시오:
     ```bash
     docker restart besu-val<N>-besu-1
     ```
     자세한 내용: [Besu 수동 설정](../deployment/besu-manual.md)의 *Chain halted*.
   - 시계도 확인하십시오([HostClockNotSynced](#hostclocknotsynced)).
3. **점검:** 다시 매초 블록이 생성됩니다. 그다음 RPC 노드가 스스로 따라잡습니다.

### BesuNodeDown

**Warning.** Besu 노드의 메트릭이 1분 동안 응답하지 않습니다.

1. **확인:** 알림에 노드 이름이 표시됩니다. 호스트가 가동 중입니까(`HostDown`)?
2. **해결** (해당 호스트에서):
   ```bash
   docker ps -a --filter name=besu-<node>
   ```
   ```bash
   docker logs --tail 100 besu-<node>-besu-1
   ```
   재시작을 반복합니까? 로그를 확인하십시오: 디스크 가득 참([HostDiskFull](#hostdiskfull)), 메모리 부족
   ([HostMemoryHigh](#hostmemoryhigh)), 데이터베이스 오류([재해 복구](disaster-recovery.md)).
   중지되어 있으면:
   ```bash
   docker start besu-<node>-besu-1
   ```
   Ansible로 다시 배포하려면: `ansible-playbook 05-besu.yml --limit <host>`.
3. **점검:** Nodes 표에서 UP, 그다음 1–2분 안에 IN SYNC가 되어야 합니다.

### BesuNodeStalled

**Warning.** 체인은 최신인데 노드의 최신 블록이 60 s 이상 오래되었습니다: 여전히 "in sync"로
표시되더라도 블록 가져오기를 중단한 것입니다.

1. **확인:** Nodes 표: Sync **STALLED**, Last block age 증가, Behind 증가. Peers를 확인하십시오(대개
   낮음).
2. **해결:**
   - **RPC 노드 (rpc1, rpc2):** 이미 RPC VIP에서 제외되었으며, `besu-rpc-health`가 5분 후 재시작합니다.
     지금 바로 하려면 해당 호스트에서:
     ```bash
     docker restart besu-<node>-besu-1
     ```
   - **검증자:** 같은 방법으로 재시작하십시오(나머지 검증자가 계속 블록을 만듭니다).
   - 그다음 원인을 찾으십시오: 피어 끊김(네트워크, 방화벽 재로드), 호스트의 메모리 압박:
     ```bash
     docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -viE "Imported|pending blocks" | tail -50
     ```
3. **점검:** IN SYNC, Behind가 다시 약 0. h135 / h136에서: `curl -s http://127.0.0.1:8410/`이 해당 RPC
   노드가 정상임을 표시합니다.

### BesuNotInSync

**Warning.** 노드가 5분 동안 동기화 중이라고 보고하거나, 알고 있는 최고 블록보다 10블록 이상
뒤처져 있습니다.

1. **확인:** Nodes 표(SYNCING / BEHIND), *Blocks behind* 차트. 재시작 직후 몇 분 동안은 정상입니다.
2. **해결:** 줄어들지 않으면 피어([BesuPeersLow](#besupeerslow))와 로그를 확인하십시오. 높이가 전혀
   움직이지 않으면 [BesuNodeStalled](#besunodestalled)로 처리하십시오.
3. **점검:** Blocks behind 0, Sync IN SYNC.

### BesuPeersMissing

**Warning.** 노드의 피어 수가 5분 동안 (가동 중인 노드 수 − 1)보다 적습니다.

1. **확인:** *Peers* 차트: 어느 노드인지, 언제부터인지.
2. **해결:** 해당 노드의 호스트에서 다른 노드의 P2P 포트(검증자 30303, RPC 노드 30304)를
   테스트하십시오:
   ```bash
   nc -zv 192.168.68.137 30303
   ```
   거부되거나 시간 초과: 방화벽(`01-hosts.yml` 재실행)이거나 다른 노드가 다운되었습니다. 새 키나
   주소로 다시 생성한 노드는 모든 노드의 `static-nodes.json`과 `permissions_config.toml`에 있어야
   합니다([Besu 수동 설정](../deployment/besu-manual.md)).
3. **점검:** 모든 노드의 피어가 5개.

### BesuPeersLow

**Warning.** 노드의 피어가 2분 동안 2개 미만입니다: 연결 하나만 끊겨도 고립되며 정지될 수 있습니다.

1. **확인 및 해결:** [BesuPeersMissing](#besupeersmissing)과 같습니다. 피어가 돌아오지 않으면 노드를
   재시작하십시오(정적 피어에 다시 연결합니다):
   ```bash
   docker restart besu-<node>-besu-1
   ```
2. **점검:** Peers ≥ 2(보통 5). [BesuNodeStalled](#besunodestalled)를 주시하십시오.

### BesuTxPoolGrowing

**Warning.** 노드에 대기 중인 트랜잭션이 10분 동안 1,000개를 넘습니다.

1. **확인:** *Transaction pool* 차트, Besu production → *Proxy senders*(STALLED, 논스 공백).
2. **해결:**
   - 발신자가 STALLED: [ProxySenderStalled](#proxysenderstalled).
   - 논스 공백: [ProxyNonceGap](#proxynoncegap).
   - 실제 부하가 용량을 초과: 블록이 가득 찼습니다(*Gas used per block*이 한도에 근접). 클라이언트의
     속도를 늦추십시오. 풀은 저절로 비워집니다.
3. **점검:** 풀이 다시 약 0으로 줄어듭니다.

### BesuHeapHigh

**Warning.** Java 힙이 10분 동안 최대치의 90 %를 넘습니다.

1. **확인:** *JVM heap used*가 녹색 최대선에 근접, *GC time* 증가.
2. **해결:** 단기적으로 노드를 재시작합니다(`docker restart besu-<node>-besu-1`). 다시 발생하면 호스트에
   메모리가 있는 경우에만 `settings.yml`의 `besu_java_opts`를 늘리고(예: `-Xmx6g`)
   `ansible-playbook 05-besu.yml`을 실행하십시오.
3. **점검:** 최대치보다 훨씬 낮은 톱니 모양.

### BesuUnpermittedPeers

**Info.** 노드가 `permissions_config.toml`에 없는 노드의 연결을 거부했습니다.

1. **확인:** 누구였는지 확인합니다:
   ```bash
   docker logs --since 1h besu-<node>-besu-1 2>&1 | grep -i "not permitted\|unpermitted" | tail
   ```
2. **해결:** 알 수 없는 머신: 방화벽에서 차단하고 조사하십시오. 새 키나 주소를 가진 자체 노드: 모든
   노드의 `permissions_config.toml`과 `static-nodes.json`에 추가하십시오
   ([Besu 수동 설정](../deployment/besu-manual.md)).

---

## MPC 서명기 {#mpc-signer}

### MpcBelowThreshold

**Critical.** 연결 가능한 MPC 노드가 임계값(3개 중 2개)보다 적습니다: **서명이 불가능합니다**.

1. **확인:** MPC signer → *MPC nodes up*, *MPC nodes* 표(어느 노드인지, 어느 코디네이터에서 보았는지).
2. **해결:** MPC 노드를 복구합니다. 각 노드는 해당 팀의 소유이며, 그 호스트에서:
   ```bash
   cd /opt/besu-chain/mpc-signer/deploy/node && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 node-mpc-node-1
   ```
   키 조각의 봉인을 해제할 수 없는 노드에는 `MPC_NODE_PASSPHRASE`(팀의 사본)가 필요합니다. 키 조각을
   잃은 경우: [프로덕션 MPC 서명기](../deployment/mpc-signer-production.md) (복원).
3. **점검:** *MPC nodes up* ≥ 2, 서명이 다시 처리됩니다.

### MpcCoordinatorDown

**Critical.** 코디네이터의 `/metrics`가 응답하지 않습니다(또는 메트릭 토큰이 일치하지 않습니다).
다른 코디네이터가 VIP를 통해 계속 서명합니다.

1. **확인:** 다운되었는지, 아니면 메트릭 토큰만 문제인지 확인합니다:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.135:9100/health
   ```
   200 = 가동 중: `/opt/monitoring/secrets/mpc-metrics-token`의 토큰이 코디네이터의
   `MPC_METRICS_TOKEN`과 일치하지 않습니다(`09-monitoring.yml` 재실행).
2. **해결** (다운된 경우, 해당 호스트에서):
   ```bash
   cd /opt/mpc-coordinator && docker compose up -d
   ```
   ```bash
   docker logs --tail 50 mpc-coordinator-mpc-coordinator-1
   ```
   Ansible 사용 시: `ansible-playbook 04-coordinators.yml --limit <host>`.
3. **점검:** MPC signer 대시보드에서 Coordinator UP.

### MpcNodeDown

**Warning.** 코디네이터가 1분 동안 MPC 노드에 연결할 수 없습니다. 3개 중 2개로 서명은 작동하지만
**계정과 섹션 생성은 작동하지 않습니다**(3개 모두 필요).

1. **확인:** *MPC nodes* 표: **두** 코디네이터 모두에서 다운 = 노드 문제, **하나**에서만 = 두 호스트
   간의 네트워크 문제.
2. **해결:** 노드 다운: [MpcBelowThreshold](#mpcbelowthreshold)의 2단계와 같습니다(해당 노드의 팀).
   네트워크: 코디네이터의 호스트에서 테스트하십시오:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://192.168.68.137:7000/health
   ```
   시간 초과: 방화벽(`01-hosts.yml`) 또는 네트워크.
3. **점검:** 두 코디네이터 모두에서 UP. 실패한 계정 또는 섹션 생성을 다시 시도하십시오.

### MpcPoolEmpty

**Warning.** 큰(핫) 키에 2분 동안 준비된 사전 서명이 없습니다: 서명이 느린 경로(서명당 약 0.6 s)로
전환됩니다.

1. **확인:** *Pools of big keys*, *Presignatures generated per second*. MPC 노드나 코디네이터 재시작
   후 몇 분 동안은 정상입니다.
2. **해결:** 계속되면:
   - 3개 노드 중 하나가 다운되면 사전 서명 생성이 느려집니다: [MpcNodeDown](#mpcnodedown).
   - 서명이 사전 서명 생성보다 빠름(지속적인 부하): MPC 노드에 CPU를 추가하거나, 코디네이터의
     `MPC_REFILL_CONCURRENCY`를 늘리십시오([MPC 서명기](../components/mpc-signer.md)).
   - 사전 서명이 많이 실패한 노드 재시작 후에는 두 코디네이터 모두에서 풀을 비워 깨끗하게 다시
     채워지도록 하십시오([MPC 서명기 업그레이드](mpc-signer-upgrade.md)).
3. **점검:** 풀이 다시 목표치를 향해 증가합니다.

### MpcSmallPoolsEmpty

**Warning.** 작은 풀(`/createaccount`로 만든 계정)의 절반 이상이 15분 동안 비어 있습니다.

1. **확인:** *Pools of small keys*가 전체 목표보다 훨씬 낮음, *Keys per pool class*.
2. **해결:** 사전 서명 생성 용량에 비해 작은 키가 너무 많습니다:
   - 드물게 쓰는 계정을 `none`으로 옮기십시오: `POST /account/pool {"address": "0x…", "pool": "none"}`
     ([프록시 API](../reference/proxy-api.md)).
   - `MPC_POOL_TARGET_SMALL`을 낮추거나, `MPC_REFILL_CONCURRENCY` / `MPC_COMPUTE_THREADS`와 MPC 노드의
     CPU를 늘리십시오.
3. **점검:** 비어 있는 작은 풀이 줄어듭니다.

### MpcPresignFailing

**Warning.** 10분 동안 사전 서명 세션이 5회 넘게 실패했습니다.

1. **확인:** 보통 MPC 노드나 코디네이터 재시작 직후입니다(몇 분 안에 저절로 해제됨). 그렇지 않으면
   코디네이터 로그를 확인하십시오:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "presign|fail|error" | tail -30
   ```
2. **해결:** 노드 시간 초과: [MpcNodeDown](#mpcnodedown). MPC 호스트 간 네트워크. 업그레이드 후 클러스터
   설정이 다른 노드([MPC 서명기 업그레이드](mpc-signer-upgrade.md)).
3. **점검:** 마지막 실패 10분 후 알림이 해제됩니다.

### MpcSignErrors

**Warning.** 정책 이외의 이유로 서명 요청이 실패했습니다.

1. **확인:** MPC signer → *Failures*, 코디네이터 로그:
   ```bash
   docker logs --since 15m mpc-coordinator-mpc-coordinator-1 2>&1 | grep -iE "sign|error" | tail -30
   ```
2. **해결:** 원인별: 알 수 없는 키(계정이 이 클러스터에 없음), 노드 시간 초과
   ([MpcNodeDown](#mpcnodedown)), `eth_sendTransaction`에 대해 Besu가 응답하지 않음
   ([BesuNodeDown](#besunodedown), RPC VIP).
3. **점검:** *Failures*가 다시 0.

### MpcPolicyRefusals

**Warning.** MPC 노드의 정책(값, 가스, 체인 ID 또는 대상)에 의해 트랜잭션이 거부되었습니다.

1. **확인:** 무엇이 거부되었는지 확인합니다:
   ```bash
   docker logs --since 1h mpc-coordinator-mpc-coordinator-1 2>&1 | grep -i policy | tail -20
   ```
2. **해결:** 호출자의 버그(잘못된 체인 ID, 너무 큰 금액): 호출자를 수정하십시오. 한도를 넘는 정당한
   트랜잭션: 팀들이 `cluster.json`의 정책을 변경합니다
   ([프로덕션 MPC 서명기](../deployment/mpc-signer-production.md)). 설명되지 않는 거부 때문에 정책을
   완화해서는 절대 안 됩니다: 공격일 수 있습니다.
3. **점검:** 새로운 거부가 없습니다.

---

## 프록시와 Redis {#proxy-and-redis}

### ProxyDown

**Critical.** 활성 프록시(VIP `.151` 경유)가 응답하지 않습니다: 애플리케이션이 전송할 수 없습니다.

1. **확인:** VIP가 어디에 있고, 그곳에서 프록시가 실행 중입니까?
   ```bash
   ip -br a | grep 192.168.68.151
   ```
   ```bash
   docker ps --filter name=proxy-proxy
   ```
2. **해결:**
   - keepalived가 VIP를 다른 호스트로 옮기고 그 프록시를 시작했어야 합니다: 두 호스트 모두에서
     `journalctl -u keepalived --since "15 min ago"`.
   - 프록시 컨테이너가 VIP 호스트에 있지만 종료됨: `docker logs --tail 100 proxy-proxy-1`
     (잘못된 `.env`, 시작 시 서명기 또는 Besu에 연결 불가).
   - 모든 것을 정상 순서로 되돌리려면: `ansible-playbook 07-ha.yml`.
3. **점검:** `curl -s http://192.168.68.151:30000/status/senders`가 응답하고, *Proxy*가 UP입니다.

### ProxySenderStalled

**Critical.** 발신자의 트랜잭션이 RPC 노드의 풀에 준비되어 있지만, 그 트랜잭션 없이 블록이 계속
생성됩니다: 검증자에게 해당 트랜잭션이 없습니다.

1. **확인:** Besu production → *Proxy senders*: 해당 발신자의 Mined가 **STALLED**.
2. **해결:** 검증자 **하나**를 재시작하십시오(풀을 다시 가져와 포함시킵니다). 예를 들어 h137에서:
   ```bash
   docker restart besu-val3-besu-1
   ```
   검증자에 `tx-pool-max-future-by-sender=2000`이 설정되어 있는지 확인하십시오.
3. **점검:** Mined OK, In flight가 다시 0으로 떨어집니다.

### ProxyNonceGap

**Warning.** 논스가 2분 넘게 누락되었습니다. 해당 발신자의 이후 트랜잭션이 대기합니다.

1. **확인:**
   ```bash
   curl -s http://192.168.68.151:30000/status/senders
   ```
   (해당 발신자의 `gap`과 대기 중인 트랜잭션).
2. **해결:** 프록시는 공백을 스스로 복구합니다(다시 보내거나 채움 트랜잭션을 보냄). 복구되지 않으면
   체인이나 서명기가 막고 있는 것입니다: `docker logs --since 15m proxy-proxy-1`을 확인하고,
   [MpcBelowThreshold](#mpcbelowthreshold)와 [BesuNoNewBlocks](#besunonewblocks)를 확인하십시오.
3. **점검:** *Nonce gap since*가 다시 0.

### ProxyNonceRepaired

**Info.** 프록시가 공백을 복구했습니다: 트랜잭션이 손실되었거나 채움 트랜잭션이 전송되었습니다.

1. **읽기:** 무슨 일이 있었는지 확인합니다: `docker logs --since 1h proxy-proxy-1 2>&1 | grep -i -E "repair|filler|gap"`.
2. **조치:** 반복될 때만 조치하십시오. 손실된 트랜잭션을 가리킵니다(트랜잭션을 버린 RPC 노드, 전송
   도중의 재시작).

### ProxySenderCheckFailing

**Warning.** 프록시의 백그라운드 점검이 2분 동안 발신자에 대해 Besu를 읽을 수 없습니다.

1. **확인:** 프록시 호스트에서 RPC VIP를 확인합니다:
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://192.168.68.150:8545
   ```
2. **해결:** 응답 없음: HAProxy와 RPC 노드(h135 / h136에서 `curl -s http://127.0.0.1:8410/`,
   [BesuNodeDown](#besunodedown)).
3. **점검:** 알림이 해제되고, *Proxy senders*가 다시 갱신됩니다.

### ProxyHttpErrors

**Warning.** 5분 동안 응답의 5 % 이상이 5xx입니다.

1. **확인:** Proxy & Redis → *Errors per second*: 어느 경로, 어느 코드인지.
2. **해결:** 오류를 확인하십시오:
   ```bash
   docker logs --since 15m proxy-proxy-1 2>&1 | grep -iE "error|fail" | tail -30
   ```
   일반적인 원인: 서명기 다운 또는 느림(MPC 알림), Besu 응답 없음(RPC VIP), 섹션 호출에 대한
   레지스트리 응답 없음.
3. **점검:** *5xx errors*가 다시 0 %.

### ProxySlow

**Warning.** 10분 동안 95번째 백분위 응답 시간이 5 s를 넘습니다(`/createaccount`와 `/admin` 제외).

1. **확인:** Proxy & Redis → *95th percentile by route*: 어느 경로인지.
2. **해결:** 송금과 NFT 판매가 느림: 콜드 경로로 서명([MpcPoolEmpty](#mpcpoolempty)) 또는 느린 RPC 노드
   (Besu → *JSON-RPC latency*). 모든 것이 느림: 프록시 자체
   ([ProxyEventLoopBlocked](#proxyeventloopblocked)) 또는 호스트([HostMemoryHigh](#hostmemoryhigh)).
3. **점검:** *Latency p95*가 다시 1–2 s 미만.

### ProxyEventLoopBlocked

**Warning.** 프록시의 단일 Node.js 스레드가 5분 동안 1 s 넘게 차단되었습니다.

1. **확인:** Proxy & Redis의 *Event-loop delay*와 *Memory*, Hosts의 호스트 CPU.
2. **해결:** 호스트의 CPU나 메모리 부족: 그것을 해결하십시오([HostMemoryHigh](#hostmemoryhigh)). 프록시의
   메모리가 꾸준히 증가: VIP 호스트에서 재시작하십시오(몇 초간 요청 실패):
   ```bash
   cd /opt/besu-chain/proxy && docker compose restart proxy
   ```
3. **점검:** 이벤트 루프 지연이 0.1 s 미만.

### ProxyRedisDisconnected

**Warning.** 활성 프록시에 5분 동안 Redis 연결이 없습니다. 계속 작동하지만(메모리 + 체인), 재시작
시 논스 캐시를 잃습니다.

1. **확인:** VIP 호스트에서: `docker ps --filter name=proxy-redis`.
2. **해결:**
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis
   ```
   프록시는 스스로 다시 연결합니다(로그에 "redis available again").
3. **점검:** Proxy & Redis → *Redis link* CONNECTED.

### RedisDown

**Warning.** 활성 프록시의 Redis(또는 그 익스포터)가 2분 동안 응답하지 않습니다.

1. **확인:** Redis입니까, 아니면 익스포터만입니까?
   ```bash
   docker ps --filter name=proxy-redis
   ```
2. **해결:** Redis 중지: [ProxyRedisDisconnected](#proxyredisdisconnected)와 같습니다. 익스포터만인 경우:
   ```bash
   cd /opt/besu-chain/proxy && docker compose up -d redis-exporter
   ```
3. **점검:** Proxy & Redis → *Redis* UP.

### RedisMemoryHigh

**Warning.** Redis가 10분 동안 `maxmemory`의 90 %를 넘습니다(최대값이 설정된 경우에만).

1. **확인:** *Memory and keys*.
2. **해결:** `maxmemory`를 늘리거나, 무엇이 증가하는지 찾으십시오(`docker exec proxy-redis-1 redis-cli --bigkeys`).
   프록시의 키는 작으므로 꾸준한 증가는 이례적입니다: 보고하십시오.
3. **점검:** 메모리가 선보다 낮습니다.

---

## 섹션 {#sections}

### SectionUpfrontEmpty

**Critical.** 활성화된 섹션의 선지급 계정이 0입니다: 계정을 생성하거나 −x를 지불할 수 없습니다.

1. **확인:** Sections 대시보드 → *Upfront accounts*, chainlens **Sections** 페이지.
2. **해결:** SENDER01에서 충전하십시오: chainlens Sections 페이지 → 해당 섹션 → **Top up**, 또는:
   ```bash
   curl -s -X POST http://192.168.68.151:30000/admin/sections/<id>/topup \
     -H "Authorization: Bearer $(cat state/secrets/proxy_admin_token)" \
     -H 'Content-Type: application/json' -d '{"amount":"500"}'
   ```
   (운영자 머신의 `ansible/`에서). SENDER01도 부족하면: [Sender01Low](#sender01low).
3. **점검:** 잔액이 `upfront_low_balance_eth`보다 높습니다.

### SectionUpfrontLow

**Warning.** 활성화된 섹션의 선지급 잔액이 `upfront_low_balance_eth` 미만입니다.

1. **해결:** 소진되기 전에 [SectionUpfrontEmpty](#sectionupfrontempty)와 같이 충전하십시오. 임계값을
   변경하려면: `settings.yml`의 `upfront_low_balance_eth`를 수정한 다음
   `ansible-playbook 06-proxy.yml`을 실행하십시오(0이면 알림이 꺼집니다).

### Sender01Low

**Warning.** SENDER01이 `sender01_low_balance_eth` 미만입니다. SENDER01은 모든 충전 자금을 제공합니다.

1. **해결:** 섹션의 돈을 회수하십시오: chainlens Sections 페이지에서 각 섹션에 대해 **Sweep**(소비 →
   결제) 후 **Pay back**(결제 → SENDER01)을 실행합니다. 그렇지 않으면 자금 관리 계정에서 SENDER01에
   자금을 넣으십시오.
2. **점검:** Sections 대시보드 → *SENDER01*이 임계값보다 높습니다.

### SectionMetricsFailing

**Warning.** 프록시가 10분 동안 섹션 잔액을 읽을 수 없습니다. 잔액 알림이 작동하지 않습니다.

1. **확인:** VIP 호스트에서 `docker logs --since 15m proxy-proxy-1 2>&1 | grep -i section | tail`.
2. **해결:** SectionRegistry 또는 Besu가 프록시에 응답하지 않습니다: RPC VIP
   ([ProxySenderCheckFailing](#proxysendercheckfailing)의 1단계)와 `/opt/besu-chain/proxy/.env`의
   `REGISTRY_CONTRACT`를 확인하십시오(`06-proxy.yml` 재실행).
3. **점검:** Sections 대시보드가 다시 갱신됩니다.

---

## 호스트 {#hosts}

### HostDown

**Warning.** 호스트의 node-exporter가 2분 동안 응답하지 않습니다. 보통 호스트 전체가 다운되었으며,
그 호스트의 다른 알림이 뒤따릅니다.

1. **확인:** 호스트에 ping과 SSH를 시도하십시오. 호스트는 가동 중이지만 node-exporter가 다운된 경우:
   ```bash
   docker ps -a --filter name=node-exporter
   ```
2. **해결:** 전원을 켜거나, node-exporter를 시작하십시오(`ansible-playbook 01-hosts.yml --limit <host>`).
   이상 동작한 호스트를 재시작하기 전에 사후 분석을 위해 로그(Besu와 MPC의 `docker logs`)를
   보존하십시오. 호스트가 복구되면 서비스를 순서대로 되돌리십시오:
   ```bash
   ansible-playbook 01-hosts.yml 05-besu.yml 07-ha.yml --limit <host>
   ```
   (h135 / h136은 `04-coordinators.yml` 추가). `MpcPoolEmpty`, `MpcPresignFailing` 및 백업 알림은
   1시간 안에 저절로 해제될 것입니다.
3. **점검:** Hosts 표에서 UP. 해당 호스트의 모든 알림이 해제되었습니다.

### HostMemoryHigh

**Warning.** 10분 동안 호스트 메모리의 90 % 이상이 실제로 사용 중입니다.

1. **확인:** 무엇이 사용하는지 확인합니다:
   ```bash
   free -m; docker stats --no-stream
   ```
   ```bash
   ps aux --sort=-rss | head -15
   ```
2. **해결:** 힙이 큰 Besu 노드: 각 노드는 `besu_java_opts`(`-Xmx`)까지 늘어날 수 있습니다. h135 / h136에는
   Besu 노드가 두 개씩 있으므로 값을 낮추고(예: `-Xmx2g`) `05-besu.yml`을 실행하십시오. 한없이 증가하는
   프로세스: 재시작하고 보고하십시오. 장기적으로: RAM 증설.
3. **점검:** 메모리 90 % 미만(Hosts 대시보드).

### HostDiskFull

**Warning.** 파일 시스템이 10분 동안 80 % 넘게 차 있습니다. 디스크가 가득 차면 Besu가 멈춥니다.

1. **확인:**
   ```bash
   df -h; docker system df
   ```
2. **해결:**
   ```bash
   docker image prune -f && docker builder prune -f
   ```
   오래된 로그(`/var/log`, `journalctl --vacuum-size=500M`), h137의 오래된 체인 스냅샷
   (`snapshot-chain.sh`의 `KEEP`), h139의 Prometheus 데이터(`prometheus_retention_size`)를 정리하십시오.
   필요하면 디스크를 확장하십시오.
3. **점검:** 80 % 미만.

### HostClockNotSynced

**Warning.** 시계가 10분 동안 동기화되지 않았거나 100 ms 넘게 차이 납니다.

1. **확인:**
   ```bash
   chronyc tracking; chronyc sources
   ```
2. **해결:** NTP 서버에 연결 불가: 방화벽 또는 `settings.yml`의 `ntp_servers`를 확인한 다음
   `ansible-playbook 01-hosts.yml --limit <host>`를 실행하십시오. 큰 차이를 지금 바로 맞추려면:
   `chronyc makestep`.
3. **점검:** Hosts 표: Clock SYNCED, 차이 50 ms 미만.

---

## 백업 {#backups}

각 백업은 자신의 호스트의 node-exporter에 보고합니다. 해당 호스트가 다운되면 그 백업이 누락된 것처럼
보입니다. 먼저 [HostDown](#hostdown)을 해결하십시오.

### BackupFailed

**Warning.** 백업의 마지막 실패가 마지막 성공보다 최근입니다.

1. **확인:** Hosts → *Backups*: 어느 백업, 어느 호스트인지(Last run FAILED).
2. **해결:** 수동으로 실행하고 오류를 확인하십시오:
   - 체인 스냅샷(h137): `cd /opt/besu-val3 && ./snapshot-chain.sh /backup/chain` (로그:
     `/var/log/besu-snapshot.log`)
   - MPC 키 조각(각 MPC 호스트): `/opt/besu-chain/mpc-signer/deploy/node/backup.sh /secure/mpc-backup`
     (로그: `/var/log/mpc-backup.log`)
   - 노드 키: `ansible-playbook 10-backups.yml`
   일반적인 원인: 디스크 가득 참, 복사 대상(`snapshot_copy_to`)에 연결 불가.
3. **점검:** Last run OK.

### ChainSnapshotTooOld

**Warning.** 2일 동안 체인 스냅샷이 없습니다.

1. **해결:** h137의 cron(`crontab -l | grep snapshot`)과 그 로그를 확인하고,
   [BackupFailed](#backupfailed)와 같이 수동으로 실행하십시오. h137이 다운되면 복구될 때까지 스냅샷이
   없습니다.

### ChainSnapshotMissing

**Warning.** 체인 스냅샷이 한 번도 기록되지 않았습니다.

1. **해결:** `ansible-playbook 10-backups.yml` (일일 cron을 설치하고 첫 스냅샷을 생성합니다. 데이터를
   아카이브하는 동안 val3이 잠시 중지되지만 체인은 계속됩니다).

### MpcShareBackupTooOld

**Warning.** MPC 노드의 키 조각 백업이 2시간 넘게 오래되었습니다(매시 :07에 실행).

1. **해결:** 호스트가 다운되었던 경우 다음 정시 실행에서 해제됩니다. 지금 해제하려면 해당 MPC
   호스트에서 백업을 실행하십시오([BackupFailed](#backupfailed)와 같이). 그렇지 않으면 cron
   (`crontab -l | grep mpc`)과 `/var/log/mpc-backup.log`를 확인하십시오.

### MpcShareBackupMissing

**Warning.** 1시간 동안 키 조각 백업 기록이 있는 MPC 노드가 3개 미만입니다.

1. **해결:** MPC 호스트 다운: [HostDown](#hostdown). 백업이 설정되지 않음: 각 팀이 매시간 `backup.sh`를
   실행하거나, `mpc_backup_cron: true`를 설정하고 `ansible-playbook 10-backups.yml`을 실행하십시오.

### ValidatorKeyBackupMissing

**Warning.** 모든 검증자에 키 백업 기록이 있지는 않습니다. 검증자 키 4개 중 2개를 잃으면 체인이
영구히 끝납니다.

1. **해결:** 검증자 호스트 다운: [HostDown](#hostdown). 그렇지 않으면 `key_backup_gpg_public_key`를
   설정하고 `ansible-playbook 10-backups.yml`을 실행하십시오([GPG 키](../deployment/gpg-key.md)).
   호스트를 재구성한 후에는 `state/key-backups/`에서 이전 파일을 옮기고 `10-backups.yml`을 다시
   실행하십시오.
2. **점검:** Hosts → *Backups*에 val1–val4의 validator-key 백업이 나열됩니다.
