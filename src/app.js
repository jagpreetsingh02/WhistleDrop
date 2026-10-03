'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const env = require('./config/env');
const { openApiSpec, swaggerUiOptions } = require('./config/swagger');
const apiRoutes = require('./routes');
const { globalLimiter } = require('./middleware/rateLimiter');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

/**
 * Builds the Express application.
 *
 * Exported separately from `server.js` so the test suite can drive the app
 * with supertest without opening a port or connecting to a real database.
 */
function createApp() {
  const app = express();

  // Behind a load balancer every request arrives from the balancer's IP. If
  // Express is not told how many proxy hops to trust, all reporters share a
  // single rate-limit bucket — one abuser locks everyone out. TRUST_PROXY sets
  // the hop count; the resolved IP is used only as an in-memory limiter key.
  app.set('trust proxy', env.trustProxy);

  // Sensible security headers (HSTS, no-sniff, frameguard, hidden X-Powered-By).
  app.use(helmet());

  app.use(cors({ origin: env.corsOrigin }));

  // Reports are text. A small body cap keeps oversized payloads from reaching
  // the database layer at all.
  app.use(express.json({ limit: '100kb' }));

  // Liveness probe — deliberately outside the versioned API and the limiter.
  app.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      data: { status: 'ok', uptime: process.uptime(), environment: env.nodeEnv },
    });
  });

  app.get('/', (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        name: 'WhistleDrop API',
        tagline: 'Speak without being seen.',
        docs: '/api-docs',
        openapi: '/api-docs.json',
        api: '/api/v1',
      },
    });
  });

  // Interactive documentation. Swagger UI needs inline styles/scripts, so it
  // gets a slightly relaxed CSP than the rest of the app — scoped to this path
  // only, never applied to the API itself.
  app.use(
    '/api-docs',
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
        },
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, swaggerUiOptions)
  );

  app.get('/api-docs.json', (_req, res) => res.status(200).json(openApiSpec));

  // Baseline throttle for the whole API; individual routes add tighter limits.
  app.use('/api/v1', globalLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
