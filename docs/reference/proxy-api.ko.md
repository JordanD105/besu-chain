# 프록시 API 레퍼런스

> **내용:** 프록시(`proxy/stress-latest.js`)의 모든 엔드포인트와 요청 본문, 응답입니다.
>
> **대상:** 애플리케이션 개발자 및 운영자.
>
> **관련 문서:** [프록시 구성 요소](../components/proxy.md) · [섹션](../features/sections.md) ·
> [NFT 워크플로](../features/nft-workflow.md) · [용어집](../glossary.md)

**목차**

- [규칙](#conventions)
- [계정과 이체](#accounts-and-transfers)
- [섹션 호출 (`X-Section-Key`)](#section-calls-x-section-key)
- [NFT 컬렉션](#nft-collections)
- [닉네임](#nicknames)
- [등록된 컨트랙트](#registered-contracts)
- [관리 API: 섹션](#admin-api-sections)
- [관리 API: 닉네임](#admin-api-nicknames)
- [관리 API: 컨트랙트와 레지스트리](#admin-api-contracts-and-registry)
- [상태와 메트릭](#status-and-metrics)
- [오류](#errors)

---

## 규칙 {#conventions}

![프록시 호출자 세 종류: 키 없음, X-Section-Key, 관리자 토큰](../images/diagrams/api-callers.svg)

| | |
|---|---|
| **기본 URL** | `http://<proxy VIP>:30000` — 프로덕션 `http://192.168.68.151:30000`(활성 프록시). 개발: `http://localhost:30000` |
| **본문** | JSON, 헤더 `Content-Type: application/json` (제한 1 MB) |
| **금액** | ETH를 십진수 문자열로 표기(`"1.5"`), wei는 사용하지 않습니다 |
| **주소** | `0x…` (대소문자 무관) |
| **응답** | JSON. 성공: `{ "success": true, … }`. 실패: HTTP 상태 코드와 `{ "error": "…" }` |
| **호출 가능 대상** | 방화벽의 `proxy_client_ips` ([접근 제어](../deployment/access-control.md)). 관리 API는 관리 토큰과 관리자 주소도 필요합니다 |

호출자는 세 종류입니다.

| 호출자 | 헤더 | 사용 가능 범위 |
|---|---|---|
| 섹션이 **없는** 애플리케이션 | 없음 | SENDER01 엔드포인트 (`sections_required: true`가 아닌 경우) |
| **섹션에 속한** 애플리케이션 | `X-Section-Key: sk_…` | 섹션 호출: 자체 계정, +x / −x 이체, NFT 구매, 컨트랙트 호출 |
| **운영자 / chainlens** | `Authorization: Bearer <ADMIN_TOKEN>`, `ADMIN_ALLOWED_IPS`에서 호출 | `/admin/*` API |

```bash
# example
curl -s -X POST http://192.168.68.151:30000/createaccount \
  -H 'Content-Type: application/json' -H 'X-Section-Key: sk_…' \
  -d '{"amount":"2","pool":"none"}'
```

---

## 계정과 이체 {#accounts-and-transfers}

### `POST /createaccount` — 새 계정 (새 MPC 키) {#post-createaccount--new-account-new-mpc-key}

MPC 노드 3개가 분산 키 생성을 실행합니다. 개인 키는 어디에도 존재하지 않습니다. **MPC 노드 3개가
모두 온라인이어야 합니다.**

| 필드 | | |
|---|---|---|
| `amount` | ETH | 새 계정에 공급할 자금 |
| `pool` | 선택 사항 | 사전 서명 풀 등급: `big`, `small`(기본값, `MPC_NEW_ACCOUNT_POOL`) 또는 `none`. `big` = 사용량이 많은 계정을 위한 빠른 서명 |

- **`X-Section-Key`가 있는 경우:** 계정이 온체인에서 해당 섹션 아래에 등록되고, 섹션의
  **선지급** 계정에서 자금을 받습니다.
- **키가 없는 경우:** `SENDER01`이 자금을 공급합니다.

```json
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "address": "0x…",
    "from": "<upfront account>", "amount": "2", "txHash": "0x…", "registryTxHash": "0x…" }
```

### `POST /account/pool` — 계정의 풀 등급 변경 {#post-accountpool--change-an-accounts-pool-class}

`{ "address": "0x…", "pool": "big" | "small" | "none" }`

### `POST /transfer` — ETH 이동 {#post-transfer--move-eth}

**섹션 호출**(`X-Section-Key`): `amount`의 부호가 방향을 정합니다.

| 본문 | 방향 |
|---|---|
| `{ "account": "0x…", "amount": "1", "memo": "optional" }` | **+x**: 사용자 계정 → 섹션의 **소비** 계정 |
| `{ "account": "0x…", "amount": "-0.5" }` | **−x**: 섹션의 **선지급** 계정 → 사용자 계정 |

`account`는 해당 섹션의 사용자 계정이어야 합니다.

```json
→ { "success": true, "section": {…}, "direction": "account -> consumption",
    "from": "0x…", "to": "0x…", "amount": "1", "txHash": "0x…" }
```

**키가 없는 경우**(SENDER01 모드): `{ "from": "0x…", "to": "0x…", "amount": "1", "memo": "optional" }`.
섹션의 계정은 이 방식으로 이동할 수 없습니다(403).

### `GET /transfer/:txHash` — 이체 상태 {#get-transfertxhash--status-of-a-transfer}

상태(pending, mined, failed)와 메모를 반환합니다.

---

## 섹션 호출 (`X-Section-Key`) {#section-calls-x-section-key}

키는 섹션을 식별하며, 섹션은 **활성** 상태여야 합니다. 키가 없으면 호출은 SENDER01을 사용합니다.
단, `sections_required: true`이면 401이 반환됩니다. [섹션](../features/sections.md)을 참조하십시오.

| 엔드포인트 | 섹션 키 사용 시 |
|---|---|
| `POST /createaccount` | 섹션의 계정, 섹션의 선지급 계정에서 자금 공급 |
| `POST /transfer` | +x / −x (위 참조) |
| `POST /nft/transfer` | 버전 3 NFT를 섹션의 사용자 계정에 판매 (아래 참조) |
| `POST /contract/send` | 섹션의 사용자 계정이 서명하는 컨트랙트 트랜잭션 (아래 참조) |

---

## NFT 컬렉션 {#nft-collections}

두 가지 버전이 있습니다.

| | 버전 3 (섹션 사용) | 버전 2 (레거시) |
|---|---|---|
| 배포 및 민팅 주체 | **컨트랙트 계정 센터** | SENDER01 |
| 최초 판매 대금 수령 | 구매자 섹션의 **소비** 계정 (컨트랙트가 확인) | SENDER01 |
| 재판매 대금 수령 | 판매자 | 판매자 |
| `/nft/transfer` | `X-Section-Key` 필요 (또는 chainlens처럼 관리 토큰) | 키 불필요 |

**컬렉션 선택:** 본문의 `collection` 또는 쿼리의 `?collection=`에 컬렉션의 **이름**,
**심볼**(대소문자 구분 없음) 또는 **주소**를 지정합니다. 지정하지 않으면 기본(첫 번째) 컬렉션이 사용됩니다.
(`contract` / `?contract=`도 같은 방식으로 허용됩니다.)

### `POST /nft/deploy` — 새 컬렉션 {#post-nftdeploy--new-collection}

`{ "name": "Dragons", "symbol": "DRG" }` — 이름과 심볼은 고유해야 합니다(그렇지 않으면 409).
컬렉션은 chainlens에서도 배포할 수 있습니다([컨트랙트 배포](../features/contract-deployment.md)).

```json
→ { "success": true, "contract": "0x…", "default": false, … }
```

### `GET /nft/collections`

```json
→ { "success": true, "collections": [ { "contract": "0x…", "name": "Dragons", "symbol": "DRG",
      "version": 3, "minter": "<contract account center>", "default": true }, … ] }
```

`version` 3 컬렉션은 컨트랙트 계정 센터가, 버전 2는 SENDER01이 민팅합니다.

### `POST /nft/mint` — 판매용 민팅 {#post-nftmint--mint-for-sale}

컬렉션의 민터(v3는 센터, v2는 SENDER01)에게 민팅되며 아무것도 지불되지 않습니다. `amount`는
ETH 단위의 **가격**으로, 온체인에 저장되며 이후 모든 판매에서 고정됩니다.

```json
{
  "collection": "DRG",
  "name": "Red dragon",
  "description": "Level 1",
  "image": "https://example.com/red.png",
  "attributes": [{ "trait_type": "level", "value": "1" }],
  "properties": { "series": "2026" },
  "amount": "3"
}
→ { "success": true, "tokenId": "1", "contract": "0x…", "owner": "<minter>", "price": "3", "txHash": "0x…" }
```

`name`과 `image`는 필수입니다. 토큰 ID는 각 컬렉션에서 1부터 시작합니다.

### `POST /nft/transfer` — 판매 {#post-nfttransfer--sale}

구매자 `to`가 정확히 가격만큼의 금액으로 **하나의** `buy` 트랜잭션에 서명합니다. NFT와 ETH는
함께 이동하거나 전혀 이동하지 않습니다.

```bash
curl -s -X POST http://192.168.68.151:30000/nft/transfer -H 'Content-Type: application/json' \
  -H 'X-Section-Key: sk_…' -d '{"collection":"DRG","to":"0xBuyer…","tokenId":"1"}'
```
```json
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "sale": "first sale",
    "price": "3", "paidTo": "<consumption account>", "txHash": "0x…", "approveTxHash": null }
```

- **버전 3:** `to`는 키에 해당하는 섹션의 사용자 계정이어야 합니다. 재판매는 같은 섹션 안에서만
  가능합니다. 필요하면 판매자의 승인이 자동으로 전송됩니다.
- **버전 2:** 키가 필요 없습니다. `from`은 선택 사항입니다(기본값: 현재 소유자).

### 조회 {#reading}

| 엔드포인트 | 응답 |
|---|---|
| `GET /nft/:tokenId?collection=DRG` | 토큰, 소유자, tokenURI, 민팅 트랜잭션, 메타데이터 |
| `GET /nft/:tokenId/metadata?collection=DRG` | 메타데이터 JSON |
| `GET /nft/owner/:address` | 컬렉션별 보유 토큰 (하나만 보려면 `?collection=`) |
| `GET /nft/contract` | 기본 컬렉션 |

Remix에서 판매까지의 단계별 안내: [NFT 워크플로](../features/nft-workflow.md).

---

## 닉네임 {#nicknames}

테두리 레벨이 있는 소울바운드 닉네임 토큰([닉네임](../features/nicknames.md)). 모든 호출에
`X-Section-Key`(또는 관리 토큰)가 필요하고, `account`는 그 섹션의 사용자 계정이어야 합니다. 가격은 ETH.

| 엔드포인트 | 본문 / 쿼리 | 응답 |
|---|---|---|
| `GET /nickname/edges` | | `{ collection, nicknamePrice, edges: [ { level, name, price, enabled, style: { color, color2, width, radius, pattern } } ] }` |
| `GET /nickname/check` | `?name=Alice` | `{ nickname, characters, tokenId, available, reason }` (`reason`: `taken`, `reserved` 또는 `null`) |
| `GET /nickname/of/:account` | | `{ nickname, tokenId, account, level, edge, image }` (`image`: SVG 데이터 URI); 없으면 404 |
| `GET /nickname/quote` | `?account=0x…&level=2` | `{ account, level, price }`: `level`까지의 단계 가격 합계 |
| `POST /nickname/buy` | `{ "account": "0x…", "nickname": "Alice" }` | `{ success, section, nickname, tokenId, account, level, edge, image, price, paidTo, txHash, blockNumber, … }` |
| `POST /nickname/edge` | `{ "account": "0x…", "level": 2 }` | `buy`와 같으며 새 레벨 포함 |

이름: NFC와 공백 제거 후 1~256자, 제어 문자와 `< > & " ' \` 불가, A–Z 대소문자 구분 없이 고유,
계정당 하나. 레벨은 올라가기만 합니다.

---

## 등록된 컨트랙트 {#registered-contracts}

SectionRegistry에 등록된 컨트랙트(컨트랙트 계정 센터가 배포한 것)만, 그리고 해당 ABI에 있는
함수만 사용할 수 있습니다.

### `POST /contract/call` — 읽기 (view / pure) {#post-contractcall--read-view--pure}

```json
{ "contract": "0x…", "function": "balanceOf", "args": ["0xOwner"] }
→ { "success": true, "function": "balanceOf(address)", "outputs": [ { "name": "0", "type": "uint256", "value": "3" } ] }
```

### `POST /contract/send` — 쓰기 (`X-Section-Key` 필요) {#post-contractsend--write-x-section-key-required}

호출자 섹션의 사용자 계정인 `from`이 서명합니다. `value`는 ETH 단위이며 payable 함수에만 사용합니다.

```json
{ "contract": "0x…", "function": "transfer(address,uint256)", "args": ["0xTo", "5"], "from": "0xSectionUser", "value": "0" }
→ { "success": true, "txHash": "0x…", "blockNumber": 123, "gasUsed": 51234, "events": [ { "name": "Transfer", "args": {…} } ] }
```

`function`은 이름 또는 전체 시그니처입니다(이름이 오버로드된 경우 시그니처가 필요합니다). `NftCollection.mint`는
이 방식으로 호출할 수 없습니다(센터만 민팅 가능). `/nft/mint`를 사용하십시오.

---

## 관리 API: 섹션 {#admin-api-sections}

`ADMIN_ALLOWED_IPS`(운영자와 chainlens 호스트)에서 `Authorization: Bearer <ADMIN_TOKEN>`
(Ansible: `state/secrets/proxy_admin_token`)을 사용합니다. 보통 chainlens **Sections** 페이지를 통해
사용합니다. 쓰기는 온체인 SectionRegistry로 전송되며 레지스트리 관리자 키로 서명됩니다.

| 엔드포인트 | 본문 | 동작 |
|---|---|---|
| `GET /admin/sections` | `?fresh=1` (10초 캐시 건너뛰기), `?archived=1` | 모든 섹션, 계정, 잔액, 정보 |
| `GET /admin/sections/:id` | | 섹션 하나 |
| `POST /admin/sections` | `{ "name": "…", "info": {…} }` | 생성: MPC 키 3개(**MPC 노드 3개 모두** 필요), 레지스트리 항목. API 키 `sk_…`는 이 응답에**만** 포함됩니다. 자금 공급 없음 |
| `POST /admin/sections/:id/name` | `{ "name": "Shop A" }` | 이름 변경 |
| `POST /admin/sections/:id/info` | `{ "key": "contact", "value": "…" }` | 정보 필드 설정 (`""`이면 제거) |
| `POST /admin/sections/:id/key` | | 새 API 키. 이전 키는 즉시 중지됩니다 |
| `POST /admin/sections/:id/active` | `{ "active": false }` | 비활성화 / 활성화 (비활성화된 섹션의 호출은 거부됨) |
| `POST /admin/sections/:id/topup` | `{ "amount": "100" }` | SENDER01 → 선지급 |
| `POST /admin/sections/:id/sweep` | `{ "amount": "all" }` | 소비 → 결제 (`"all"` 또는 ETH) |
| `POST /admin/sections/:id/payback` | `{ "amount": "all" }` | 결제 → SENDER01 |
| `POST /admin/sections/:id/account` | `{ "role": "payment" }` | 역할의 계정을 새 MPC 키로 교체. 잔액이 새 계정으로 이동합니다 |
| `POST /admin/sections/:id/archive` | `{ "confirm": "<name>" }` | 모든 자금을 SENDER01로 반환하고 섹션을 영구적으로 종료 (이력은 유지) |
| `GET /admin/sections/:id/accounts` | | 섹션의 사용자 계정 |
| `POST /admin/sections/:id/accounts` | `{ "amount": "5", "pool": "small" }` | 사용자 계정 생성 (`/createaccount`와 동일) |
| `POST /admin/sections/:id/transfer` | `{ "account", "amount", "memo" }` | 사용자 계정에 대한 +x / −x (`/transfer`와 동일) |

모든 자금 이동에는 작업 이름을 담은 메모가 붙습니다.

---

## 관리 API: 닉네임 {#admin-api-nicknames}

위와 같은 관리 토큰. 보통 chainlens **Nicknames** 페이지로 사용합니다. 쓰기는 컨트랙트 계정 센터
(컬렉션의 민터)가 서명합니다.

| 엔드포인트 | 본문 | 동작 |
|---|---|---|
| `GET /admin/nickname` | `?q=` (검색) | 컬렉션, 가격, 보유자 수가 있는 테두리 레벨, 닉네임(최대 200개) |
| `POST /admin/nickname/deploy` | `{ "name", "symbol", "price": "1", "edge0": "Simple", "another": false }` | 컬렉션 배포와 등록; 이미 있으면 `another: true`가 아닌 한 409 |
| `PUT /admin/nickname/price` | `{ "price": "1" }` | 닉네임 가격(새 구매자) |
| `POST /admin/nickname/edges` | `{ "name", "price", "color", "color2", "width", "radius", "pattern" }` | 다음 테두리 레벨 추가 |
| `PUT /admin/nickname/edges/:level` | 위 필드 중 아무것, `enabled` | 레벨 변경; 기존 닉네임도 다시 그려짐. 레벨 0은 가격 0과 활성 상태 유지 |
| `POST /admin/nickname/reserve` | `{ "nicknames": ["admin"], "reserved": true }` | 이름 최대 100개 예약(또는 해제) |

---

## 관리 API: 컨트랙트와 레지스트리 {#admin-api-contracts-and-registry}

| 엔드포인트 | 본문 | 동작 |
|---|---|---|
| `GET /admin/contracts` | | 등록된 컨트랙트 |
| `POST /admin/contracts/check` | `{ "kind": "common" \| "nft", "name", "abi", "bytecode", "deployedBytecode", "args" }` | 시험 실행: 인수, 가스, 배포될 주소. 아무것도 서명하지 않습니다 |
| `POST /admin/contracts/deploy` | 동일 | 컨트랙트 계정 센터로 배포하고, 코드를 비교하고, ABI와 함께 등록 |
| `POST /admin/registry/migrate` | `{ "from": "0xOldRegistry" }` | 버전 1 레지스트리에서 섹션 복사 (Ansible `08-check.yml`이 실행) |

```json
→ { "success": true, "address": "0x…", "txHash": "0x…", "codeCheck": "matches the artifact", "registryTxHash": "0x…" }
```

---

## 상태와 메트릭 {#status-and-metrics}

| 엔드포인트 | 응답 |
|---|---|
| `GET /status/senders` | 송신자별: 다음 논스와 Besu 값 비교, 처리 중인 금액, 논스 공백과 정지, 백그라운드 체인 검사의 수정 내역 |
| `GET /metrics` | Prometheus 형식: 송신자, 섹션, 라우트별 HTTP 요청과 지연 시간, 프로세스, Redis 연결. 선택 사항 `METRICS_TOKEN`(Bearer). [모니터링](../components/monitoring.md)이 수집합니다 |

---

## 오류 {#errors}

| 상태 | 일반적인 원인 |
|---|---|
| 400 | 잘못된 입력: 필드 누락, 잘못된 금액 또는 주소, ABI에 없는 함수, "the transaction would revert: …" |
| 401 | `X-Section-Key is required`, 알 수 없는 섹션 키, 잘못된 관리 토큰 |
| 403 | 계정이 해당 섹션의 사용자가 아님, 비활성화된 섹션, 관리자 주소가 아닌 곳에서의 관리 API 호출 |
| 404 | 알 수 없는 컬렉션, 토큰, 컨트랙트 또는 섹션 |
| 409 | 이미 사용 중인 컬렉션 이름 또는 심볼 |
| 500 / 502 / 503 | 서명기, Besu 또는 레지스트리가 응답하지 않음. 프록시 로그와 [문제 해결](../operations/troubleshooting.md)을 참조하십시오 |
