# 닉네임

> **내용:** 닉네임 토큰: 사용자 계정이 닉네임 하나를 구매하고, 추가로 결제해 **테두리(edge)**(닉네임을 둘러싼 프레임)를 올립니다.
>
> **대상:** 애플리케이션 개발자, 비즈니스 관리자.
>
> **관련 문서:** [섹션](sections.md) · [NFT 워크플로](nft-workflow.md) · [프록시 API](../reference/proxy-api.md#nicknames) · [chainlens](../components/chainlens.md)

**목차**

- [규칙](#rules)
- [동작 방식](#how-it-works)
- [테두리 레벨과 스타일](#edge-levels-and-styles)
- [1. 컬렉션 배포](#1-deploy-the-collection)
- [2. 테두리 레벨](#2-edge-levels)
- [3. 닉네임 구매](#3-buy-a-nickname)
- [4. 테두리 올리기](#4-raise-the-edge)
- [자금과 모니터링](#money-and-monitoring)
- [오류](#errors)
- [파일](#files)

---

토큰은 두 종류입니다. **이미지 토큰**은 [NFT 워크플로](nft-workflow.md)의 NFT 컬렉션(버전 3)으로,
센터가 민팅한 그림을 판매하고 재판매합니다. **닉네임 토큰**은 이 문서의 대상으로, 사용자가 자신을
위해 구매하는 이름이며 다시 판매할 수 없습니다.

![테두리 레벨 Simple, Silver, Gold, Diamond의 닉네임](../images/screenshots/nickname-examples.png)

## 규칙 {#rules}

| 규칙 | 지키는 방법 |
|---|---|
| **1~256자** | 프록시가 유니코드 NFC 정규화와 양 끝 공백 제거 후 글자 수를 셉니다. 컨트랙트는 1~1024바이트를 받습니다 |
| **허용되지 않음:** 제어 문자와 `< > & " ' \` | 프록시와 컨트랙트(그림이 체인 위의 SVG이므로) |
| **고유, 대소문자 구분 없음** | 토큰 ID는 A–Z를 소문자로 바꾼 이름의 `keccak256`이므로 `Alice`, `alice`, `ALICE`는 하나의 닉네임입니다. 다른 문자(한글, 키릴 문자 등)는 NFC 후 정확히 비교합니다 |
| **계정당 닉네임 하나** | 컨트랙트의 `nicknameOf(account)`; 두 번째 구매는 거부됩니다 |
| **첫 구매자에게 귀속** | 소울바운드(ERC-5192: `locked()`가 true). `transferFrom`, `safeTransferFrom`, `approve`, `setApprovalForAll`은 항상 되돌려집니다(revert) |
| **테두리는 올라가기만 함** | `upgradeEdge`는 현재보다 높은 레벨만 받습니다. 낮추기와 만료는 없습니다 |
| **섹션의 사용자 계정이 구매** | 구매자는 사용자 계정(레지스트리 종류 1)이어야 하고, 돈은 **자기 섹션의 소비(consumption) 계정**으로 갑니다. 둘 다 컨트랙트가 SectionRegistry로 확인합니다 |

## 동작 방식 {#how-it-works}

1. 애플리케이션이 섹션 키로 `POST /nickname/buy {account, nickname}`을 호출합니다.
2. 프록시가 이름을 정규화(NFC, 공백 제거)하고 1~256자인지, 사용 가능한지 확인합니다.
3. MPC 서명기가 **사용자 계정으로** `buyNickname(nickname, consumption)`에 서명하며, 닉네임 가격을
   값으로 보냅니다.
4. 컨트랙트가 SectionRegistry에 묻습니다: 구매자가 사용자 계정인가, 수취인이 그 섹션의 소비 계정인가?
   그다음 토큰을 민팅하고 가격을 전달합니다.
5. 이후 `POST /nickname/edge {account, level}`이 견적 가격으로 `upgradeEdge(level, consumption)`을
   보내면 테두리가 올라가고 그림이 다시 그려집니다.

- 컬렉션은 **컨트랙트 계정 센터**가 배포하고 SectionRegistry에 공통(common) 컨트랙트로 등록됩니다.
  프록시는 `buyNickname`이 있는 등록 컨트랙트 중 **가장 최근** 것을 사용합니다.
- 그림(`tokenURI`)은 **체인 위에서** 만들어집니다: JSON과 SVG, base64. 매번 테두리 레벨의 스타일을
  읽으므로 스타일을 수정하면 그 레벨의 모든 닉네임이 다시 그려집니다(지갑과 탐색기를 위해 ERC-4906
  `BatchMetadataUpdate`를 발생시킵니다).
- 긴 이름은 공백에서 줄바꿈되고, 길이에 따라 글꼴이 작아집니다(56, 36, 28 px). 넓은 문자(한글, 중국어,
  일본어, 이모지)는 폭을 반 단위 두 개로 셉니다.

## 테두리 레벨과 스타일 {#edge-levels-and-styles}

레벨 0은 모든 닉네임이 시작하는 기본 테두리입니다. 가격은 항상 0이고 끌 수 없습니다. 다음 레벨마다
**단계 가격**이 있습니다. 레벨 *a*에서 *b*로 올리면 레벨 *a+1 … b*의 단계 가격 합계를 냅니다
(`quote(account, level)`). 그래서 레벨을 건너뛰어도 차례로 올리는 것과 비용이 같습니다.

| 스타일 필드 | 값 |
|---|---|
| `color`, `color2` | `#rrggbb` (`color2`는 `double`, `gradient`, `glow`에서 사용) |
| `width` | 1~20 (픽셀) |
| `radius` | 0~40 (모서리 반경) |
| `pattern` | `solid`, `double`, `dashed`, `gradient`, `glow` |

레벨을 **판매 중지**(`enabled: false`)할 수 있습니다. 그러면 누구도 그 레벨로(또는 그 너머로) 올릴 수
없고, 이미 그 레벨인 닉네임은 그대로 유지됩니다.

## 1. 컬렉션 배포 {#1-deploy-the-collection}

한 번만, chainlens **Nicknames**(`#/nicknames`, `chainlens_sections_enabled: true`일 때 표시)에서
이름, 심볼, 닉네임 가격, 기본 테두리 이름을 입력하고 **Deploy**를 누릅니다. 또는 관리 API로:

```bash
T=$(cat ansible/state/secrets/proxy_admin_token)
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST \
  --data '{"name":"Nicknames","symbol":"NICK","price":"1","edge0":"Simple"}' \
  http://<proxy>:30000/admin/nickname/deploy
```

본문에 `"another": true`가 없으면 두 번째 배포는 거부됩니다(409). 있으면 그때부터 새 컬렉션이 사용되고,
이전 컬렉션은 체인에서 계속 읽을 수 있습니다.

![chainlens Nicknames 페이지: 가격, 미리보기가 있는 테두리 레벨, 예약된 닉네임, 목록](../images/screenshots/chainlens-nicknames.png)

## 2. 테두리 레벨 {#2-edge-levels}

Nicknames 페이지에서 레벨마다 실시간 미리보기가 있는 편집기가 있고, **Add level**로 다음 레벨을
추가합니다. API로:

```bash
curl -s -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -X POST \
  --data '{"name":"Gold","price":"1","color":"#f59e0b","color2":"#fde68a","width":6,"radius":20,"pattern":"gradient"}' \
  http://<proxy>:30000/admin/nickname/edges
```

이 페이지에서 닉네임 가격(새 구매자에게만 적용)도 바꾸고, 누구도 살 수 없는 이름(예: `admin`)을
**예약**합니다.

## 3. 닉네임 구매 {#3-buy-a-nickname}

애플리케이션은 섹션 키로 호출합니다. `account`는 그 섹션의 사용자 계정이며 가격만큼의 ETH가 있어야
합니다(이 체인에서 가스는 무료).

```bash
K=sk_…   # 섹션의 API 키
curl -s -H "X-Section-Key: $K" "http://<proxy>:30000/nickname/check?name=Alice"
# { "nickname": "Alice", "characters": 5, "available": true, "reason": null, … }
curl -s -H "X-Section-Key: $K" -H 'Content-Type: application/json' -X POST \
  --data '{"account":"0xUser","nickname":"Alice"}' http://<proxy>:30000/nickname/buy
# { "success": true, "nickname": "Alice", "level": 0, "edge": "Simple", "price": "1", "paidTo": "0xConsumption", "txHash": "0x…", "image": "data:image/svg+xml;base64,…" }
```

`GET /nickname/of/0xUser`로 언제든 계정의 닉네임, 레벨, 그림을 얻습니다.

## 4. 테두리 올리기 {#4-raise-the-edge}

```bash
curl -s -H "X-Section-Key: $K" "http://<proxy>:30000/nickname/quote?account=0xUser&level=2"
# { "account": "0xUser", "level": 2, "price": "1.5" }
curl -s -H "X-Section-Key: $K" -H 'Content-Type: application/json' -X POST \
  --data '{"account":"0xUser","level":2}' http://<proxy>:30000/nickname/edge
```

응답에 새 레벨과 그림이 있습니다. 같거나 낮은 레벨, 없거나 판매 중지된 레벨, 부족한 ETH는 거부됩니다.

## 자금과 모니터링 {#money-and-monitoring}

| 작업 | 보내는 곳 → 받는 곳 | 섹션 작업(메트릭) |
|---|---|---|
| 구매 | 사용자 계정 → 그 섹션의 **소비** 계정(닉네임 가격) | `nickname_sale` |
| 테두리 올리기 | 사용자 계정 → 그 섹션의 **소비** 계정(단계 가격 합계) | `edge_upgrade` |

둘 다 섹션의 **수입**으로 집계됩니다: chainlens 섹션 통계와 Grafana **Sections** 대시보드(All-sections
표의 **Nicknames**, **Edge upgrades** 열). 소비 계정의 돈은 평소처럼 스윕과 반환으로 이어집니다
([섹션](sections.md)).

## 오류 {#errors}

| 상태 | 메시지(시작 부분) | 원인 |
|---|---|---|
| 400 | `nickname: 1 to 256 characters` | 공백 제거 후 비었거나 너무 김 |
| 400 | `nickname: no control characters and none of …` | 금지된 문자 |
| 401 | `X-Section-Key is required` | 키 없음 |
| 403 | `… is not a user account of a section` | `account`가 역할 계정이거나 알 수 없음 |
| 403 | `section "…" is disabled` | 섹션이 꺼져 있음 |
| 404 | `… has no nickname: buy one first` | 구매 전에 테두리 올리기 |
| 409 | `… already has a nickname (one per account)` | 두 번째 구매 |
| 409 | `nickname "…" is taken` / `is reserved` | 다른 계정이 보유(대소문자 무관)하거나 예약됨 |
| 400 | `insufficient funds` / 컨트랙트 사유 | ETH 부족; 레벨이 현재보다 높지 않거나, 없거나, 판매 중지됨 |
| 503 | `no nickname collection yet` | 먼저 배포하세요 |

## 파일 {#files}

| 파일 | 내용 |
|---|---|
| `proxy/contracts/NicknameCollection.sol` | 컨트랙트(ERC-721 + ERC-5192 + ERC-4906, 체인 위 SVG) |
| `proxy/nickname-collection.json` | 컴파일된 아티팩트(`node scripts/compile-contract.js contracts/NicknameCollection.sol NicknameCollection nickname-collection.json`) |
| `proxy/stress-latest.js` | `/nickname/*`와 `/admin/nickname/*` 라우트 |
| `chainlens/public/app.js` | Nicknames 페이지(`showNicknames`, `edgeEditor`, `edgePreview`) |
| `monitoring/grafana/tools/gen_sections_dashboard.py` | Sections 대시보드의 수입과 새 열 |
