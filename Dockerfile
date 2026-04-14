FROM node:20-slim

# System dependencies for git operations
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install git-ai CLI for AI code metrics tracking
# git-ai silently tags each commit with which AI tool helped write it
# Installed as root first, then PATH is available to autoship user
RUN curl -sSL https://usegitai.com/install.sh | bash || true \
    && cp -f /root/.local/bin/git-ai /usr/local/bin/git-ai 2>/dev/null || true

# Working directory
WORKDIR /app

# Install dependencies (layer-cached)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY public/ ./public/

# Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN groupadd -g 1001 autoship && useradd -u 1001 -g autoship -m -s /bin/bash autoship

# Repos volume (persistent across restarts)
RUN mkdir -p /app/repos /app/logs && chown -R autoship:autoship /app

VOLUME ["/app/repos"]

# Git config for automated commits
RUN git config --global user.name "AutoShip" \
    && git config --global user.email "autoship@example.com" \
    && git config --global init.defaultBranch dev

# Switch to non-root user
USER autoship

# Copy git config to autoship user home
RUN git config --global user.name "AutoShip" \
    && git config --global user.email "autoship@example.com" \
    && git config --global init.defaultBranch dev

# Pre-initialize Claude Code for headless/CI operation.
# Without this, Claude Code blocks on an interactive onboarding prompt
# even with CI=true and ANTHROPIC_API_KEY set (zero output, hangs until SIGTERM).
# See: https://github.com/anthropics/claude-code/issues/4714
RUN mkdir -p /home/autoship/.claude \
    && echo '{"hasCompletedOnboarding":true}' > /home/autoship/.claude/.claude.json \
    && chmod 644 /home/autoship/.claude/.claude.json

# Expose server port
EXPOSE 3457

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD curl -f http://localhost:3457/health || exit 1

CMD ["node", "src/server.js"]
