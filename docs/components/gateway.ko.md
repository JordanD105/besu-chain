# 섹션 게이트웨이

> **내용:** 낙관적 섹션 게이트웨이(`gateway/`)입니다. 섹션마다 하나씩, 그 애플리케이션 옆에서 실행되는
> 작은 서비스로, 프록시의 애플리케이션 API를 그대로 제공합니다. 프록시에 연결할 수 없는 동안에는 로컬
> 원장으로 직접 응답하고 쓰기를 큐에 저장했다가, 연결이 돌아오면 전송합니다.
>
> **대상:** 운영자(배포), 애플리케이션 개발자(호출), 비즈니스 관리자(단절 중 단일 작성자 규칙).
>
> **관련 문서:** [프록시 API](../reference/proxy-api.md) · [섹션](../features/sections.md) ·
> [알림](../operations/alerts.md#7-section-gateways-gatewayyml) · [Ansible](../deployment/ansible.md)

**목차**

- [한눈에 보기](#at-a-glance)
- [필요한 이유](#why)
- [작동 방식](#how-it-works)
- [오프라인에서 되는 것](#what-works-offline)
- [단일 작성자 규칙](#the-single-writer-rule)
- [예비 계정](#spare-accounts)
- [안전한 재시도: `X-Request-Id`](#safe-retries-x-request-id)
- [게이트웨이 자체 라우트](#the-gateways-own-routes)
- [정정](#corrections)
- [설정](#settings)
- [배포](#deployment)
- [방화벽](#firewall)
- [모니터링](#monitoring)
- [랩 테스트](#lab-test)
- [알려진 한계](#known-limits)
- [파일](#files)

---

## 한눈에 보기 {#at-a-glance}

| | |
|---|---|
| **URL** | `http://<gateway host>:30010`, 프록시와 같은 라우트(`/transfer`, `/createaccount`, `/contract/*` …) |
| **호출자** | 섹션의 애플리케이션, 섹션 키 사용(`X-Section-Key: sk_…`) |
| **개수** | 섹션당 하나(`gateway_hosts`의 호스트에 `gateway_section: <id>`) |
| **프로그램** | `gateway/gateway.js`: Node.js 22, npm 패키지 없음(`node:http`, `node:sqlite`, `fetch`) |
| **이미지** | `localhost/besu-gateway/gateway`(`02-images.yml`이 빌드), 컨테이너 사용자 uid 1000 |
| **데이터** | `/var/lib/besu-gateway/gateway.db`(SQLite: 원장, 큐, 예비 계정, 보고) |
| **설정** | `/etc/besu-gateway/gateway.json`과 `section.key`, `14-gateway.yml`이 작성 |
| **기본값** | 꺼짐: `settings.yml`의 `gateway_enabled: false` |

## 필요한 이유 {#why}

섹션의 애플리케이션은 보통 VIP `.151:30000`의 프록시를 호출합니다. 애플리케이션 호스트와 프록시 사이의
연결이 끊어지면(스위치, 방화벽 변경, 두 건물 사이의 단절) 애플리케이션이 멈춥니다. 결제도, 아이템 판매도,
조회도 되지 않습니다.

애플리케이션 옆에 게이트웨이가 있으면 **애플리케이션과 그 호스트가 프록시에서 단절되어도 애플리케이션이
계속 동작합니다.** 게이트웨이는 알고 있는 정보로 응답하고, 쓰기를 큐에 저장했다가 연결이 돌아오면 순서대로
전송합니다. *낙관적*이라는 것은, 큐에 저장한 쓰기가 실행될 것이라고 약속한다는 뜻입니다. 나중에 체인이
그 쓰기를 거부하면 원장에서 되돌리고 애플리케이션에 알립니다([정정](#corrections)).

이것이 가능한 이유는 단절 중에는 **게이트웨이만 섹션의 자금을 움직이기** 때문입니다
([단일 작성자 규칙](#the-single-writer-rule)). 원장이 모든 잔액을 알고 있으므로, 큐에 저장된 결제에
잔액이 부족한 일은 없습니다.

## 작동 방식 {#how-it-works}

게이트웨이는 항상 세 가지 모드 중 하나에 있습니다(`GET /gateway/status`, 메트릭 `gateway_mode`).

| 모드 | 쓰기 | 읽기 |
|---|---|---|
| **online** (0) | 프록시로 그대로 전달. 각 쓰기 후 체인에서 원장을 갱신 | 그대로 전달. 각 응답을 캐시 |
| **offline** (1) | 게이트웨이가 원장으로 응답하고 큐에 저장 | 원장(플랫폼 컬렉션) 또는 마지막으로 캐시된 응답 |
| **draining** (2) | 큐를 순서대로 전송. 새 쓰기는 원장으로 응답하고 큐 뒤에 저장 | offline과 같음 |

### 온라인: 그대로 전달과 원장 {#online-pass-through-and-the-ledger}

모든 요청은 섹션 키와 함께 프록시로 가고, 프록시의 응답이 그대로 돌아옵니다. 그동안 게이트웨이는 로컬
**원장**을 유지합니다.

- 섹션 계정(선지급, 소비, 결제, 그리고 게이트웨이가 아는 사용자 계정)의 **잔액**: `sync_seconds`(30초)마다,
  그리고 각 쓰기 후 체인에서 읽습니다.
- 플랫폼 컬렉션의 **아이템**(아바타와 닉네임: 소유자, 가격, 레벨, 결제, 취소 기한): 컬렉션의 이벤트에서
  읽습니다.
- **모든 읽기의 마지막 응답**(캐시): 게이트웨이가 직접 계산할 수 없는 읽기용입니다.

또한 [예비 계정](#spare-accounts)을 비축하고, 아직 전달되지 않은 [정정](#corrections)을 전달합니다.

### 오프라인: 응답과 큐 {#offline-answers-and-the-queue}

게이트웨이는 `health_check_seconds`마다 프록시를 점검합니다(`GET /contract/list?type=none`, 타임아웃 3초).
연속으로 `offline_after_failures`번 실패하면 **offline**이 됩니다. 요청 도중 연결이 끊겨 실패한 쓰기는
즉시 offline으로 전환합니다.

오프라인에서는 각 쓰기를 원장으로 검사합니다(섹션의 알려진 사용자 계정인지, 잔액이 충분한지, 아이템이
판매 중인지, 취소 기간이 열려 있는지, [한도](#offline-limits)). 그런 다음 **원장에 반영하고, 큐에 저장하고,
응답합니다.** 응답은 프록시가 했을 응답에 `gateway` 필드가 더해진 형태입니다. `txHash`는 실제 해시가 생길
때까지 임시 해시(`sha256("gateway:" + 요청 id)`)입니다.

```json
POST http://<gateway host>:30010/transfer   { "account": "0xUser", "amount": "0.2", "memo": "offline +x" }
→ { "success": true, "section": { "id": 1, "name": "Shop B" }, "direction": "account -> consumption",
    "from": "0xUser", "to": "0xConsumption", "amount": "0.2", "memo": "offline +x",
    "txHash": "0x1789…f124",
    "gateway": { "mode": "offline", "queued": true, "request": "d8498d08-…" } }
```

### 드레이닝: 큐 전송 {#draining-sending-the-queue}

단절 후 첫 점검이 성공하면 게이트웨이는 **draining**이 됩니다(큐가 비어 있으면 바로 online). 큐를
**한 번에 하나씩, 순서대로** 전송합니다.

| 단계 | 내용 |
|---|---|
| **논스 점검** | 전송 전에 서명자의 논스를 기록합니다. 이전 전송에 응답이 없었던 요청(연결 끊김, `uncertain`)은 두 번 보내지 않습니다. 서명자의 논스가 기록된 값을 넘어섰으면 최근 60개 블록에서 그 트랜잭션을 찾아 요청을 완료로 표시합니다 |
| **전송됨** | 프록시가 200으로 응답: 요청은 실제 트랜잭션 해시와 함께 `done` |
| **프록시 오류**(5xx, 연결 끊김) | 요청은 `uncertain`으로 남고, 다음 라운드에서 논스를 점검한 뒤 재시도합니다 |
| **충돌**(4xx: 체인이나 프록시가 거부) | 요청은 `failed`. 그 효과를 **원장에서 되돌리고**, 큐에 있는 **같은 아이템**의 이후 요청은 `cancelled`(역시 되돌림)가 됩니다. 보고를 기록하고 정정 웹훅으로 보냅니다 |
| **조정(reconcile)** | 큐가 비면 전체 동기화로 체인의 모든 잔액과 아이템을 읽습니다. 원장과 다른 점은 보고(`reconcile`)에 기록합니다. 그다음 **online**이 됩니다 |

`GET /transfer/<임시 해시>`는 요청이 큐에 있는 동안 `pending`(또는 `failed`)으로 응답하고, 전송된 후에는
실제 트랜잭션에 대한 프록시의 응답을 돌려줍니다.

### 모드와 시간 {#modes-and-timing}

| | 시간 |
|---|---|
| 연결 거부(connection refused, host unreachable) → offline | 약 `offline_after_failures` × `health_check_seconds`(랩: 3 × 2초로 7.9초) |
| 패킷이 조용히 버려짐 → offline | 더 깁니다. 각 점검이 3초 타임아웃을 기다리고, 같은 루프에서 실행 중인 동기화도 기다립니다(랩: 22.4초, [알려진 한계](#known-limits)) |
| 연결 복구 → online(큐 비어 있음) | 다음 점검(랩: 0.7–1.6초) |
| 연결 복구 → draining → online | 다음 점검, 그리고 큐 전송과 전체 동기화 한 번에 걸리는 시간 |

모드, 큐, 원장은 디스크에 있으므로 게이트웨이를 재시작해도 유지됩니다.

## 오프라인에서 되는 것 {#what-works-offline}

### 라우트 {#routes}

| 라우트 | 오프라인 |
|---|---|
| `POST /transfer` | 게이트웨이가 아는 사용자 계정의 **+x**(사용자 → 소비)와 **−x**(선지급 → 사용자). 잔액은 원장으로 검사 |
| `POST /createaccount` | [예비 계정](#spare-accounts)을 내줍니다. 선지급 계정에서의 입금과 풀 등급은 큐에 저장합니다. `registryTxHash`는 `null`(예비 계정은 이미 등록됨) |
| `POST /account/pool` | 큐에 저장 |
| `POST /contract/send` | 플랫폼 컬렉션(아래 표). 다른 컨트랙트는 `contract_send_allowed`에 있을 때만 |
| `POST /contract/call` | 플랫폼 컬렉션은 원장에서(아래 표). 그 밖의 호출은 같은 컨트랙트, 함수, 인자의 마지막 캐시 응답, 없으면 오류. 일괄 호출(`calls`)은 호출마다 따로 응답 |
| `GET /transfer/:txHash` | 게이트웨이의 임시 해시: `pending` / `failed`. 다른 해시: 503 |
| 그 밖의 읽기(`GET /contract/list`, `POST /contract/events`, …) | 같은 요청의 마지막 캐시 응답(`gateway.cachedAt` 포함). 온라인에서 한 번도 요청되지 않았으면 503 |

사용자 계정은 마지막 `14-gateway.yml` 실행 때 섹션에 있었거나 게이트웨이를 통해 생성되었을 때 "알려진"
계정입니다. 그 후 다른 곳(chainlens Sections 페이지, 키 없는 호출)에서 만든 계정은 `14-gateway.yml`을 다시
실행할 때까지 오프라인에서 거부됩니다(403).

### 플랫폼 컨트랙트 함수 {#platform-contract-functions}

SectionRegistry에 등록된 아바타와 닉네임 컬렉션(`/contract/list?type=avatar`, `type=nickname`):

| 함수 | 오프라인 |
|---|---|
| `buy`(`tokenId`, `imageUrl` 또는 `nickname`으로) | **쓰기:** 원장에서 아이템이 판매되지 않은 상태여야 합니다. 가격은 사용자 → 소비 계정으로 지불되고, 취소 기한은 지금부터 시작합니다. 큐 요청은 그 가격을 담고 있으므로, 그사이 센터가 가격을 바꾸면 다른 금액이 지불되지 않고 구매가 [정정](#corrections)이 됩니다 |
| `upgradeLevel`(닉네임) | **쓰기:** 소유자만, 레벨은 올리기만, 중간의 모든 레벨이 판매 중이어야 합니다 |
| `undo` | **쓰기:** 취소 기간 안에, 소비 계정이 아이템에 지불된 전액을 환불하고 아이템은 센터로 돌아갑니다 |
| `undoLevel`(닉네임) | **쓰기:** 가장 최근의 레벨 업그레이드, 그 취소 기간 안에 |
| `ownerOf`, `priceOf`, `imageOf`, `nicknameOf`, `levelOf`, `tokenURI`, `paymentsOf`, `tokensOf`, `balanceOf`, `tokenOf`, `levelCount`, `levelInfo`, `quote`, `holdSeconds`, `totalSupply`, `minter`, `name`, `symbol` | 원장에서 **읽기**, `gateway.fromLedger: true` 포함(오프라인 결제는 `pending: true`로 표시) |
| 그 밖의 함수(`mint`, `setPrice`, `addLevel`, …) | 거부(503): 관리 작업은 메인 측에서 합니다 |

### 오프라인에서 거부되는 것 {#refused-offline}

| 거부 | 상태 |
|---|---|
| 관리 작업(`mint`, `setPrice`, 레벨…. 관리 API는 게이트웨이가 제공하지 않음) | 503 |
| 플랫폼 컬렉션이 아닌 컨트랙트. 단, `contract_send_allowed`에 `"0xContract:function"`이 있으면 허용(원장 검사 없이 큐에 저장, 결과는 `null`) | 503 |
| `offline_operations`에 없는 작업 | 503 |
| 한도 도달([아래](#offline-limits)), 또는 예비 계정 없음 | 503 |
| 섹션의 알려진 사용자가 아닌 계정 | 403 |
| 원장 잔액 부족 | 400 |
| 이미 판매된 아이템, 취소 기간 종료 | 409 |
| 온라인에서 한 번도 요청되지 않은 읽기 | 503 |

### 오프라인 한도 {#offline-limits}

| 설정 | 한도 |
|---|---|
| `offline_max_hours`(24) | 이 시간 이상 오프라인이면 더 이상 낙관적 응답을 하지 않음(503) |
| `offline_total_eth`(100) | 한 번의 단절 동안 섹션의 큐 요청이 움직이는 전체 금액 |
| `offline_per_account_eth`(20) | 한 번의 단절 동안 지불 계정 하나가 움직이는 금액. **지불 계정**은 +x와 구매에서는 사용자, −x와 새 계정에서는 **선지급** 계정, 취소에서는 **소비** 계정입니다 |
| `offline_operations` | 오프라인에서 응답하는 쓰기의 종류 |

## 단일 작성자 규칙 {#the-single-writer-rule}

단절 중에는 **게이트웨이만 섹션의 자금을 움직일 수 있습니다.** 원장은 이를 전제로 합니다. 메인 측에서
한 충전, 스윕, 반환, 이체, 새 계정, 계정 교체(chainlens Sections 페이지, 관리 API, 키 없는 호출)는
게이트웨이에 보이지 않으며, 큐 요청이 전송될 때 실패하게 만들 수 있습니다(스윕은 취소 환불을 지급할 소비
계정을 비웁니다).

- **관리자:** 섹션의 게이트웨이가 offline 또는 draining인 동안 그 섹션에 쓰기를 하지 마십시오. 센터가
  컬렉션에 하는 변경(새 가격, 메인 측에서의 판매)은 처리되지만, 각각이 큐 요청을 [정정](#corrections)으로
  바꿀 수 있습니다.
- **Chainlens:** **Sections** 페이지는 게이트웨이가 online이 아닌 섹션마다 빨간 안내를 표시합니다
  (`GET /api/sections/gateways`, `chainlens/.env`의 `GATEWAYS`에서). 내용은 *"게이트웨이가 프록시에 연결할 수
  없음(… 이후 offline, 큐 N개) … 복구될 때까지 이 섹션에 관리 쓰기를 하지 마십시오"*, 또는 게이트웨이가
  전혀 응답하지 않는다는 것입니다.
- **알림:** [GatewayOffline](../operations/alert-runbook.md#gatewayoffline)이 1분 후 발생합니다.

## 예비 계정 {#spare-accounts}

`/createaccount`에는 3개 MPC 노드가 모두 필요하며(키 생성), 단절 중에는 게이트웨이가 그 노드에 연결할 수
없습니다. 그래서 **온라인이고 큐가 비어 있는 동안** 게이트웨이는 프록시를 통해 계정을 미리 만듭니다(섹션
키로 `/createaccount`, 금액 `0`, 풀 `none`: 섹션 아래에 등록됨). 라운드마다 하나씩, `spare_accounts`(20)개가
될 때까지 만듭니다. 오프라인에서 `/createaccount`는 가장 오래된 예비 계정을 내주고, 그 입금을 −x 이체로,
풀 등급(기본 `small`)을 `/account/pool` 요청으로 큐에 저장합니다.

남은 개수가 30분 동안 `spare_alert_below`(5)보다 적으면 `GatewaySparesLow`가 발생합니다. 하나도 없으면
오프라인 `/createaccount`는 503으로 응답합니다.

## 안전한 재시도: `X-Request-Id` {#safe-retries-x-request-id}

각 쓰기에 고유한 `X-Request-Id`(최대 100자)를 보내십시오. 게이트웨이가 큐에 저장한 요청을 애플리케이션이
재시도하면(애플리케이션 쪽 타임아웃, 재시작) 게이트웨이는 **첫 응답**을 `gateway.repeated: true`와 함께
돌려주고 다시 큐에 넣지 않습니다.

```bash
curl -s -X POST http://<gateway host>:30010/transfer -H "X-Section-Key: sk_…" \
  -H "X-Request-Id: order-1234" -H 'Content-Type: application/json' -d '{"account":"0xUser","amount":"0.01"}'
# 같은 X-Request-Id로 다시 → 같은 응답, "gateway": { "request": "order-1234", "status": "queued", "repeated": true }
```

id는 게이트웨이가 **큐에 저장한** 요청(offline, draining, 또는 요청 도중 단절)에 대해서만 기억합니다. 온라인
그대로 전달된 쓰기는 기억하지 않으므로 재시도하면 프록시로 다시 전송됩니다. 금액 `0`인 오프라인
`/createaccount`를 재시도하면 다른 예비 계정을 내줍니다. 헤더가 없으면 게이트웨이가 자체 id를 만듭니다
(`gateway.request`에 표시).

## 게이트웨이 자체 라우트 {#the-gateways-own-routes}

| 라우트 | 키 | 응답 |
|---|---|---|
| `GET /gateway/status` | 불필요 | `section`, `mode`, `since`(단절 시작), `queue`, `oldestSeconds`, `spares`, `offlineEth`(이번 단절 동안 지출), `conflicts`, `lastSync`, `limits` |
| `GET /gateway/request/:id` | 필요 | id 또는 임시 해시로 큐 요청 하나: `status`(`queued`, `sending`, `uncertain`, `done`, `failed`, `cancelled`), `txHash`(전송 후에는 실제 해시), `error`, `created` |
| `GET /gateway/report?since=<ISO 시각>` | 필요 | 최근 보고 500개, 최신순: `conflict`와 `reconcile` 항목, `delivered` 포함 |
| `GET /metrics` | 불필요 | Prometheus 메트릭([모니터링](#monitoring)) |

그 밖의 모든 라우트는 섹션 키가 필요합니다(없으면 0.5초 후 401).

## 정정 {#corrections}

**정정**은 연결이 돌아온 후 체인이 거부한 큐 요청입니다. 게이트웨이는 원장에서 그것을 되돌리고 `conflict`
보고를 기록하며, `correction_webhook`이 설정되어 있으면 애플리케이션에 POST합니다(온라인인 동안 2xx 응답을
받을 때까지 라운드마다 재시도. 보고는 `report_keep_days` 동안 보관).

```json
{ "id": "d8498d08-…", "section": 1, "at": "2026-11-23T17:51:…Z",
  "request": "d8498d08-…", "txHash": "0x…(애플리케이션이 받은 임시 해시)",
  "operation": "nickname_buy", "path": "/contract/send", "body": { "contract": "0xNicknames", "function": "buy", "args": { "tokenId": "2" }, "from": "0xUser" },
  "promised": { "tokenId": "2", "nickname": "Ben", "buyer": "0xUser", "paid": "0.2", "undoUntil": "…" },
  "result": "failed", "reason": "token 2 is already sold",
  "refund": [ { "account": "0xUser", "amount": "0.2" } ],
  "cancelled": [ "50e6ad6b-…" ] }
```

`refund`는 원장이 돌려준 금액입니다(체인에서는 자금이 나간 적이 없습니다). `cancelled`는 함께 취소된 같은
아이템의 이후 요청 목록입니다(여기서는 그 닉네임의 레벨 업그레이드). 애플리케이션은 사용자에게 알리고, 자기
쪽에서 제공한 것을 되돌려야 합니다.

## 설정 {#settings}

`ansible/group_vars/all/settings.yml`에서:

| 설정 | 기본값 | 의미 |
|---|---|---|
| `gateway_enabled` | `false` | 게이트웨이를 켭니다(이미지, 방화벽, `14-gateway.yml`, Prometheus 대상, chainlens 안내) |
| `gateway_port` | `30010` | 모든 게이트웨이의 호스트 포트 |
| `gateway_client_ips` | `[]` | 게이트웨이를 호출할 수 있는 곳: 애플리케이션(주소 또는 네트워크) |
| `gateway_sections` | `{}` | 섹션 id별로 `gateway_defaults`와 다른 값만, 예: `{ 1: { offline_total_eth: 150 } }` |

`gateway_defaults`:

| 설정 | 기본값 | 의미 |
|---|---|---|
| `health_check_seconds` | `3` | 프록시 점검 간격(루프 한 라운드) |
| `offline_after_failures` | `3` | 연속 점검 실패 횟수 → offline |
| `offline_max_hours` | `24` | 이 시간 이상 오프라인이면 더 이상 낙관적 응답 없음(503). 취소 기간(7일)보다 훨씬 짧게 유지하십시오 |
| `offline_total_eth` | `100` | 한 번의 단절 동안 섹션의 모든 결제 |
| `offline_per_account_eth` | `20` | 한 번의 단절 동안 지불 계정 하나 |
| `offline_operations` | `[transfer, createaccount, avatar_buy, nickname_buy, level_upgrade, undo, account_pool]` | 오프라인에서 응답하는 쓰기(`undo`는 `undo`와 `undoLevel`을 포함) |
| `contract_send_allowed` | `[]` | 오프라인에서 허용하는 다른 컨트랙트의 쓰기: `"0xContract:function"` |
| `spare_accounts` | `20` | 오프라인 `/createaccount`용으로 미리 만드는 계정 수 |
| `spare_alert_below` | `5` | 이보다 적으면 `GatewaySparesLow` |
| `correction_webhook` | `""` | 정정을 받는 애플리케이션의 URL(`""` = 보고만) |
| `report_keep_days` | `365` | 보고 보관 기간 |
| `sync_seconds` | `30` | 온라인에서 체인을 읽는 간격 |

**설정 변경:** `settings.yml`을 수정한 다음 `ansible-playbook 14-gateway.yml`을 실행하십시오. `gateway.json`을
다시 쓰고 컨테이너를 다시 만듭니다. `/var/lib/besu-gateway`의 원장, 큐, 예비 계정, 보고는 유지됩니다.
`gateway_port`나 `gateway_client_ips`를 바꾸면 `01-hosts.yml`(방화벽)도, `gateway_port`를 바꾸면
`09-monitoring.yml`과 `11-chainlens.yml`도 실행해야 합니다.

## 배포 {#deployment}

1. 섹션 애플리케이션 옆의 **호스트를 고르고**(`ansible/inventory.yml`의 `servers`에 있는 호스트) 그 섹션을
   지정합니다.

   ```yaml
   gateway_hosts: { hosts: { h137: { gateway_section: 1 } } }
   ```

2. `settings.yml`에서 **켭니다**: `gateway_enabled: true`, 그리고 `gateway_client_ips`에 애플리케이션 주소.
3. **섹션 키.** 게이트웨이는 섹션 키를 사용하며, 애플리케이션은 **같은** 키로 게이트웨이를 호출합니다. 섹션의
   현재 키를 `ansible/state/secrets/gateway-section-<id>.key`에 한 줄로 넣거나, Ansible이 새 키를 만들게
   하십시오: `-e gateway_new_key=true`(이전 키는 즉시 중지되므로 애플리케이션을 동시에 게이트웨이로
   전환하십시오).
4. `ansible/`에서 **적용합니다**.

   ```bash
   ansible-playbook 01-hosts.yml 02-images.yml 14-gateway.yml -e gateway_new_key=true   # 처음, 새 키
   ansible-playbook 09-monitoring.yml 11-chainlens.yml                                   # 대상, chainlens 안내
   ```

   `14-gateway.yml`은 프록시 관리 API에서 섹션과 그 사용자 계정을 읽고, `/etc/besu-gateway/gateway.json`과
   `section.key`를 쓰고, 컨테이너를 시작하고 `/gateway/status`를 기다립니다. 모드와 예비 계정 수를 출력합니다
   (예비 계정은 이후 몇 분 동안 온라인에서 만들어집니다).
5. 애플리케이션이 프록시 대신 `http://<gateway host>:30010`을 **가리키게 합니다.** 호출 방식은 그 밖에
   바뀌지 않습니다.

`site.yml`은 `14-gateway.yml`을(`gateway_enabled`일 때) `09-monitoring.yml`보다 먼저 실행하므로 Prometheus가
게이트웨이의 응답을 확인할 수 있습니다. `gateway/`를 변경한 후: `01-hosts.yml 02-images.yml 14-gateway.yml`.

## 방화벽 {#firewall}

`ha/firewall-layout.sh`(단계 `01-hosts.yml`)는 `gateway_enabled`일 때 다음을 엽니다.

| 포트 | 출발지 | 대상 |
|---|---|---|
| 30010 (`GATEWAY_PORT`) | `gateway_client_ips`, 모니터링 호스트(Prometheus, chainlens), `operator_ip` | 게이트웨이 호스트(`HAS_GATEWAY=1`) |
| 30000 (프록시 VIP) | 게이트웨이 호스트(`PROXY_CLIENTS`에 추가) | HA 쌍 |
| 8545 (RPC VIP) | 게이트웨이 호스트(`GATEWAYS`: 잔액, 논스) | HA 쌍 |

그러면 애플리케이션에는 `proxy_client_ips`가 아니라 `gateway_client_ips`만 필요합니다.

## 모니터링 {#monitoring}

Prometheus 작업 `gateway`(IP 계획에서 만든 대상: `name: gateway-<section id>`), `GET /metrics`의 메트릭,
레이블 `section_id`와 `section`:

| 메트릭 | 의미 |
|---|---|
| `gateway_mode` | 0 online, 1 offline, 2 draining |
| `gateway_queue_length` | 전송을 기다리는 요청 |
| `gateway_queue_oldest_seconds` | 가장 오래 기다린 요청의 나이 |
| `gateway_offline_eth` | 현재 단절 동안 지출된 ETH |
| `gateway_spare_accounts`, `gateway_spare_target` | 남은 예비 계정, 원하는 수 |
| `gateway_spare_alert_below` | `GatewaySparesLow` 임계값 |
| `gateway_conflicts_total` | 재연결 후 체인이 거부한 큐 요청 |
| `gateway_last_sync_timestamp_seconds` | 체인과의 마지막 전체 동기화 |

알림(`monitoring/prometheus/rules/gateway.yml`, [알림](../operations/alerts.md#7-section-gateways-gatewayyml)):

| 알림 | 심각도 | 대기 | 발생 조건 |
|---|---|---|---|
| [GatewayOffline](../operations/alert-runbook.md#gatewayoffline) | warning | 1 min | 게이트웨이가 프록시에 연결할 수 없음 |
| [GatewayDrainingLong](../operations/alert-runbook.md#gatewaydraininglong) | warning | 15 min | 아직 큐를 전송 중 |
| [GatewayQueueOld](../operations/alert-runbook.md#gatewayqueueold) | warning | 5 min | 큐 요청이 1시간보다 오래됨 |
| [GatewaySparesLow](../operations/alert-runbook.md#gatewayspareslow) | warning | 30 min | 예비 계정이 `spare_alert_below`보다 적음 |
| [GatewayConflicts](../operations/alert-runbook.md#gatewayconflicts) | warning | – | 지난 1시간 동안 큐 요청이 거부됨 |
| [GatewayDown](../operations/alert-runbook.md#gatewaydown) | critical | 2 min | 게이트웨이가 응답하지 않음 |

## 랩 테스트 {#lab-test}

랩 구성(`10.77.0.x`)에서 h137에 섹션 1("Shop B")용 게이트웨이 하나를 두고, `health_check_seconds: 2`,
`offline_after_failures: 3`, `spare_accounts: 3`으로 실행했습니다. 연결은 h137에서 두 VIP(프록시와 RPC)로
가는 트래픽을 iptables로 막아 끊었습니다. 운영자 머신은 끊지 않았습니다.

| 단계 | 한 일 | 결과 |
|---|---|---|
| 1. 온라인 | 상태, 예비 계정 3개까지 채움, 키 없는 호출 | (출력 미보존) |
| 2. 게이트웨이를 통해 | 새 계정 0xUser(3 ETH), +x 0.5. 메인 측에서 센터가 아바타와 닉네임 컬렉션을 배포하고 아바타 3개(0.1)와 닉네임 3개(0.2), 레벨 2개(0.05, 0.1)를 민팅. 프록시에서 계정 0xOther 생성 | (출력 미보존). 4단계에서 원장이 새 아이템을 알고 있었음 |
| 3. 단절 | 두 VIP로 REJECT | offline(출력 미보존) |
| 4. 오프라인 응답 | 새 계정 0xUser2(1 ETH, 예비 계정), +x 0.2, −x 0.3, 이미지 URL로 아바타 1 구매, 이름으로 닉네임 "Ann" 구매, 레벨 0 → 1 → 2, `undoLevel`, 읽기(`tokensOf`, `paymentsOf`), `GET /transfer/<임시 해시>`, 같은 `X-Request-Id` 두 번 | 모두 즉시 응답. 임시 해시는 `pending`. 재시도는 첫 응답을 받음 |
| 4. (거부) | 0xUser2가 아바타 1을 다시 구매, 0xUser2의 +x 50, `mint` | 409 *already sold*. 503 *the offline limit of 0xUser2 (20 ETH) is reached*. 503 *admin work is done on the main side* |
| 5. 메인 측에서 충돌 준비 | 센터가 아바타 3의 가격을 0.15로 변경. 0xOther가 프록시에서 닉네임 "Ben" 구매. 그다음 오프라인에서: 0xUser가 아바타 3(0.1에)과 "Ben"을 구매하고 "Ben"을 업그레이드. 0xUser2가 "Cat" 구매 | 게이트웨이는 (알 수 없었으므로) 응답함. 큐 14개, `offlineEth` 2.61 |
| 6. 연결 복구 | iptables 규칙 제거 | draining 후 online. 큐 0. +x 0.2의 임시 해시가 이제 실제 트랜잭션으로 응답 |
| 7. 체인과 보고 | 소유자, 레벨, 잔액. `/gateway/report`. `/metrics` | 충돌 2건을 제외하고 원장이 약속한 대로 |

**충돌 2건**(둘 다 환불과 함께 보고됨):

| 요청 | 이유 | 환불 | 취소됨 |
|---|---|---|---|
| 아바타 3을 0.1에 구매 | `value: the price is 0.15 ETH` | 0xUser에게 0.1 | – |
| 닉네임 "Ben" 구매 | `token 2 is already sold` | 0xUser에게 0.2 | 큐에 있던 "Ben"의 레벨 업그레이드 |

**조정 차이:** 계정 하나, 소비 계정: 원장 48.27, 체인 48.47. 0.2는 단절 중 0xOther가 프록시에서 한 "Ben"
구매로, 게이트웨이는 볼 수 없었습니다. 바로 [단일 작성자 규칙](#the-single-writer-rule)이 다루는 경우입니다.
최종 잔액은 원장과 일치했습니다: 0xUser 2.24, 0xUser2 0.8.

**감지 시간**(`health_check_seconds: 2`, `offline_after_failures: 3`):

| 단절 | offline까지 | 다시 online까지 |
|---|---|---|
| 연결 거부(REJECT) | 7.9초 | 1.6초 |
| 패킷이 조용히 버려짐(DROP) | 22.4초 | 0.7초 |

## 알려진 한계 {#known-limits}

아직 구현되지 않았으며, 해결 방법은 제안입니다.

| 한계 | 영향 | 제안된 해결 방법 |
|---|---|---|
| **상태 점검이 루프를 공유**합니다(동기화, 예비 계정 생성과 같은 루프) | 바쁜 게이트웨이(조용한 단절에서 기다리는 동기화나 `/createaccount`)는 늦게 점검합니다. 조용한 단절을 늦게 감지합니다(랩에서 약 8초 대신 22.4초) | 상태 점검을 별도 타이머로 실행하고, 동기화 호출에 짧은 타임아웃을 줍니다 |
| **조용한 단절 직전에 그대로 전달된 쓰기**는 프록시의 응답을 최대 120초 기다립니다 | 애플리케이션은 게이트웨이가 원장으로 응답하기까지 최대 2분 기다립니다(그 요청은 `uncertain`으로 큐에 저장되고, 재전송 전에 논스를 점검합니다) | 그대로 전달하는 쓰기의 응답 타임아웃을 줄이거나, 상태 점검이 단절을 선언하는 즉시 원장으로 응답합니다 |

설계상 한계도 있습니다. 게이트웨이 밖에서 만든 계정은 `14-gateway.yml`을 다시 실행할 때까지 오프라인에서
알 수 없고, `X-Request-Id`는 큐 요청만 보호하며, 온라인에서 한 번도 요청되지 않은 읽기는 오프라인에서
응답할 수 없습니다.

## 파일 {#files}

| 파일 | 내용 |
|---|---|
| [`gateway/gateway.js`](../../gateway/gateway.js) | 프로그램 |
| [`gateway/Dockerfile`](../../gateway/Dockerfile), [`gateway/docker-compose.yml`](../../gateway/docker-compose.yml) | 이미지(`node:22-alpine`)와 컨테이너(포트, `/config`, `/data`) |
| [`ansible/14-gateway.yml`](../../ansible/14-gateway.yml) | 배포: 섹션, 키, 설정, 컨테이너 |
| [`ansible/group_vars/all/settings.yml`](../../ansible/group_vars/all/settings.yml) | `gateway_enabled`, `gateway_port`, `gateway_defaults`, `gateway_sections`, `gateway_client_ips` |
| [`ansible/inventory.yml`](../../ansible/inventory.yml) | `gateway_section`이 있는 `gateway_hosts` |
| [`ha/firewall-layout.sh`](../../ha/firewall-layout.sh) | `GATEWAYS`, `HAS_GATEWAY`, `GATEWAY_CLIENTS`, `GATEWAY_PORT` |
| [`ansible/templates/targets/gateway.yml.j2`](../../ansible/templates/targets/gateway.yml.j2) | Prometheus 대상 |
| [`monitoring/prometheus/rules/gateway.yml`](../../monitoring/prometheus/rules/gateway.yml) | 알림 6개 |
| [`ansible/templates/chainlens.env.j2`](../../ansible/templates/chainlens.env.j2) | chainlens 안내용 `GATEWAYS` |
| 게이트웨이 호스트 | `/etc/besu-gateway/gateway.json`, `/etc/besu-gateway/section.key`, `/var/lib/besu-gateway/gateway.db`, `/opt/besu-chain/gateway/.env` |
| 운영자 머신 | `ansible/state/secrets/gateway-section-<id>.key` |
