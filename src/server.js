'use strict';

const env = require('./config/env');
const createApp = require('./app');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const logger = require('./utils/logger');

/**
 * Entry point: connect to MongoDB first, then start listening. Starting the
 * other way round would let the API accept reports it cannot store.
 */
async function start() {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`WhistleDrop API listening on http://localhost:${env.port} (${env.nodeEnv})`);
    logger.info(`API docs available at http://localhost:${env.port}/api-docs`);
  });

  /** Finish in-flight requests, then close the database connection. */
  const shutdown = (signal) => async () => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Don't hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });
}

start().catch((error) => {
  logger.error('Failed to start WhistleDrop API:', error.message);
  process.exit(1);
});
