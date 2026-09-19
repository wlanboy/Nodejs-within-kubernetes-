# Node.js Hello World in Kubernetes

Minimaler Node.js-REST-Service (`GET /hello`, `GET /cpu?key=...`) mit
separatem Management-Port fuer Liveness/Readiness/Prometheus-Metriken,
optimiert fuer geringen Speicher-/CPU-Verbrauch und schnellen Start in
Kubernetes (Betrieb hinter einem Istio-Sidecar moeglich, funktioniert aber
genauso lokal).

## Deploy

```bash
kubectl create namespace nodejs-hello-world
kubectl label namespace nodejs-hello-world istio-injection=enabled

docker build -t wlanboy/nodejs-hello-world:latest service/
helm install nodejs-hello-world chart/ --namespace nodejs-hello-world

helm status nodejs-hello-world --namespace nodejs-hello-world

helm upgrade nodejs-hello-world chart/ --namespace nodejs-hello-world
```

**Hinweis zum Image-Tag:** [values.yaml](chart/values.yaml) nutzt bewusst
`:latest` mit `imagePullPolicy: Always` fuer dieses Beispiel-Repo (schnelles
lokales Bauen/Testen ohne Versions-Bumps). Fuer den produktiven Einsatz
sollte stattdessen ein gepinnter Tag (z. B. `1.0.0`) oder ein Image-Digest
verwendet werden, damit Rollouts reproduzierbar bleiben und Nodes nicht
dauerhaft an ein veraltetes gecachtes `latest`-Image gebunden sind.

---

## Docker-Image (`service/Dockerfile`)

| Entscheidung | Begruendung |
|---|---|
| Zweistufiger Build (`deps` + Runtime) | `npm ci --omit=dev` laeuft in einer eigenen Stage, damit Layer-Caching greift, solange sich `package.json`/`package-lock.json` nicht aendern - Quellcode-Aenderungen erzwingen keinen erneuten `npm ci`. |
| `--mount=type=cache,target=/root/.npm` | Nutzt den BuildKit-Cache-Mount fuer den npm-Cache ueber mehrere Builds hinweg, ohne ihn im Image-Layer zu materialisieren. |
| `node:24-slim` statt `node:24-alpine` | Bewusst **kein** Alpine: Alpine nutzt musl statt glibc, was bei nativen npm-Addons zu Kompatibilitaetsproblemen fuehren kann und in Kubernetes fuer die bekannten musl-DNS-Resolver-Eigenheiten (u. a. kein paralleles A/AAAA-Lookup) sorgt. `slim` ist Debian-basiert (glibc, maximal kompatibel) und trotzdem deutlich schlanker als das volle `node:24`-Image (kein Build-Toolchain/Doku-Overhead). |
| Kein `addgroup`/`adduser` | `node:*-slim` bringt bereits einen `node`-User mit fester UID/GID **1000** mit - passt exakt zu `runAsUser`/`fsGroup` in [chart/values.yaml](chart/values.yaml), ohne dass ein eigener User angelegt werden muss. |
| `USER 1000:1000` (numerisch) | Numerisch statt `USER node`, damit `runAsNonRoot`/`runAsUser` im Pod-SecurityContext die UID zuverlaessig auswerten koennen, unabhaengig vom `/etc/passwd`-Eintrag im Image. |
| Kein Shell-Entrypoint/`entrypoint.sh` | Node liest die Umgebungsvariable `NODE_OPTIONS` automatisch beim Start (siehe unten) - ein Wrapper-Skript wie im JVM/`JarLauncher`-Setup (dort noetig, um `JAVA_OPTS` vor den Klassenpfad zu haengen) ist ueberfluessig. `ENTRYPOINT ["node", "src/server.js"]` macht den Node-Prozess direkt zu PID 1 und er erhaelt `SIGTERM` unmittelbar, ohne den `exec`-Trick eines Shell-Skripts. |
| `EXPOSE 8080 8081` | Getrennter Application- (8080) und Management-Port (8081), siehe unten. |

---

## Application- vs. Management-Port (`src/server.js`)

Wie beim Java-Referenzprojekt laufen Health-/Metrics-Endpunkte auf einem
**eigenen Port** (8081), der ueber den Kubernetes-`Service`
([chart/templates/service.yaml](chart/templates/service.yaml)) **nicht**
exposed wird - erreichbar nur direkt an der Pod-IP (Probes,
`prometheus.io/port`-Annotation).

| Endpoint | Port | Zweck |
|---|---|---|
| `GET /hello` | 8080 | Hochzaehlender Counter (analog `HelloController#hello`) |
| `GET /cpu?key=...` | 8080 | Idempotency-Key-Pattern: gleicher `key` liefert immer denselben, einmalig vergebenen Wert zurueck |
| `GET /health/liveness` | 8081 | Immer `200`, solange der Event-Loop laeuft - bleibt waehrend eines geordneten Shutdowns `UP`, damit Kubernetes den Pod nicht zusaetzlich per Liveness-Kill beendet, waehrend er sich bereits geordnet beendet |
| `GET /health/readiness` | 8081 | `200`, sobald beide Server lauschen; faellt auf `503`, sobald `SIGTERM`/`SIGINT` empfangen wurde - signalisiert dem Service/Endpoint-Controller, keinen neuen Traffic mehr zu schicken |
| `GET /metrics` | 8081 | Prometheus-Textformat (`prom-client`, Default-Node-Metriken + `nodejs_hello_world_hello_requests_total`) |

### Graceful Shutdown

Node ist single-threaded pro Prozess - anders als bei Tomcat/Spring gibt es
keinen Thread-Pool, der leerlaufen muss. Der Ablauf bei Pod-Terminierung:

1. Kubernetes entfernt den Pod aus den Endpoints und ruft `preStop` auf
   (`sleep <preStopSleepSeconds>`, siehe Deployment) - Puffer, damit
   laufende `kube-proxy`/Istio-Konfiguration den Wegfall des Pods propagiert,
   *bevor* er tatsaechlich aufhoert, Traffic anzunehmen.
2. Kubernetes sendet `SIGTERM`. Der Handler in `src/server.js` setzt
   `readiness` sofort auf `DOWN` (falls `preStop` das nicht schon
   ueberbrueckt hat) und ruft `server.close()` auf beiden HTTP-Servern auf -
   neue Verbindungen werden abgelehnt, laufende Requests aber zu Ende
   bearbeitet.
3. Ein `SHUTDOWN_TIMEOUT_MS`-Timer (Default 10 s) erzwingt `process.exit(1)`,
   falls das Draining haengen bleibt - muss kleiner sein als
   `terminationGracePeriodSeconds` im Deployment, sonst killt Kubernetes den
   Prozess per `SIGKILL`, bevor der geordnete Shutdown fertig ist.

---

## Node-/V8-Tuning (`nodeOptions`/`env` in `chart/values.yaml`)

| Einstellung | Begruendung |
|---|---|
| `--max-old-space-size=160` | Node/V8 leitet die Heap-Groesse **nicht** automatisch aus dem cgroup-Memory-Limit ab (anders als container-aware JVMs via `-XX:MaxRAMPercentage`). Ohne dieses Flag kann der Heap im Zweifel ueber `resources.limits.memory` (hier 256Mi) hinauswachsen und der Container wird vom Kubelet per OOM-Kill beendet, statt dass V8 selbst kontrolliert Garbage Collection betreibt. Der Wert liegt bewusst deutlich unter dem Memory-Limit, da der tatsaechliche Speicherverbrauch (RSS) zusaetzlich Code, Stacks, Buffer und native Allocations ausserhalb des V8-Heaps enthaelt. |
| `--max-http-header-size=16384` | Begrenzt die maximale Groesse eingehender HTTP-Header (Default 16 KiB) explizit, um das Verhalten unabhaengig von der Node-Version stabil zu halten und ueberdimensionierte Header nicht erst spaet (z. B. am Ingress) abzufangen. |
| `UV_THREADPOOLSIZE=4` | Groesse des libuv-Thread-Pools (fuer DNS-Lookups, Dateisystem, Crypto etc.), Default ist 4. Explizit gesetzt, um die Kopplung an `resources.limits.cpu` sichtbar zu machen: mehr Threads als CPU-Zeit verfuegbar ist bringt bei diesem I/O-armen Hello-World-Workload keinen Durchsatzgewinn, nur Kontextwechsel-Overhead. |
| `NODE_ENV=production` | Deaktiviert Dev-spezifisches Verhalten in Node selbst und in ueblichen npm-Paketen (z. B. keine ausfuehrlichen Stacktraces/Debug-Logs). |

Es gibt bewusst **kein** GC-Algorithmus-Tuning wie bei der JVM (`-XX:+UseSerialGC`
im Java-Referenzprojekt): V8 nutzt einen einzigen, generationellen Collector
ohne austauschbare Strategien; das einzige relevante Hebel sind Heap-Grenzen
(`--max-old-space-size`) sowie ausreichend, aber nicht ueberdimensioniertes
`resources.limits.memory`.

---

## Kubernetes-Chart (`chart/`)

Struktur und Sicherheits-/Verfuegbarkeits-Defaults sind bewusst analog zum
Java-Referenzprojekt gehalten, mit folgenden Node-spezifischen Anpassungen:

- **Kein `ConfigMap`/gemountetes Config-File**: Node-Apps konfigurieren sich
  idiomatisch ueber Umgebungsvariablen. Alle Einstellungen laufen ueber
  `env`/`nodeOptions` in `values.yaml` direkt ins Deployment.
- **Kuerzere `terminationGracePeriodSeconds`/Probe-Intervalle**: Node startet
  und beendet sich typischerweise in unter einer Sekunde (kein
  Classloading/JIT-Warmup), daher kuerzere Startup-Probe-Intervalle und ein
  kleineres Termination-Grace-Fenster als im JVM-Pendant.
- **`readOnlyRootFilesystem: true`** bleibt erhalten; ein `emptyDir` wird nur
  fuer `/tmp` gemountet, falls eine Abhaengigkeit dort transient schreibt.

| Ressource | Zweck |
|---|---|
| `templates/deployment.yaml` | Deployment mit RollingUpdate (`maxUnavailable: 0`), Pod-AntiAffinity ueber Nodes, non-root `securityContext` (Pod + Container), Startup-/Readiness-/Liveness-Probes gegen den Management-Port, `preStop`-Sleep, Resource-Requests/-Limits. |
| `templates/service.yaml` | `ClusterIP`-Service, exposed nur den Application-Port (8080) - der Management-Port bleibt absichtlich unexposed. |
| `templates/poddisruptionbudget.yaml` | Begrenzt gleichzeitige freiwillige Disruptions (Node-Drain, Cluster-Autoscaler-Downscale); schuetzt **nicht** vor Crashes/OOM-Kills. |
| `templates/gateway.yaml` | Istio `Gateway` (nur bei `istio.gateway.enabled: true`), bindet den bestehenden `istio-ingressgateway`-Service ueber `spec.selector` an den in `istio.host` konfigurierten Hostnamen. |
| `templates/virtualservice.yaml` | Istio `VirtualService`, routet Traffic fuer `istio.host` vom Gateway auf den `Service` (Application-Port). |

### Zugriff ueber den Istio Ingress Gateway

`istio.host` ist standardmaessig `nodejs-hello-world.localhost` gesetzt -
diese TLD wird von den meisten Resolvern (RFC 6761) automatisch auf
`127.0.0.1` aufgeloest, ganz ohne `/etc/hosts`-Eintrag:

```bash
curl http://nodejs-hello-world.localhost:80/hello
```
