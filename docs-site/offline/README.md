# Offline build archive

`wheels.tgz`: the Python wheels of `../requirements.txt`, made by `offline/make-offline.sh`.
When it is here, the Dockerfile installs from it without network. See `offline/README.md`.
