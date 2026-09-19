import { Counter } from '@prometheus-io/client';

const helloRequestsTotal = new Counter({
  name: 'nodejs_hello_world_hello_requests_total',
  help: 'Total number of /hello requests',
});

// Zaehler + Idempotency-Store: Node ist single-threaded pro Prozess, daher
// reicht ein einfacher Zaehler/Map ohne Locking (kein AtomicLong/ConcurrentHashMap noetig).
let counter = 0;
const idempotencyStore = new Map();

// gibt true zurueck, wenn die Route bedient wurde, sonst false (server.js faellt
// dann auf notFound() zurueck) - kein Express-Router noetig fuer zwei Routen.
export function handleHelloRoutes(req, res, url, sendJson) {
  if (req.method === 'GET' && url.pathname === '/hello') {
    counter += 1;
    helloRequestsTotal.inc();
    sendJson(res, 200, { message: 'Hello, World!', count: counter });
    return true;
  }

  // gleicher key liefert immer denselben, einmalig berechneten Wert zurueck
  // (Idempotency-Key-Pattern), statt bei jedem Aufruf neu hochzuzaehlen
  if (req.method === 'GET' && url.pathname === '/cpu') {
    const key = url.searchParams.get('key');
    if (!key) {
      sendJson(res, 400, { error: 'missing required query parameter: key' });
      return true;
    }
    if (!idempotencyStore.has(key)) {
      counter += 1;
      idempotencyStore.set(key, counter);
    }
    sendJson(res, 200, { key, value: idempotencyStore.get(key) });
    return true;
  }

  return false;
}
