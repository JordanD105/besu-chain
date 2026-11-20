# Ansible로 복원

> **내용:** Ansible로 백업에서 전체 사이트를 다시 구축합니다. 호스트를 준비하고, 노드 키, 체인 스냅샷, MPC 키 조각을 복원한 다음 배포합니다.
>
> **대상:** 운영자.
>
> **관련 문서:** [재해 복구](disaster-recovery.md) · [GPG 키](../deployment/gpg-key.md) · [운영자 가이드](../deployment/operator-guide.md)

**목차**

- [필요한 항목](#what-you-need)
- [1. 운영자 머신과 호스트](#1-operator-machine-and-hosts)
- [2. Besu 노드: 노드가 시작되기 전에 키와 체인 복원](#2-besu-nodes-key-and-chain-before-anything-starts-them)
- [3. MPC 노드: 각 팀이 자기 호스트에서](#3-mpc-nodes-each-team-on-its-own-host)
- [4. 나머지 전부: Ansible](#4-everything-else-ansible)
- [5. 확인 후 정합성 맞추기](#5-check-then-reconcile)

---

모든 호스트를 다시 구축하고 백업에서 배포를 되살립니다. 이 문서는 [재해 복구](disaster-recovery.md)의
6.7절을 Ansible 배포에 맞게 정리한 것입니다.
호스트나 노드 하나만 잃은 경우에는 런북의 다른 절을 사용하십시오.

> **유일한 함정:** 노드 키와 체인 스냅샷을 복원하기 전에 빈 호스트에서 `site.yml`을 실행하지 마십시오.
> 키가 없는 호스트에서는 05단계가 **새** 노드 키를 생성하고 블록 0부터 **빈** 체인을 시작합니다.
> 즉, 기존 체인과 다른 체인이 됩니다. 따라서 Ansible이 호스트를 준비하고(1단계), 사용자가 데이터를
> 복원한 다음(2~3단계), Ansible이 나머지를 수행합니다(4단계).

## 필요한 항목 {#what-you-need}

| 백업 | 출처 |
|---|---|
| `ansible/state/` (`secrets/`의 토큰, `network/`, `cluster.json`, `sender01`, `registry.json`, `registry-admin`, `registry-record/`, `contract-center`, `smoke-test.json`, `key-backups/*.key.gpg`) | 운영자 보안 저장소 |
| 컨트랙트 기록(`contracts/deployments/`)이 커밋된 저장소 | 사용 중인 git 서버 |
| GPG **개인** 키 + 패스프레이즈(노드 키 복호화, [노드 키 백업용 GPG 키](../deployment/gpg-key.md)) | 오프라인 보안 저장소 |
| 최신 체인 스냅샷 `besu-chain-val3-<time>-b<block>.tgz` **및 그 `.json`** | `/backup/chain` 사본 또는 오프사이트(`snapshot_copy_to`) |
| 각 MPC 노드의 `mpc-node<N>-<time>.tgz` + 그 `.env`(`MPC_NODE_PASSPHRASE` 포함) | 각 팀의 보안 저장소 |

## 1. 운영자 머신과 호스트 {#1-operator-machine-and-hosts}

5개 호스트를 **같은 IP**로 다시 구축합니다(네트워크 파일의 노드 주소에 IP가 들어 있습니다).
운영자 머신에서 저장소를 클론하고(배포했던 브랜치), `ansible/state/`를 되돌려 놓은 뒤,
`group_vars/all/settings.yml`과 `inventory.yml`에 사용자의 값이 있는지 확인합니다. 그다음
`ansible/`에서 준비 단계**만** 실행합니다.

```bash
cd besu-chain/ansible
```

```bash
ansible-playbook 00-preflight.yml 01-hosts.yml 02-images.yml
```

이렇게 하면 호스트에 Docker, 방화벽, `/opt/besu-chain`의 저장소(그리고 이후 단계가 이를 받아들이도록
`state/repo.commit`), node-exporter, 모든 이미지가 준비됩니다. 보안 저장소에 `state/build/`가
없었다면 `02-images.yml`이 github.com에서 Remix 사이트를 다시 가져옵니다
(`remix_enabled: true`).

## 2. Besu 노드: 노드가 시작되기 전에 키와 체인 복원 {#2-besu-nodes-key-and-chain-before-anything-starts-them}

각 노드에 대해 수행합니다. .135에는 val1과 rpc1, .136에는 val2와 rpc2, .137에는 val3, .138에는 val4가
있습니다. 예시는 val1입니다.

1. 노드 폴더:

   ```bash
   cp -r /opt/besu-chain/besu-production/node /opt/besu-val1
   ```

2. 노드의 `.env`: 해당 노드에 대한 [프로덕션 구성](../overview/production-layout.md) 4.6절의 값과
   정확히 같아야 합니다(`chmod 600 .env`). 4단계에서 Ansible이 작성하는 `.env`도 같습니다.

3. 운영자 머신에서 네트워크 파일을 복사합니다.

   ```bash
   scp ansible/state/network/* root@192.168.68.135:/opt/besu-val1/network/
   ```

4. 노드의 키: GPG 개인 키가 있는 머신에서 복호화하고([노드 키 백업용 GPG 키](../deployment/gpg-key.md)
   5단계), SSH로 호스트에 복사하여 복원한 다음, 모든 평문 사본을 파쇄합니다.

   ```bash
   gpg --pinentry-mode loopback --decrypt val1.key.gpg > val1.key
   ```

   호스트의 `/opt/besu-val1`에서 실행합니다.

   ```bash
   ./restore-key.sh /root/val1.key && shred -u /root/val1.key
   ```

   `OK: … in static-nodes.json`이 출력되어야 합니다.

5. 체인 스냅샷: 같은 `.tgz` **및** `.json`을 각 호스트에 복사한 다음, 각 노드 폴더에서 실행합니다
   (아카이브와 제네시스를 확인하고, 노드의 키를 유지하며, 노드를 시작합니다).

   ```bash
   ./restore-chain.sh --yes /backup/chain/besu-chain-val3-<time>-b<block>.tgz
   ```

   검증자(val1–val4)를 먼저, 그다음 rpc1과 rpc2를 복원합니다.

6. .137에서 블록을 확인합니다.

   ```bash
   cd /opt/besu-val3 && /opt/besu-chain/besu-production/operator/qbft.sh health
   ```

   높이는 스냅샷의 블록보다 높아야 하며 계속 증가해야 합니다. 몇 분 안에 새 블록이 생성되지 않으면
   네 개의 검증자를 함께 재시작하십시오(런북 6.3의 3단계). 전체 중단 후에는 블록이 재개되기까지
   QBFT가 약 3분간 라운드 변경을 거칠 수 있습니다.

## 3. MPC 노드: 각 팀이 자기 호스트에서 {#3-mpc-nodes-each-team-on-its-own-host}

노드 폴더(`mpc_node_dir`, 기본값 `/opt/besu-chain/mpc-signer/deploy/node`)에서 수행합니다.

1. 팀의 `.env`(기존과 같은 파일: 같은 패스프레이즈)와 `cluster.json`(`ansible/state/cluster.json`에서
   가져옴)을 되돌려 놓습니다.
2. 백업을 복원하고 시작합니다.

   ```bash
   docker compose down; ./restore.sh /secure/mpc-backup/mpc-node<N>-<time>.tgz && docker compose up -d
   ```

3. 로그에 `node loaded … keys=<same number as before>`(이전과 같은 키 수)가 표시되어야 합니다.

   ```bash
   docker compose logs --tail 5
   ```

3개 노드 중 2개가 복구되면 서명이 다시 동작합니다. 계정 생성에는 3개 모두가 필요합니다. 백업에는
백업 이전에 만들어진 모든 MPC 키가 들어 있습니다. `SENDER01`, SectionRegistry 관리자, 컨트랙트
계정 센터, 프록시를 통해 생성된 계정이 해당됩니다.

## 4. 나머지 전부: Ansible {#4-everything-else-ansible}

```bash
ansible-playbook site.yml
```

이제 안전합니다.

- 03단계는 MPC 노드가 실행 중인 것을 확인합니다.
- 04단계는 새 키 세레모니 없이 코디네이터를 시작합니다(`state/sender01`이 있음).
- 05단계는 복원된 키를 유지하고(`init.sh`는 기존 키를 교체하지 않습니다), `state/network`의
  제네시스를 재사용하며, 실행 중인 노드는 그대로 둡니다.
- 06단계는 `state/registry.json`을 찾아 복원된 체인에서 레지스트리의 버전을 읽습니다. 새
  SectionRegistry를 배포하지 않으며, 컨트랙트 계정 센터(`state/contract-center`)도 유지됩니다.
- 06~10단계는 프록시와 redis-exporter, RPC 상태 검사기, HAProxy + keepalived, 관리 API 점검
  (08단계), 모니터링, chainlens, Remix, 백업 cron을 되살립니다.
  스모크 테스트는 반복하지 않습니다(`state/smoke-test.json`이 있음).

Prometheus는 빈 이력으로 시작합니다. 메트릭은 백업되지 않습니다.

## 5. 확인 후 정합성 맞추기 {#5-check-then-reconcile}

- 런북 7절의 체크리스트: 발생 중인 알림 없음, 검증자 4개, MPC 3/3, 프록시
  `/status/senders`, 테스트 전송 1회.
- **체인은 스냅샷의 블록 시점으로 돌아갑니다.** 그 이후의 트랜잭션은 **사라집니다**: 전송,
  민팅, 계정 자금 지급. 업무 기록과 비교하여 필요한 작업을 다시 수행하십시오.
- 스냅샷 이후에 생성된 MPC 계정은 키를 그대로 가지고 있지만(MPC 백업이 더 최신인 경우),
  자금 지급은 사라집니다.
- **섹션**은 체인(SectionRegistry)에 있으므로 섹션도 스냅샷 시점의 상태로 돌아갑니다.
  스냅샷 이후에 생성, 변경, 충전, 스윕된 섹션은 사라집니다. chainlens Sections 페이지나 프록시 관리
  API로 확인하십시오([섹션](../features/sections.md)).
- 스냅샷 이후에 배포된 컨트랙트는 체인에서 사라집니다. 그 기록은 여전히
  `contracts/deployments/`에 있을 수 있습니다.
- **즉시 새 백업을 만드십시오:** MPC 백업(각 팀이, 또는 `mpc_backup_cron: true`이면 10단계)과
  체인 스냅샷입니다. 10단계는 `snapshot_dir`에 스냅샷이 없을 때만 첫 스냅샷을 만드는데, 복원한
  스냅샷이 그곳에 있으므로 .137에서 수동으로 만드십시오.

  ```bash
  cd /opt/besu-val3 && ./snapshot-chain.sh /backup/chain
  ```
- **노드 키 백업:** 10단계는 `state/key-backups/`에 파일이 있는 키를 모두 건너뛰므로, 다시 구축한
  호스트에서는 모니터링용 기록이 남지 않아 `ValidatorKeyBackupMissing`이 발생합니다. 이전 파일을
  다른 곳으로 옮기고(새 파일을 확인할 때까지 보관), 키를 다시 백업하십시오. 같은 키이므로 새 파일을
  복호화하면 같은 내용이 나옵니다.

  ```bash
  mv state/key-backups state/key-backups.old
  ```

  ```bash
  ansible-playbook 10-backups.yml
  ```

**필요해지기 전에 연습하십시오**(런북 8절): 예비 호스트에서 다시 구축하고, 각 단계의 시간을 측정하여
런북에 기록하십시오.
