# 노드 키 백업용 GPG 키

> **내용:** 노드 키 백업을 암호화하는 GPG 키를 다룹니다. 키를 생성하고, Ansible에 공개 키를 제공하고, 개인 키를 오프라인에 보관하며, 백업을 확인하고 복호화하는 방법을 설명합니다.
>
> **대상:** 운영자.
>
> **관련 문서:** [Ansible](ansible.md) · [재해 복구](../operations/disaster-recovery.md) · [복원](../operations/restore.md)

**목차**

- [1. 키 쌍 생성](#1-create-the-key-pair)
- [2. Ansible용 공개 키 내보내기](#2-export-the-public-key-for-ansible)
- [3. 운영자 머신에서 개인 키 옮기기 (그곳에서 생성한 경우)](#3-move-the-private-key-off-the-operator-if-you-created-it-there)
- [4. 백업 실행 및 확인](#4-run-the-backups-and-check-them)
- [5. 복원을 위한 키 복호화](#5-decrypt-a-key-for-a-restore)
- [참고 사항](#notes)

---

10단계(`10-backups.yml`)는 6개 Besu 노드 키(val1–val4, rpc1, rpc2)를 백업합니다. 각 키는 데이터
볼륨에서 비공개 임시 디렉터리로 복사되고(`backup-key.sh`), **자기 호스트에서** 사용자의 GPG **공개**
키로 암호화됩니다(`install_packages`가 true이면 Ansible이 그곳에 GnuPG를 설치합니다). 평문 사본은
파쇄되고, 암호화된 파일만 `ansible/state/key-backups/<node>.key.gpg`에 보관됩니다. 짝이 맞는
**개인** 키(와 그 패스프레이즈)로만 복호화할 수 있습니다. 따라서 다음과 같이 합니다.

- **공개 키**는 Ansible을 위해 운영자 머신에 둡니다(`key_backup_gpg_public_key`).
- **개인 키**는 오프라인 보안 저장소에 두며, 암호화된 백업과 같은 곳에 두지 않습니다.

키 쌍은 오프라인 상태로 유지되는 머신에서 생성하는 것이 가장 좋습니다. 운영자 머신에서 생성했다면
이후에 개인 키를 그 머신에서 옮기십시오(3단계).

## 1. 키 쌍 생성 {#1-create-the-key-pair}

데스크톱이 없는 서버에서는 GPG가 일반적인 패스프레이즈 창을 열 수 없으므로("No pinentry"),
터미널에서 묻도록 합니다.

```bash
gpg --pinentry-mode loopback --quick-gen-key 'besu-chain key backups' rsa4096 encr never
```

패스프레이즈를 두 번 묻습니다. 강력한 패스프레이즈를 선택하여 보안 저장소에 보관하십시오. 개인 키와
이 패스프레이즈가 함께 있어야 노드 키 백업을 복호화할 수 있습니다.

(대안: `dnf install -y pinentry` 또는 `apt install -y pinentry-curses`로 터미널 pinentry를
설치한 다음, `--pinentry-mode loopback` 없이 같은 명령을 실행합니다.)

## 2. Ansible용 공개 키 내보내기 {#2-export-the-public-key-for-ansible}

```bash
mkdir -p /opt/000 && gpg --armor --export 'besu-chain key backups' > /opt/000/backup-pub.asc
```

```bash
head -1 /opt/000/backup-pub.asc
```

`-----BEGIN PGP PUBLIC KEY BLOCK-----`가 출력되어야 합니다. 그다음
`ansible/group_vars/all/settings.yml`에 다음을 설정합니다.

```yaml
key_backup_gpg_public_key: /opt/000/backup-pub.asc
```

## 3. 운영자 머신에서 개인 키 옮기기 (그곳에서 생성한 경우) {#3-move-the-private-key-off-the-operator-if-you-created-it-there}

1. 개인 키를 파일로 내보냅니다(패스프레이즈를 묻습니다).

   ```bash
   gpg --pinentry-mode loopback --armor --export-secret-keys 'besu-chain key backups' > besu-backup-private.asc
   ```

2. `besu-backup-private.asc`를 오프라인 보안 저장소(USB 키, 비밀번호 관리자 파일, 금고)에 복사하고,
   그곳에서 사본을 읽을 수 있는지 확인합니다.

3. 운영자 머신에서 제거합니다. 먼저 파일을, 그다음 GPG 키링에서 비밀 키를 제거합니다(GPG가 물으면
   확인하십시오).

   ```bash
   shred -u besu-backup-private.asc
   ```

   ```bash
   gpg --pinentry-mode loopback --delete-secret-keys 'besu-chain key backups'
   ```

공개 키는 남아 있으며, Ansible에는 공개 키만 있으면 됩니다.

```bash
gpg --list-keys 'besu-chain key backups'
```

`gpg --list-secret-keys`에는 더 이상 표시되지 않아야 합니다.

## 4. 백업 실행 및 확인 {#4-run-the-backups-and-check-them}

```bash
cd ansible && ansible-playbook 10-backups.yml
```

```bash
ls -l state/key-backups/
```

6개 파일 `val1.key.gpg` … `val4.key.gpg`, `rpc1.key.gpg`, `rpc2.key.gpg`가 있어야 합니다. 각 백업은
모니터링을 위해 해당 호스트에도 기록되므로, 네 개의 검증자 키가 모두 기록되면 `ValidatorKeyBackupMissing`
알림([알림](../operations/alerts.md))이 해제됩니다. 각 파일은 사용자의 키로 암호화되어 있어야 합니다
(이 확인은 개인 키 없이도 가능합니다). 다음 출력의 첫 줄에 있는 `keyid`가

```bash
gpg --list-packets state/key-backups/val1.key.gpg 2>&1 | grep -i 'pubkey enc packet'
```

여기에서 `rsa4096/` 뒤에 나오는 값과 같아야 합니다.

```bash
gpg --list-keys --keyid-format long 'besu-chain key backups'
```

그다음 `ansible/state/`(`key-backups/` 포함)를 보안 저장소에 복사하십시오. 가끔 오프라인 머신에서
결과를 사용하지 않고 복원을 테스트하십시오(5단계).

## 5. 복원을 위한 키 복호화 {#5-decrypt-a-key-for-a-restore}

개인 키가 있는 머신에서 실행합니다(필요하면 먼저 보안 저장소에서 가져옵니다).

```bash
gpg --pinentry-mode loopback --import besu-backup-private.asc
```

```bash
gpg --pinentry-mode loopback --decrypt val3.key.gpg > val3.key
```

`val3.key`를 SSH로 노드의 호스트에 복사하고, 그곳의 해당 노드 폴더에서 `./restore-key.sh`로
복원한 다음([재해 복구](../operations/disaster-recovery.md), 6.1 참고), 모든 평문 사본을
파쇄하십시오.

```bash
shred -u val3.key
```

## 참고 사항 {#notes}

- **개인 키나 패스프레이즈를 잃어버린 경우:** 기존 백업은 더 이상 읽을 수 없습니다. 새 키 쌍을 만들고
  (1~3단계), 새 공개 키를 설정한 뒤, `state/key-backups/`를 삭제하고 `10-backups.yml`을 다시
  실행하십시오. 키가 새 키로 암호화되어 다시 백업됩니다.
- **새 키 쌍, 이전 백업:** 위와 같습니다. 이전 백업을 보관하는 동안은 이전 개인 키도 보관하십시오.
- 백업은 키당 한 번 만들어집니다(노드 키는 변경되지 않습니다). Ansible이 특정 노드를 다시
  백업하게 하려면 `state/key-backups/`에서 해당 파일을 삭제하십시오.
- **다시 구축한 호스트:** 모니터링용 기록은 호스트에 있으므로, 다시 구축한 후에는
  `state/key-backups/`가 완전하더라도 `ValidatorKeyBackupMissing` 알림이 발생합니다. 파일을
  다른 곳으로 옮기고 `10-backups.yml`을 다시 실행하십시오([Ansible로 복원](../operations/restore.md), 5단계).
- `key_backup_gpg_public_key`가 없으면 10단계는 키 백업을 건너뛰고 알림이 유지됩니다.
