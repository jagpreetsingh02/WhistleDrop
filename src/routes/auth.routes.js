'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const noStore = require('../middleware/noStore');
const { loginLimiter } = require('../middleware/rateLimiter');
const { requireModerator } = require('../middleware/auth');
const { login, me } = require('../controllers/auth.controller');
const { loginSchema } = require('../validators/auth.validator');

const router = express.Router();

// Login responses carry a bearer token; never let a cache keep one.
router.use(noStore);

router.post('/login', loginLimiter, validate({ body: loginSchema }), login);
router.get('/me', requireModerator, me);

module.exports = router;
