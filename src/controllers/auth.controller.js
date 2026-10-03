'use strict';

const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/auth.service');

/** POST /api/v1/auth/login — exchanges moderator credentials for a JWT. */
const login = asyncHandler(async (req, res) => {
  const { username, password } = req.validated.body;
  const result = await authService.login({ username, password });

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: result,
  });
});

/** GET /api/v1/auth/me — confirms who the presented token belongs to. */
const me = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      id: req.moderator._id.toString(),
      username: req.moderator.username,
      displayName: req.moderator.displayName,
    },
  });
});

module.exports = { login, me };
