# Personal NanoClaw agent layer
# Adds tools and packages specific to this installation.
# Built on top of the public base image by container/build.sh.

FROM nanoclaw-agent:base

USER root

# PostgreSQL + pgvector + Redis (for integration tests)
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql \
    postgresql-client \
    postgresql-server-dev-15 \
    redis-server \
    && rm -rf /var/lib/apt/lists/* \
    && cd /tmp \
    && git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git \
    && cd pgvector && make -j$(nproc) && make install \
    && rm -rf /tmp/pgvector

# Python test/dev packages
RUN uv pip install --system --break-system-packages \
    pytest httpx pytest-repeat pytest-xdist pipenv

USER node
