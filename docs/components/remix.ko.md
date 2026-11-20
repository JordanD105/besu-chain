# Remix IDE (자체 호스팅)

> **내용:** 로컬 Solidity 컴파일러 미러를 포함한 자체 호스팅 Remix IDE와, 이 체인에서 사용하는 방법입니다.
>
> **대상:** 컨트랙트 개발자, 운영자.
>
> **관련 문서:** [컨트랙트 배포](../features/contract-deployment.md) · [NFT 워크플로](../features/nft-workflow.md) · [접근 제어](../deployment/access-control.md)

---

[Remix](https://remix.ethereum.org)는 모니터링 호스트의 `http://<monitoring host>:30200`에서 제공되며,
브라우저에서 컨트랙트를 작성, 컴파일, 테스트하는 데 사용합니다. 사용 시점에 인터넷에서 아무것도
다운로드하지 않습니다. 컴파일러는 이미지 내부의 미러에서 제공됩니다.

| | |
|---|---|
| Remix | `github.com/remix-project-org/remix-live`(브랜치 `gh-pages`, remix.ethereum.org가 제공하는 것)의 사전 빌드된 사이트로, 커밋으로 고정됩니다: `ansible/group_vars/all/settings.yml`의 `remix_commit` (Remix 2.6.15) |
| 컴파일러 | `remix_solc_versions`(기본값 `0.8.28`)와 Remix가 기본으로 선택하는 버전(2.6.15에서는 0.8.34). npm 패키지 `solc`(공식 Emscripten 빌드)에서 가져오며, binaries.soliditylang.org와 같은 형식의 `list.json`과 함께 `/solc-bin/`에서 제공됩니다 |
| 서버 | `serve.js`: `node:22-alpine`(프록시와 chainlens가 이미 사용하는 베이스 이미지) 기반의 작은 정적 서버, 포트 30200, gzip, 의존성 없음 |
| 접근 | 운영자(`operator_ip`)와 `remix_ips`. 그 외에는 모두 방화벽으로 차단됩니다 |

## 배포 {#deployment}

`remix_enabled: true`(기본값)이면 Ansible이 모든 작업을 수행합니다.

- `02-images.yml`은 운영자 머신에서 고정된 Remix 사이트를 **커밋당 한 번** 가져오고(`git fetch
  --depth 1`, 약 400 MB, `state/build/remix/remix-live`에 저장; 이를 위해 운영자 머신은 github.com에
  접근할 수 있어야 합니다) `localhost/besu-remix/remix`를 빌드합니다. 다른 이미지와 마찬가지로 한 번
  빌드하여 호스트로 복사하며, `save-images.yml`은 이를 `remix-docker.tar`로 저장합니다.
- `12-remix.yml`은 모니터링 호스트에서 이를 시작하고 컴파일러 목록을 확인합니다.
- `ha/firewall-layout.sh`는 모니터링 호스트의 포트 30200을 `operator_ip`와 `remix_ips`에 개방합니다.

컴파일러를 추가하려면 `remix_solc_versions`(예: `["0.8.24", "0.8.28"]`)를 변경하고
`ansible-playbook 02-images.yml 12-remix.yml`을 실행합니다. Remix를 업데이트하려면 `remix_commit`을
`remix-live`의 최신 커밋(커밋 메시지에 Remix 버전이 적혀 있습니다)으로 설정하고 같은 명령을 실행합니다.
끄려면 `remix_enabled: false`로 설정합니다.

인터넷에 접근할 수 있는 호스트에서 수동으로 하는 방법:

```bash
git clone --depth 1 https://github.com/remix-project-org/remix-live.git remix/remix-live
```

```bash
cd remix && SOLC_VERSIONS="0.8.28" docker compose build && docker compose up -d
```

## 이 체인에서 사용하기 {#using-it-with-this-chain}

1. **컴파일러:** 미러된 버전(`0.8.28`)을 선택합니다. **Solidity compiler → Advanced configurations →
   EVM version: `cancun`.** Remix 2.6.15의 기본값은 `osaka`입니다. 이 체인(및 여기서 사용하는 Besu 버전)에는
   Prague/Osaka 옵코드가 없으므로, 이를 대상으로 컴파일한 코드는 체인에서 실패할 수 있습니다. 배포용
   빌드에서는 옵티마이저를 켜십시오(200 runs).
2. *Deploy & run → Remix VM (Cancun)*에서 **테스트**합니다. 브라우저 내 체인이므로 어떤 데이터도
   브라우저 밖으로 나가지 않습니다.
3. **아티팩트 내보내기:** *Settings → Generate contract metadata*가 켜져 있으면 Remix는
   `contracts/artifacts/<Name>.json`(ABI + 바이트코드)을 작성합니다. 소스와 함께 다운로드하십시오.
4. chainlens **Deploy** 페이지에서 **운영 환경에 배포**합니다
   ([컨트랙트 배포(chainlens Deploy 페이지)](../features/contract-deployment.md)). 컨트랙트 계정 센터가
   서명하고 체인에 등록되므로, chainlens와 애플리케이션(`/contract/call`, `/contract/send`)이 즉시
   사용할 수 있습니다. NFT 컬렉션의 경우 판매까지의 전체 과정은 [NFT 워크플로](../features/nft-workflow.md)에
   있습니다. 다른 방법은 운영자 머신에서 `besu-production/operator/deploy-contract.js`를 사용하는 것입니다
   ([Besu 운영 패키지(수동 설정)](../deployment/besu-manual.md#deploying-a-contract)). 이 방법은 MPC 계정으로
   서명하며, `contracts/deployments/`에 레코드를 작성합니다([컨트랙트 레코드](../features/contract-records.md)).
   이 레코드로 chainlens에서 컨트랙트를 조회할 수 있지만, 온체인 레지스트리에는 등록되지 않습니다.

Remix 자체는 운영 체인에 연결하지 않으며 키를 보관하지 않습니다. Remix의 *Deploy & run*이 아니라
위의 두 방법 중 하나로 배포하십시오.

Remix는 각 사용자의 브라우저(IndexedDB)에 파일을 보관합니다. 소스는 git에 저장하십시오. Remix 빌드는
이미지 빌드 시 패치되어 컴파일러 목록과 컴파일러를 `binaries.soliditylang.org` 대신 `/solc-bin/`에서
불러옵니다. 미러는 다음 명령으로 확인합니다.

```bash
curl -s http://192.168.68.139:30200/solc-bin/list.json
```

Remix의 클라우드 서비스가 필요한 기능은 여기서 동작하지 않습니다. RemixAI, 플러그인 디렉터리,
GitHub/Gist 가져오기 및 공유, 미러되지 않은 컴파일러 버전이 해당됩니다. Remix는 사용자의 브라우저에서
이 서비스에 접근을 시도하지만, 인터넷에 접근할 수 없으므로 오류 표시 없이 실패합니다.
