# Documentation website: MkDocs (Material theme) builds docs/ into static HTML, nginx serves it.
# Build context: the repository root (docker-compose.yml sets it), filtered by Dockerfile.dockerignore.
FROM python:3.12.8-slim AS build
ARG PIP_INDEX_URL
# Every package pinned in requirements.txt. Offline: when docs-site/offline/wheels.tgz is in the context
# (offline/make-offline.sh), only from those wheels, without network; otherwise from PyPI.
COPY docs-site/requirements.txt /tmp/requirements.txt
RUN --mount=type=bind,source=docs-site/offline,target=/offline \
    if [ -f /offline/wheels.tgz ]; then \
      mkdir /tmp/wheels && tar -xzf /offline/wheels.tgz -C /tmp/wheels \
      && pip install --no-cache-dir --no-index --find-links /tmp/wheels -r /tmp/requirements.txt && rm -rf /tmp/wheels; \
    else pip install --no-cache-dir -r /tmp/requirements.txt; fi
WORKDIR /src
COPY . .
RUN mkdocs build -f docs-site/mkdocs.yml -d /site

FROM nginx:1.27.3-alpine
COPY docs-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html
EXPOSE 30300
