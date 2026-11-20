# NFT 워크플로

> **내용:** Solidity에서 NFT 판매까지: Remix에서 컴파일하고, chainlens에서 배포하고, 민팅하고, 구매자를 생성하고, 판매합니다.
>
> **대상:** 컨트랙트 개발자, 비즈니스 관리자.
>
> **관련 문서:** [섹션](sections.md) · [프록시 API](../reference/proxy-api.md) · [chainlens](../components/chainlens.md)

**목차**

- [0. 시작하기 전에](#0-before-you-start)
- [1. Remix에서 컴파일](#1-compile-in-remix)
- [2. chainlens에서 배포](#2-deploy-in-chainlens)
- [3. 민팅](#3-mint)
- [4. 구매자: 섹션의 사용자 계정](#4-a-buyer-a-sections-user-account)
- [5. 판매](#5-sell)
- [6. 확인](#6-check)
- [버전 2 컬렉션](#version-2-collections)
- [오류](#errors)

---

이 가이드는 NFT 컬렉션을 소스 코드에서 최초 판매와 재판매까지 진행합니다.
[`proxy/contracts/NftCollection.sol`](../../proxy/contracts/NftCollection.sol)(버전 3)을 사용합니다. 규칙은
[섹션](sections.md#nft-collections)에 있습니다.

| 단계 | 위치 | 서명 주체 |
|---|---|---|
| 1. 컴파일 | Remix (`http://192.168.68.139:30200`) | 없음 |
| 2. 배포 | chainlens **Deploy** 페이지 (또는 `POST /nft/deploy`) | 컨트랙트 계정 센터 |
| 3. 민팅 | 컬렉션의 chainlens 페이지에서 **Mint**, 또는 `POST /nft/mint` | 컨트랙트 계정 센터 |
| 4. 구매자 | 섹션의 키로 `POST /createaccount`, 또는 chainlens Sections 페이지에서 **Create account** | — (섹션의 선지급 계정에서 자금 공급) |
| 5. 판매 | 컬렉션의 chainlens 페이지에서 **Sell**, 또는 섹션의 키로 `POST /nft/transfer` | 구매자 (재판매의 경우 판매자의 승인 포함) |

아래 주소는 프로덕션 주소입니다(프록시 VIP `192.168.68.151:30000`, chainlens와 Remix는
h139). 2, 3, 5단계는 운영자 머신 또는 `chainlens_deploy_ips`에 있는 PC의 브라우저에서 실행하십시오
([컨트랙트 배포 (chainlens Deploy 페이지)](contract-deployment.md)).

## 0. 시작하기 전에 {#0-before-you-start}

- 섹션이 구성되어 있어야 하며(06 단계에서 SectionRegistry와 컨트랙트 계정 센터를 생성),
  선지급 계정에 자금이 있는 **섹션**이 하나 이상 있어야 합니다(chainlens **Sections**
  페이지 또는 `POST /admin/sections`).
- chainlens 관리 페이지가 켜져 있어야 합니다. 브라우저에서 2단계를 하려면 `chainlens_deploy_enabled: true`가 필요합니다.
  **Mint and sell** 카드는 Deploy 페이지나 Sections 페이지가 켜져 있으면 표시됩니다.
- 생성자 인수인 **SectionRegistry의 주소**가 필요합니다. 이 주소는
  chainlens 대시보드(*Platform* → *Section registry*)에 표시되며, `ansible/state/registry.json`에도 있습니다.
- chainlens 관리 페이지용 **관리 토큰**이 필요합니다(Deploy 페이지에서는 *Deploy
  token*, Mint and sell 카드에서는 *Admin token*이라고 부르지만 같은 토큰입니다). 운영자 머신에서 다음을 실행하십시오.

  ```bash
  cat ansible/state/secrets/chainlens_deploy_token
  ```

## 1. Remix에서 컴파일 {#1-compile-in-remix}

1. `http://192.168.68.139:30200`을 엽니다([Remix IDE (자체 호스팅)](../components/remix.md)).
   `NftCollection.sol`을 생성하고
   [`proxy/contracts/NftCollection.sol`](../../proxy/contracts/NftCollection.sol)의 내용을 붙여넣습니다.
2. **Solidity compiler:** 버전 `0.8.28`, **Advanced configurations → EVM version `cancun`**,
   옵티마이저 켜기(200 runs). 컴파일합니다.
3. **Settings → Generate contract metadata**를 켭니다. Remix가
   `contracts/artifacts/NftCollection.json`(ABI + 바이트코드)을 작성합니다. 이 파일을 마우스 오른쪽 버튼으로 클릭 → **Download**.

   (저장소에 같은 컴파일 결과물이 이미 있으므로 대신 사용할 수 있습니다:
   `proxy/nft-collection-v3.json`.)

먼저 컨트랙트를 시험해 보려면 *Deploy & run → Remix VM (Cancun)*을 사용하십시오. 브라우저 내부 체인이므로
아무것도 브라우저 밖으로 나가지 않습니다.

## 2. chainlens에서 배포 {#2-deploy-in-chainlens}

`http://192.168.68.139:30100/#/deploy`를 여십시오.

1. **Deploy token:** 토큰을 붙여넣습니다.
2. **Compiler artifact:** `NftCollection.json`. 파일에 컨트랙트가 여러 개 있으면 **NftCollection**을 선택합니다.
3. **Constructor arguments:**
   - `name_`은 컬렉션의 이름입니다(`Dragons`).
   - `symbol_`은 컬렉션의 심볼입니다(`DRG`).
   - `registry_`는 SectionRegistry의 주소입니다.
4. **Kind:** *NFT collection*. **Name in the registry:** 선택 사항, 예: `Dragons`.
5. **Check**를 누른 다음 **Deploy**를 누릅니다. 페이지에 새 컨트랙트 링크가 표시됩니다: `#/contracts/0x…`.

컨트랙트 계정 센터가 배포자이므로 컬렉션의 **민터**가 됩니다. 컬렉션은
온체인에 등록되며(종류 NFT), 프록시는 주소, 이름 또는 심볼로 컬렉션을 찾고, 모든
섹션이 컬렉션을 공유합니다. `GET /nft/collections`에 나열됩니다. 종류는 *NFT collection*을 선택하십시오.
*Common contract*로 등록된 컬렉션은 프록시 목록에 나타나지 않으며 주소로만 선택할 수 있습니다.

**또는 curl 사용:** `POST /nft/deploy`는 레지스트리 주소를 채워 같은 컨트랙트(`proxy/nft-collection-v3.json`)를
배포하고 등록합니다. 이름과 심볼은 고유해야 합니다(그렇지 않으면
409).

```bash
curl -s -X POST http://192.168.68.151:30000/nft/deploy -H 'Content-Type: application/json' \
  -d '{"name":"Dragons","symbol":"DRG"}'
```

## 3. 민팅 {#3-mint}

**chainlens에서:** 컬렉션 페이지(`#/contracts/0x…`)에서 **Mint and sell** 카드를 엽니다.
이름, ETH 단위 가격, 이미지 URL을 입력합니다. 설명과 속성(JSON)은 선택 사항입니다.
**Mint**를 클릭합니다. 결과에 새 토큰 ID와 NFT 링크가 표시됩니다.

**또는 curl 사용**(`collection` = 주소, 이름 또는 심볼):

```bash
curl -s -X POST http://192.168.68.151:30000/nft/mint -H 'Content-Type: application/json' \
  -d '{"collection":"DRG","name":"Red dragon","image":"https://example.com/red.png","description":"Level 1","attributes":[{"trait_type":"level","value":"1"}],"amount":"3"}'
```

```
{ "success": true, "tokenId": "1", "contract": "0x…", "version": 3, "owner": "<center>", "price": "3", "tokenURI": "data:application/json;base64,…", "txHash": "0x…", ... }
```

센터는 판매용으로 NFT를 자신에게 민팅합니다. `amount`는 **가격**(ETH)입니다. 가격은 영구 고정되며,
모든 판매(최초 판매와 재판매)가 이 가격으로 이루어집니다. 민팅은 섹션과 연결되지 않으며
아무것도 지불하지 않습니다. 메타데이터는 토큰 URI에 온체인으로 저장됩니다(JSON 최대 48 KB).

## 4. 구매자: 섹션의 사용자 계정 {#4-a-buyer-a-sections-user-account}

구매자는 **섹션의 사용자 계정**이어야 하며 최소한 가격만큼의 잔액이 있어야 합니다.

```bash
curl -s -X POST http://192.168.68.151:30000/createaccount -H 'Content-Type: application/json' \
  -H 'X-Section-Key: sk_…' -d '{"amount":"5"}'
```

```
{ "success": true, "section": {"id": 1, "name": "Shop A"}, "address": "0xBuyer…", ... }
```

계정은 해당 섹션의 선지급 계정에서 자금을 받습니다. 나중에 ETH를 더 주려면
섹션의 키와 음수 금액으로 `POST /transfer`를 사용하십시오(`−x`: 선지급 → 계정,
[섹션](sections.md#application-api-section-calls) 참조). 키가 없으면 chainlens **Sections** 페이지에서
같은 작업을 할 수 있습니다(섹션의 사용자 계정: **Create account**, **Transfer**).

## 5. 판매 {#5-sell}

**chainlens에서:** **Mint and sell** 카드의 **Sell** 아래에 토큰 ID와 구매자를 입력합니다.
구매자 필드는 섹션 사용자 계정을 섹션 및 잔액과 함께 제안합니다. **Sell**을 클릭합니다.

**또는 curl 사용**, 구매자 섹션의 키와 함께:

```bash
curl -s -X POST http://192.168.68.151:30000/nft/transfer -H 'Content-Type: application/json' \
  -H 'X-Section-Key: sk_…' -d '{"collection":"DRG","to":"0xBuyer…","tokenId":"1"}'
```

```
{ "success": true, "section": {"id": 1, "name": "Shop A"}, "sale": "first sale",
  "price": "3", "paidTo": "<Shop A's consumption account>", "txHash": "0x…", "approveTxHash": null, ... }
```

구매자는 원자적인 `buy(tokenId, payee)` 트랜잭션 하나에 서명합니다. 정확히 가격만큼 지불하고
토큰을 받습니다. 어떤 검사라도 실패하면 아무것도 이동하지 않습니다.

- **최초 판매**(센터가 토큰 보유): 대금은 구매자 섹션의
  **소비 계정**으로 갑니다. 컨트랙트 자체가 `payee`가
  활성 섹션의 소비 계정인지 확인합니다(`SectionRegistry.isConsumptionAccount`).
- **재판매**(사용자가 토큰 보유): 새 구매자로 `/nft/transfer`를 다시 호출합니다. 새 구매자는 판매자와
  **같은 섹션**의 사용자여야 합니다. 필요하면 프록시가 판매자의 승인을 보내며
  (`approveTxHash`), 대금은 **판매자**에게 갑니다.

키가 없으면 프록시는 401 `X-Section-Key is required`로 응답합니다. 유일한 예외는 관리
API 호출자입니다. chainlens Sell 양식에는 섹션 키가 필요 없습니다. chainlens가 프록시의
`ADMIN_ALLOWED_IPS`에 있는 주소에서 관리 토큰으로 프록시를 호출하기 때문이며, 이때 섹션은 구매자의 섹션입니다.

## 6. 확인 {#6-check}

- **chainlens:**
  - `#/nfts/<collection>/<tokenId>`에 소유자, 메타데이터, 이미지가 표시됩니다.
  - 구매자의 계정 페이지에 섹션과 NFT가 표시됩니다.
  - **Sections** 페이지에 소비 계정의 잔액이 표시됩니다.
  - 대시보드의 **Section statistics**에 판매가 집계됩니다(*NFT sales*, *Income*).
- **프록시:** `GET /nft/1?collection=DRG`는 토큰, 소유자, 토큰 URI, 메타데이터를 반환하고,
  `GET /nft/owner/0xBuyer…`는 구매자가 보유한 토큰을 나열합니다.
- **Grafana → Sections:** `nft_first_sale` / `nft_resale` 작업과 이동한 ETH.
- **자금:** chainlens **Sections** 페이지에서 소비 계정을 결제 계정으로 스윕하고, SENDER01로
  반환합니다.

## 버전 2 컬렉션 {#version-2-collections}

섹션 도입 이전에 배포된 컬렉션([`NftCollectionV2.sol`](../../proxy/contracts/NftCollectionV2.sol),
SENDER01이 민팅)은 키 없이 계속 동작합니다. `/nft/mint`는 SENDER01에게 민팅하고, `/nft/transfer`는
`buy(tokenId)`로 판매하며, 최초 판매에서는 SENDER01에게, 재판매에서는 판매자에게 대금을 지급합니다. 섹션이 없는
프록시(개발)는 `/nft/deploy`로 버전 2 컬렉션을 배포합니다
([프록시](../components/proxy.md#nft-collections)).

## 오류 {#errors}

| 메시지 | 원인 |
|---|---|
| `X-Section-Key is required: the buyer "to" must be a user account of that section` | 버전 3 컬렉션의 `/nft/transfer`에 `X-Section-Key` 헤더가 없음 (관리 API 호출자도 아님) |
| `unknown section key` | 키가 교체되었거나 섹션이 보관됨 |
| `… is not a user account of a section` | `to`가 `/createaccount`와 섹션 키로 생성되지 않음 |
| `section "…" is disabled` | 구매자의 섹션이 비활성화됨 (Sections 페이지) |
| `… is not an account of section "…"` | 구매자가 키에 해당하는 섹션의 사용자가 아니거나, 다른 섹션으로의 재판매임 |
| `insufficient balance: the price of this token is N ETH` | 구매자의 잔액이 가격보다 적음: 충전하십시오 (`−x` 이체) |
| `the sale would revert: …` | 컨트랙트가 판매를 거부함, 예: `payee is not a section's consumption account` |
| `token not found` / `token is already owned by to` | 잘못된 토큰 ID이거나 구매자가 이미 보유함 |
| `no NFT collection named "…"` | 잘못된 이름 또는 심볼: 주소를 사용하거나 `GET /nft/collections`를 확인하십시오 |
| `"…" matches several collections` | 주소를 사용하십시오 |
| `the collection's minter 0x… is not the contract account center` | 컬렉션이 컨트랙트 계정 센터가 아닌 다른 곳에서 배포됨 |
