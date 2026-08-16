# ============================================================
# automation-backend — multi-stage Docker build (Node-base)
# Uses the official Playwright image (browsers + system deps bundled).
# ============================================================

# ---------- Stage 1: build ----------
FROM mcr.microsoft.com/playwright:v1.56.1-jammy AS build

WORKDIR /app

# Install dependencies first (better layer caching).
# Skip the browser download here; the runtime image already has browsers.
ENV SKIP_BROWSER_INSTALL=1
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# Copy source and compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies for a slim runtime node_modules
RUN npm prune --omit=dev


# ---------- Stage 2: runtime ----------
FROM mcr.microsoft.com/playwright:v1.56.1-jammy AS runtime

# APP_ENV=server is the important line here.
#
# NODE_ENV=production alone used to be the whole story, and it silently broke
# the headline feature: the `production` profile is HEADLESS, and a headless
# Chrome loads NO extensions at all (measured: 0 extension service workers
# headless vs 1 headed). Every container therefore ran the Remote Browser with
# the Element Inspector and all cookie extensions missing, with nothing in the
# logs to say so.
#
# `server` means "a remote server that is expected to RUN the Remote Browser":
# same production hardening (rate limits on, DevTools port shut), but headed on
# a virtual display so extensions exist. NODE_ENV stays `production` because
# Express and half of npm read it for their own, unrelated reasons.
ENV NODE_ENV=production \
    APP_ENV=server \
    PORT=3000 \
    SKIP_BROWSER_INSTALL=1

WORKDIR /app

# The virtual display stack.
#
# The base Playwright image ships browsers and their libraries, but NOT Xvfb —
# it expects headless use. A headed browser needs a screen, so without these
# three packages `APP_ENV=server` would ask for a display that can never start.
# x11vnc + websockify are what make /desktop/chrome viewable in a tab; openbox
# is the window manager that maps the Chrome window (an unmanaged X session
# leaves it unmapped and the view stays blank).
#
# Installed at build time on purpose: the server CAN provision these itself at
# runtime (DESKTOP_AUTO_PROVISION), but doing it in the image means the first
# request is fast, works offline, and cannot fail behind a corporate proxy.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc websockify novnc openbox \
 && rm -rf /var/lib/apt/lists/*

# Bring in only what we need to run
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Static dashboard UI (served by Express from the project root at runtime)
COPY public ./public

# The Element Inspector extension. MUST be copied.
#
# `seedInspectorExtension()` resolves it from `process.cwd()/extension`, and it
# NEVER THROWS — a missing directory returns `no_source` and the browser starts
# happily without an Inspector. So omitting this (as every previous image did)
# removed a headline feature and produced no error anywhere.
COPY extension ./extension

# Runtime data directories
RUN mkdir -p logs profiles uploads downloads

EXPOSE 3000

# Container-level healthcheck hitting the /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run the compiled server directly (single process; use PM2/compose scale for clustering)
CMD ["node", "dist/index.js"]
