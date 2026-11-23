# 프록시 API 레퍼런스

> **내용:** 프록시(`proxy/stress-latest.js`)의 모든 엔드포인트와 요청 본문, 응답입니다.
>
> **대상:** 애플리케이션 개발자 및 운영자.
>
> **관련 문서:** [프록시 구성 요소](../components/proxy.md) · [섹션](../features/sections.md) ·
> [아바타](../features/avatars.md) · [닉네임](../features/nicknames.md) · [용어집](../glossary.md)

**목차**

- [규칙](#conventions)
- [계정과 이체](#accounts-and-transfers)
- [섹션 호출 (`X-Section-Key`)](#section-calls-x-section-key)
- [컨트랙트](#contracts)
- [아바타 컬렉션](#avatar-collections)
- [닉네임](#nicknames)
- [관리 API: 섹션](#admin-api-sections)
- [관리 API: 컨트랙트와 레지스트리](#admin-api-contracts-and-registry)
- [제거된 라우트](#removed-routes)
- [상태와 메트릭](#status-and-metrics)
- [오류](#errors)

---

## 규칙 {#conventions}

![프록시 호출자 세 종류: 키 없음, X-Section-Key, 관리자 토큰](../images/diagrams/api-callers.svg)

| | |
|---|---|
| **기본 URL** | `http://<proxy VIP>:30000` — 프로덕션 `http://192.168.68.151:30000`(활성 프록시). 개발: `http://localhost:30000` |
| **본문** | JSON, 헤더 `Content-Type: application/json` (제한 1 MB) |
| **금액** | ETH를 십진수 문자열로 표기(`"1.5"`), wei는 사용하지 않습니다. 예외: 목록 형태 `args`의 원시 ABI 값([아래](#arguments-a-list-or-an-object)) |
| **주소** | `0x…` (대소문자 무관) |
| **응답** | JSON. 성공: `{ "success": true, … }`. 실패: HTTP 상태 코드와 `{ "error": "…" }` |
| **호출 가능 대상** | 방화벽의 `proxy_client_ips` ([접근 제어](../deployment/access-control.md)). 관리 API는 관리 토큰과 관리자 주소도 필요합니다 |

호출자는 세 종류입니다.

| 호출자 | 헤더 | 사용 가능 범위 |
|---|---|---|
| 섹션이 **없는** 애플리케이션 | 없음 | SENDER01을 쓰는 `/createaccount`와 `/transfer`, 컨트랙트 읽기(`/contract/call`, `/contract/events`, `/contract/list`). `sections_required: true`이면 모두 거부(401) |
| **섹션에 속한** 애플리케이션 | `X-Section-Key: sk_…` | 섹션 호출: 자체 계정, +x / −x 이체, 컨트랙트 읽기와 쓰기(아바타와 닉네임 구매, 레벨 업그레이드, 취소) |
| **운영자 / chainlens** | `Authorization: Bearer <ADMIN_TOKEN>`, `ADMIN_ALLOWED_IPS`에서 호출 | `/admin/*` API, 키 없는 `/contract/send` |

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

**키가 없는 경우:** `{ "from": "0x…", "to": "0x…", "amount": "1", "memo": "optional" }`.
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
| `POST /contract/send` | 섹션의 사용자 계정이 서명하는 컨트랙트 트랜잭션. 모든 아이템 구매와 레벨 업그레이드, 그리고 취소(섹션의 소비 계정이 서명)도 포함 ([아래](#contracts)) |
| `POST /contract/call`, `/contract/events`, `GET /contract/list` | 읽기. 키는 `sections_required: true`일 때만 필요 |

---

## 컨트랙트 {#contracts}

SectionRegistry에 등록된 모든 컨트랙트(컨트랙트 계정 센터가 배포한 것)에 하나의 API를 씁니다.
해당 ABI의 함수와 이벤트만 사용할 수 있습니다. 플랫폼 자체 컨트랙트(아바타 컬렉션과 닉네임
컬렉션)도 같은 호출을 쓰며, 친화적인 값을 사용합니다.

| 엔드포인트 | 동작 | 호출자 |
|---|---|---|
| `POST /contract/call` | 읽기: view / pure 함수(`eth_call`), 한 번에 최대 50개 | 허용된 누구나 (`sections_required: true`이면 섹션 키) |
| `POST /contract/send` | 쓰기: **호출자 섹션의 사용자 계정**이 서명하는 트랜잭션 | `X-Section-Key` 또는 관리 토큰 |
| `POST /contract/events` | 컨트랙트의 이벤트, 필터 적용, 최신순 | `/contract/call`과 동일 |
| `GET /contract/list` | 등록된 컨트랙트 | `/contract/call`과 동일 |
| `POST /admin/contract/send` | **컨트랙트 계정 센터**(플랫폼 컨트랙트의 민터이자 소유자)가 서명하는 쓰기 | 관리 토큰 ([아래](#post-admincontractsend--write-as-the-contract-account-center)) |

`contract`는 컨트랙트 주소입니다. `function`은 이름이며, 이름이 오버로드된 경우 전체 시그니처
(`transfer(address,uint256)`)를 씁니다.

### 인수: 목록 또는 객체 {#arguments-a-list-or-an-object}

| `args` | 의미 | 예 |
|---|---|---|
| **목록** | 순서대로 원시 ABI 값: wei, `bytes3` 16진수, 토큰 ID… | `"args": ["1"]` |
| **객체** | **이름으로** 지정한 값 (ABI의 입력 이름. 앞뒤의 `_`는 무시) | `"args": { "tokenId": "1" }` |
| 생략 | 인수 없음 | |

숫자는 문자열 또는 숫자, 주소는 `0x…`, 불리언은 `true` / `false`, 배열과 튜플은 JSON으로 씁니다.
**플랫폼 컨트랙트**에 객체를 쓰면 값이 **친화적**입니다: ETH 가격, 민팅용 메타데이터([아래 표](#friendly-values-of-the-platform-contracts)). 다른 컨트랙트에서는
객체가 값을 ABI 순서로 놓기만 합니다.

- 빠졌거나 이름이 틀린 값: 400 `args: no value for "level" (quote(uint256,uint8)); given: tokenId`.
- 다른 컨트랙트에서 알 수 없는 이름: 400 `args: unknown name(s) x; f(uint256) takes a, b`.
- 플랫폼 컨트랙트에서 알 수 없는 이름: 400 `args: unknown name(s) name; mint takes image, price, description, attributes`.
- 닉네임은 목록에서도 항상 앞뒤 공백 제거와 NFC 정규화를 거칩니다.

### `POST /contract/call` — 읽기 {#post-contractcall--read}

```json
{ "contract": "0xFaces", "function": "priceOf", "args": { "tokenId": "1" } }
→ { "success": true, "contract": "0xFaces", "function": "priceOf(uint256)",
    "result": { "tokenId": "1", "price": "0.3" },
    "outputs": [ { "name": "0", "type": "uint256", "value": "300000000000000000" } ] }
```

`result`는 친화적인 값, `outputs`는 원시 ABI 값입니다.

**일괄 처리:** `{ "calls": [ { contract, function, args }, … ] }`, 읽기 1~50개, 어떤 컨트랙트든
가능합니다. 각각 따로 응답하거나 실패합니다. 모두 성공했을 때만 `success`가 true입니다.

```json
{ "calls": [
    { "contract": "0xFaces", "function": "ownerOf", "args": { "tokenId": "1" } },
    { "contract": "0xFaces", "function": "ownerOf", "args": ["77"] },
    { "contract": "0xFaces", "function": "name" } ] }
→ { "success": false, "results": [
    { "success": true, "function": "ownerOf(uint256)", "result": { "tokenId": "1", "owner": "0xUser", "sold": true }, "outputs": […], … },
    { "success": false, "status": 400, "error": "call reverted: no such token" },
    { "success": true, "function": "name()", "result": "Faces", "outputs": […], … } ] }
```

### `POST /contract/send` — 쓰기 {#post-contractsend--write}

호출자 섹션의 사용자 계정인 `from`이 서명합니다(취소는 돈을 받은 소비 계정이 서명,
[아래](#undo-signed-by-the-consumption-account)). 블록을 기다립니다. `value`는 ETH이며 payable 함수에만 씁니다.

```json
{ "contract": "0x…", "function": "transfer(address,uint256)", "args": ["0xTo", "5"], "from": "0xUser", "value": "0" }
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "contract": "0x…", "function": "transfer(address,uint256)",
    "from": "0xUser", "value": "0.0", "txHash": "0x…", "blockNumber": 123, "gasUsed": 51234,
    "result": null, "events": [ { "name": "Transfer", "args": {…} } ] }
```

`result`는 플랫폼 컨트랙트의 친화적인 결과(판매, 레벨 업그레이드, 취소…)이며, 다른 컨트랙트에서는 `null`입니다.
`events`는 컨트랙트의 디코딩된 이벤트입니다(원시 값: wei). 채굴되었지만 되돌려진 트랜잭션은 `success: false`와
함께 400으로 응답합니다.

- **호출자:** `X-Section-Key`, 또는 키 없이 `ADMIN_ALLOWED_IPS`에서 관리 토큰(chainlens 방식). 이때 섹션은
  `from`의 섹션(취소의 경우: 돈을 받은 계정의 섹션)이며, 활성 섹션이어야 합니다.
- **Payee:** 이름이 `payee`인 `address` 입력은 생략하면 보내는 계정의 섹션의 **소비** 계정으로 설정됩니다. 다른 주소 → 400.
- **가격:** `buy`와 `upgradeLevel`은 생략한 `value`를 가격으로, `undo`와 `undoLevel`은 환불액으로 채웁니다. 다른 값 → 400.
- **메트릭:** 섹션 작업은 이벤트로 셉니다: `Sold` → `avatar_sale` / `nickname_sale`, `Undone` → `avatar_undo` /
  `nickname_undo`, `LevelUpgraded` → `level_upgrade`, `LevelUndone` → `level_undo`.

| 컨트랙트 | 함수, `args` | 서명 주체 | 채워지는 `value` | 보내기 전 확인 | 이벤트 |
|---|---|---|---|---|---|
| 아바타, 닉네임 | `buy`, `{ tokenId }`; 아바타 `{ imageUrl }`, 닉네임 `{ nickname }` | `from`(구매자) | `priceOf(tokenId)` | 민팅됨(404 `token N is not minted`, `image … is not minted`, `nickname "…" is not minted`); 판매되지 않음(409 `token N is already sold`) | `Sold {tokenId, buyer, price, paidTo}`, `Transfer`, `Locked` |
| 닉네임 | `upgradeLevel`, `{ tokenId, level }` | `from`(소유자) | `quote(tokenId, level)`(단계 가격 합계) | `from`이 소유(403 `token N is not owned by …`); 레벨이 있고 판매 중이며 현재보다 높음(400 `level N: …`) | `LevelUpgraded {tokenId, owner, fromLevel, toLevel, price, paidTo}`, `MetadataUpdate` |
| 아바타, 닉네임 | `undo`, `{ tokenId }`, **`from` 없음** | 돈을 받은 소비 계정 | 환불액: 판매 + 취소되지 않은 레벨 업그레이드 | 판매됨(409 `token N is not sold`); 기간 안(409 `the undo period of token N ended at …`); 키의 섹션이 돈을 받음(403); 소비 계정에 환불액이 있음(409) | `Undone {tokenId, buyer, refunded, by}`, `Transfer` |
| 닉네임 | `undoLevel`, `{ tokenId }`, **`from` 없음** | 돈을 받은 소비 계정 | 가장 최근 업그레이드의 가격 | 취소할 레벨 업그레이드가 있음(409 `token N has no level upgrade to undo`); 그 기간 안(409 `the undo period of the level a -> b upgrade ended at …`); 나머지는 `undo`와 같음 | `LevelUndone {tokenId, owner, fromLevel, toLevel, refunded, by}`, `MetadataUpdate` |

`mint`, `setPrice`, `addLevel`, `setLevel`은 이 방법으로 보낼 수 없습니다(센터만 가능, `not minter`):
[`POST /admin/contract/send`](#post-admincontractsend--write-as-the-contract-account-center)를 사용하십시오.
이전과 승인(`transferFrom`, `approve`, …)은 항상 되돌려집니다: 아이템은 구매자에게 귀속됩니다.

#### 취소: 소비 계정이 서명 {#undo-signed-by-the-consumption-account}

`undo`와 `undoLevel`은 **`from`을 받지 않습니다**. 프록시는 `paymentsOf`를 읽어 돈을 받은 계정(구매자 섹션의 소비
계정)을 찾고 그 계정으로 서명합니다. 그 계정이 같은 트랜잭션에서 환불을 보내고, 컨트랙트가 구매자에게 지불합니다.

```json
{ "contract": "0xFaces", "function": "undo", "args": { "tokenId": "1" } }
→ { "success": true, "section": { "id": 1, "name": "Shop A" }, "function": "undo(uint256)",
    "from": "0xConsumption", "value": "0.4", "txHash": "0x…",
    "result": { "tokenId": "1", "undone": "sale", "buyer": "0xUser", "refunded": "0.4", "by": "0xConsumption" }, "events": [ … ] }
```

| 거부되는 경우 | 상태, 메시지 |
|---|---|
| 판매되지 않았거나 이미 취소됨 | 409 `token N is not sold` |
| 판매의 / 가장 최근 레벨 업그레이드의 보류 기간 이후 | 409 `the undo period of token N ended at <time>` / `the undo period of the level a -> b upgrade ended at <time>` |
| 남은 레벨 업그레이드 없음(`undoLevel`) | 409 `token N has no level upgrade to undo` |
| 다른 섹션의 키 | 403 `token N was paid to section "…": only its key can undo` |
| 소비 계정의 ETH 부족 | 409 `the refund needs X ETH but 0x… (section "…" consumption) has Y ETH` |
| 그 계정이 아닌 `from` | 400 `from: leave it out (an undo is signed by 0x…, the account that was paid)` |
| 돈을 받은 계정이 더 이상 섹션의 계정이 아님 | 409 `token N was paid to 0x…, not a section's account` |

### `POST /contract/events` — 이벤트 {#post-contractevents--events}

```json
{ "contract": "0xFaces", "event": "Transfer", "where": { "to": "0xUser" }, "current": true }
→ { "success": true, "contract": "0xFaces", "event": "Transfer(address,address,uint256)",
    "fromBlock": 37567, "toBlock": 37592, "count": 1, "complete": true,
    "events": [ { "name": "Transfer", "args": { "from": "<center>", "to": "0xUser", "tokenId": "1" },
                  "blockNumber": 37590, "txHash": "0x…", "logIndex": 0, "time": "2026-11-23T12:20:15.000Z" } ] }
```

| 필드 | |
|---|---|
| `event` | 이벤트 이름(또는 시그니처). 틀리면 목록과 함께 400 |
| `where` | `{ arg: value }`. **indexed** 인수는 체인이 필터링하고, 나머지는 프록시가 디코딩 후 필터링 |
| `fromBlock`, `toBlock` | 기본값: 컨트랙트 등록 시점부터 최신 블록까지 |
| `limit` | 기본 100, 최대 1000. 최신 이벤트부터 |
| `current` | 이벤트 `Transfer`와 `where.to`에서만 `true`: 그 주소가 **아직 보유한** 토큰만 남김(토큰당 이벤트 하나) |

`complete: false`는 한도에 도달했다는 뜻으로, 더 오래된 이벤트가 있습니다. 플랫폼 컨트랙트에서 `price`와
`stepPrice`는 ETH입니다(`refunded` 같은 다른 금액은 wei). 계정이 보유한 아이템은 `tokensOf`가 더 간단합니다.

### `GET /contract/list` — 등록된 컨트랙트 {#get-contractlist--registered-contracts}

| 쿼리 | 남기는 것 |
|---|---|
| `?type=avatar` / `nickname` / `contract` | 아바타 컬렉션, 닉네임 컬렉션, 그 밖의 컨트랙트 |
| `?kind=common` / `avatar` | 레지스트리 종류 |
| `?has=upgradeLevel` | 이 함수가 있는 컨트랙트 |
| `?q=face` | 이름에 포함(대소문자 무관) |
| `?functions=1` | 각 컨트랙트의 `functions`(시그니처, mutability)와 `events` 추가 |

```json
→ { "success": true, "contracts": [
    { "address": "0xFaces", "name": "Faces", "type": "avatar", "kind": "avatar", "registeredIn": 14172,
      "symbol": "FACE", "minter": "<contract account center>" },
    { "address": "0xNicknames", "name": "Nicknames", "type": "nickname", "kind": "common", "registeredIn": 35444,
      "symbol": "NICK", "minter": "<contract account center>", "current": true } ],
  "center": "<contract account center>" }
```

오래된 것부터 나열합니다. `current: true`는 사용 중인 닉네임 컬렉션(가장 최근에 등록된 것)을 표시합니다.
현재 버전만 아이템입니다: 아바타 버전 4는 `type: "avatar"`, 닉네임 버전 6은 `type: "nickname"`. 이전 컬렉션(아바타
버전 3, 닉네임 버전 4와 5)은 일반 컨트랙트입니다(`type: "contract"`, 친화적인 값 없음): 새로 배포하십시오.
`center`는 컨트랙트 계정 센터(배포자이자 민터)의 주소입니다.

### 플랫폼 컨트랙트의 친화적인 값 {#friendly-values-of-the-platform-contracts}

아바타와 닉네임 컬렉션은 **아이템**입니다([아바타](../features/avatars.md), [닉네임](../features/nicknames.md)).
객체 `args`는 이 이름만 받습니다(다른 이름: 400 `args: unknown name(s) …; <function> takes …`).
*센터* = `/admin/contract/send`에서만.

**인수**, 두 종류 공통:

| 함수 | `args` |
|---|---|
| `buy` | `{ tokenId }`, 아바타 `{ imageUrl }`, 닉네임 `{ nickname }`(payee와 가격은 채워짐) |
| `undo` | `{ tokenId }`(`from` 없음) |
| `setPrice`(센터) | `{ tokenId, price }`(ETH; 토큰이 판매되기 전까지) |
| `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` | `{ tokenId }` |
| `tokensOf`, `balanceOf` | `{ account }`(또는 `{ owner }`) |
| `holdSeconds`, `totalSupply`, `minter`, `name`, `symbol` | 없음 |

| 종류 | 함수 | `args` |
|---|---|---|
| 아바타 | `mint`(센터) | `{ image, price, description, attributes }`: `image` 필수, `price`는 ETH(기본 0). `name` 없음. 프록시가 체인상 메타데이터 URI를 만듦 |
| 아바타 | `tokenOf` | `{ imageUrl }` |
| 아바타 | `imageOf` | `{ tokenId }` |
| 닉네임 | `mint`(센터) | `{ nickname, price }`(공백 제거, NFC, 1~256자) |
| 닉네임 | `tokenOf` | `{ nickname }`(A–Z 대소문자 무관) |
| 닉네임 | `nicknameOf`, `levelOf`, `undoLevel` | `{ tokenId }` |
| 닉네임 | `upgradeLevel` | `{ tokenId, level }` |
| 닉네임 | `quote` | `{ tokenId, level }` |
| 닉네임 | `levelInfo` | `{ level }` |
| 닉네임 | `addLevel`(센터) | `{ price }`: 다음 레벨의 단계 가격(ETH). 판매 중으로 추가 |
| 닉네임 | `setLevel`(센터) | `{ level, price, forSale }`: 생략한 필드는 값 유지 |

레벨은 단계 가격과 판매 여부만 저장합니다. 레벨 0은 항상 가격 0이며 항상 판매 중입니다.

**결과**(`result`), 가격은 ETH:

| 종류 | 함수 | `result` |
|---|---|---|
| 공통 | `priceOf` | `{ tokenId, price }` |
| 공통 | `ownerOf` | `{ tokenId, owner, sold }` |
| 공통 | `balanceOf` | `{ owner, tokens }` |
| 공통 | `tokenOf` | `{ tokenId, minted, sold, owner, price }`, 또는 `{ tokenId: null, minted: false }` |
| 공통 | `tokensOf` | 아바타 `[ { tokenId, image, price } ]`, 닉네임 `[ { tokenId, nickname, level, price } ]` |
| 공통 | `paymentsOf` | `[ { kind: "sale" \| "level", fromLevel, toLevel, amount, payer, paidTo, paidAt, undoUntil, undone, undoable, current } ]`, 오래된 것부터(`fromLevel`, `toLevel`은 `level`에만; `undoable`: 지금 취소 가능; `current`: 유효한 판매에 속함) |
| 공통 | `mint` | `{ minted: true, tokenId, image, price }` / `{ minted: true, tokenId, nickname, level, price }` |
| 공통 | `setPrice` | `{ tokenId, price }` |
| 공통 | `buy` | 아이템(`tokensOf`와 같음) + `buyer`, `paid`, `paidTo`, `undoUntil` |
| 공통 | `undo` | `{ tokenId, undone: "sale", buyer, refunded, by }` |
| 아바타 | `tokenURI` | `{ tokenId, metadata: { image, description, attributes }, image }` |
| 아바타 | `imageOf` | `{ tokenId, image }` |
| 닉네임 | `tokenURI` | `{ tokenId, metadata: { name, description, attributes: [ { trait_type: "user level", display_type: "number", value } ] } }`(이미지 없음) |
| 닉네임 | `nicknameOf` / `levelOf` | `{ tokenId, nickname }` / `{ tokenId, level }` |
| 닉네임 | `levelCount` | `{ count, levels: [ { level, price, forSale } ] }` |
| 닉네임 | `levelInfo` | `{ level, price, forSale }` |
| 닉네임 | `quote` | `{ tokenId, level, price }`: `level`까지의 단계 가격 합계 |
| 닉네임 | `upgradeLevel` | 닉네임(`tokensOf`와 같음) + `fromLevel`, `paid`, `paidTo`, `undoUntil` |
| 닉네임 | `undoLevel` | `{ tokenId, undone: "level", level, undoneLevel, refunded }`(`level`: 현재 레벨) |
| 닉네임 | `addLevel`, `setLevel` | `{ level: { level, price, forSale } }` |
| 그 밖 | 읽기 | 값 하나, 또는 이름 붙은 값들의 객체. JSON data URI는 디코딩 |

### 컨트랙트 호출의 오류 {#errors-of-the-contract-calls}

| 상태 | 메시지(시작 부분) |
|---|---|
| 400 | `contract: a contract address` |
| 404 | `0x… is not a registered contract` |
| 400 | `function "x" is not in the contract's ABI` / `several functions have this name, give the signature …` |
| 400 | `… changes state: use POST /contract/send` / `… only reads: use POST /contract/call`(아이템의 `transferFrom`, `approve`도: 항상 되돌려짐) |
| 400 | `args: no value for "…" (…); given: …` / `args: unknown name(s) …; mint takes image, price, description, attributes` / `args: a list (raw ABI values) or an object (by name)` |
| 400 | 친화적인 값: `price: ETH, e.g. "0.5"`, `tokenId: a token id (1, 2, …)`, `nickname: 1 to 256 characters …` |
| 404 | `token N is not minted` / `image … is not minted` / `nickname "…" is not minted` / `level: no level 40 (levels 0-3)`(`setLevel`) |
| 409 | `token N is already sold` / `token N is not sold` / `token N has no level upgrade to undo` / `the undo period of … ended at …` / `the refund needs X ETH …` |
| 403 | `token N is not owned by 0x…` / `token N was paid to section "…": only its key can undo` |
| 400 | `call reverted: …`(읽기) / `calls: a list of 1 to 50 reads …` |
| 400 | `event: one of …` / `where: Sold has no argument …` / `current: only with event Transfer and where.to …` |
| 400 | `payee: the consumption account of section "…" (0x…); leave it out to fill it in` |
| 400 | `value: the price is X ETH (leave "value" out to pay it)` / `… is not payable: send no value` |
| 400 | `insufficient balance: X ETH is needed` |
| 400 | `the transaction would revert: …`(서명 전에 컨트랙트의 사유와 함께 거부) |
| 401 | `X-Section-Key is required: …`(키가 없고 관리자 호출자도 아님) |
| 403 | `… is not a user account of a section` / `section "…" is disabled` |

---

## 아바타 컬렉션 {#avatar-collections}

**아바타**는 플랫폼의 이미지 토큰이며 **아이템**입니다
([`AvatarCollection.sol`](../../proxy/contracts/AvatarCollection.sol) 버전 4, [`BoundItems.sol`](../../proxy/contracts/BoundItems.sol) 기반).
컬렉션은 **컨트랙트 계정 센터**(민터)가 배포하고, SectionRegistry에 등록되며(종류 avatar), 모든 섹션이 공유합니다.
센터는 이미지마다 한 번, 아바타가 판매되기 전까지 바꿀 수 있는 가격으로 민팅합니다. 섹션의 사용자 계정이 **한 번**
구매합니다: 가격은 즉시 구매자 섹션의 소비 계정으로 가고, 아바타는 구매자에게 귀속됩니다(재판매 없음, 이전 없음).
보류 기간(`holdDays`, 기본 7일) 안에는 판매를 취소할 수 있습니다.

| 작업 | 호출 |
|---|---|
| 컬렉션 목록 | `GET /contract/list?type=avatar` |
| 배포 | `POST /admin/contract/deploy` `{ "template": "avatar-collection", "name", "symbol", "holdDays" }` |
| 판매용 민팅 | `POST /admin/contract/send` `mint` `{ image, price, description, attributes }` |
| 가격 변경(미판매) | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` |
| 구매 | `POST /contract/send` `buy` `{ tokenId }` 또는 `{ imageUrl }`, `from` = 구매자 |
| 판매 취소 | `POST /contract/send` `undo` `{ tokenId }`, `from` 없음([취소](#undo-signed-by-the-consumption-account)) |
| 계정의 아바타 | `POST /contract/call` `tokensOf` `{ account }` |
| 이미지의 토큰 | `POST /contract/call` `tokenOf` `{ imageUrl }` |
| 토큰 상세 | `POST /contract/call` 일괄: `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` |
| 판매와 취소 | `POST /contract/events` `Sold`, `Undone` |

```bash
P=http://192.168.68.151:30000; T=<admin token>; K=<section key>
# 배포 (이름과 심볼은 아바타 컬렉션 사이에서 대소문자 무관하게 고유, 아니면 409)
curl -s -X POST $P/admin/contract/deploy -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"template":"avatar-collection","name":"Faces","symbol":"FACE","holdDays":7}'
# → { "success": true, "name": "Faces", "kind": "avatar", "address": "0xFaces", "codeCheck": "matches the artifact", … }

# 민팅(센터가 판매용으로 보유)과 가격 변경
curl -s -X POST $P/admin/contract/send -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"mint","args":{"image":"https://img.example/fox.png","price":"0.3","description":"fox"}}'
# → "function": "mint(string,string,uint256)", "result": { "minted": true, "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.3" }
curl -s -X POST $P/admin/contract/send -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"setPrice","args":{"tokenId":"1","price":"0.4"}}'
# → "result": { "tokenId": "1", "price": "0.4" }

# 이미지 URL로 구매(구매자: 키 섹션의 사용자 계정)
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"buy","args":{"imageUrl":"https://img.example/fox.png"},"from":"0xUser"}'
# → "value": "0.4", "result": { "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.4", "buyer": "0xUser",
#     "paid": "0.4", "paidTo": "0xConsumption", "undoUntil": "2026-11-30T17:36:09.250Z" }

# 0xUser가 보유한 것과 토큰 1의 결제
curl -s -X POST $P/contract/call -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"calls":[{"contract":"0xFaces","function":"tokensOf","args":{"account":"0xUser"}},{"contract":"0xFaces","function":"paymentsOf","args":{"tokenId":"1"}}]}'
# → results: [ { "tokenId": "1", "image": "https://img.example/fox.png", "price": "0.4" } ],
#            [ { "kind": "sale", "amount": "0.4", "payer": "0xUser", "paidTo": "0xConsumption", "paidAt": "…",
#                "undoUntil": "2026-11-30T17:36:09.000Z", "undone": false, "undoable": true, "current": true } ]

# 보류 기간 안의 취소: 0xConsumption에서 0xUser로 0.4 환불, 토큰 1은 다시 판매
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xFaces","function":"undo","args":{"tokenId":"1"}}'
# → "from": "0xConsumption", "value": "0.4", "result": { "tokenId": "1", "undone": "sale", "buyer": "0xUser", "refunded": "0.4", "by": "0xConsumption" }
```

토큰 ID는 컬렉션마다 1, 2, 3…입니다. 메타데이터(`image`, `description`, `attributes`; 이름 없음)는 토큰 URI에
체인상으로 저장됩니다(JSON; 블록에 들어가지 않으면 400 `metadata is too large for the chain`). 이미지마다 한 번만
민팅할 수 있습니다(`this image is already minted`). 단계별 안내: [아바타](../features/avatars.md).

**이전 컬렉션:** 버전 3(재판매 있음)은 프록시에게 일반 컨트랙트이고, 버전 2(SENDER01이 민팅)는 **폐기되어** 프록시가
더 이상 읽거나 민팅하거나 판매하지 않습니다. 둘 다 체인에 남습니다.

### 이전 이름 {#old-names}

프록시는 *avatar*로 이름을 바꾸기 전의 이름도 받습니다:

| 이전 이름 | 현재 |
|---|---|
| `?type=nft`, `?kind=nft` | `?type=avatar`, `?kind=avatar` |
| `"kind": "nft"` (deploy, check) | `"kind": "avatar"` (체인에서 종류는 여전히 숫자 2) |
| 템플릿 `nft-collection` | 템플릿 `avatar-collection` |

응답은 항상 새 이름을 씁니다. 이전 컬렉션의 다음 함수는 별칭 없이 사라졌습니다:

| 사라짐 | 현재 |
|---|---|
| 아바타 `approve`(재판매 등록), `buy`를 통한 재판매 | 없음: 아바타는 한 번 구매되고 구매자에게 귀속 |
| 아바타 `mint` `{ name, image, properties, … }` | `mint` `{ image, price, description, attributes }`(이름 없음) |
| 닉네임 `buyNickname` `{ nickname }` | `buy` `{ nickname }` 또는 `{ tokenId }`(민팅된 이름만) |
| 닉네임 `upgradeEdge` `{ level }`, `quote` `{ account, level }` | `upgradeLevel` `{ tokenId, level }`, `quote` `{ tokenId, level }` |
| 닉네임 `addEdge`, `setEdge`, `edgeCount`, `edgeInfo`, `edgeOf` | `addLevel`, `setLevel`, `levelCount`, `levelInfo`, `levelOf` |
| 닉네임 `setNicknamePrice`, `nicknamePrice` | `setPrice` `{ tokenId, price }`, `priceOf`(닉네임마다 자체 가격) |
| 닉네임 `reserve`, `reserved`, `isAvailable`, `idOf` | 없음(센터가 민팅한 이름만 구매 가능); `tokenOf` `{ nickname }` |
| 닉네임 `nicknameOf` `{ account }` | `tokensOf` `{ account }`(계정당 여러 개 가능); `nicknameOf` `{ tokenId }` |
| 템플릿 `nickname-collection`의 `price` | `mint` `{ nickname, price }` |

메트릭 `op` 값도 바뀌었습니다: `nft_first_sale` → `avatar_sale`; `nft_resale`와 `avatar_resale`는 사라짐;
`edge_upgrade` → `level_upgrade`; 새로 추가: `avatar_undo`, `nickname_undo`, `level_undo`. 대시보드는 이전 이름의
이력도 계속 보여 줍니다.

---

## 닉네임 {#nicknames}

**사용자 레벨**이 있는 닉네임 토큰([닉네임](../features/nicknames.md))으로, **닉네임 컬렉션**(버전 6, 아바타처럼
**아이템**)에 있습니다: 센터가 배포한 등록 컨트랙트입니다. `GET /contract/list?type=nickname`(`current: true`인 것)으로
찾습니다. 센터가 이름을 민팅하고, 섹션의 사용자 계정이 하나 또는 여러 개를 각각 한 번 구매하며, 소유자가 레벨을
올립니다. 가격은 ETH입니다.

| 작업 | 호출 | `result` |
|---|---|---|
| 민팅(센터) | `POST /admin/contract/send` `mint` `{ nickname, price }` | `{ minted, tokenId, nickname, level, price }` |
| 가격 변경(센터, 미판매) | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` | `{ tokenId, price }` |
| 레벨 추가 / 변경(센터) | `POST /admin/contract/send` `addLevel` `{ price }` / `setLevel` `{ level, price, forSale }` | `{ level: { level, price, forSale } }` |
| 사용자 레벨 | `POST /contract/call` `levelCount` | `{ count, levels: [ { level, price, forSale } ] }` |
| 이름 찾기 | `POST /contract/call` `tokenOf` `{ nickname }` | `{ tokenId, minted, sold, owner, price }` |
| 계정의 닉네임 | `POST /contract/call` `tokensOf` `{ account }` | `[ { tokenId, nickname, level, price } ]` |
| 레벨 가격 | `POST /contract/call` `quote` `{ tokenId, level }` | `{ tokenId, level, price }` |
| 구매 | `POST /contract/send` `buy` `{ nickname }` 또는 `{ tokenId }`, `from` | 닉네임 + `buyer`, `paid`, `paidTo`, `undoUntil` |
| 사용자 레벨 올리기 | `POST /contract/send` `upgradeLevel` `{ tokenId, level }`, `from` = 소유자 | 닉네임 + `fromLevel`, `paid`, `paidTo`, `undoUntil` |
| 판매 취소 | `POST /contract/send` `undo` `{ tokenId }`, `from` 없음 | `{ tokenId, undone: "sale", buyer, refunded, by }` |
| 가장 최근 레벨 업그레이드 취소 | `POST /contract/send` `undoLevel` `{ tokenId }`, `from` 없음 | `{ tokenId, undone: "level", level, undoneLevel, refunded }` |
| 결제 | `POST /contract/call` `paymentsOf` `{ tokenId }` | 판매와 레벨 업그레이드, `undoUntil`, `undoable` 포함 |

```bash
curl -s -X POST $P/contract/call -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"calls":[{"contract":"0xNicknames","function":"tokenOf","args":{"nickname":"  alice "}},{"contract":"0xNicknames","function":"levelCount"}]}'
# → results: { "tokenId": "1", "minted": true, "sold": false, "owner": "<center>", "price": "1" },
#            { "count": 3, "levels": [ { "level": 0, "price": "0", "forSale": true }, { "level": 1, "price": "0.5", "forSale": true }, … ] }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"buy","args":{"nickname":"alice"},"from":"0xUser"}'
# → "value": "1.0", "result": { "tokenId": "1", "nickname": "Alice", "level": 0, "price": "1", "buyer": "0xUser", "paid": "1",
#     "paidTo": "0xConsumption", "undoUntil": "…" }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"upgradeLevel","args":{"tokenId":"1","level":2},"from":"0xUser"}'
# → "value": "1.5", "result": { "tokenId": "1", "nickname": "Alice", "level": 2, "price": "1", "fromLevel": 0, "paid": "1.5", … }
curl -s -X POST $P/contract/send -H "X-Section-Key: $K" -H 'Content-Type: application/json' \
  -d '{"contract":"0xNicknames","function":"undoLevel","args":{"tokenId":"1"}}'
# → "from": "0xConsumption", "value": "1.5", "result": { "tokenId": "1", "undone": "level", "level": 0, "undoneLevel": 2, "refunded": "1.5" }
```

이름: NFC와 공백 제거 후 1~256자, 제어 문자와 `< > & " ' \` 없음, A–Z 대소문자 무관하게 고유, 민팅된 이름만 구매 가능,
계정당 여러 개. 레벨은 취소할 때를 빼면 올라가기만 합니다: `undo`는 판매와 취소되지 않은 레벨 업그레이드를 환불하고
레벨을 0으로 만듭니다. `undoLevel`은 가장 최근 업그레이드 하나만 그 자신의 보류 기간 안에 취소하고 그 가격만 환불합니다.

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

## 관리 API: 컨트랙트와 레지스트리 {#admin-api-contracts-and-registry}

위와 같은 관리 토큰.

| 엔드포인트 | 본문 | 동작 |
|---|---|---|
| `POST /admin/contract/check` | 템플릿, 또는 `{ "kind": "common" \| "avatar", "name", "abi", "bytecode", "deployedBytecode", "immutableReferences", "args" }` | 시험 실행: 인수, 가스, 배포될 주소. 아무것도 서명하지 않습니다 |
| `POST /admin/contract/deploy` | 동일 | 컨트랙트 계정 센터로 배포하고, 코드를 비교하고, ABI와 함께 등록 |
| `POST /admin/contract/send` | `{ "contract", "function", "args", "value" }` | 컨트랙트 계정 센터가 서명하는 쓰기 ([아래](#post-admincontractsend--write-as-the-contract-account-center)) |
| `POST /admin/registry/migrate` | `{ "from": "0xOldRegistry" }` | 버전 1 레지스트리에서 섹션 복사 (Ansible `08-check.yml`이 실행) |

```json
→ { "success": true, "name": "Faces", "kind": "avatar", "address": "0x…", "deployer": "<center>", "txHash": "0x…",
    "blockNumber": 37570, "gasUsed": 1408380, "codeCheck": "matches the artifact", "registryTxHash": "0x…" }
```

### 템플릿 {#templates}

플랫폼 자체 컨트랙트는 프록시 이미지에 컴파일되어 들어 있습니다. `check`와 `deploy`는 `abi`와
`bytecode` 대신 템플릿을 받으며, 레지스트리 주소는 자동으로 채워집니다.

| 템플릿 | 본문 | 등록 종류 |
|---|---|---|
| `avatar-collection` | `{ "template": "avatar-collection", "name": "Faces", "symbol": "FACE", "holdDays": 7 }` (`name`과 `symbol` 필수). 이름과 심볼은 아바타 컬렉션 사이에서 대소문자 무관하게 고유: 아니면 409 | 종류 avatar |
| `nickname-collection` | `{ "template": "nickname-collection", "name": "Nicknames", "symbol": "NICK", "holdDays": 7, "another": false }` (이 값들이 기본값). 가격 없음: 닉네임마다 민팅할 때 가격을 정함 | common |

`holdDays`는 판매(와 닉네임 레벨 업그레이드)의 취소 기간입니다: 기본 7, 0~365, 소수 허용(테스트용 `0.0025` = 216초).
아니면 400 `holdDays: 0 to 365 (default 7)`. 배포할 때 고정됩니다(컨트랙트의 `holdSeconds`).

두 번째 버전 6 닉네임 컬렉션은 `"another": true`가 아니면 거부됩니다(409 `a nickname collection exists at 0x… (send "another": true …)`).
`another: true`이면 그때부터 새 컬렉션이 사용됩니다. 알 수 없는 템플릿: 400
`template: avatar-collection or nickname-collection (or no template: abi and bytecode)`.

### `POST /admin/contract/send` — 컨트랙트 계정 센터로 쓰기 {#post-admincontractsend--write-as-the-contract-account-center}

`/contract/send`와 같은 본문이며 `from`이 없습니다: 컨트랙트 계정 센터(플랫폼 컨트랙트의 민터이자
소유자)가 서명합니다. 모든 등록 컨트랙트에 쓸 수 있으며, 친화적인 `args`와 `result`는
[표](#friendly-values-of-the-platform-contracts)와 같습니다.

| 함수 | `args` |
|---|---|
| `mint` (아바타) | `{ "image", "price": "0.5", "description", "attributes" }` (메타데이터 URI는 프록시가 만듦) |
| `mint` (닉네임) | `{ "nickname", "price": "1" }` |
| `setPrice` | `{ "tokenId", "price" }`: 토큰이 판매되기 전까지 |
| `addLevel` | `{ "price": "1" }`: 다음 사용자 레벨의 단계 가격. 판매 중으로 추가 |
| `setLevel` | `{ "level": 3, "price": "2", "forSale": false }`: 생략한 필드는 그대로. 레벨 0은 가격 0과 판매 중 상태 유지 |

```json
{ "contract": "0xNicknames", "function": "setLevel", "args": { "level": 3, "forSale": false } }
→ { "success": true, "function": "setLevel(uint8,uint256,bool)", "from": "<center>",
    "txHash": "0x…", "result": { "level": { "level": 3, "price": "2", "forSale": false } },
    "events": [ { "name": "LevelSet", "args": { "level": "3", "stepPrice": "2000000000000000000", "forSale": false } } ] }
```

센터는 구매, 업그레이드, 취소를 하지 않습니다: 이것들은 [`/contract/send`](#post-contractsend--write)를 사용합니다.

revert는 400으로 응답합니다(서명 전 `the transaction would revert: …`, 서명 후 `reverted in block N`).

---

## 제거된 라우트 {#removed-routes}

이 라우트는 **410**으로 응답하며, 메시지가 대체 호출을 알려 줍니다. `0xFaces`와
`0xNicknames`는 `GET /contract/list`의 컨트랙트 주소입니다.

| 제거됨 | 대신 사용 |
|---|---|
| `POST /nft/deploy` | `POST /admin/contract/deploy` `{ "template": "avatar-collection", "name", "symbol" }` |
| `POST /nft/mint` | `POST /admin/contract/send` `mint` `{ image, price }` |
| `POST /nft/transfer` | `POST /contract/send` `buy` `{ tokenId }`, `from` = 구매자 (아바타는 한 번 구매되며 재판매되지 않음). 버전 2 컬렉션은 폐기됨 |
| `GET /nft/contract`, `GET /nft/collections` | `GET /contract/list?type=avatar` |
| `GET /nft/owner/:address` | `POST /contract/call` `tokensOf` `{ account }` |
| `GET /nft/:tokenId/metadata` | `POST /contract/call` `tokenURI` `{ tokenId }` (`result.metadata`) |
| `GET /nft/:tokenId` | `POST /contract/call` 일괄 `ownerOf`, `priceOf`, `tokenURI`, `paymentsOf` |
| `GET /nickname/edges` | `POST /contract/call` `levelCount` (`result.levels`). 컬렉션: `GET /contract/list?type=nickname` |
| `GET /nickname/check` | `POST /contract/call` `tokenOf` `{ nickname }` |
| `GET /nickname/of/:account` | `POST /contract/call` `tokensOf` `{ account }` |
| `GET /nickname/quote` | `POST /contract/call` `quote` `{ tokenId, level }` |
| `POST /nickname/buy` | `POST /contract/send` `buy` `{ nickname }`, `from` |
| `POST /nickname/edge` | `POST /contract/send` `upgradeLevel` `{ tokenId, level }`, `from` |
| `POST /admin/nickname/deploy` | `POST /admin/contract/deploy` `{ "template": "nickname-collection", "name", "symbol" }` |
| `PUT /admin/nickname/price` | `POST /admin/contract/send` `setPrice` `{ tokenId, price }` (닉네임마다 자체 가격) |
| `POST /admin/nickname/edges` | `POST /admin/contract/send` `addLevel` `{ price }` |
| `PUT /admin/nickname/edges/:level` | `POST /admin/contract/send` `setLevel` `{ level, price, forSale }` |
| `POST /admin/nickname/reserve` | 없음: 예약 이름은 사라짐(센터가 민팅한 이름만 구매 가능) |
| `GET /admin/contracts` | `GET /contract/list` (`center`: 컨트랙트 계정 센터) |
| `POST /admin/contracts/check` | `POST /admin/contract/check` (같은 본문) |
| `POST /admin/contracts/deploy` | `POST /admin/contract/deploy` (같은 본문) |
| `GET /admin/nickname` | `GET /contract/list?type=nickname` (컬렉션), `POST /contract/call` (`levelCount`, `totalSupply`, `tokensOf`), `POST /contract/events` (`Sold`, `Undone`, `LevelUpgraded`, `LevelUndone`) |

```json
GET /nft/collections
→ 410 { "error": "GET /nft/collections was removed: use GET /contract/list?type=avatar" }
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
| 400 | 잘못된 입력: 필드 누락, 잘못된 금액 또는 주소, ABI에 없는 함수, 빠진 `args` 값, "the transaction would revert: …" |
| 401 | `X-Section-Key is required`, 알 수 없는 섹션 키, 잘못된 관리 토큰 |
| 403 | 계정이 해당 섹션의 사용자가 아님, 비활성화된 섹션, 토큰의 소유자가 아님, 다른 섹션의 키로 취소, 관리자 주소가 아닌 곳에서의 관리 API 호출 |
| 404 | 알 수 없는 컨트랙트, 토큰, 이미지, 닉네임, 사용자 레벨 또는 섹션 |
| 409 | 이미 사용 중인 컬렉션 이름 또는 심볼. 이미 판매되었거나(구매) 판매되지 않은(취소) 토큰. 끝난 취소 기간. 환불을 지불할 수 없는 소비 계정. 이미 있는 닉네임 컬렉션 |
| 410 | 제거된 라우트 ([위](#removed-routes)) |
| 500 / 502 / 503 / 504 | 서명기, Besu 또는 레지스트리가 응답하지 않거나 트랜잭션이 제때 채굴되지 않음. 프록시 로그와 [문제 해결](../operations/troubleshooting.md)을 참조하십시오 |
