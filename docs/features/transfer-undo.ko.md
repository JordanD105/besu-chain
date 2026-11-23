# 이체 취소

> **내용:** 섹션의 **+x** 또는 **−x** 이체를 취소할 수 있습니다: 7일 안에 한 번, 전액이 돌아갑니다. ETH 이체는
> 체인에서 되돌릴 수 없으므로, 취소는 돈을 돌려보내는 두 번째 이체이며 각 이체를 한 번만 취소하도록 하는 작은
> `TransferUndo` 컨트랙트를 거쳐 보내집니다.
>
> **대상:** 애플리케이션 개발자(`POST /transfer/undo`), 비즈니스 관리자(chainlens의 **취소** 버튼), 운영자(설정, 배포).
>
> **관련 문서:** [프록시 API](../reference/proxy-api.md#post-transferundo--undo-a-transfer) · [섹션](sections.md) ·
> [메모](memos.md) · [섹션 게이트웨이](../components/gateway.md)

**목차**

- [규칙](#rules)
- [작동 방식](#how-it-works)
- [API](#the-api)
- [Chainlens](#chainlens)
- [게이트웨이](#the-gateway)
- [돈과 모니터링](#money-and-monitoring)
- [배포와 설정](#deployment-and-settings)
- [랩 테스트](#lab-test)
- [파일](#files)

---

## 규칙 {#rules}

| 규칙 | |
|---|---|
| **대상** | 섹션의 +x 또는 −x(메모 종류 `transfer.in` / `transfer.out`), 채굴되고 성공한 것 |
| **금액** | 전액만 |
| **횟수** | 한 번: 어느 프록시가 보내든 `TransferUndo` 컨트랙트가 두 번째 취소를 거부 |
| **기한** | 원거래 블록으로부터 `transfer_undo_days`(7)일 안 |
| **누가** | 섹션 키(또는 그 섹션에 대한 관리 API / chainlens) |
| **취소 불가** | 관리 이동(충전, 정산, 반환: 반대 이동으로 바로잡음), 새 계정 충전, 아이템 구매(자체 취소가 있음), 취소 자체 |

| 원거래 | 취소 | 서명 |
|---|---|---|
| **+x**: 사용자 → 소비 | 소비 → 사용자 | 섹션의 소비 계정(아이템 취소와 같음) |
| **−x**: 선지급 → 사용자 | 사용자 → 선지급 | 사용자 계정 |

돌려주는 계정에 금액이 있어야 합니다(없으면 409): 소비 계정이 정산되었거나 사용자가 −x로 받은 돈을 썼을 수 있습니다.

## 작동 방식 {#how-it-works}

```
POST /transfer/undo { txHash }
  프록시: 원거래가 이 섹션의 +x / -x, 채굴됨, 7일 이내, 취소되지 않음(undoneAt == 0)
  프록시 → TransferUndo.undo(original, recipient)  value = 금액, 돌려주는 계정이 서명(MPC)
  컨트랙트: undoneAt[original] == 0 ? 블록 기록, ETH 전달, TransferUndone 이벤트 : revert "already undone"
```

컨트랙트는 호출자가 섹션의 계정인지도 확인하므로(`SectionRegistry.accountKind`) 다른 누구도 이체를 취소된 것으로
표시할 수 없습니다. 취소 트랜잭션에는 `undoOf` = 원거래 해시인 메모 `transfer.undoIn` / `transfer.undoOut`이
붙습니다([메모](memos.md)).

## API {#the-api}

`X-Section-Key`로 `POST /transfer/undo`(관리: `POST /admin/sections/:id/undo`):

```json
POST /transfer/undo  { "txHash": "0x…+x…", "memo": "order 77 cancelled" }
→ { "success": true, "section": { "id": 1, "name": "Shop B" }, "undoOf": "0x…",
    "direction": "consumption -> account", "from": "0xConsumption", "to": "0xUser", "amount": "0.5",
    "txHash": "0x…취소…", "memo": "order 77 cancelled", "memoType": "transfer.undoIn", … }
```

| 오류 | 상태 |
|---|---|
| 이 섹션의 +x / −x가 아님(다른 섹션의 것, 충전, 취소…) | 409 |
| 이미 취소됨(블록과 취소 해시 포함) | 409 |
| `transfer_undo_days`보다 오래됨 | 409 |
| 돌려주는 계정의 잔액 부족 | 409 |
| 없음 또는 아직 채굴 안 됨 | 404 |
| 섹션 키 없음 | 401 |
| 컨트랙트 미배포 | 503 |

+x / −x의 `GET /transfer/:txHash`에는 `undoneBy: { block, txHash }`(또는 `null`)가 추가됩니다.

## Chainlens {#chainlens}

섹션 페이지의 **내역**에 **취소** 열이 있습니다:

| 행 | 표시 |
|---|---|
| 취소 기간 안이고 취소되지 않은 +x / −x | **취소** 버튼(확인을 묻고, 페이지의 **메모** 필드가 함께 감) |
| 취소된 이체 | **취소됨**, 취소 트랜잭션 링크 |
| 취소 트랜잭션 | 원거래 링크 |

트랜잭션 페이지에는 *취소한 트랜잭션* / *취소한 원거래* 링크가 있습니다. 내역에는 이제 −x 취소(사용자 계정이 서명)도
메모로 찾아 함께 나옵니다.

## 게이트웨이 {#the-gateway}

| 모드 | 취소 |
|---|---|
| 온라인 | 프록시로 전달. 임시 해시(오프라인에 만들어 그 뒤 전송된 이체)는 실제 해시로 바꿔 전달 |
| 오프라인, 원거래가 아직 큐에 있음 | 원거래를 **취소**: 체인에 아무것도 가지 않음. `GET /transfer/<그 해시>`는 `failed`("undone before it was sent") |
| 오프라인, 원거래가 이미 전송됨 | 취소를 큐에 넣고 단절 후 전송(컨트랙트가 여전히 한 번만 허용) |
| 오프라인, 게이트웨이가 모르는 이체(다른 곳에서 만든 것) | 503 |

`offline_operations`의 작업 이름은 `transfer_undo`입니다(기본으로 켜짐).

## 돈과 모니터링 {#money-and-monitoring}

| 지표(`proxy_section_operations_total`, `proxy_section_amount_eth_total`) | op |
|---|---|
| +x 취소 | `transfer_in_undo` |
| −x 취소 | `transfer_out_undo` |

Grafana **Sections**: 수입 = +x, 판매, 레벨 업그레이드 **빼기** 취소(이제 `transfer_in_undo` 포함).

## 배포와 설정 {#deployment-and-settings}

| | |
|---|---|
| **컨트랙트** | `TransferUndo`(`proxy/contracts/TransferUndo.sol`, 아티팩트 `proxy/transfer-undo.json`), 컨트랙트 계정 센터가 한 번 배포: `06-proxy.yml`이 수행(`POST /admin/contract/deploy { "template": "transfer-undo" }`; 409 = 이미 있음) |
| `transfer_undo_days` | `7`: 취소 기간(프록시, chainlens, 게이트웨이) |

## 랩 테스트 {#lab-test}

| 테스트 | 결과 |
|---|---|
| 메모를 넣은 +x 0.5, 메모를 넣은 취소 | 사용자 2.5 → 3.0, 소비 −0.5. 메모 `order 77 cancelled`, 기본 문구 `Shop B：撤销付款 0.5 ETH（已退款）`. 원거래에 `undoneBy` |
| 같은 취소 다시; 취소의 취소; 충전의 취소; 키 없이 | 409 *already undone in block …*; 409; 409; 401 |
| −x 0.3, 취소(`ko`) | 사용자 3.3 → 3.0, 선지급 +0.3. `Shop B: 0.3 ETH 지급 취소(반환)` |
| 같은 +x에 대한 동시 취소 두 건 | 하나 완료, 다른 하나는 **컨트랙트가 revert**. 사용자는 0.2를 한 번만 받음 |
| 게이트웨이 온라인 취소 | 완료 |
| 게이트웨이 오프라인: 큐에 있는 +x 취소 | 원거래 취소, 전송 안 됨. 두 번째 취소 409 |
| 게이트웨이 오프라인: 단절 전에 온라인으로 보낸 +x 취소 | 큐에 들어가 단절 후 전송. 사용자는 0.13을 돌려받음. 정정 없음 |
| chainlens 내역 | `undoneBy` / `undoOf` 링크. 메모를 넣어 chainlens에서 취소 |
| 지표 | `transfer_in_undo` 0.9 ETH, `transfer_out_undo` 0.3 ETH |

## 파일 {#files}

| 파일 | 내용 |
|---|---|
| [`proxy/contracts/TransferUndo.sol`](../../proxy/contracts/TransferUndo.sol), `proxy/transfer-undo.json` | 컨트랙트와 컴파일된 아티팩트 |
| [`proxy/stress-latest.js`](../../proxy/stress-latest.js) | `POST /transfer/undo`, `/admin/sections/:id/undo`, 템플릿, `undoneBy` |
| [`gateway/gateway.js`](../../gateway/gateway.js) | 오프라인 취소(원거래 취소 또는 큐) |
| [`chainlens/public/app.js`](../../chainlens/public/app.js) | 취소 열과 링크 |
| [`ansible/06-proxy.yml`](../../ansible/06-proxy.yml) | 컨트랙트를 한 번 배포 |
