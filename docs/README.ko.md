# 문서

**besu-chain**에 관한 모든 내용입니다. besu-chain은 MPC 서명(키가 어디에도 존재하지 않음), 섹션과 NFT를 지원하는
애플리케이션 API, 고가용성, 모니터링, Ansible 배포를 갖춘 프라이빗 Hyperledger Besu(QBFT) 체인입니다.

**처음이십니까?** [소개](overview/introduction.md) → [아키텍처](overview/architecture.md)
→ [용어집](glossary.md) 순서로 읽으십시오.

---

## 역할별 시작하기 {#start-by-role}

| 역할 | 읽는 순서 |
|---|---|
| **프로젝트를 처음 접하는 분** | [소개](overview/introduction.md) · [아키텍처](overview/architecture.md) · [용어집](glossary.md) |
| **애플리케이션 개발자** (API 호출) | [프록시 API](reference/proxy-api.md) · [섹션](features/sections.md) · [NFT 워크플로](features/nft-workflow.md) · [개발 환경](getting-started/development.md) |
| **운영자** (배포, 프로덕션 운영) | [운영자 가이드](deployment/operator-guide.md) · [Ansible](deployment/ansible.md) · [접근 제어](deployment/access-control.md) · [알림](operations/alerts.md) · [대시보드](operations/dashboards.md) · [문제 해결](operations/troubleshooting.md) |
| **MPC 노드 팀** (세 팀 중 하나) | [MPC 서명기](components/mpc-signer.md) · [운영 환경의 MPC 서명기](deployment/mpc-signer-production.md) · [MPC 업그레이드](operations/mpc-signer-upgrade.md) |
| **비즈니스 관리자** (섹션, 자금, NFT) | [섹션](features/sections.md) · [chainlens](components/chainlens.md) · [NFT 워크플로](features/nft-workflow.md) |
| **컨트랙트 개발자** | [Remix](components/remix.md) · [컨트랙트 배포](features/contract-deployment.md) · [컨트랙트 기록](features/contract-records.md) |
| **당직 중, 문제가 발생한 경우** | [문제 해결](operations/troubleshooting.md) · [알림](operations/alerts.md) · [재해 복구](operations/disaster-recovery.md) |

## 작업별 시작하기 {#start-by-task}

| 하려는 작업 | 문서 |
|---|---|
| 프로덕션을 처음부터 배포 | [운영자 가이드](deployment/operator-guide.md) |
| `git pull` 후 프로덕션 업데이트 | [Ansible: 재실행](deployment/ansible.md) (단계 `01` 먼저) |
| PC나 네트워크가 서비스에 접근하도록 허용 | [접근 제어](deployment/access-control.md) |
| 섹션 생성, 충전, 스윕, 반환 | [섹션](features/sections.md) |
| 브라우저에서 컨트랙트 배포 | [컨트랙트 배포](features/contract-deployment.md) |
| Solidity 작성부터 NFT 판매까지 | [NFT 워크플로](features/nft-workflow.md) |
| 알림 이해 | [알림](operations/alerts.md) |
| 알림 해결 | [알림 런북](operations/alert-runbook.md) |
| Grafana 대시보드 읽기 | [Grafana 대시보드](operations/dashboards.md) |
| Besu 검증자 추가 또는 제거, MPC 노드 이동 | [노드 추가 및 제거](operations/adding-nodes.md) |
| 손실된 호스트나 사이트 복구 | [재해 복구](operations/disaster-recovery.md) · [Ansible로 복원](operations/restore.md) |
| MPC 서명기 업그레이드 | [MPC 업그레이드](operations/mpc-signer-upgrade.md) |
| 인터넷이 없는 사이트에서 이미지 빌드 | [오프라인 빌드](deployment/offline-build.md) |
| 모든 것을 한 대의 머신에서 실행 | [개발 환경](getting-started/development.md) |

---

## 전체 문서 {#all-documents}

### 개요 {#overview}
| 문서 | 내용 |
|---|---|
| [소개](overview/introduction.md) | 프로젝트 소개, 구성 요소, 개발 환경과 프로덕션 환경 비교 |
| [아키텍처](overview/architecture.md) | 호스트, 플로팅 IP, 네트워크 영역, 요청 흐름, 장애 표, 알려진 한계 |
| [프로덕션 구성](overview/production-layout.md) | 모든 호스트, 포트, 설정; 처음부터 수동 배포; 장애 조치 테스트 |
| [용어집](glossary.md) | 문서 전반에서 사용하는 용어 |

### 시작하기 {#getting-started}
| 문서 | 내용 |
|---|---|
| [개발 환경](getting-started/development.md) | Docker 호스트 한 대에서 실행하는 전체 스택, 첫 호출, 벤치마크 |

### 배포 {#deployment}
| 문서 | 내용 |
|---|---|
| [운영자 가이드](deployment/operator-guide.md) | 운영자 머신에서의 단계별 작업: 도구, SSH, 설정, 실행, 이후 작업 |
| [Ansible](deployment/ansible.md) | 설정, 단계, MPC 팀 작업, 운영자 상태, 재실행, 보안 |
| [접근 제어](deployment/access-control.md) | 각 서비스에 연결할 수 있는 대상; 주소와 네트워크; 방화벽 |
| [고가용성](deployment/high-availability.md) | HAProxy, keepalived, 플로팅 IP, RPC 상태 검사, 장애 조치 테스트 |
| [Besu 수동 설정](deployment/besu-manual.md) | Besu 패키지 수동 설치: 네트워크 파일, 시작, 검증자 추가 / 제거 |
| [운영 환경의 MPC 서명기](deployment/mpc-signer-production.md) | 세 팀, 토큰, 키 세레모니, 백업, 운영 |
| [GPG 키](deployment/gpg-key.md) | 노드 키 백업을 암호화하는 키 |
| [오프라인 빌드](deployment/offline-build.md) | 인터넷 없이 모든 이미지 빌드: 패키지 아카이브, 베이스 이미지, `offline_build` |

### 구성 요소 {#components}
| 문서 | 내용 |
|---|---|
| [Hyperledger Besu 체인](components/besu.md) | 체인: 노드, QBFT 합의, 제네시스, 구성, 포트, 권한 관리, 운영 |
| [프록시](components/proxy.md) | MPC 서명기 위의 애플리케이션 API, Redis 선택 사용 설계, 문제 해결 |
| [MPC 서명기](components/mpc-signer.md) | 설계, 빠른 시작, 보안 |
| [Chainlens](components/chainlens.md) | 탐색기 페이지, 관리자 페이지, 설정 |
| [Remix](components/remix.md) | 자체 호스팅 IDE |
| [모니터링](components/monitoring.md) | Prometheus, Grafana 대시보드, 메트릭 엔드포인트, 알림 목록 |
| [문서 웹사이트](components/docs-site.md) | 이 문서를 자체 호스팅 웹사이트로 제공 (Docker, 포트 30300) |

### 기능 {#features}
| 문서 | 내용 |
|---|---|
| [섹션](features/sections.md) | 자체 계정, 키, 자금 흐름을 가진 비즈니스 단위; SectionRegistry; 컨트랙트; NFT v3; 모니터링 |
| [컨트랙트 배포](features/contract-deployment.md) | chainlens의 Deploy 페이지 |
| [컨트랙트 기록](features/contract-records.md) | `contracts/deployments/`: 컨트랙트마다 하나의 기록 |
| [NFT 워크플로](features/nft-workflow.md) | Remix → 배포 → 민팅 → 판매, 단계별 안내 |
| [닉네임](features/nicknames.md) | 소울바운드 닉네임 토큰: 구매하고 테두리 올리기; 규칙, API, chainlens 페이지 |

### 운영 {#operations}
| 문서 | 내용 |
|---|---|
| [알림](operations/alerts.md) | 모든 알림: 발생 조건, 의미, 조치 |
| [알림 런북](operations/alert-runbook.md) | 모든 알림의 해결 방법, 명령어와 함께 단계별로 |
| [Grafana 대시보드](operations/dashboards.md) | 모든 대시보드와 패널: 표시 내용, 정상 값, 조치 |
| [문제 해결](operations/troubleshooting.md) | 증상 → 원인 → 확인 → 해결 |
| [재해 복구](operations/disaster-recovery.md) | 백업, 일정, 시나리오별 복구, 훈련 |
| [Ansible로 복원](operations/restore.md) | 백업으로 전체 사이트 재구축 |
| [노드 추가 및 제거](operations/adding-nodes.md) | Besu 검증자 추가 및 제거(Ansible, 테스트 완료), RPC 노드, 4번째 MPC 노드가 불가능한 이유, MPC 노드 이동 |
| [MPC 서명기 업그레이드](operations/mpc-signer-upgrade.md) | 롤링 업그레이드와 롤백 |

### 참조 {#reference}
| 문서 | 내용 |
|---|---|
| [프록시 API](reference/proxy-api.md) | 모든 엔드포인트의 요청 본문, 응답, 오류 |
| `ansible/group_vars/all/settings.yml` | 모든 설정, 파일 자체에 주석으로 설명 |

### 개발 {#development}
| 문서 | 내용 |
|---|---|
| [MPC 벤치마크](development/mpc-benchmarks.md) | MPC 서명기의 서명 처리량과 지연 시간, 용량 산정; 원시 실행 결과는 `mpc-signer/bench/results/` |
| [Paladin](development/paladin.md) | 테스트 네트워크의 프라이버시 노드 |

---

## 문서 규칙 {#conventions}

- 모든 문서는 **내용 / 대상 / 관련 문서**로 시작하며, 긴 문서에는 그다음에 목차가 있습니다.
- 명령어는 별도의 `bash` 블록에 있습니다. Ansible 명령어는 운영자 머신의 `ansible/`에서 실행하십시오.
- 호스트는 마지막 옥텟으로 부릅니다(**h135** = `192.168.68.135`). 프로덕션 주소는
  `ansible/inventory.yml`과 `settings.yml`의 기본값입니다.
- Grafana의 시간은 브라우저의 로컬 시간입니다. 호스트의 로그와 `journalctl`은 UTC일 수 있습니다.
- 이미지는 [`docs/images/`](images/)에 있습니다.
