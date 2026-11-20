# 소개

> **내용:** 이 프로젝트가 무엇인지, 구성 요소, 그리고 두 가지 환경(개발과 프로덕션)을 설명합니다.
>
> **대상:** 모든 분, 가장 먼저 읽으십시오.
>
> **다음:** [아키텍처](architecture.md) · [용어집](../glossary.md) · [문서 지도](../README.md)

---

## 개요 {#what-it-is}

조직이 결제와 NFT를 운영하는 데 필요한 모든 것을 갖춘 **프라이빗 Hyperledger Besu 블록체인(QBFT 합의)**입니다.

- **애플리케이션**은 하나의 HTTP API(**프록시**)를 호출하여 계정을 생성하고, ETH를 이동하고, NFT를 판매하고,
  컨트랙트를 호출합니다. 애플리케이션은 키를 보유하지 않습니다.
- **키는 어디에도 존재하지 않습니다**. 모든 계정은 세 팀이 운영하는 세 MPC 노드에 나뉜 **2-of-3 MPC 키**입니다.
  서명하려면 그중 두 노드가 동의해야 하며, 단일 머신, 팀, 디스크, 백업만으로는 서명할 수 없습니다.
- **섹션**은 비즈니스 단위(매장, 부서)를 분리합니다. 각 섹션은 자체 계정, API 키, 자금 흐름
  (선지급 → 사용자 → 소비 → 결제)을 가지며, 이는 체인에 기록됩니다.
- **운영** 기능도 함께 제공됩니다. 두 호스트의 고가용성, 모니터링과 알림, 백업과 재해 복구 런북,
  블록 탐색기, 자체 호스팅 Remix IDE, 그리고 이 모든 것을 배포하는 Ansible이 포함됩니다.

## 구성 요소 {#components}

| 구성 요소 | 폴더 | 역할 | 문서 |
|---|---|---|---|
| **Besu (QBFT)** | `besu-production/` | 검증자 4개 + RPC 노드 2개, 1초 블록, 무료 가스, 노드 허용 목록 | [Besu 체인](../components/besu.md) · [수동 설정](../deployment/besu-manual.md) |
| **MPC 서명기** | `mpc-signer/` | 2-of-3 임계값 ECDSA(CGGMP24): MPC 노드 3개 + 코디네이터 2개; 이더리움 서명기 JSON-RPC API | [MPC 서명기](../components/mpc-signer.md) |
| **프록시** | `proxy/` | 애플리케이션 API: 계정, 이체, NFT, 컨트랙트, 섹션, Admin API; 선택적 캐시로 Redis 사용 | [프록시](../components/proxy.md) · [API](../reference/proxy-api.md) |
| **SectionRegistry** | `proxy/contracts/` | 섹션, 섹션의 계정, 등록된 컨트랙트의 온체인 기록 | [섹션](../features/sections.md) |
| **Chainlens** | `chainlens/` | 플랫폼 개요, 통계, 관리자 페이지를 갖춘 블록 탐색기 | [chainlens](../components/chainlens.md) |
| **Remix** | `remix/` | 로컬 컴파일러 미러를 갖춘 자체 호스팅 Remix IDE | [Remix](../components/remix.md) |
| **HA** | `ha/` | HAProxy + keepalived: 플로팅 IP, 장애 조치, RPC 상태 검사, 방화벽 | [고가용성](../deployment/high-availability.md) |
| **모니터링** | `monitoring/` | Prometheus + Grafana: 대시보드와 알림 | [모니터링](../components/monitoring.md) · [알림](../operations/alerts.md) |
| **Ansible** | `ansible/` | 운영자 머신에서 모든 것을 배포하고 업데이트 | [Ansible](../deployment/ansible.md) |
| **컨트랙트 기록** | `contracts/deployments/` | 배포된 컨트랙트마다 하나의 JSON 기록 | [컨트랙트 기록](../features/contract-records.md) |

개발 전용: `besu-test-network/`(호스트 한 대의 테스트 체인)와 `mpc-signer/quickstart/`(호스트 한 대의
MPC 노드 3개).

## 두 가지 환경 {#two-setups}

| | 개발 / 테스트 | 프로덕션 |
|---|---|---|
| **위치** | 모든 것을 Docker 호스트 한 대에서 실행 | 호스트 5대 (`192.168.68.135`–`.139`) |
| **Besu** | `besu-test-network/` (chain id 1337) | `besu-production/` |
| **MPC 서명기** | `mpc-signer/quickstart/` (호스트 한 대에 노드 3개) | 호스트와 팀마다 노드 하나 (`mpc-signer/deploy/`) |
| **고가용성** | 없음 | HA 쌍 .135 / .136, 플로팅 IP .150 / .151 |
| **배포** | Docker Compose로 수동 배포 | Ansible |
| **가이드** | [개발 환경](../getting-started/development.md) | [운영자 가이드](../deployment/operator-guide.md) |

개발 환경은 포트가 열려 있고 테스트 키를 사용합니다. **절대 프로덕션에 사용하지 마십시오.**
