# Offline build: Solidity compilers

Ansible (`02-images.yml`) copies `remix-solc-npm-cache.tgz` here from `image_archives_dir` before
building; the Dockerfile then installs solc from it without network. Not in git (it depends on
`remix_solc_versions`); made by `offline/make-offline.sh --remix DIR`. See `offline/README.md`.
