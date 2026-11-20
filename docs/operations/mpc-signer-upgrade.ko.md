# MPC 서명기 업그레이드

> **내용:** MPC 서명기 업그레이드: 이미지 배포, 각 팀이 MPC 노드를 한 번에 하나씩 업그레이드, 그다음 코디네이터와 프록시, 롤백.
>
> **대상:** MPC 노드 팀, 운영자.
>
> **관련 문서:** [운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md) · [MPC 서명기](../components/mpc-signer.md)

**목차**

- [1. 운영자: 이미지 빌드 및 배포 (00–02 단계만)](#1-operator-build-and-ship-the-image-phases-0002-only)
- [2. 각 MPC 팀: 자기 노드 업그레이드, 한 번에 한 노드씩](#2-each-mpc-team-upgrade-its-node-one-node-at-a-time)
- [3. 운영자: 나머지 모두 업그레이드](#3-operator-upgrade-everything-else)
- [롤백 (새 버전에서 노드가 비정상 동작하는 경우)](#rollback-if-a-node-misbehaves-on-the-new-version)
- [Ansible 없이](#without-ansible)
- [1.3.0의 새 기능](#whats-new-in-130)

---

순서: **이미지를 배포하고, MPC 노드 3개를 한 번에 하나씩 업그레이드한 다음(각 노드는 해당 팀이 수행),
코디네이터와 프록시를 업그레이드합니다.** 명령은 1.3.0과 Ansible 배포
([Ansible 배포](../deployment/ansible.md))를 기준으로 합니다. 다른 버전의 경우 먼저
`ansible/group_vars/all/settings.yml`의 태그(`mpc_image`)를 변경하십시오.

**노드를 먼저 업그레이드하는 이유:** 새 코디네이터는 이전 노드에 없는 노드 기능을 사용할 수 있습니다.
1.3.0의 경우, 노드가 아직 1.2.0인데 코디네이터가 1.3.0이면 사전 서명 풀 클래스를 저장할 수 없습니다: 새 계정이
풀을 받지 못하고, 계정의 풀 클래스 변경이 실패합니다.

**노드 폴더.** 아래에서 `<node dir>`은 팀이 노드를 실행하는 폴더입니다: Ansible 설정의 `mpc_node_dir`,
기본값은 `/opt/besu-chain/mpc-signer/deploy/node`(저장소 사본의 노드 패키지)입니다.
[운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md)에 따라 수동으로 설치한 노드는
`/opt/mpc-node`를 사용합니다.

## 1. 운영자: 이미지 빌드 및 배포 (00–02 단계만) {#1-operator-build-and-ship-the-image-phases-0002-only}

팀이 새 이미지로 전환하려면 먼저 노드 호스트에 이미지가 있어야 합니다. 운영자 머신에서:

```bash
cd besu-chain && git pull && cd ansible
```

```bash
ansible-playbook 00-preflight.yml 01-hosts.yml 02-images.yml
```

이 명령은 현재 코드를 호스트에 복사하고, 운영자 머신에서 `registry.example.com/mpc-signer:1.3.0`을
빌드한 후(처음에는 몇 분 걸립니다. `mpc_image_build: false`이면 호스트가 대신 레지스트리에서 가져옵니다)
.135, .136, .137, .138에 로드합니다. 실행 중인 노드나 팀의 `.env`, `cluster.json`, `node<ID>.json`은
건드리지 않습니다.

**아직 `site.yml`을 실행하지 마십시오:** 노드보다 코디네이터를 먼저 업그레이드하게 됩니다.

## 2. 각 MPC 팀: 자기 노드 업그레이드, 한 번에 한 노드씩 {#2-each-mpc-team-upgrade-its-node-one-node-at-a-time}

순서: mpc1(.135), 그다음 mpc2(.137), 그다음 mpc3(.138). 이전 노드가 돌아온 후에만 다음 노드를 시작합니다.
각 노드 호스트에서:

1. 새 이미지가 있는지 확인합니다.

   ```bash
   docker images registry.example.com/mpc-signer
   ```

   `1.3.0`(그리고 롤백용으로 보관하는 이전 `1.2.0`)이 표시되어야 합니다.

2. 먼저 백업을 만듭니다(팀의 평소 백업 위치).

   ```bash
   <node dir>/backup.sh /secure/backup
   ```

3. 1.3.0으로 전환하고 재시작합니다.

   ```bash
   cd <node dir> && sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.3.0|' .env && docker compose up -d
   ```

4. 노드가 로드될 때까지 기다립니다. 키 자료를 준비하는 동안 약 15–30초가 걸립니다.

   ```bash
   docker compose logs -f --tail 5
   ```

   다음 두 줄이 나타날 때까지 기다린 후 Ctrl+C를 누릅니다.
   - `node loaded party=<0|1|2> keys=<N> has_aux=true`. `keys`는 업그레이드 전과 같은 숫자여야 합니다.
   - `node API listening`.

5. 실행 중인 버전을 확인합니다.

   ```bash
   docker compose ps --format '{{.Image}} {{.Status}}'
   ```

6. 운영자에게 알립니다. 이 노드가 메모리에 보관하던 사전 서명은 사라졌으므로, 운영자가 **두** 코디네이터
   모두에서 풀을 비웁니다(그렇지 않으면 서명이 먼저 오래된 사전 서명을 시도한 후 재시도하거나 콜드 경로로
   전환합니다).

   ```bash
   curl -s -X POST http://192.168.68.135:9100/admin/pool/clear -H "Authorization: Bearer $(cat state/secrets/mpc_admin_token)"
   ```

   ```bash
   curl -s -X POST http://192.168.68.136:9100/admin/pool/clear -H "Authorization: Bearer $(cat state/secrets/mpc_admin_token)"
   ```

7. 다음 팀이 시작하기 전에: Grafana의 **MPC signer** 대시보드에서 **MPC nodes** 표(MPC 노드)가 coord1과
   coord2 모두에서 이 노드를 **UP**으로 표시해야 합니다.

**노드가 재시작되는 동안:** 나머지 두 노드로 서명이 계속됩니다. 키 생성에는 세 노드가 모두 필요하므로 그 약
30초 동안 `/createaccount`는 실패합니다.

## 3. 운영자: 나머지 모두 업그레이드 {#3-operator-upgrade-everything-else}

세 노드가 모두 1.3.0을 실행하면:

```bash
ansible-playbook site.yml
```

`site.yml`은 세 노드가 응답하는지 확인한 후 코디네이터를 한 번에 하나씩 업그레이드하고(.135의 coord1, 그다음
.136의 coord2. 그동안 HAProxy가 클라이언트를 다른 쪽으로 보냅니다), 프록시, 모니터링(대시보드와 알림), 나머지를
업그레이드합니다. 1.3.0의 경우 두 코디네이터 모두 풀 클래스(`target_small`, 그리고 키별 `class`)를 보고하는지
확인하십시오.

```bash
curl -s http://192.168.68.135:9100/admin/pool | head -c 400
```

```bash
curl -s http://192.168.68.136:9100/admin/pool | head -c 400
```

## 롤백 (새 버전에서 노드가 비정상 동작하는 경우) {#rollback-if-a-node-misbehaves-on-the-new-version}

이전 이미지는 아직 호스트에 있습니다. 해당 노드의 폴더에서:

```bash
cd <node dir> && sed -i 's|^MPC_IMAGE=.*|MPC_IMAGE=registry.example.com/mpc-signer:1.2.0|' .env && docker compose up -d
```

그다음 두 코디네이터 모두에서 풀을 비웁니다(2.6단계). 1.2.0은 1.3.0이 작성했을 수 있는 풀 클래스 파일을
무시하므로 롤백은 안전합니다. 어느 노드라도 이전 버전을 실행하는 동안에는 코디네이터도 이전 버전으로 유지하십시오:
`site.yml`을 실행하지 마십시오.

## Ansible 없이 {#without-ansible}

1. [운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md#2-build-and-distribute-the-image-once-per-release-eg-in-ci)에
   따라 이미지를 빌드하고 배포합니다.
2. 여기의 2단계에 따라 노드를 업그레이드합니다.
3. 코디네이터를 한 번에 하나씩 업그레이드합니다(coord2 먼저, 그다음 coord1): `.env`에 새 `MPC_IMAGE`를 설정하고
   `docker compose up -d`를 실행합니다.
4. 그다음 프록시를 업그레이드합니다.

## 1.3.0의 새 기능 {#whats-new-in-130}

MPC 노드에 키와 함께 저장되는 계정별 사전 서명 풀 클래스(`big`, `small`, `none`), 코디네이터의
`MPC_POOL_TARGET_SMALL`, `POST /admin/keys/<address>/pool`, 프록시의 `/createaccount` `pool` 필드와
`POST /account/pool`. 자세한 내용: [운영 환경의 MPC 서명기](../deployment/mpc-signer-production.md#presignature-pools-big-small-and-none)의
"사전 서명 풀".
