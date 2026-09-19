import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { collectDefaultMetrics, register } from '@prometheus-io/client';
import { trace } from '@opentelemetry/api';
import { sdk as otelSdk } from './tracing.js';
import { logger } from './logger.js';
import { handleHelloRoutes } from './hello.js';

const APP_PORT = Number(process.env.PORT ?? 8080);
const MANAGEMENT_PORT = Number(process.env.MANAGEMENT_PORT ?? 8081);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

// Node's Default (5s) laeuft dem Idle-Timeout des Istio/Envoy-Sidecars davon:
// haelt Envoy eine Keep-Alive-Verbindung fuer laenger offen als Node bereit
// ist, killt Node sie serverseitig und Envoy bekommt sporadisch ein RST beim
// naechsten Reuse. keepAliveTimeout muss daher > Envoy-Idle-Timeout sein,
// headersTimeout wiederum > keepAliveTimeout (Node-Vorgabe).
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS ?? 65_000);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS ?? 66_000);

collectDefaultMetrics({ prefix: 'nodejs_hello_world_' });

// readinessState: wird erst true, sobald beide Server lauschen, und sofort
// false beim ersten SIGTERM/SIGINT (Traffic-Abschaltung, vgl. Spring's
// management.health.readinessstate). livenessState bleibt davon unberuehrt,
// damit Kubernetes den Pod waehrend eines geordneten Shutdowns nicht zusaetzlich killt.
let ready = false;
let shuttingDown = false;

// Actuator-artige HealthIndicator-Komposition: jede registrierte Check-Funktion
// liefert { status: 'UP' | 'DOWN', ... }, Gesamtstatus ist UP nur wenn alle es sind.
// Kuenftige Abhaengigkeiten (DB, Downstream-Call) registrieren sich hier, statt
// die Readiness weiter an das statische ready-Flag zu koppeln.
const healthChecks = new Map();

function registerHealthCheck(name, check) {
  healthChecks.set(name, check);
}

registerHealthCheck('app', async () => (ready && !shuttingDown ? { status: 'UP' } : { status: 'DOWN' }));

async function evaluateReadiness() {
  const components = {};
  let overallUp = true;
  for (const [name, check] of healthChecks) {
    try {
      components[name] = await check();
    } catch (err) {
      components[name] = { status: 'DOWN', error: err.message };
    }
    if (components[name].status !== 'UP') overallUp = false;
  }
  return { status: overallUp ? 'UP' : 'DOWN', components };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' });
}

// Request-ID: uebernimmt Istios x-request-id (Korrelation mit den
// Envoy-Access-Logs des Sidecars), sonst neu generiert. traceId/spanId kommen,
// falls vorhanden, vom aktiven OTel-Span (siehe tracing.js) dazu, damit Logs
// und Traces ueber dieselbe ID verknuepfbar sind.
function withRequestLogging(handler) {
  return async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    res.setHeader('x-request-id', requestId);
    const spanContext = trace.getActiveSpan()?.spanContext();
    req.log = logger.child({
      requestId,
      ...(spanContext && { traceId: spanContext.traceId, spanId: spanContext.spanId }),
    });

    const start = performance.now();
    try {
      await handler(req, res);
    } finally {
      req.log.info(
        {
          method: req.method,
          path: req.url,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - start),
        },
        'request completed',
      );
    }
  };
}

const appServer = http.createServer(
  withRequestLogging((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (handleHelloRoutes(req, res, url, sendJson)) return;
    notFound(res);
  }),
);

const managementServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health/liveness') {
    sendJson(res, 200, { status: 'UP' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health/readiness') {
    const result = await evaluateReadiness();
    sendJson(res, result.status === 'UP' ? 200 : 503, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
    return;
  }

  notFound(res);
});

for (const server of [appServer, managementServer]) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

appServer.listen(APP_PORT, () => {
  logger.info({ port: APP_PORT }, 'application server listening');
});

managementServer.listen(MANAGEMENT_PORT, () => {
  ready = true;
  logger.info({ port: MANAGEMENT_PORT }, 'management server listening');
});

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'refusing new traffic and draining connections');

  const forceExit = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  let pending = 2;
  const onClosed = () => {
    pending -= 1;
    if (pending === 0) {
      clearTimeout(forceExit);
      otelSdk
        .shutdown()
        .catch((err) => logger.warn({ err }, 'otel shutdown failed'))
        .finally(() => process.exit(exitCode));
    }
  };

  appServer.close(onClosed);
  managementServer.close(onClosed);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prozesszustand nach einem uncaught error ist nicht mehr vertrauenswuerdig
// (Node-Empfehlung: loggen und beenden statt weiterlaufen zu lassen) - der
// bestehende Drain-Mechanismus inkl. forceExit-Timeout uebernimmt den Rest,
// der Pod wird von Kubernetes anschliessend neu gestartet.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandledRejection');
  shutdown('unhandledRejection', 1);
});
