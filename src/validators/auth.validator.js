'use strict';

const { z } = require('zod');

const loginSchema = z.strictObject({
  username: z.string({ message: 'username is required' }).trim().min(3).max(40),
  password: z.string({ message: 'password is required' }).min(8).max(128),
});

module.exports = { loginSchema };
