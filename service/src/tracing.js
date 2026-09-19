// Wird per `node --import ./src/tracing.js` VOR server.js geladen, damit die
// HTTP-Instrumentation das http-Modul patchen kann, bevor server.js es importiert
// (Patchen nach dem Import von node:http haette keine Wirkung mehr).
//
// Ohne Collector einfach per OTEL_SDK_DISABLED=true (Standard-OTel-Env-Var)
// deaktivieren, statt Fehlermeldungen beim Export-Versuch zu bekommen.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'nodejs-hello-world',
  }),
  // liest Endpoint/Headers/Protokoll automatisch aus den Standard-Env-Vars
  // OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new HttpInstrumentation()],
});

sdk.start();
