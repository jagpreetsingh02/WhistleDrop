'use strict';

const http = require('http');
const supertest = require('supertest');

/**
 * Serves an Express app on 127.0.0.1 for supertest.
 *
 * Why not just `supertest(app)`? It calls `app.listen(0)`, which binds the
 * IPv6 wildcard [::], and then connects to 127.0.0.1. On macOS a wildcard bind
 * does not conflict with another process already listening on 127.0.0.1 at
 * the same port — each test file's in-memory mongod, for instance — so every
 * so often a request is delivered to the wrong process: a stray 404 from
 * someone else's server, or a hang until the test times out. Binding to
 * 127.0.0.1 ourselves makes the OS hand out a port that is genuinely free on
 * the address the client connects to.
 */
async function listenOnLoopback(app) {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    request: () => supertest(url),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Starts the server before the file's tests and stops it afterwards. Returns
 * a function that yields a supertest client for that server.
 */
function useLoopbackServer(app) {
  let served = null;

  beforeAll(async () => {
    served = await listenOnLoopback(app);
  });

  afterAll(async () => {
    if (served) await served.close();
  });

  return () => {
    if (!served)
      throw new Error('Test server is not listening yet — call it inside a test or hook');
    return served.request();
  };
}

module.exports = { listenOnLoopback, useLoopbackServer };
