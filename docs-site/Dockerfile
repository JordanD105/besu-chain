# Documentation website: MkDocs (Material theme) builds docs/ into static HTML, nginx serves it.
# Build context: the repository root (docker-compose.yml sets it), filtered by Dockerfile.dockerignore.
FROM python:3.12.8-slim AS build
ARG PIP_INDEX_URL
RUN pip install --no-cache-dir mkdocs==1.6.1 mkdocs-material==9.5.49 mkdocs-static-i18n==1.2.3
WORKDIR /src
COPY . .
RUN mkdocs build -f docs-site/mkdocs.yml -d /site

FROM nginx:1.27.3-alpine
COPY docs-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html
EXPOSE 30300
