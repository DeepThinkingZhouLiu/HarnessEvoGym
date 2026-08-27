FROM python:3.12-slim-bookworm

ARG OFFICEVAL_RUNTIME_REVISION=unknown
ARG DEBIAN_MIRROR=https://mirrors.aliyun.com/debian
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

LABEL io.harness-rsi.runtime="omegause-officeval-linux-v1" \
      io.harness-rsi.officeval-runtime-revision="${OFFICEVAL_RUNTIME_REVISION}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# 同一可信基础镜像供 Solver 与 Verifier 使用。Candidate 和具体 Verifier 均在运行时只读挂载，
# 不会被烘焙进镜像。LibreOffice 提供真实 Office 文件转换/检查能力；Python 库与上游
# OmegaUse-OfficeVal 的 Linux 静态 Verifier 依赖一致。
RUN sed -i "s#http://deb.debian.org/debian#${DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-dejavu-core \
      fonts-liberation2 \
      fonts-noto-cjk \
      ghostscript \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-writer \
      poppler-utils \
      qpdf \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --index-url "${PYPI_INDEX_URL}" \
      lxml==5.4.0 \
      numpy==2.2.6 \
      openpyxl==3.1.5 \
      opencv-python-headless==4.11.0.86 \
      pdfplumber==0.11.7 \
      Pillow==11.2.1 \
      pypdfium2==4.30.1 \
      python-docx==1.2.0 \
      python-pptx==1.0.2

COPY docker/omegause-officeval/run-verifier.py /opt/harness-rsi/run-officeval-verifier.py

ENTRYPOINT []
