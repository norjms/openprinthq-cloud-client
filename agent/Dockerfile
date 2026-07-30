# OpenPrintHQ local connector — Docker image
# Runs on the same LAN as your printers. Outbound-only; no ports to publish.
FROM node:22-alpine

# go2rtc + ffmpeg for agent-local camera relay (Bambu RTSPS held on the LAN,
# re-served as MJPEG/JPEG for the tunnel). Architecture credit: OctoEverywhere
# (https://github.com/QuinnDamerell/OctoPrint-OctoEverywhere, AGPL-3.0).
# go2rtc ships as a single static binary. ffmpeg is used by go2rtc for the
# RTSPS->MJPEG transcode. Pinned go2rtc version for reproducibility.
ARG GO2RTC_VERSION=1.9.9
RUN apk add --no-cache ffmpeg curl \
    && ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64) G2="go2rtc_linux_amd64" ;; \
         aarch64) G2="go2rtc_linux_arm64" ;; \
         armv7l) G2="go2rtc_linux_arm" ;; \
         *) G2="go2rtc_linux_amd64" ;; \
       esac \
    && curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${G2}" -o /usr/local/bin/go2rtc \
    && chmod +x /usr/local/bin/go2rtc \
    && go2rtc --version || true

WORKDIR /app
COPY package.json ./
COPY src ./src
# No node dependencies to install — the agent uses only Node built-ins.
USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "src/agent.js"]
