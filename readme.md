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

## Docker-Image

Es gibt zwei alternative Dockerfiles fuer dieselbe Runtime-Konfiguration
(gleiche `USER`/`WORKDIR`-Zielgroessen, gleicher Start-Befehl) - der
Unterschied liegt nur in der Basis-Image-Wahl:

| Datei | Basis-Image (Runtime-Stage) | Wann verwenden |
|---|---|---|
| [`service/Dockerfile`](service/Dockerfile) (Default, wird von `docker build service/` sowie der CI in [dockerpublish.yml](.github/workflows/dockerpublish.yml) genutzt) | Red Hat UBI10 (`registry.access.redhat.com/ubi10/nodejs-24-minimal`) | OpenShift-Betrieb, bestehender RHEL-Support-Vertrag, oder wenn RHEL-gepflegtes CVE-Patching/Compliance-Nachweis wichtiger ist als minimale Image-Groesse. Bringt weiterhin `bash`/Coreutils mit. |
| [`service/Dockerfile-Distroless`](service/Dockerfile-Distroless) (`docker build -f service/Dockerfile-Distroless -t ... service/`) | [Google Distroless](https://github.com/GoogleContainerTools/distroless) (`gcr.io/distroless/nodejs24-debian13:nonroot`) | Wenn minimale Angriffsflaeche/Image-Groesse Prioritaet hat und kein RHEL-Support-Bezug besteht. Kein Shell im Image - kein `kubectl exec ... sh`. |

Beide sind zweistufig gebaut: eine Builder-Stage fuer `npm ci`, und eine
schlanke Runtime-Stage, die nur `node_modules`/`package.json`/`src` kopiert.

### `service/Dockerfile` (UBI10, Default)

| Entscheidung | Begruendung |
|---|---|
| Zweistufiger Build (`deps` + Runtime) | `npm ci --omit=dev` laeuft in einer eigenen Stage, damit Layer-Caching greift, solange sich `package.json`/`package-lock.json` nicht aendern - Quellcode-Aenderungen erzwingen keinen erneuten `npm ci`. |
| `registry.access.redhat.com/ubi10/nodejs-24` als Builder-Stage (`deps`) | Volles Builder-Image (inkl. `npm`, Build-Toolchain), RHEL-10-basiert (glibc). `--mount=type=cache,target=/opt/app-root/src/.npm,uid=1001,gid=0` nutzt den BuildKit-Cache-Mount fuer den npm-Cache passend zum Default-User (UID 1001) dieses Basis-Images. |
| `registry.access.redhat.com/ubi10/nodejs-24-minimal` als Runtime-Stage | Gleiche RHEL-10-Basis wie der Builder, aber ohne die s2i-/Build-Tools, die zur Laufzeit nicht mehr gebraucht werden. Weiterhin mit `bash`/Coreutils - kein Attack-Surface-Minimum wie bei `Dockerfile-Distroless`, dafuer volle Debug-Faehigkeit per `kubectl exec ... bash` und Red-Hat-eigenes CVE-Tracking/Patching der Basis-Libraries. |
| `WORKDIR /opt/app-root/src` statt `/app` | Der Default-User des Basis-Images (UID 1001, OpenShift-"arbitrary uid"-Konvention: GID 0) koennte ein neues Verzeichnis wie `/app` nicht anlegen, da `/` nicht gruppen-beschreibbar ist - `/opt/app-root/src` ist im Image bereits fuer GID 0 beschreibbar vorbereitet. |
| `COPY --chown=1000:1000 ...` | Image-Default ist UID 1001/GID 0. Explizit auf UID/GID 1000 umgesetzt, damit der Dateibesitz mit `runAsUser`/`fsGroup` im Pod-SecurityContext ([chart/values.yaml](chart/values.yaml)) uebereinstimmt. |
| `USER 1000:1000` (numerisch) | Ueberschreibt den image-eigenen Default-User (UID 1001) explizit auf UID/GID 1000 aus demselben Grund. |
| Eigenes `ENTRYPOINT` statt des s2i-`container-entrypoint`-Wrappers | Der im Basis-Image gesetzte Wrapper ist nur ein `exec`-Passthrough (harmlos fuer PID-1/Signal-Handling), aber fuer diesen Nicht-s2i-Build ueberfluessig - `ENTRYPOINT ["node", "--import", "./src/tracing.js", "src/server.js"]` macht die Absicht explizit. `--import` laedt `tracing.js` **vor** `server.js`, damit die OTel-HTTP-Instrumentation das `http`-Modul patchen kann, bevor `server.js` es importiert. |
| `EXPOSE 8080 8081` | Getrennter Application- (8080) und Management-Port (8081), siehe unten. |

### `service/Dockerfile-Distroless` (Alternative)

| Entscheidung | Begruendung |
|---|---|
| `node:24-slim` als Builder-Stage (`deps`) statt `node:24-alpine` | Bewusst **kein** Alpine fuer den `npm ci`-Schritt: Alpine nutzt musl statt glibc, was bei nativen npm-Addons zu Kompatibilitaetsproblemen fuehren kann. `slim` ist Debian-basiert (glibc, maximal kompatibel) und trotzdem deutlich schlanker als das volle `node:24`-Image (kein Build-Toolchain/Doku-Overhead). |
| `gcr.io/distroless/nodejs24-debian13:nonroot` als Runtime-Stage | Enthaelt nur die Node-Runtime und noetige System-Libraries - kein Shell, kein Paketmanager, keine Coreutils. Kleinstes Image der drei Varianten (getestet: ~214 MB Basis vs. ~332 MB `node:24-slim` vs. ~343 MB `ubi10/nodejs-24-minimal`). Preis: kein `kubectl exec ... sh` mehr moeglich - fuer Debugging lokal kurzzeitig auf den `:debug-nonroot`-Tag wechseln oder `kubectl debug` mit einem Ephemeral-Container nutzen. |
| `COPY --chown=1000:1000 ...` statt `RUN chown -R node:node /app` | Distroless hat kein Shell, `chown` ist im finalen Image also gar nicht verfuegbar - der Dateibesitz wird stattdessen ueber das BuildKit-Feature `--chown` direkt beim `COPY` gesetzt (laeuft im Builder, nicht im Zielimage). |
| `USER 1000:1000` (numerisch) | Ueberschreibt den image-eigenen `nonroot`-Default-User des Distroless-Images (UID/GID 65532) explizit auf UID/GID 1000, damit `runAsUser`/`fsGroup` im Pod-SecurityContext ([chart/values.yaml](chart/values.yaml)) mit dem Dateibesitz der `COPY --chown`-Befehle uebereinstimmen. Funktioniert rein numerisch auch ohne `/etc/passwd`-Eintrag im Image. |
| Kein eigenes `ENTRYPOINT`, stattdessen `CMD` | Das Distroless-Image setzt `ENTRYPOINT` bereits auf die eingebettete Node-Binary - der Node-Prozess wird dadurch direkt PID 1 und erhaelt `SIGTERM` unmittelbar, ganz ohne Shell-Wrapper. `CMD ["--import", "./src/tracing.js", "src/server.js"]` liefert nur noch die Argumente. |

Beide Varianten wurden lokal gebaut und gegen `readOnlyRootFilesystem`
(`docker run --read-only --tmpfs /tmp`), `/health/readiness`, `USER 1000:1000`
und sauberen `SIGTERM`-Shutdown (Exit-Code 0) getestet.

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
| `--max-old-space-size=160` | Node/V8 leitet die Heap-Groesse **nicht** automatisch aus dem cgroup-Memory-Limit ab (anders als container-aware JVMs via `-XX:MaxRAMPercentage`). Ohne dieses Flag kann der Heap im Zweifel ueber `resources.limits.memory` (hier 256Mi) hinauswachsen und der Container wird vom Kubelet per OOM-Kill beendet, statt dass V8 selbst kontrolliert Garbage Collection betreibt. Der Wert liegt bewusst deutlich unter dem Memory-Limit, da der tatsaechliche Speicherverbrauch (RSS) zusaetzlich Code, Stacks, Buffer und native Allocations ausserhalb des V8-Heaps enthaelt. Node 20+ liest cgroup-Limits zwar inzwischen automatisch fuer die Heap-Groesse aus, das gilt aber insbesondere unter cgroup v2 laut mehreren Quellen noch als unzuverlässig - das explizite Flag ist daher weiterhin die sicherere Wahl ([Red Hat Developer: Node.js 20+ memory management in containers](https://developers.redhat.com/articles/2025/10/10/nodejs-20-memory-management-containers)). |
| `--max-http-header-size=16384` | Begrenzt die maximale Groesse eingehender HTTP-Header (Default 16 KiB) explizit, um das Verhalten unabhaengig von der Node-Version stabil zu halten und ueberdimensionierte Header nicht erst spaet (z. B. am Ingress) abzufangen. |
| `UV_THREADPOOLSIZE=4` | Groesse des libuv-Thread-Pools (fuer DNS-Lookups, Dateisystem, Crypto etc.), Default ist 4. Explizit gesetzt, um die Kopplung an `resources.limits.cpu` sichtbar zu machen: mehr Threads als CPU-Zeit verfuegbar ist bringt bei diesem I/O-armen Hello-World-Workload keinen Durchsatzgewinn, nur Kontextwechsel-Overhead. |
| `NODE_ENV=production` | Deaktiviert Dev-spezifisches Verhalten in Node selbst und in ueblichen npm-Paketen (z. B. keine ausfuehrlichen Stacktraces/Debug-Logs). |
| `NODE_COMPILE_CACHE=/tmp/node-compile-cache` | Seit Node 22.1 persistiert diese Env-Var den V8-Code-Cache (kompilierte Bytecode-Darstellung der Module) auf Disk, sodass ein nachfolgender Prozessstart nicht erneut parsen/kompilieren muss. Zeigt bewusst auf `/tmp`, weil dort ohnehin ein beschreibbares `emptyDir`-Volume gemountet ist (`readOnlyRootFilesystem: true` verbietet Schreiben anderswo im Image). **Wichtig zur Reichweite:** Das `emptyDir` ist an den *Pod* gebunden, nicht an das Image - es ueberlebt Container-Neustarts *innerhalb* desselben Pods (z. B. nach `uncaughtException`/OOM-Kill, siehe [Graceful Shutdown](#graceful-shutdown)), bringt aber **keinen** Vorteil beim allerersten Start eines neu geschedulten Pods (Scale-out, Node-Wechsel) - dort ist der Cache-Ordner leer und wird erst waehrend dieses Laufs befuellt. |

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
