# 컨트랙트 레코드

> **내용:** 컨트랙트 레지스트리 폴더 `contracts/deployments/`: 배포된 컨트랙트마다 JSON 레코드가 하나씩 있습니다.
>
> **대상:** 운영자, 컨트랙트 개발자.
>
> **관련 문서:** [컨트랙트 배포](contract-deployment.md) · [chainlens](../components/chainlens.md)

**목차**

- [두 가지 등록 방식](#two-kinds-of-registration)
- [레코드의 내용](#what-a-record-holds)
- [레코드 게시](#publish-a-record)
- [컨트랙트 수동 등록](#register-a-contract-by-hand)

---

## 두 가지 등록 방식 {#two-kinds-of-registration}

Chainlens는 컨트랙트의 ABI를 알 때 컨트랙트에 이름과 함수 목록을 부여합니다. ABI는 두 곳에서 얻습니다.

| | 온체인 레지스트리(SectionRegistry) | 레코드 파일(`contracts/deployments/`) |
|---|---|---|
| 작성 주체 | 프록시를 통한 chainlens Deploy 페이지와 `POST /admin/contract/deploy`(`nft-collection`, `nickname-collection` 템플릿 포함)([컨트랙트 배포](contract-deployment.md)) | [`besu-production/operator/deploy-contract.js`](../../besu-production/operator/deploy-contract.js); 이전 버전의 Deploy 페이지 |
| 배포자 | 컨트랙트 계정 센터 | `--from`으로 지정한 MPC 계정 |
| 읽는 주체 | chainlens **및** 프록시(`/contract/call`, `/contract/send`) | chainlens만 |
| 게시 방법 | 필요 없음: 체인에 있습니다 | 파일을 커밋하고 Ansible을 실행합니다([아래](#publish-a-record)) |

애플리케이션이 사용할 컨트랙트는 Deploy 페이지를 사용하는 것이 좋습니다. 레코드 파일만 있는 컨트랙트는
`/contract/call`이나 `/contract/send`로 사용할 수 없습니다. 한 주소에 둘 다 있으면 chainlens는 레코드
파일을 사용합니다.

## 레코드의 내용 {#what-a-record-holds}

컨트랙트마다 파일 하나, `<address>.json`(소문자 주소)이며, `deploy-contract.js`가 작성합니다.

| 필드 | |
|---|---|
| `name`, `address`, `chainId` | chainlens에 표시되는 컨트랙트 이름, 주소, 체인 |
| `deployer`, `txHash`, `blockNumber`, `gasUsed`, `deployedAt` | 배포 정보 |
| `artifact`, `constructorArgs` | 아티팩트 파일 이름과 생성자 인수 |
| `codeHash` | 배포 후 체인상 런타임 코드의 keccak256 |
| `codeCheck` | 그 코드를 아티팩트와 비교한 결과(`matches the artifact`, …) |
| `abi` | 컨트랙트 페이지용 ABI |

이전 버전의 Deploy 페이지가 작성한 레코드는 모니터링 호스트의 `/var/lib/chainlens/deployments`
(`chainlens_local_registry`)에 있습니다. `11-chainlens.yml`이 이를 여기로 다시 복사하고 커밋하도록 안내합니다.

## 레코드 게시 {#publish-a-record}

Chainlens는 이 디렉터리를 `/registry`에 읽기 전용으로 마운트하여 읽습니다
([`chainlens/docker-compose.yml`](../../chainlens/docker-compose.yml) 참조). 등록된 컨트랙트는 탐색기에서
이름이 표시되며, 컨트랙트 페이지에 함수 목록이 나타나고 view/pure 함수를 실행할 수 있습니다
(`eth_call`, 읽기 전용). Chainlens 자체는 서명하지 않습니다. 관리자 페이지는 요청을 프록시로 전달합니다.

새 레코드를 커밋한 다음 Ansible 배포를 다시 실행합니다. 이 디렉터리를 포함한 커밋된 저장소가 호스트로
복사됩니다.

```bash
ansible-playbook 01-hosts.yml
```

(또는 전체 `site.yml`). Chainlens는 재시작 없이 15초 이내에 레코드를 반영합니다.

## 컨트랙트 수동 등록 {#register-a-contract-by-hand}

다른 방법으로 배포한 컨트랙트는 수동으로 등록할 수 있습니다. 최소한 `name`, `address`, `abi`가 포함된
`<address>.json` 파일을 만듭니다. `codeHash`(런타임 코드의 keccak256)를 추가하면 chainlens가 체인상의
코드가 여전히 그 코드인지 확인하며, 그렇지 않으면 컨트랙트 페이지에 경고가 표시됩니다.
