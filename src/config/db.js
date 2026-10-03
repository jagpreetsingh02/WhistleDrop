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
  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.connection.close();
  logger.info('MongoDB disconnected');
}

module.exports = { connectDatabase, disconnectDatabase };
