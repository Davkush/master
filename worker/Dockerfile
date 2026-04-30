FROM kalilinux/kali-rolling:latest

ENV DEBIAN_FRONTEND=noninteractive

# ── Build deps ────────────────────────────────────────────────────────────────
RUN apt-get update --fix-missing && apt-get install -y --no-install-recommends \
    build-essential git curl wget \
    libgmp-dev libssl-dev \
    python3 python3-pip \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ── Build Keyhunt from source ─────────────────────────────────────────────────
RUN git clone https://github.com/albertobsd/keyhunt.git /opt/keyhunt \
    && cd /opt/keyhunt \
    && make \
    && cp keyhunt /usr/local/bin/keyhunt \
    && chmod +x /usr/local/bin/keyhunt

# ── Also build BitCrack (CPU) as fallback ─────────────────────────────────────
RUN git clone https://github.com/brichard19/BitCrack.git /opt/bitcrack \
    && cd /opt/bitcrack \
    && make BUILD_CUDA=0 BUILD_OPENCL=0 \
    && cp bin/clBitCrack /usr/local/bin/bitcrack 2>/dev/null || \
       cp bin/cuBitCrack /usr/local/bin/bitcrack 2>/dev/null || \
       ls bin/ || true

# ── Puzzle #71 address file ───────────────────────────────────────────────────
RUN echo "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU" > /opt/puzzle71.txt

# ── Worker orchestration script ───────────────────────────────────────────────
COPY worker.sh /worker.sh
RUN chmod +x /worker.sh

CMD ["/worker.sh"]
