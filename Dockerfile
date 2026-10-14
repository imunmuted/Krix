FROM node:22-slim

# Runtimes + file-tooling used by the sandbox (zip/unzip/7z, ImageMagick and Pillow for image conversion).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-pil \
    golang-go \
    default-jdk-headless \
    g++ \
    rustc \
    ruby \
    php-cli \
    curl \
    wget \
    ca-certificates \
    zip \
    unzip \
    p7zip-full \
    imagemagick \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged user that ALL sandboxed code, git commands and sandbox file operations run as.
# The server itself stays root only so it can switch to this user for each child process; the
# sandbox user therefore cannot read the server's environment/memory (/proc/<pid>/environ) or code.
RUN groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev && chmod -R go-rwx /app && chmod 755 /app

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=400" \
    SANDBOX_UID=10001 \
    SANDBOX_GID=10001 \
    SANDBOX_REQUIRE_ISOLATION=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
