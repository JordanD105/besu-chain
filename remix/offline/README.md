# Offline build: Solidity compilers

Before building, Ansible (`02-images.yml`) copies `remix-solc-npm-cache.tgz` from
`image_archives_dir` here as `solc-npm-cache.tgz`; the Dockerfile then installs solc from that npm
cache without network. Not in git: it depends on `remix_solc_versions`. Made by
`offline/make-offline.sh --remix DIR`. See `offline/README.md`.
