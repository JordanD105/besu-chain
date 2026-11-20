# 운영자 가이드

> **내용:** 운영자 머신에서 Ansible로 프로덕션을 배포하는 단계별 절차입니다. 도구, SSH 접근, 설정, 실행, 그리고 배포 후 할 일을 다룹니다.
>
> **대상:** 운영자 (프로덕션은 여기서 시작하십시오).
>
> **관련 문서:** [Ansible](ansible.md) · [접근 제어](access-control.md) · [아키텍처](../overview/architecture.md)

**목차**

- [1. 운영자 머신에 도구 설치](#1-install-the-tools-on-the-operator)
- [2. 코드 가져오기](#2-get-the-code)
- [3. 5개 호스트에 대한 SSH 접근](#3-ssh-access-to-the-5-hosts)
- [4. 설정](#4-settings)
- [5. 먼저 점검](#5-check-first)
- [6. 실행](#6-run)
- [7. 배포 후](#7-after-the-deployment)
- [이후 작업](#later)

---

빈 운영자 머신에서 시작하여 프로덕션 구성을 배포하기까지의 단계별 절차입니다. 각 단계가 하는 일,
운영자 상태, 재실행은 [Ansible 배포](ansible.md)에 설명되어 있습니다.

## 1. 운영자 머신에 도구 설치 {#1-install-the-tools-on-the-operator}

운영자 머신에는 Ansible, Docker, git, curl이 필요합니다. 운영자 머신은 MPC, 프록시, chainlens, Remix,
문서 사이트 이미지를 빌드하고 제네시스를 생성하므로 Docker가 필요합니다. Remix IDE가 켜져 있으면
(기본값) Remix 사이트를 github.com에서 한 번 가져옵니다.

RHEL / Rocky / Alma:

```bash
sudo dnf install -y git curl python3-pip && pip3 install --user ansible-core
```

Ubuntu / Debian:

```bash
sudo apt install -y git curl python3-pip pipx && pipx install ansible-core
```

그다음 사용 중인 배포판에 맞게 Docker Engine을 설치하고(docs.docker.com 참고) 모든 도구가 있는지 확인하십시오.

```bash
ansible --version && docker version && git --version
```

## 2. 코드 가져오기 {#2-get-the-code}

```bash
git clone https://github.com/JordanD105/besu-chain.git
```

```bash
cd besu-chain/ansible
```

아래의 모든 명령은 이 `ansible/` 폴더에서 실행합니다. 배포하려는 버전이 있는 브랜치를 사용하십시오(`git clone -b <branch> …`).

## 3. 5개 호스트에 대한 SSH 접근 {#3-ssh-access-to-the-5-hosts}

Ansible은 SSH 키로 로그인합니다. 아직 키가 없다면 다음을 실행합니다.

```bash
ssh-keygen -t ed25519
```

키를 각 호스트(.135 ~ .139)에 복사합니다.

```bash
for h in 135 136 137 138 139; do ssh-copy-id root@192.168.68.$h; done
```

그다음 각 호스트 키를 한 번씩 수락합니다.

```bash
for h in 135 136 137 138 139; do ssh root@192.168.68.$h hostname; done
```

root 대신 sudo 사용자로 로그인한다면 `inventory.yml`에 `ansible_user: <that user>`를 설정하고,
sudo가 비밀번호를 요구하면 모든 `ansible-playbook` 명령에 `-K`를 추가하십시오.

Ansible이 모든 호스트에 접근하는지 확인합니다.

```bash
ansible servers -m ping
```

## 4. 설정 {#4-settings}

`group_vars/all/settings.yml`을 편집합니다.

| 설정 | 입력할 값 |
|---|---|
| `vip_rpc`, `vip_proxy`, `vip_prefix` | 두 플로팅 IP와 그 마스크입니다. 두 HA 호스트와 같은 서브넷에 있는 **사용하지 않는** 주소를 지정합니다. `inventory.yml`의 호스트 IP(`ansible_host`)와 함께 이 값들이 전체 IP 계획이 됩니다. Ansible은 이 값으로 HAProxy, keepalived, 방화벽, Prometheus 파일을 생성합니다([Ansible 배포](ansible.md), "IP 계획") |
| `operator_ip` | **호스트에서 보이는 이 머신의 IP**입니다. 방화벽은 이 IP만 허용하므로 값이 틀리면 접속할 수 없게 됩니다 |
| `proxy_client_ips` | 프록시 API(`:30000`)를 호출하는 애플리케이션의 IP입니다. 예: `[10.1.2.3, 10.1.2.4]` |
| `chainlens_ips` | 익스플로러인 chainlens(`:30100`)를 열 수 있는 대상 |
| `grafana_ips` | 대시보드인 Grafana(`:3000`)를 열 수 있는 대상 |
| `remix_ips` | Remix IDE(`:30200`)를 열 수 있는 개발자 |
| `docs_ips` | 문서 웹사이트(`:30300`)를 열 수 있는 대상 |
| `chainlens_deploy_ips` | `operator_ip` 외에 chainlens 관리자 페이지(Deploy, Sections)를 사용할 수 있는 관리자 PC입니다. 예: `[192.168.68.1]`. 해당 페이지 중 하나가 켜져 있을 때만 사용됩니다(아래 참고) |
| | 접근 목록에는 주소와 네트워크를 지정합니다. 예: `[192.168.68.0/24, 10.1.2.9]` (`*` 와일드카드는 사용할 수 없습니다): [접근 제어](access-control.md) |
| `image_archives_dir` | 이미지 아카이브(`besu-26.11.1-docker.tar`, `grafana-13.2-docker.tar`, `node-exporter-v1.12.1-docker.tar`, `prometheus-3.16.0-docker.tar`, `redis-8.10.3-docker.tar`, `redis-exporter-v1.67.0-docker.tar`)가 있는 폴더입니다. 예: `/opt/images`. 비워 두면 Docker Hub에서 이미지를 내려받습니다 |
| `snapshot_copy_to` | 일일 체인 스냅샷의 오프사이트 대상입니다. 예: `backup@offsite:/besu-chain` (선택 사항) |
| `key_backup_gpg_public_key` | 운영자 머신에 있는 **GPG 공개 키**의 경로입니다. 예: `/opt/000/backup-pub.asc`. 키 쌍은 [노드 키 백업용 GPG 키](gpg-key.md)에 따라 생성하십시오. Ansible은 6개 Besu 노드 키를 이 키로 암호화하여 백업합니다. 개인 키는 오프라인에 보관하십시오. 비워 두면 키 백업을 하지 않습니다 |
| `mpc_backup_cron` | `true`이면 Ansible이 3개 MPC 호스트에 매시간 MPC 키 조각 백업을 설정합니다(기본값 `false`: 각 팀이 직접 설정) |
| `ntp_servers` | 사용하는 시간 서버입니다. 예: `[ntp1.internal.example, 10.0.0.1]`. 비워 두면 배포판의 공용 서버를 사용합니다(인터넷 필요). 인터넷에 접근할 수 없는 호스트는 여기에 내부 서버를 **반드시** 지정해야 합니다. QBFT는 타임스탬프가 잘못된 블록을 거부합니다. `HostClockNotSynced` 알림과 Hosts 대시보드의 Clock 열이 이를 감시합니다 |
| `chainlens_sections_enabled` | chainlens의 Sections 페이지입니다(기본값 꺼짐). 섹션을 생성·관리하고 충전, 스윕, 반환을 수행합니다([섹션](../features/sections.md)). Deploy 페이지와 같은 접근 권한과 토큰(`state/secrets/chainlens_deploy_token`)을 사용합니다 |
| `upfront_low_balance_eth`, `sender01_low_balance_eth` | ETH 단위 알림 임계값입니다(기본값 100과 10000, 0 = 끔). 섹션의 선지급 계정 / SENDER01 잔액이 이 값보다 낮으면 `SectionUpfrontLow` / `Sender01Low`가 발생합니다([섹션](../features/sections.md), 모니터링) |
| `sections_required` | `false`(기본값): 섹션 키가 없는 호출도 계속 SENDER01을 사용합니다. 모든 애플리케이션이 `X-Section-Key`를 보내게 되면 `true`로 설정합니다([섹션](../features/sections.md)). `true`이면 배포 시 1회 테스트 전송을 건너뜁니다 |
| `chainlens_deploy_enabled`, `chainlens_deploy_ips` | chainlens의 Deploy 페이지입니다(기본값 꺼짐). 브라우저에서 프록시를 통해 컨트랙트를 배포합니다(컨트랙트 계정 센터, 체인에 등록됨). `operator_ip`와 `chainlens_deploy_ips`의 관리자 PC에서 사용할 수 있습니다: [컨트랙트 배포 (chainlens Deploy 페이지)](../features/contract-deployment.md) |
| `remix_enabled`, `remix_solc_versions` | 모니터링 호스트의 자체 호스팅 Remix IDE(`:30200`, 기본값 켜짐; [Remix IDE (자체 호스팅)](../components/remix.md))와 제공할 컴파일러 버전(기본값 `["0.8.28"]`)입니다. 운영자 머신이 github.com에서 Remix를 한 번 가져옵니다 |
| `docs_site_enabled` | 모니터링 호스트에서 이 문서를 웹사이트로 제공합니다(`:30300`, 기본값 켜짐; [문서 웹사이트](../components/docs-site.md)) |
| `prometheus_retention`, `prometheus_retention_size` | Prometheus의 메트릭 보존 기간(기본값 `400d`)과 디스크 상한(기본값 `20GB`) |
| `rpc_max_block_age`, `rpc_max_blocks_behind`, `rpc_auto_restart_minutes` | HAProxy가 RPC 노드를 VIP에서 제외하는 시점과 정지된 노드를 재시작하는 시점입니다(기본값 30초, 10블록, 5분): [고가용성](high-availability.md), "RPC 상태" |
| `vrrp_interface` | 비워 두십시오. 자동으로 감지됩니다 |

아카이브를 생성하려면(또는 배포에 사용되는 모든 이미지의 사본을 보관하려면) 운영자 머신에서 다음을 실행합니다.

```bash
ansible-playbook save-images.yml -e image_archives_dir=/opt/000
```

이 명령은 6개의 서드파티 이미지(없으면 먼저 pull)를 저장하고, 배포 실행으로 빌드된 후에는 MPC 서명기,
프록시, chainlens, Remix, 문서 사이트 이미지도 저장합니다. `/opt/000`에 총 11개가 저장됩니다
(`remix_enabled`와 `docs_site_enabled`를 각각 `false`로 설정할 때마다 하나씩 줄어듭니다). `site.yml` 실행 후 다시 실행하면 이미지가 갱신됩니다.

그 밖의 모든 값(체인 ID 1337, 1초 블록, `SENDER01` 자금 지급, 이미지 버전)은 이미 설정되어 있습니다.
각 설정은 `settings.yml`에 주석으로 설명되어 있으며, [Ansible 배포](ansible.md)의 2절에서 모두 설명합니다.
다른 값을 원할 때만 변경하십시오. 체인 설정은 첫 실행 이후에는 변경할 수 없습니다.

호스트에는 **커밋된** 코드가 전달됩니다. `settings.yml`과 `inventory.yml` 외의 파일을 편집했다면
먼저 커밋하십시오. 사전 점검 단계에서 커밋되지 않은 변경 사항을 경고합니다.

## 5. 먼저 점검 {#5-check-first}

이 명령은 아무것도 변경하지 않습니다. 설정, 도구, 그리고 각 호스트가 예상한 IP를 가지고 있는지 점검합니다.

```bash
ansible-playbook 00-preflight.yml
```

## 6. 실행 {#6-run}

```bash
ansible-playbook site.yml
```

MPC 팀이 각자 노드를 설정하므로 세 차례에 걸쳐 실행합니다.

**1차 실행**은 모든 호스트를 준비하고 이미지를 빌드한 뒤(첫 MPC 이미지 빌드에는 몇 분이 걸립니다)
"waiting for the MPC teams" 메시지와 함께 멈춥니다.

1. 각 팀에 지침(`state/handoff/mpc1.md`, `mpc2.md`, `mpc3.md`)과 `state/secrets/mpc_node_token`의
   `MPC_NODE_TOKEN`을 보냅니다. 토큰은 보안 채널로 보내십시오.
2. 각 팀은 자기 호스트에서 `init.sh`를 실행하고 `node<ID>.json`을 회신합니다.
3. 세 파일을 `state/mpc/`에 넣은 다음 실행합니다.

```bash
ansible-playbook site.yml
```

**2차 실행**은 `state/cluster.json`을 생성하고 그 sha256을 출력한 뒤 멈춥니다. `cluster.json`을
세 팀에 보냅니다. 각 팀은 sha256을 확인하고 파일을 노드 폴더(`mpc_node_dir`,
기본값 `/opt/besu-chain/mpc-signer/deploy/node`)에 복사한 뒤
`docker compose up -d`를 실행합니다. 그다음 실행합니다.

```bash
ansible-playbook site.yml
```

**3차 실행**은 약 5~10분 안에 끝까지 진행됩니다. 코디네이터, 키 세레모니, 체인, SectionRegistry와
컨트랙트 계정 센터, 프록시, HAProxy + keepalived, 테스트 전송, 모니터링, chainlens, Remix,
문서 사이트, 백업 순입니다. 마지막에 다음을 출력합니다.

- 애플리케이션: `http://192.168.68.151:30000`
- Grafana: `http://192.168.68.139:3000`, 사용자 `admin`, 비밀번호는 `state/secrets/grafana_admin_password`에 있음
- Chainlens: `http://192.168.68.139:30100`
- Chainlens Deploy 페이지 `#/deploy`와 Sections 페이지 `#/sections`(켜져 있을 때): 토큰은
  `state/secrets/chainlens_deploy_token`에 있으며, `operator_ip`와 `chainlens_deploy_ips`에서만 접근 가능
- Remix IDE: `http://192.168.68.139:30200` (EVM 버전 `cancun`으로 컴파일)
- 문서 웹사이트: `http://192.168.68.139:30300`
- 아직 수동으로 해야 하는 작업(백업, 오프사이트 복사, 장애 조치 테스트)과,
  `snapshot_copy_to`가 비어 있으면 경고

## 7. 배포 후 {#7-after-the-deployment}

- **`ansible/state/`를 보안 저장소에 복사하십시오.** 여기에는 토큰, 제네시스, `cluster.json`,
  `SENDER01`, SectionRegistry(`registry.json`), 컨트랙트 계정 센터가 들어 있습니다. 이것이 없으면
  Ansible이 이후에 배포를 업데이트할 수 없습니다.
- **백업**은 마지막 단계에서 설정됩니다. 일일 체인 스냅샷(그리고 첫 스냅샷), `state/key-backups/`에
  암호화된 6개 노드 키(`key_backup_gpg_public_key`가 설정된 경우), 그리고 `mpc_backup_cron: true`이면
  MPC 키 조각 백업입니다. 그렇지 않으면 각 **MPC 팀**이 매시간 실행되는 `backup.sh`
  cron을 설정합니다(팀 지침의 5단계). Grafana의 백업 알림은 모든 백업이 실행되면 해제됩니다.
- **장애 조치 테스트**: [프로덕션 구성](../overview/production-layout.md), 6절.
  그다음 운영을 시작합니다.

## 이후 작업 {#later}

변경(설정, 새 버전, 새 코드)이 있으면 코드인 경우 커밋한 뒤 같은 명령을 다시 실행하십시오.
달라진 부분만 변경합니다.

```bash
ansible-playbook site.yml
```

**`git pull` 후:** `site.yml`은 먼저 새 코드를 호스트에 복사합니다. 대신 개별 단계
(예: `11-chainlens.yml`)를 실행하려면 먼저 `01-hosts.yml`을 실행하십시오. 현재 코드가 복사될 때까지
다른 단계는 "The hosts have older code" 메시지와 함께 멈춥니다.

```bash
ansible-playbook 01-hosts.yml
```

**컨트랙트 기록:** chainlens Deploy 페이지에서 컨트랙트를 배포한 경우, 11단계(`11-chainlens.yml`)가
그 기록을 `contracts/deployments/`에 복사하고 `git add` / `git commit` 명령을 출력합니다.
이를 커밋하십시오.

**실패한 경우:** 빨간색 메시지를 읽으십시오. 원인을 해결한 뒤 같은 명령을 다시 실행하면
멈춘 지점부터 안전하게 계속됩니다. 자세한 내용을 보려면 `-v`를 추가하십시오.
