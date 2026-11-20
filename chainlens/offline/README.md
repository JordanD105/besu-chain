# Offline build archive

`npm-cache.tgz`: the npm packages of `../package-lock.json`, made by `offline/make-offline.sh`.
When it is here, the Dockerfile installs from it without network. See `offline/README.md`.
