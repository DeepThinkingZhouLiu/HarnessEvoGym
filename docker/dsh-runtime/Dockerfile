# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE=debian:bookworm-slim
ARG DSH_PACKAGE=@deepseek-ai/dsh
ARG DSH_VERSION=0.1.1-rc.1
ARG DSH_SOURCE_REVISION=unknown
ARG DSH_SOURCE_PATH=sources/deepseek-harness
ARG DSH_RUNTIME_DEFINITION_DIGEST=unknown
ARG DSH_BASE_IMAGE_IDENTITY=unknown

FROM node:24-bookworm-slim AS dsh-build
ARG DSH_SOURCE_PATH
ARG DSH_SOURCE_REVISION
ENV CI=1
ENV DSH_CLIENT_COMMIT_HASH=${DSH_SOURCE_REVISION}
WORKDIR /opt/dsh
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY ${DSH_SOURCE_PATH}/ ./
RUN --mount=type=cache,id=harness-rsi-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile \
    && pnpm run build

FROM ${BASE_IMAGE}
ARG DSH_PACKAGE
ARG DSH_VERSION
ARG DSH_SOURCE_REVISION
ARG DSH_SOURCE_PATH
ARG DSH_RUNTIME_DEFINITION_DIGEST
ARG DSH_BASE_IMAGE_IDENTITY
LABEL org.opencontainers.image.revision="${DSH_SOURCE_REVISION}" \
      io.harness-rsi.dsh-package="${DSH_PACKAGE}" \
      io.harness-rsi.dsh-version="${DSH_VERSION}" \
      io.harness-rsi.dsh-source-path="${DSH_SOURCE_PATH}" \
      io.harness-rsi.runtime-definition-digest="${DSH_RUNTIME_DEFINITION_DIGEST}" \
      io.harness-rsi.base-image-identity="${DSH_BASE_IMAGE_IDENTITY}"
COPY --from=dsh-build /usr/local/ /usr/local/
COPY --from=dsh-build /opt/dsh/ /opt/dsh/
COPY --chmod=0755 docker/dsh-runtime/dsh /usr/local/bin/dsh
ENTRYPOINT []
