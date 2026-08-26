# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE}

ARG MSA_SOURCE_REVISION=unknown
ARG MSA_SOURCE_PATH=sources/msa-minimal-harness
ARG MSA_RUNTIME_DEFINITION_DIGEST=unknown
ARG MSA_BASE_IMAGE_IDENTITY=unknown

LABEL org.opencontainers.image.revision="${MSA_SOURCE_REVISION}" \
      io.harness-rsi.runtime="msa-minimal-cowork-v1" \
      io.harness-rsi.msa-source-path="${MSA_SOURCE_PATH}" \
      io.harness-rsi.runtime-definition-digest="${MSA_RUNTIME_DEFINITION_DIGEST}" \
      io.harness-rsi.base-image-identity="${MSA_BASE_IMAGE_IDENTITY}"

# MSA Candidate 在运行时只读挂载，不烘焙进 Task Image。清空上游 Task
# Image 的 ENTRYPOINT，确保 Solver 只能由 Controller 给出的命令启动。
ENTRYPOINT []
