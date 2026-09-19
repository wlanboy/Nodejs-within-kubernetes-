# syntax=docker/dockerfile:1

# --- Dependencies (nur Produktions-Deps, cache-freundlich getrennt vom Quellcode) ---
FROM registry.access.redhat.com/ubi10/nodejs-24:latest AS deps
WORKDIR /opt/app-root/src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/opt/app-root/src/.npm,uid=1001,gid=0 npm ci --omit=dev

# --- Runtime ---
# Red Hat UBI10 statt node:24-slim/Distroless (siehe Dockerfile-Distroless):
# RHEL-gepatchte glibc/OpenSSL-Basis mit eigenem CVE-Tracking im Red Hat
# Ecosystem Catalog. Anders als Distroless bringt das Image weiterhin
# bash/coreutils mit (kein Attack-Surface-Minimum), dafuer volle
# Debug-Faehigkeit per "kubectl exec ... bash". "-minimal"-Variante spart
# gegenueber dem vollen Builder-Image die s2i-/Build-Tools, die zur Laufzeit
# nicht mehr gebraucht werden.
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal:latest
# WORKDIR bewusst /opt/app-root/src statt /app: eigenes Verzeichnis wie /app
# koennte der Default-User (UID 1001, arbitrary-uid-Konvention) nicht
# anlegen, da "/" nicht gruppen-beschreibbar ist - /opt/app-root/src ist im
# Basisimage bereits fuer GID 0 beschreibbar vorbereitet.
WORKDIR /opt/app-root/src
COPY --from=deps --chown=1000:1000 /opt/app-root/src/node_modules ./node_modules
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 src ./src

# Image-Default ist UID 1001/GID 0 (OpenShift-"arbitrary uid"-Konvention).
# Hier stattdessen fest auf UID/GID 1000, damit runAsUser/fsGroup in
# chart/values.yaml mit dem Dateibesitz der COPY --chown-Befehle oben
# uebereinstimmen.
USER 1000:1000
EXPOSE 8080 8081
ENV NODE_ENV=production

# Eigenes ENTRYPOINT statt des s2i-"container-entrypoint"-Wrappers des
# Basisimages (der ist nur ein exec-Passthrough, aber fuer diesen
# Nicht-s2i-Build ueberfluessig). Node wird dadurch direkt PID 1 und
# erhaelt SIGTERM unmittelbar. --import laedt tracing.js VOR server.js,
# damit die OTel-HTTP-Instrumentation das http-Modul patchen kann, bevor
# server.js es importiert.
ENTRYPOINT ["node", "--import", "./src/tracing.js", "src/server.js"]
