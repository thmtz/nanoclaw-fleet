# syntax=docker/dockerfile:1
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium + Rust build tools
# Cached between builds — only re-runs if the package list changes
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    ca-certificates \
    build-essential \
    pkg-config \
    libssl-dev \
    jq \
    unzip \
    python3 \
    python3-pip \
    python3-venv \
    openssh-client \
    rsync \
    sudo \
    tree \
    && rm -rf /var/lib/apt/lists/*

# Give node user passwordless sudo so workers can install packages at runtime
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node

# Install Tailscale CLI (uses host's tailscaled via mounted socket)
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager — for Python CLI tools)
# Install to /usr/local/bin so it's accessible to all users (container runs as node)
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Install rclone (for R2/S3 bucket access)
RUN curl https://rclone.org/install.sh | bash

# Install Docker CLI binary directly (avoids apt repo complexity)
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.2.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Install Rust system-wide (so node user can compile projects against container's glibc)
# Cache mount avoids re-downloading the toolchain on every build
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/root/.rustup/downloads,sharing=locked \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- -y --default-toolchain stable --no-modify-path && \
    chmod -R a+rw /usr/local/rustup /usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
# Cached — only re-runs if this line changes
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g agent-browser @anthropic-ai/claude-code

# Install ruff (Python linter/formatter) to a shared location
RUN uv tool install ruff && cp /root/.local/bin/ruff /usr/local/bin/ruff

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies (cached by npm cache mount)
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript and save source content hash for runtime skip detection.
# Hash only file contents (not paths) so mount path differences don't matter.
RUN npm run build && \
    find src -name '*.ts' -exec md5sum {} + | awk '{print $1}' | sort | md5sum | cut -d' ' -f1 > dist/.src-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script (includes startup profiling)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Configure git to use GITHUB_TOKEN for HTTPS auth when present.
# The token is injected as an env var by the host (never stored in the image).
# Also rewrites git@github.com: SSH URLs to HTTPS so git push works without SSH keys.
RUN git config --system credential.helper \
      '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f' && \
    git config --system url."https://github.com/".insteadOf "git@github.com:"

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /app && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
