# fin v2/v3 worker image. Build context is the v2/ directory:
#
#   docker build -f ops/docker/Dockerfile -t fin-v2 v2/
#
# or through compose (ops/docker/compose.yml), which sets the context for you.
#
# Two stages. The build stage installs the full dependency tree and compiles
# src/ -> dist/ (tsconfig.build.json); the runtime stage carries only dist/,
# the production node_modules, the dashboard's static files and an empty
# reports/ directory on Amazon Linux 2023 minimal with the distribution's Node
# 24, and runs as an unprivileged `nonroot` user. Both bases come from ECR
# Public (AWS-maintained or AWS-mirrored), not Docker Hub or gcr.io.
#
# Why `npm ci` runs INSIDE the image rather than copying host node_modules: the
# Agent SDK resolves a per-platform native package (an optionalDependency named
# after the OS and CPU), so a macOS host's tree would not run on Linux.
#
# What is deliberately NOT in the image: pandoc and weasyprint. The letter's
# markdown is its artifact; the .docx/.pdf conversions are optional and the
# report logs their absence and carries on. Extend this image if you want them.

# ---------- build ----------
# Node 24 (active LTS). Node 20 reached end of life in April 2026.
# ECR Public's mirror of the Docker Hub official image.
FROM public.ecr.aws/docker/library/node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run compile \
 && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime ----------
# Amazon Linux 2023 minimal plus the distribution's nodejs24 package: node and
# its shared libraries, no npm (a separate package, not installed) and ~100
# rpms. Trivy found 0 high/critical here against 2 on distroless Node 24 and
# 26 on the Lambda Node image, whose runtime client bundles its own npm tree.
# The tag, not a digest, so a rebuild picks up AL2023's security updates; the
# `dnf upgrade` applies any released since the base image was cut. Node itself
# is pinned (NODE_RPM): AL2023 keeps earlier builds in its repository, so the pin
# rebuilds reproducibly; bump it for a Node security release
# (`dnf repoquery nodejs24` lists them).
# The Agent SDK picks its glibc binary (AL2023 is glibc 2.34).
# The runtime user is written straight into /etc/passwd - uid 65532, HOME
# /home/nonroot, the same as distroless's `nonroot` - so no shadow-utils.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal AS runtime
ARG NODE_RPM=nodejs24-24.21.0
RUN dnf -y upgrade \
 && dnf -y install "$NODE_RPM" \
 && dnf clean all \
 && rm -rf /var/cache/dnf /var/log/dnf* \
 && echo 'nonroot:x:65532:65532:nonroot:/home/nonroot:/sbin/nologin' >> /etc/passwd \
 && echo 'nonroot:x:65532:' >> /etc/group \
 && mkdir -p /home/nonroot /opt/fin/v2/reports \
 && chown 65532:65532 /home/nonroot /opt/fin/v2/reports
# AWS_SDK_LOAD_CONFIG: read ~/.aws/config (profiles, credential_process) when a
# profile directory is mounted in.
ENV NODE_ENV=production \
    AWS_SDK_LOAD_CONFIG=1
WORKDIR /opt/fin/v2
# Code stays root-owned and read-only to the runtime user; only reports/
# (created above) is writable by it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# dist/dashboard.js serves ../dashboard; dist/daily-report.js writes ../reports.
COPY dashboard ./dashboard
VOLUME ["/opt/fin/v2/reports"]
USER nonroot
# Liveness only: healthy while a node process runs one of the compiled entry
# points (the worker has no port to probe). compose.yml replaces this with an
# HTTP check for the dashboard service.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const fs=require('fs');process.exit(fs.readdirSync('/proc').some(p=>{try{return /^\\d+$/.test(p)&&p!=process.pid&&fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('dist/')}catch{return false}})?0:1)"]
ENTRYPOINT ["node"]
# The worker is the default. Override CMD for the dashboard (dist/dashboard.js)
# or the letter (dist/daily-report.js); compose.yml does this per service.
CMD ["dist/worker.js"]
