'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/**
 * Spins up an in-memory MongoDB per test file. Tests therefore run against a
 * real MongoDB (indexes, unique constraints, aggregation all behave as in
 * production) without needing a server installed or a shared database that
 * tests could pollute for each other.
 */
let mongoServer;

async function connect(serverOptions = {}) {
  mongoServer = await MongoMemoryServer.create(serverOptions);
  await mongoose.connect(mongoServer.getUri());
  // Unique indexes (e.g. caseCodeHash) must exist for the tests that rely on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

async function clear() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

async function close() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
}

module.exports = { connect, clear, close };
