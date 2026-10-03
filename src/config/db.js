'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

/**
 * Connects to MongoDB. Called from server.js before the HTTP server starts,
 * so the API never accepts traffic it cannot serve.
 */
async function connectDatabase(uri = env.mongoUri) {
  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  logger.info('MongoDB connected');

  // Bring indexes in line with the schemas. Mongoose's autoIndex only ever
  // creates indexes, so without this a changed RETENTION_DAYS_AFTER_CLOSE
  // would hit an "index options conflict" and the old TTL would stay active,
  // and setting it to 0 would never remove the TTL index.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  logger.info('MongoDB indexes synchronised');

  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.connection.close();
  logger.info('MongoDB disconnected');
}

module.exports = { connectDatabase, disconnectDatabase };
