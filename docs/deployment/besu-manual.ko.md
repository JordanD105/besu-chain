# Besu 운영 패키지 (수동 설치)

> **내용:** 수동으로 사용하는 운영용 Besu 패키지(Ansible도 같은 작업을 수행합니다): 네트워크 파일, 노드 시작, 검증자 추가 및 제거, 운영.
>
> **대상:** 운영자.
>
> **관련 문서:** [Ansible](ansible.md) · [운영 환경 구성](../overview/production-layout.md) · [재해 복구](../operations/disaster-recovery.md)

**목차**

- [운영 네트워크와 테스트 네트워크 비교](#production-vs-test-network)
- [규모와 토폴로지](#sizing-and-topology)
- [단계별 설치](#step-by-step)
- [한 호스트에 여러 노드](#several-nodes-on-one-host)
- [컨트랙트 배포](#deploying-a-contract)
- [운영](#operations)
- [(아직) 지원하지 않는 기능](#what-it-does-not-do-yet)

---

[`besu-production/`](../../besu-production)은 [`besu-test-network/`](../../besu-test-network)의
운영용 버전으로, 허가형 QBFT 네트워크를 위한 것입니다.

- **검증자**: 호스트 및 장애 도메인마다 하나씩 두며, p2p로만 접근할 수 있습니다.
- **RPC 노드**: 검증하지 않는 노드로, 프록시, MPC 코디네이터, 익스플로러에 서비스를 제공합니다.

모든 노드의 키는 **해당 호스트에서** 생성되며 호스트 밖으로 나가지 않습니다. 운영자는 공개 enode만
받아서 이를 바탕으로 네트워크 파일을 만듭니다.

모든 단계는 각각 고유 IP를 가진 검증자 호스트 4대와 RPC 노드 1대로 사전 테스트했습니다.

- 체크섬 검증을 포함한 네트워크 구성 및 시작
- RPC 노드를 통한 트랜잭션, 그리고 RPC 노드의 `admin_*` 거부
- 검증자 하나 중지: 블록이 계속 생성됩니다. 두 개 중지: 체인이 정지합니다. 재시작: 체인이 재개됩니다.
- 노드 키 백업
- 실행 중인 체인에 **5번째 검증자 추가**(새 노드, 파일 업데이트, 순차 재시작, 투표)

운영 환경 구성([운영 환경 구성](../overview/production-layout.md)): 호스트당 하나씩 검증자 4개,
그리고 두 애플리케이션 호스트에 RPC 노드 2개.

```
   .135: val1 + rpc1      .136: val2 + rpc2      .137: val3      .138: val4
     ▲  p2p 30303 (validators), 30304 (rpc nodes); static peers + node allowlist  ▲
     └───────────────────────────────────────────────────────────────────────────┘
  proxy, coordinators ──► HAProxy VIP 192.168.68.150:8545 ──► rpc1 (rpc2 as backup)
  chainlens (.139) ──► rpc2 :8555          Prometheus (.139) ──► :9545 / :9546 on every node
  operator ──SSH──► validator host (validator RPC on 127.0.0.1 only)
```

아래 표의 경로는 `besu-production/` 기준 상대 경로입니다.

| 경로 | 사용 주체 | 용도 |
|---|---|---|
| `node/` | 모든 Besu 호스트 | `docker-compose.yml`(호스트당 여러 노드는 `docker-compose.host.yml`), `.env.example`, `validator.toml`, `rpc.toml`, `init.sh`, `start.sh`, `backup-key.sh`, `restore-key.sh`, `snapshot-chain.sh`, `restore-chain.sh`, `reset-chain.sh` |
| `operator/make-network.sh` | 운영자, 한 번 | 제네시스(QBFT 검증자 집합), `static-nodes.json`, `permissions_config.toml`, `SHA256SUMS` |
| `operator/add-node.sh` | 운영자, 나중에 | **실행 중인** 네트워크에 노드 추가(제네시스는 변경하지 않음) |
| `operator/remove-node.sh` | 운영자, 나중에 | **실행 중인** 네트워크에서 노드 제거(투표로 제외된 후) |
| `operator/move-node.sh` | 운영자, 나중에 | 노드가 키는 유지하고 새 IP/포트를 받는 경우(예: 교체 호스트): 네트워크 파일에서 해당 노드의 주소를 업데이트 |
| `operator/deploy-contract.js` | 운영자 | MPC 계정으로 서명하여 컴파일된 컨트랙트를 배포하고 chainlens용으로 기록([컨트랙트 배포](#deploying-a-contract), 브라우저에서는 chainlens의 Deploy 페이지를 대신 사용할 수 있음) |
| `operator/qbft.sh` | 검증자 호스트에서 | 검증자 집합, 추가/제거 투표, 피어, 상태 |
| [`monitoring/`](../../monitoring) | 모니터링 호스트 | Prometheus + Grafana, 이 노드들과 MPC 서명기를 위한 대시보드와 알림 |
| `firewall-example.sh` | 모든 호스트 | 역할별 ufw 규칙(범용. firewalld를 사용하는 5호스트 구성에는 [`ha/firewall-layout.sh`](../../ha/firewall-layout.sh)를 사용) |

## 운영 네트워크와 테스트 네트워크 비교 {#production-vs-test-network}

| | `besu-test-network` (테스트) | `besu-production` |
|---|---|---|
| 호스트 | 모두 하나의 Docker 호스트에 | 호스트당 검증자 하나(.135–.138), .135와 .136에는 검증자 옆에 RPC 노드 |
| 노드 키 | 저장소에 커밋됨 | 각 호스트에서 생성, 해당 볼륨에 보관 |
| 검증자 RPC | 게시됨, ADMIN/DEBUG/TRACE/PERM 활성화, 모든 호스트 허용 | `127.0.0.1`만, SSH를 통한 운영자용 |
| 클라이언트 RPC | 검증자와 같은 노드 | 전용 RPC 노드: ETH/NET/WEB3/TXPOOL(익스플로러: ETH/NET/WEB3), 호스트 허용 목록 |
| 피어링 | 디스커버리 + 부트노드 | **정적 피어 + 노드 허용 목록**(권한 관리), 디스커버리 끔 |
| 무결성 | 없음 | 운영자 `SHA256SUMS`, 모든 노드에서 `start.sh`가 검증 |
| 사전 충전 계정 | 잘 알려진 개발용 키 | `ALLOC`에 나열한 계정만(예: MPC `SENDER01`) |

## 규모와 토폴로지 {#sizing-and-topology}

- **검증자:** **4개**, 호스트당 하나(.135, .136, .137, .138): 쿼럼 3이므로 어느 호스트 하나가 실패해도 됩니다.
  한 호스트에 검증자 두 개를 두지 마십시오: 그 호스트를 잃으면 체인이 정지합니다. (검증자 7개는 2개 실패를
  견딥니다. 호스트가 3대뿐이면 호스트당 2개씩 검증자 6개로 호스트 하나의 장애를 견딥니다.)
  - 각각: vCPU 4개, RAM 8 GB, SSD. 현재 부하에서는 `JAVA_OPTS=-Xmx2g`로 충분합니다(힙 사용량 약
    100–200 MB). *JVM heap used* 패널이 필요하다고 보여 주면 늘리십시오.
- **RPC 노드:** 플로팅 IP `192.168.68.150:8545`의 HAProxy 뒤에 있는 **rpc1**(.135)과 **rpc2**(.136):
  평상시에는 rpc1, rpc1이 비정상이면 rpc2를 사용합니다. "정상" 여부는 `besu-rpc-health`가
  `eth_syncing`만이 아니라 블록 높이와 블록 나이로 판단하며, 정지된 로컬 RPC 노드는 재시작됩니다
  ([고가용성](high-availability.md#3-rpc-health-besu-rpc-health)).
  Chainlens는 **rpc2**를 직접 읽으므로 익스플로러 폴링이 rpc1에 부하를 주지 않습니다.
  - 각각: vCPU 4–8개, RAM 8–16 GB, SSD.
- **한 호스트에 두 노드**(.135, .136): 호스트 네트워킹과 별도의 포트 사용(*한 호스트에 여러 노드*
  절 참조): 검증자 P2P 30303 / 메트릭 9545 / RPC `127.0.0.1:8645`, RPC 노드 P2P 30304 / 메트릭
  9546 / RPC `<host IP>:8555`(8545는 VIP에서 HAProxy가 사용하는 포트).
- **블록 주기:** 여러 사이트에 걸치면 `BLOCK_PERIOD=2`, 하나의 LAN이면 1. `REQUEST_TIMEOUT`은 사이트
  간 왕복 시간의 4배 이상이고 `BLOCK_PERIOD`보다 크게 설정하십시오.

## 단계별 설치 {#step-by-step}

### 1. 호스트, 네트워크, 방화벽 {#1-hosts-network-firewall}

- 모든 노드 호스트에 Docker Engine과 Compose v2가 설치된 Linux, 동기화된 시계(`chrony`).
- 모든 노드 간의 사설 네트워크(이 구성에서는 192.168.68.0/24 사용).
- 방화벽: [`ha/firewall-layout.sh`](../../ha/firewall-layout.sh)는 firewalld로 구성의 규칙을 적용하고,
  Docker가 게시하는 포트(val3와 val4는 호스트 네트워킹 없이 실행)에도 같은 허용 목록을 nftables 테이블
  `inet besu_docker`에 적용합니다
  ([운영 환경 구성](../overview/production-layout.md#3-ports-and-firewall)).
  `firewall-example.sh`는 범용 ufw 대안입니다.

| 출발지 | 목적지 | 포트 |
|---|---|---|
| 모든 Besu 호스트(.135–.138) | 모든 Besu 노드 | 30303(검증자), 30304(rpc1, rpc2) tcp + udp |
| HAProxy 및 `besu-rpc-health`(.135, .136), chainlens(.139) | rpc1, rpc2 | 8555 |
| 프록시, 코디네이터(.135, .136) | VIP `.150`의 HAProxy | 8545 |
| Prometheus(.139) | 모든 노드 | 9545(검증자), 9546(RPC 노드) |
| 배스천 | 모든 호스트 | 22 |

검증자는 JSON-RPC를 `127.0.0.1`에만 게시하므로 방화벽에서 이를 위해 여는 포트는 없습니다.

### 2. 각 노드 초기화 (각 호스트에서) {#2-initialise-each-node-on-each-host}

노드마다 디렉터리 하나를 사용합니다. 예: .135에서 `/opt/besu-val1`과 `/opt/besu-rpc1`.

```bash
cp -r besu-production/node /opt/besu-val1 && cd /opt/besu-val1
cp .env.example .env
```

모든 노드의 정확한 값은 [운영 환경 구성](../overview/production-layout.md)(2절)에 있습니다.
`.env`를 편집합니다.

| 변수 | 값 |
|---|---|
| `BESU_IMAGE` | 정확한 버전, 예: `hyperledger/besu:26.11.1` |
| `BESU_ROLE` | `validator` 또는 `rpc` |
| `NODE_NAME` | 고유한 이름: `val1` … `val4`, `rpc1`, `rpc2` |
| `P2P_HOST`, `BIND_IP` | 이 호스트의 IP, 예: `192.168.68.135` |
| `P2P_PORT`, `METRICS_PORT`, `RPC_PORT`, `WS_PORT`, `COMPOSE_FILE` | .135와 .136(호스트당 두 노드): 구성 표를 참조하십시오 |

**RPC 노드**에는 다음도 필요합니다.

| 변수 | 값 |
|---|---|
| `RPC_BIND_IP` | 호스트의 IP(rpc1은 `192.168.68.135`, rpc2는 `.136`) |
| `BESU_HOST_ALLOWLIST` | 클라이언트가 URL에 사용하는 이름/IP: 호스트의 IP **와 VIP** `192.168.68.150`, 그리고 `localhost,127.0.0.1` |

그다음 실행합니다.

```bash
./init.sh
```

`init.sh`는 다음을 수행합니다.

- `besu-data` 볼륨 안에 노드 키를 생성합니다(커널의 난수 생성기 사용).
- **공개** enode와 주소가 담긴 `<NODE_NAME>.json`을 작성합니다. 이 파일을 운영자에게 보내십시오.
- 지금 키를 백업하십시오: `./backup-key.sh /secure/dir`, 파일을 암호화하여 이 팀의 보관소에 저장합니다
  (Ansible을 사용하면 `10-backups.yml`이 GPG로 이 작업을 수행합니다: [GPG 키](gpg-key.md)). 검증자의 키는
  검증자의 신원입니다: 키를 잃으면 투표로 검증자를 교체해야 하며, 두 개를 동시에 잃으면 체인이 끝납니다.

### 3. 네트워크 파일 생성 (운영자) {#3-build-the-network-files-operator}

```bash
CHAIN_ID=1337 BLOCK_PERIOD=1 REQUEST_TIMEOUT=2 \
ALLOC="0x<SENDER01>=1000000000000000000000000" \
  besu-production/operator/make-network.sh network/ val1.json val2.json val3.json val4.json rpc1.json rpc2.json
```

다음 파일이 생성됩니다.

- Besu가 인코딩한 QBFT 검증자 집합이 포함된 `genesis.json`(`rlp encode --type=QBFT_EXTRA_DATA`)
- `static-nodes.json`
- 노드 허용 목록인 `permissions_config.toml`
- `SHA256SUMS`

블록 가스 한도의 기본값은 **30,000,000**(`GAS_LIMIT=0x1c9c380`)입니다. 가스 가격이 0이므로 이 값이
한 블록의 작업량을 제한하는 유일한 상한입니다. 적당한 값으로 유지하십시오. 실행 중인 체인에서
변경하려면 모든 검증자의 `.env`에 `BESU_TARGET_GAS_LIMIT`을 설정하고 하나씩 재시작하십시오. Besu가
한도를 점진적으로 그 값에 맞춥니다.

`ALLOC`에는 실제로 자금을 넣으려는 계정만 포함해야 합니다. 예: MPC `SENDER01`
([운영 환경의 MPC 서명기](mpc-signer-production.md) 참조). **네트워크 파일을 보관하십시오.** 체인이
실행된 후에는 `genesis.json`을 절대 변경하면 안 됩니다.

### 4. 배포 및 시작 (각 호스트) {#4-distribute-and-start-each-host}

파일 4개를 각 노드 디렉터리의 `network/`(예: `/opt/besu-val1/network/`)에 복사합니다. 별도의 채널로
운영자와 `SHA256SUMS`를 비교한 후 시작합니다.

```bash
./start.sh
```

`start.sh`는 파일이 누락되었거나 `SHA256SUMS`와 일치하지 않으면 시작을 거부합니다. 검증자를 먼저
시작하고, 그다음 RPC 노드를 시작하십시오.

### 5. 확인 {#5-verify}

아무 검증자 호스트에서:

```bash
operator/qbft.sh health       # block number increasing, peer count = number of nodes - 1
operator/qbft.sh validators   # the validator set from genesis
```

애플리케이션 호스트에서 각 RPC 노드를 직접 확인하고, HAProxy가 실행되면 VIP를 통해 확인합니다.

```bash
curl -s http://192.168.68.135:8555 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

```bash
curl -s http://192.168.68.150:8545 -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

그다음 애플리케이션이 RPC 노드를 가리키도록 설정합니다.

- 프록시(.135, .136): `BESU_IP=192.168.68.150`, `BESU_PORT=8545`(HAProxy)
- 코디네이터: `MPC_BESU_RPC=http://192.168.68.150:8545`
- chainlens(.139): `BESU_RPC=http://192.168.68.136:8555`(rpc2)

노드를 모니터링에 추가합니다:
[`monitoring/prometheus/targets/besu.yml`](../../monitoring/prometheus/targets/besu.yml)에 노드당 항목
하나([모니터링 (Prometheus 및 Grafana)](../components/monitoring.md) 참조).

## 한 호스트에 여러 노드 {#several-nodes-on-one-host}

이 구성에서 .135는 val1 + rpc1, .136은 val2 + rpc2를 실행합니다.

- **노드마다 디렉터리 하나**, 예: `/opt/besu-val1`과 `/opt/besu-rpc1`. 디렉터리 이름이 compose
  프로젝트와 데이터 볼륨 이름이 되므로 키가 분리된 상태로 유지됩니다.
- **호스트 네트워킹:** 각 `.env`에 `COMPOSE_FILE=docker-compose.host.yml`. Docker의 브리지 네트워크를
  사용하면 같은 호스트의 다른 노드에 연결하는 노드의 출발지 주소가 Docker 게이트웨이 주소(172.x)가 되어
  `permissions_config.toml`에서 찾을 수 없으므로 연결이 끊깁니다.
- **노드마다 다른 포트:** 검증자 P2P 30303, 메트릭 9545, RPC `127.0.0.1:8645`. RPC 노드 P2P 30304,
  메트릭 9546, RPC `<host IP>:8555`. `P2P_HOST`와 `BIND_IP`는 같습니다(호스트의 IP).
- 검증자 RPC는 자체 포트로 `127.0.0.1`에 유지됩니다: `RPC=http://127.0.0.1:8645 operator/qbft.sh health`.
- 방화벽: [`ha/firewall-layout.sh`](../../ha/firewall-layout.sh)가 두 노드의 포트를 모두 엽니다.

**장애 허용:** 한 호스트에 **검증자** 두 개를 두지 마십시오: 그 호스트를 잃으면 4개 중 2개가 다운되어
체인이 정지합니다(쿼럼 3). 검증자 옆에 RPC 노드를 두는 것은 괜찮습니다.

## 컨트랙트 배포 {#deploying-a-contract}

두 가지 방법이 있습니다: 브라우저에서 chainlens **Deploy 페이지**를 사용하거나(이 절의 끝,
[컨트랙트 배포](../features/contract-deployment.md)), 이 스크립트를 사용합니다.
`operator/deploy-contract.js`는 **MPC 계정**으로 컴파일된 컨트랙트를 배포하고(코디네이터가 서명하며
개인 키는 어디에도 존재하지 않습니다), 결과를 확인한 후
[`contracts/deployments/`](../../contracts/deployments)에 기록을 작성합니다. Chainlens는 이 기록을 읽습니다:
컨트랙트에 이름이 붙고, 컨트랙트 페이지에 함수 목록이 표시되며 읽기 전용 함수를 실행할 수 있습니다.

**1. 이 체인용으로 컴파일**합니다(자체 호스팅 Remix IDE, [Remix IDE (자체 호스팅)](../components/remix.md)는
오프라인에서 동작합니다): `evmVersion` **`cancun`** 이하의 Solidity(여기의 Besu에는 Prague 옵코드가
없습니다), 그리고 컴파일러 버전과 옵티마이저 설정을 소스와 함께 보관하십시오. 전체 컴파일러 아티팩트
(ABI **와** 바이트코드)를 내보냅니다: Hardhat `artifacts/…/X.json`, Foundry `out/X.sol/X.json`,
Remix `artifacts/X.json`(Remix: *Solidity compiler → Advanced → EVM version cancun*), 또는 solc
standard-JSON 출력(`--contract X`로 하나를 선택). 먼저 개발 또는 스테이징 체인에서 테스트하십시오.

**2. 배포자 계정**, 한 번만 만듭니다: 배포에만 사용하는 MPC 키이며, `SENDER01`이나 프록시가 발신하는 다른
계정은 절대 사용하지 마십시오(프록시는 이들 계정의 논스를 메모리에서 추적하므로, 외부에서 보낸 트랜잭션이
다음 트랜잭션을 깨뜨립니다. 스크립트는 `SENDER01`을 거부합니다). 이 체인에서는 가스가 무료이므로 자금이
필요하지 않습니다.

```bash
curl -s -X POST http://192.168.68.151:30000/createaccount -H 'content-type: application/json' -d '{"amount":"0","pool":"none"}'
```

반환된 `address`를 배포자로 보관하십시오. MPC 정책이 컨트랙트 생성을 허용해야 합니다: 비어 있는
`ALLOWED_TO`(기본값)와 충분한 `MAX_GAS`(기본값 30 000 000, 블록 가스 한도).

**3. 사전 실행(dry run)**: 운영자 머신의 저장소 루트에서 실행합니다(필요한 모든 것이 들어 있는 프록시
이미지에서 실행되므로 아무것도 설치하지 않습니다). 배포자, 인수, 가스를 확인하고 컨트랙트가 받을 주소를
출력합니다.

```bash
docker run --rm --network host -u "$(id -u)" -v "$PWD":/work -w /work -e NODE_PATH=/app/node_modules localhost/besu-proxy/besu-proxy node besu-production/operator/deploy-contract.js --artifact build/MyToken.json --from 0xDEPLOYER --args '["My token", "MTK", "1000000"]'
```

생성자 인수는 JSON 배열입니다. 큰 숫자는 문자열로 작성하십시오. 기본값: 코디네이터
`http://192.168.68.150:9100`, RPC `http://192.168.68.150:8545`(둘 다 VIP의 HAProxy를 통함. 다른 주소는
`--coordinator` / `--rpc` 또는 `COORDINATOR_URL` / `RPC_URL`).

**4. 배포:** 같은 명령에 `--yes`를 붙입니다. 코디네이터(MPC 노드 3개 중 2개)를 통해 서명하고, 서명된
트랜잭션을 요청과 대조하여 확인한 후 전송하고, 영수증을 기다린 다음 체인의 코드를 아티팩트의 런타임
바이트코드와 비교합니다(다르면 종료 코드 3). 기록은 `contracts/deployments/<address>.json`입니다.

**5. 기록 게시:** 커밋한 후 `ansible-playbook 01-hosts.yml`(또는 전체 `site.yml`)이 호스트에 복사합니다.
Chainlens는 15초 안에 이를 반영합니다:
`http://192.168.68.139:30100/#/contracts/<address>`.

**브라우저에서 대신 배포:** chainlens에는 운영자 및 관리자 PC 전용이며 기본적으로 꺼져 있는 Deploy 페이지가
있습니다: 프록시를 통해 컨트랙트 계정 센터의 서명으로 배포하고, ABI와 함께 컨트랙트를 체인에 등록하므로
애플리케이션이 `/contract/call`과 `/contract/send`로 사용할 수 있습니다
([컨트랙트 배포 (chainlens Deploy 페이지)](../features/contract-deployment.md),
[섹션](../features/sections.md)). 애플리케이션이 사용할 컨트랙트에는 이 방법을 권장합니다: 이 스크립트로
배포한 컨트랙트는 온체인 레지스트리에 없습니다.

그 외에는 chainlens는 **읽기만** 합니다(view/pure 함수의 `eth_call`). 상태를 변경하는 호출은 프록시나 이와
같은 스크립트를 통해 MPC 계정의 서명으로 수행합니다.

## 운영 {#operations}

| 작업 | 방법 |
|---|---|
| **Besu 업그레이드** | `BESU_IMAGE`에 새 정확한 태그를 설정하고 `./start.sh`를 실행합니다. **한 번에 한 노드씩**, 체인 헤드로 돌아올 때까지(`qbft.sh health`) 기다립니다. 검증자가 4개일 때 2개를 동시에 다운시키지 마십시오. |
| **노드가 새 IP를 받는 경우**(같은 키, 예: 교체 호스트) | 운영자: `operator/move-node.sh network/ <node>.json <new IP:port>`, 파일 4개를 모든 노드에 복사하고 나머지 노드를 하나씩 재시작합니다. 새 호스트에서 `restore-key.sh`로 노드를 시작합니다. **하나의 키를 두 호스트에서 동시에 실행하지 마십시오.** [재해 복구](../operations/disaster-recovery.md), 6.1 참조 |
| **RPC 노드 추가** | 새 호스트에서 `init.sh`, 그다음 `operator/add-node.sh network/ rpcN.json`. 파일 4개를 **모든** 노드에 복사하고 노드를 하나씩 재시작한 후(`./start.sh && docker compose restart`) 새 노드를 시작합니다. |
| **검증자 추가** | RPC 노드와 같은 절차 후, 현재 검증자의 **과반수**에서 `operator/qbft.sh propose 0x<new address> true`를 실행합니다. `qbft.sh validators`에 표시되면 해당 검증자들에서 `qbft.sh discard 0x<address>`를 실행합니다. |
| **검증자 제거** | 검증자의 과반수에서 `qbft.sh propose 0x<address> false`, 그다음 `discard`. 이후 `operator/remove-node.sh network/ <node>.json`을 실행하고, 파일 4개를 다시 배포한 다음 노드를 하나씩 재시작합니다. Ansible 사용 시: [노드 추가 및 제거](../operations/adding-nodes.md). |
| **잃어버린 검증자 키 교체** | 새 노드(새 키)를 시작하고 투표로 추가한 다음, 이전 주소를 투표로 제거합니다 |
| **블록은 계속되는데 한 발신자의 트랜잭션이 채굴되지 않음**(프록시 알림 `ProxySenderStalled`, RPC 노드의 풀이 계속 커짐) | RPC 노드에는 트랜잭션이 있지만 검증자에는 없습니다: 바쁜 발신자의 트랜잭션을 논스 순서가 아니게 받은 검증자는 그중 `tx-pool-max-future-by-sender`개(Besu 기본값 200)만 보관하고 나머지는 버리며, 버려진 트랜잭션은 다시 전송되지 않습니다. **해결:** 검증자 **하나**를 재시작합니다(`docker compose restart`): 다시 연결될 때 RPC 노드의 풀을 가져옵니다. **예방:** 모든 검증자의 `validator.toml`에 `tx-pool-max-future-by-sender=2000`(이 패키지의 기본값). |
| **체인이 정지된 후 쿼럼이 돌아왔지만 새 블록이 없음** | 쿼럼을 잃은 동안 모든 검증자는 더 높은 QBFT 라운드로 계속 이동하고, 라운드마다 타임아웃이 두 배가 됩니다(`REQUEST_TIMEOUT` × 2^round). 다운되었던 검증자는 라운드 0에서 재시작하므로, 오랜 장애 후에는 같은 라운드에서 만나기까지 몇 분이 걸립니다(사전 테스트: 약 8분 장애는 스스로 재개하는 데 **8분 20초**, 3분 장애는 45초 안에 재개). 쿼럼이 돌아온 후 약 1분 안에 블록이 생성되지 않으면 **모든 검증자를 동시에 재시작**하십시오(각각에서 `docker compose restart`). 라운드 상태는 메모리에만 있으므로 잃는 것은 없습니다. 사전 테스트에서는 재시작 **25초** 후에 블록이 재개되었습니다. |
| **새 제네시스(체인 초기화)** | Besu가 *"Supplied genesis block does not match chain data stored in /data"* 메시지와 함께 시작을 거부합니다. 원래 네트워크 파일을 되돌려 놓거나, 정말로 새 체인을 시작하려면 **모든** 노드에서 `./reset-chain.sh`를 실행합니다(검증자 먼저). 체인 데이터는 삭제하지만 노드 키는 유지하므로 enode는 유효하게 남습니다. **볼륨을 삭제하지 마십시오**: 키도 함께 삭제됩니다. |
| **모니터링** | [`monitoring/`](../../monitoring): Besu 운영 대시보드와 알림(쿼럼 손실, 새 블록 없음, 노드 다운, 피어 누락, 피어 부족, 노드 정지, 동기화 벗어남, 트랜잭션 풀, 허가되지 않은 피어, 힙, 호스트 디스크)이 있는 Prometheus + Grafana. 각 알림의 의미와 조치: [알림](../operations/alerts.md), 증상: [문제 해결](../operations/troubleshooting.md). 메트릭은 `BIND_IP:METRICS_PORT`에서 제공됩니다. compose 파일이 `BIND_IP`를 호스트 허용 목록에 추가하므로 Prometheus가 403으로 거부되지 않습니다. |
| **백업** | **키:** 모든 노드에서 `./backup-key.sh /secure/dir`(한 번, 그다음 암호화. 검증자 키 4개 중 2개를 잃으면 체인이 끝납니다). Ansible(`10-backups.yml`)은 키를 GPG 공개 키로 암호화합니다([GPG 키](gpg-key.md)). 재구축한 호스트에서 `./restore-key.sh <file>`로 복원합니다. **체인 데이터:** 애플리케이션이 의존하지 않는 **하나의** 노드에서 cron으로 매일 `./snapshot-chain.sh /backup/chain`(검증자도 괜찮습니다: 먼저 모든 피어가 연결되었는지 확인한 후 몇 분간 노드를 중지합니다). 외부 복사본은 `COPY_TO=user@host:/path`, 스냅샷은 `KEEP`개 보관(기본값 7). Ansible은 이를 val3에 `snapshot_cron_hour`:`snapshot_cron_minute`(03:17)로 설치합니다. 체인의 아무 노드에나 `./restore-chain.sh <archive>`로 복원합니다(해당 노드의 키는 유지하며, 다른 체인의 스냅샷은 거부합니다). 결과는 모니터링에 게시되며(노드 자체 호스트의 node-exporter textfile collector를 사용하므로, 다운된 호스트는 백업이 누락된 것으로 보입니다), 오래되었거나 누락되었거나 실패한 백업에 대한 알림이 있습니다. 전체 절차: [재해 복구](../operations/disaster-recovery.md). |

## (아직) 지원하지 않는 기능 {#what-it-does-not-do-yet}

- **JSON-RPC의 TLS.** 사설 네트워크를 사용하거나 RPC 노드 앞에 내부 TLS 프록시를 두십시오.
- **온체인(컨트랙트 기반) 권한 관리.** 로컬 허용 목록 파일을 사용하므로, 변경하려면 모든 노드를
  업데이트하고 재시작해야 합니다.
- **비공개 트랜잭션(Paladin/Tessera).** 포함되어 있지 않습니다. 개발 환경 설정은
  [Paladin](../development/paladin.md)을 참조하십시오.
