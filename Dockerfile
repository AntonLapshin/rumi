FROM node:20-bookworm

ENV RUMI_IN_CONTAINER=1 \
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    HOME=/home/node

# 1) Node CLIs: Claude Code, OpenCode, playwright-cli.
RUN npm install -g @anthropic-ai/claude-code opencode-ai @playwright/cli

# 2) Install Chromium + system deps for headless runs. We use playwright's
#    install --with-deps to grab apt packages, then prime playwright-cli's
#    own browser cache (may be a different chromium build than what the
#    `playwright` package picks) so runtime `playwright-cli install --skills`
#    calls don't have to redownload.
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
 && npx --yes playwright install --with-deps chromium \
 && mkdir -p /tmp/pwprime && cd /tmp/pwprime \
 && playwright-cli install \
 && rm -rf /tmp/pwprime

# 3) Build + install rumi.
WORKDIR /opt/rumi
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
RUN npm ci \
 && npm run build \
 && npm install -g .

# 4) Non-root runtime user. The base image ships a `node` user at UID 1000
#    with a writable /home/node — we reuse it. Credential bind mounts land in
#    /home/node/.{claude,opencode}; /work is the bind-mounted host project
#    (host uid governs write perms on Linux; macOS/Docker Desktop bind mounts
#    are uid-transparent).
RUN mkdir -p /home/node/.claude /home/node/.opencode \
 && chown -R node:node /home/node /opt/playwright

USER node
WORKDIR /work
ENTRYPOINT ["rumi"]
