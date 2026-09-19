# syntax=docker/dockerfile:1

# --- Dependencies (nur Produktions-Deps, cache-freundlich getrennt vom Quellcode) ---
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# --- Runtime ---
FROM node:24-slim
# node:*-slim ist Debian-basiert (glibc statt musl wie bei Alpine, dadurch keine
# der ueblichen Alpine/musl-Kompatibilitaetsprobleme) und bringt bereits einen
# "node"-User mit fester UID/GID 1000 mit - passt exakt zu runAsUser/fsGroup in
# chart/values.yaml, daher kein addgroup/adduser noetig
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 src ./src

# numerisch statt namentlich, damit runAsNonRoot/runAsUser in
# chart/templates/deployment.yaml die UID zuverlaessig auswerten koennen
USER 1000:1000
EXPOSE 8080 8081
ENV NODE_ENV=production

# Kein Shell-Entrypoint noetig: Node liest NODE_OPTIONS automatisch aus der
# Umgebung (siehe chart/values.yaml), der Node-Prozess wird dadurch direkt
# PID 1 und erhaelt SIGTERM unmittelbar.
# --import laedt tracing.js VOR server.js, damit die OTel-HTTP-Instrumentation
# das http-Modul patchen kann, bevor server.js es importiert.
ENTRYPOINT ["node", "--import", "./src/tracing.js", "src/server.js"]
