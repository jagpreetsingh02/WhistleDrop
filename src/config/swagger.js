'use strict';

const { CATEGORIES, STATUSES, VISIBILITIES, ROLES, AUDIT_ACTIONS } = require('../utils/constants');
const { PII_WARNING_CODES } = require('../utils/piiScanner');
const { ALLOWED_TRANSITIONS } = require('../utils/statusWorkflow');

/**
 * Hand-written OpenAPI 3 document.
 *
 * Kept in one file (rather than JSDoc comments spread across routes) so the
 * contract can be read top-to-bottom, reviewed in a diff, and exported to any
 * other tool as-is.
 */

const errorResponse = (description, example) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
      example,
    },
  },
});

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'WhistleDrop API',
    version: '1.0.0',
    description: [
      '**Speak without being seen.**',
      '',
      'WhistleDrop accepts anonymous reports and lets the reporter follow the case',
      'using a one-time case code — no account, no email, no session.',
      '',
      '### Try it',
      '1. `POST /reports` and copy the `caseCode` from the response (shown only once).',
      '2. `GET /reports/{caseCode}` to see status, public updates and messages.',
      '3. `POST /auth/login` as a moderator or admin, click **Authorize**, paste the token.',
      '4. Work the queue under `/moderator/*`: search, review, change status, add notes,',
      '   ask the reporter a question.',
      '5. Reply as the reporter with `POST /reports/{caseCode}/messages`.',
      '6. As an admin, manage accounts and check `GET /admin/audit-log/verify`.',
      '',
      '### Roles',
      '- **Reporter** — anonymous; the case code is the only credential.',
      '- **moderator** — reads and works reports (`/moderator/*`).',
      '- **admin** — everything a moderator can do, plus `/admin/*`.',
      '',
      '### Privacy',
      'No IP address, user-agent, email or account is stored against a report. Only a',
      'SHA-256 hash of the case code is persisted. Reporter timestamps are rounded down',
      'to a 15-minute bucket, closed reports are deleted after a retention period, and',
      'reporter-facing responses never reveal which moderator acted.',
      '',
      '### Errors',
      'Every error uses `{ success: false, error: { message, details? } }`.',
      '`400` malformed input · `401` not authenticated · `403` wrong role ·',
      '`404` unknown · `409` state conflict · `422` workflow violation · `429` rate limited.',
    ].join('\n'),
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
  },
  servers: [{ url: '/api/v1', description: 'Current server' }],
  tags: [
    { name: 'Meta', description: 'Service metadata and health' },
    { name: 'Reports (public)', description: 'Anonymous submission and tracking' },
    { name: 'Auth', description: 'Moderator authentication' },
    { name: 'Moderation', description: 'Protected moderator operations' },
    { name: 'Admin', description: 'Staff account management — admin role only' },
  ],
  components: {
    headers: {
      CacheControlNoStore: {
        description:
          'Always `no-store`: case codes and case status must never be kept by a browser, proxy or CDN.',
        schema: { type: 'string', example: 'no-store' },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the token returned by `POST /auth/login`.',
      },
    },
    schemas: {
      Category: { type: 'string', enum: [...CATEGORIES], example: 'SECURITY' },
      Visibility: {
        type: 'string',
        enum: [...VISIBILITIES],
        example: 'PUBLIC',
        description: 'PUBLIC updates are shown to the reporter; INTERNAL notes are moderator-only.',
      },
      Status: { type: 'string', enum: [...STATUSES], example: 'SUBMITTED' },

      SubmitReportRequest: {
        type: 'object',
        required: ['category', 'description'],
        additionalProperties: false,
        properties: {
          category: { $ref: '#/components/schemas/Category' },
          description: {
            type: 'string',
            minLength: 20,
            maxLength: 5000,
            description: 'What happened. Avoid including details that identify you.',
            example:
              'Customer database backups are stored in a public bucket with no encryption or access control.',
          },
          evidenceUrl: {
            type: 'string',
            format: 'uri',
            nullable: true,
            maxLength: 2048,
            description: 'Optional http(s) link to externally hosted evidence.',
            example: 'https://example.com/evidence/2026-09-21',
          },
        },
      },

      PiiWarning: {
        type: 'object',
        description:
          'A kind of possibly-identifying content found in reporter text. Never includes the matched text, and never blocks the request.',
        properties: {
          code: { type: 'string', enum: PII_WARNING_CODES, example: 'POSSIBLE_EMAIL' },
          message: {
            type: 'string',
            example:
              'The text appears to contain an email address. Moderators will see this text. If it could identify you, avoid repeating such details in follow-up messages.',
          },
        },
      },

      SubmitReportResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              caseCode: { type: 'string', example: 'WD-4K9TM-XQ7YB-2NHVR' },
              category: { $ref: '#/components/schemas/Category' },
              status: { $ref: '#/components/schemas/Status' },
              submittedAt: {
                type: 'string',
                format: 'date-time',
                description:
                  'Start of the TIMESTAMP_BUCKET_MINUTES window (default 15 min) the report arrived in — never the exact time.',
                example: '2026-09-21T14:30:00.000Z',
              },
              warnings: {
                type: 'array',
                items: { $ref: '#/components/schemas/PiiWarning' },
                description: 'Empty when nothing identifying was detected.',
              },
            },
          },
        },
      },

      ReporterUpdate: {
        type: 'object',
        properties: {
          message: { type: 'string', example: 'A moderator has started reviewing this case.' },
          status: {
            type: 'string',
            enum: [...STATUSES, null],
            nullable: true,
            example: 'UNDER_REVIEW',
            description: 'Status this update moved the case to, or null for a note.',
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      Message: {
        type: 'object',
        properties: {
          from: { type: 'string', enum: ['REPORTER', 'MODERATOR'], example: 'MODERATOR' },
          body: {
            type: 'string',
            maxLength: 1000,
            example: 'Which repository are the credentials in?',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description:
              'Reporter messages carry the start of their time bucket, not the exact time. Thread order is authoritative.',
          },
        },
      },

      MessageRequest: {
        type: 'object',
        required: ['body'],
        additionalProperties: false,
        properties: {
          body: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            example: 'It is the infra-scripts repo, in the deploy folder.',
          },
        },
      },

      ReporterCase: {
        type: 'object',
        properties: {
          category: { $ref: '#/components/schemas/Category' },
          status: { $ref: '#/components/schemas/Status' },
          submittedAt: { type: 'string', format: 'date-time' },
          lastUpdatedAt: {
            type: 'string',
            format: 'date-time',
            description: 'Latest change visible to the reporter (internal notes do not count).',
          },
          isClosed: { type: 'boolean', example: false },
          awaitingYourReply: {
            type: 'boolean',
            example: true,
            description: 'A moderator has asked a question that has not been answered yet.',
          },
          updates: {
            type: 'array',
            items: { $ref: '#/components/schemas/ReporterUpdate' },
          },
          messages: {
            type: 'array',
            description: 'The follow-up thread. Never says which moderator wrote a message.',
            items: { $ref: '#/components/schemas/Message' },
          },
        },
      },

      TrackReportResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/ReporterCase' },
        },
      },

      ReportSummary: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '66f1c0a4b6f4c2a1d8e3b9f2' },
          category: { $ref: '#/components/schemas/Category' },
          status: { $ref: '#/components/schemas/Status' },
          descriptionPreview: { type: 'string' },
          hasEvidence: { type: 'boolean' },
          updateCount: { type: 'integer', example: 2 },
          messageCount: { type: 'integer', example: 1 },
          awaitingReporter: { type: 'boolean', example: true },
          submittedAt: { type: 'string', format: 'date-time' },
          lastUpdatedAt: { type: 'string', format: 'date-time' },
        },
      },

      ReportDetail: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { $ref: '#/components/schemas/Category' },
          description: { type: 'string' },
          evidenceUrl: { type: 'string', nullable: true },
          status: { $ref: '#/components/schemas/Status' },
          allowedTransitions: {
            type: 'array',
            items: { $ref: '#/components/schemas/Status' },
            description: 'Statuses this report may move to next.',
          },
          submittedAt: { type: 'string', format: 'date-time' },
          lastUpdatedAt: { type: 'string', format: 'date-time' },
          awaitingReporter: { type: 'boolean', example: false },
          messages: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/Message' },
                {
                  type: 'object',
                  properties: {
                    moderator: {
                      type: 'object',
                      nullable: true,
                      description: 'Author of a MODERATOR message; null for reporter messages.',
                      properties: { id: { type: 'string' }, displayName: { type: 'string' } },
                    },
                  },
                },
              ],
            },
          },
          closedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description:
              'When the report became RESOLVED or DISMISSED. The report is deleted RETENTION_DAYS_AFTER_CLOSE days later.',
          },
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                message: { type: 'string' },
                status: { type: 'string', nullable: true },
                visibility: { $ref: '#/components/schemas/Visibility' },
                createdAt: { type: 'string', format: 'date-time' },
                moderator: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    displayName: { type: 'string', example: 'Ethics Desk' },
                  },
                },
              },
            },
          },
        },
      },

      Role: { type: 'string', enum: [...ROLES], example: 'moderator' },

      StaffAccount: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '6ab17466f6cabe35b17ce5cc' },
          username: { type: 'string', example: 'neha.r' },
          displayName: { type: 'string', example: 'Compliance Desk' },
          role: { $ref: '#/components/schemas/Role' },
          isActive: { type: 'boolean', example: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      CreateStaffRequest: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: {
            type: 'string',
            minLength: 3,
            maxLength: 40,
            pattern: '^[a-z0-9._-]+$',
            description: 'Stored lower-case.',
            example: 'neha.r',
          },
          password: {
            type: 'string',
            format: 'password',
            minLength: 12,
            maxLength: 128,
            example: 'An0ther-Long-Passphrase',
          },
          displayName: { type: 'string', maxLength: 80, example: 'Compliance Desk' },
          role: { allOf: [{ $ref: '#/components/schemas/Role' }], default: 'moderator' },
        },
      },

      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 20 },
          total: { type: 'integer', example: 2 },
          totalPages: { type: 'integer', example: 1 },
        },
      },

      AuditEntry: {
        type: 'object',
        description:
          'One staff action. Contains ids and the action only — never report text, case codes or network identifiers.',
        properties: {
          seq: { type: 'integer', example: 42 },
          action: { type: 'string', enum: [...AUDIT_ACTIONS], example: 'VIEW_REPORT' },
          moderator: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              username: { type: 'string', example: 'alice' },
              displayName: { type: 'string', example: 'Ethics Desk' },
            },
          },
          reportId: { type: 'string', nullable: true, example: '6ab17466f6cabe35b17ce5cf' },
          targetModeratorId: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          prevHash: { type: 'string', example: '3b1f…(64 hex chars)' },
          hash: { type: 'string', example: '9c4e…(64 hex chars)' },
        },
      },

      AuditVerifyResult: {
        type: 'object',
        properties: {
          intact: { type: 'boolean' },
          checkedEntries: {
            type: 'integer',
            description: 'Entries verified before the first break.',
          },
          headSeq: { type: 'integer', description: 'Present when intact.' },
          headHash: {
            type: 'string',
            description:
              'Present when intact. Record it outside the database: comparing it later is the only way to detect the newest entries being deleted.',
          },
          brokenAtSeq: { type: 'integer', description: 'Present when not intact.' },
          reason: {
            type: 'string',
            enum: ['MISSING_ENTRY', 'PREVIOUS_HASH_MISMATCH', 'CONTENT_HASH_MISMATCH'],
            description: 'Present when not intact.',
          },
        },
      },

      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: { type: 'string', example: 'moderator' },
          password: { type: 'string', format: 'password', example: 'Str0ngPassphrase!' },
        },
      },

      LoginResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Login successful' },
          data: {
            type: 'object',
            properties: {
              token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
              expiresIn: { type: 'string', example: '2h' },
              moderator: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  username: { type: 'string' },
                  displayName: { type: 'string' },
                  role: { $ref: '#/components/schemas/Role' },
                },
              },
            },
          },
        },
      },

      UpdateStatusRequest: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: {
          status: { $ref: '#/components/schemas/Status' },
          message: {
            type: 'string',
            minLength: 5,
            maxLength: 500,
            description:
              'Note shown to the reporter. Defaults to "Status changed to X" if omitted.',
            example: 'We have opened an investigation and contacted the infrastructure team.',
          },
        },
      },

      AddUpdateRequest: {
        type: 'object',
        required: ['message'],
        additionalProperties: false,
        properties: {
          message: {
            type: 'string',
            minLength: 5,
            maxLength: 500,
            example: 'Still in progress — we expect an outcome within two weeks.',
          },
          visibility: {
            allOf: [{ $ref: '#/components/schemas/Visibility' }],
            default: 'PUBLIC',
          },
        },
      },

      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              details: {
                description:
                  'Present only when there is more to say: field-level validation errors (array), or conflict/workflow context (object).',
                oneOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        field: { type: 'string', example: 'body.description' },
                        message: { type: 'string' },
                      },
                    },
                  },
                  { type: 'object' },
                ],
              },
            },
          },
        },
      },
    },
  },

  paths: {
    '/health': {
      get: {
        operationId: 'getHealth',
        // Public: no authentication, by design.
        security: [],
        tags: ['Meta'],
        summary: 'Liveness probe',
        responses: {
          200: {
            description: 'Service is up',
            content: {
              'application/json': { example: { success: true, data: { status: 'ok' } } },
            },
          },
          429: errorResponse('Too many requests'),
        },
      },
    },

    '/meta': {
      get: {
        operationId: 'getMeta',
        // Public: no authentication, by design.
        security: [],
        tags: ['Meta'],
        summary: 'Categories, statuses and the status workflow',
        responses: {
          200: {
            description: 'Service metadata',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: {
                    categories: CATEGORIES,
                    statuses: STATUSES,
                    workflow: ALLOWED_TRANSITIONS,
                  },
                },
              },
            },
          },
          429: errorResponse('Too many requests'),
        },
      },
    },

    '/reports': {
      post: {
        operationId: 'submitReport',
        // Public: no authentication, by design.
        security: [],
        tags: ['Reports (public)'],
        summary: 'Submit an anonymous report',
        description:
          'No authentication. The returned `caseCode` is shown once and is the only way to track the case.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubmitReportRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Report stored, case code issued',
            headers: { 'Cache-Control': { $ref: '#/components/headers/CacheControlNoStore' } },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubmitReportResponse' },
              },
            },
          },
          400: errorResponse('Validation failed', {
            success: false,
            error: {
              message: 'Validation failed',
              details: [
                {
                  field: 'body.description',
                  message: 'description must be at least 20 characters',
                },
              ],
            },
          }),
          429: errorResponse('Too many submissions from this network', {
            success: false,
            error: {
              message: 'Too many reports submitted from this network. Please try again later.',
            },
          }),
        },
      },
    },

    '/reports/{caseCode}': {
      get: {
        operationId: 'trackReport',
        // Public: no authentication, by design.
        security: [],
        tags: ['Reports (public)'],
        summary: 'Track a case with its code',
        description:
          'Case-insensitive; dashes and spaces are ignored. Returns status and moderator updates only.',
        parameters: [
          {
            name: 'caseCode',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            example: 'WD-4K9TM-XQ7YB-2NHVR',
          },
        ],
        responses: {
          200: {
            description: 'Current status of the case',
            headers: { 'Cache-Control': { $ref: '#/components/headers/CacheControlNoStore' } },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TrackReportResponse' },
              },
            },
          },
          400: errorResponse('Malformed case code', {
            success: false,
            error: {
              message: 'Validation failed',
              details: [{ field: 'params.caseCode', message: 'caseCode is not a valid case code' }],
            },
          }),
          404: errorResponse('Unknown case code', {
            success: false,
            error: { message: 'No case found for that code. Check the code and try again.' },
          }),
          429: errorResponse('Too many lookups', {
            success: false,
            error: { message: 'Too many case lookups. Please try again later.' },
          }),
        },
      },
    },

    '/reports/{caseCode}/messages': {
      post: {
        operationId: 'sendReporterMessage',
        // Public: no authentication, by design.
        security: [],
        tags: ['Reports (public)'],
        summary: 'Reply to moderators anonymously',
        description:
          'Uses only the case code. Clears `awaitingYourReply`. The text is scanned for identifying details and `warnings` are returned (codes only). Rejected with 409 once the case is closed.',
        parameters: [
          {
            name: 'caseCode',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            example: 'WD-4K9TM-XQ7YB-2NHVR',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/MessageRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Message added; returns the case as the reporter sees it, plus warnings',
            headers: { 'Cache-Control': { $ref: '#/components/headers/CacheControlNoStore' } },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Message sent' },
                    data: {
                      allOf: [
                        { $ref: '#/components/schemas/ReporterCase' },
                        {
                          type: 'object',
                          properties: {
                            warnings: {
                              type: 'array',
                              items: { $ref: '#/components/schemas/PiiWarning' },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          400: errorResponse('Malformed case code or invalid body'),
          404: errorResponse('Unknown case code', {
            success: false,
            error: { message: 'No case found for that code. Check the code and try again.' },
          }),
          409: errorResponse('Case is closed, or the thread is full', {
            success: false,
            error: { message: 'This case is closed (RESOLVED) and no longer accepts messages' },
          }),
          429: errorResponse('Too many messages', {
            success: false,
            error: { message: 'Too many messages sent. Please wait before replying again.' },
          }),
        },
      },
    },

    '/auth/login': {
      post: {
        operationId: 'login',
        // Public: no authentication, by design.
        security: [],
        tags: ['Auth'],
        summary: 'Moderator login',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } },
          },
        },
        responses: {
          200: {
            description: 'JWT issued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } },
            },
          },
          400: errorResponse('Validation failed'),
          401: errorResponse('Bad credentials', {
            success: false,
            error: { message: 'Invalid username or password' },
          }),
          429: errorResponse('Too many login attempts'),
        },
      },
    },

    '/auth/me': {
      get: {
        operationId: 'getCurrentAccount',
        tags: ['Auth'],
        summary: 'Current moderator profile',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'The account the token belongs to',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', example: '6ab17466f6cabe35b17ce5cc' },
                        username: { type: 'string', example: 'alice' },
                        displayName: { type: 'string', example: 'Ethics Desk' },
                        role: { $ref: '#/components/schemas/Role' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: errorResponse('Missing, invalid or expired token'),
        },
      },
    },

    '/moderator/reports': {
      get: {
        operationId: 'listReports',
        tags: ['Moderation'],
        summary: 'List, search and filter reports',
        description:
          'All filters combine with AND. `q` uses a MongoDB text index over descriptions: words are stemmed and OR-ed, `"exact phrase"` and `-excluded` are supported. Dates filter on the (coarsened) submission time.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/Status' } },
          { name: 'category', in: 'query', schema: { $ref: '#/components/schemas/Category' } },
          {
            name: 'q',
            in: 'query',
            description: 'Full-text search over descriptions.',
            schema: { type: 'string', minLength: 2, maxLength: 100 },
            example: 'credentials',
          },
          {
            name: 'from',
            in: 'query',
            description: 'Inclusive lower bound — ISO 8601 date or date-time.',
            schema: { type: 'string', example: '2026-09-01' },
          },
          {
            name: 'to',
            in: 'query',
            description:
              'Upper bound — ISO 8601 date or date-time. A plain date includes that whole day. Must not be earlier than `from`.',
            schema: { type: 'string', example: '2026-09-30' },
          },
          {
            name: 'hasEvidence',
            in: 'query',
            description: 'Only reports with (true) or without (false) an evidence link.',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
          {
            name: 'awaitingReporter',
            in: 'query',
            description: 'Only cases waiting (true) or not waiting (false) for a reporter reply.',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          {
            name: 'sort',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['newest', 'oldest', 'recentlyUpdated'],
              default: 'newest',
            },
          },
        ],
        responses: {
          200: {
            description: 'Paginated list of report summaries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ReportSummary' },
                    },
                    meta: {
                      allOf: [
                        { $ref: '#/components/schemas/Pagination' },
                        {
                          type: 'object',
                          properties: {
                            sort: { type: 'string', example: 'newest' },
                            filters: {
                              type: 'object',
                              description: 'Applied filters, normalised (null = not applied).',
                              example: {
                                status: null,
                                category: 'SECURITY',
                                q: 'credentials',
                                from: '2026-09-01T00:00:00.000Z',
                                toExclusive: '2026-10-01T00:00:00.000Z',
                                hasEvidence: true,
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          400: errorResponse('Invalid filter value', {
            success: false,
            error: {
              message: 'Validation failed',
              details: [{ field: 'query.to', message: 'to must not be earlier than from' }],
            },
          }),
          401: errorResponse('Missing or invalid token'),
        },
      },
    },

    '/moderator/reports/{id}': {
      get: {
        operationId: 'getReport',
        tags: ['Moderation'],
        summary: 'Read one report in full',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Full report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: '#/components/schemas/ReportDetail' },
                  },
                },
              },
            },
          },
          400: errorResponse('Malformed report id'),
          401: errorResponse('Missing or invalid token'),
          404: errorResponse('Report not found'),
        },
      },
    },

    '/moderator/reports/{id}/status': {
      patch: {
        operationId: 'updateReportStatus',
        tags: ['Moderation'],
        summary: 'Move a report to the next status',
        description:
          'Allowed transitions: SUBMITTED → UNDER_REVIEW | DISMISSED, UNDER_REVIEW → RESOLVED | DISMISSED. RESOLVED and DISMISSED are final.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UpdateStatusRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Status changed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    data: { $ref: '#/components/schemas/ReportDetail' },
                  },
                },
              },
            },
          },
          400: errorResponse('Validation failed'),
          401: errorResponse('Missing or invalid token'),
          404: errorResponse('Report not found'),
          409: errorResponse(
            'Report is already in that status, or another moderator changed it while this request was in flight',
            {
              success: false,
              error: {
                message:
                  'Report status changed from UNDER_REVIEW to RESOLVED while this request was in flight. Reload and try again.',
                details: { expectedStatus: 'UNDER_REVIEW', currentStatus: 'RESOLVED' },
              },
            }
          ),
          422: errorResponse('Illegal status transition', {
            success: false,
            error: {
              message: 'Cannot change status from SUBMITTED to RESOLVED',
              details: {
                currentStatus: 'SUBMITTED',
                requestedStatus: 'RESOLVED',
                allowedTransitions: ['UNDER_REVIEW', 'DISMISSED'],
              },
            },
          }),
        },
      },
    },

    '/moderator/reports/{id}/updates': {
      post: {
        operationId: 'addReportUpdate',
        tags: ['Moderation'],
        summary: 'Add a public update or an internal note without changing status',
        description:
          'PUBLIC (default) updates appear on the reporter tracking page. INTERNAL notes are visible to moderators only and do not move the reporter-facing lastUpdatedAt.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AddUpdateRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Update or internal note added; returns the full report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Internal note added' },
                    data: { $ref: '#/components/schemas/ReportDetail' },
                  },
                },
              },
            },
          },
          400: errorResponse('Validation failed'),
          401: errorResponse('Missing or invalid token'),
          404: errorResponse('Report not found'),
          409: errorResponse('Case is closed', {
            success: false,
            error: { message: 'Report is closed (RESOLVED) and cannot be changed' },
          }),
        },
      },
    },

    '/moderator/reports/{id}/messages': {
      post: {
        operationId: 'sendModeratorMessage',
        tags: ['Moderation'],
        summary: 'Ask the reporter a question',
        description:
          'Adds a MODERATOR message to the anonymous thread and sets `awaitingReporter` until the reporter replies. The reporter sees the text but never who wrote it.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/MessageRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Message sent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string', example: 'Message sent to the reporter' },
                    data: { $ref: '#/components/schemas/ReportDetail' },
                  },
                },
              },
            },
          },
          400: errorResponse('Validation failed'),
          401: errorResponse('Missing or invalid token'),
          404: errorResponse('Report not found'),
          409: errorResponse('Case is closed, or the thread is full'),
        },
      },
    },

    '/moderator/stats': {
      get: {
        operationId: 'getReportStats',
        tags: ['Moderation'],
        summary: 'Report counts per status',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Queue overview',
            content: {
              'application/json': {
                example: {
                  success: true,
                  data: { total: 12, byStatus: { SUBMITTED: 5, UNDER_REVIEW: 4, RESOLVED: 3 } },
                },
              },
            },
          },
          401: errorResponse('Missing or invalid token'),
        },
      },
    },

    '/admin/moderators': {
      post: {
        operationId: 'createStaffAccount',
        tags: ['Admin'],
        summary: 'Create a moderator or admin account',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateStaffRequest' } },
          },
        },
        responses: {
          201: {
            description: 'Account created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string', example: 'Account "neha.r" created' },
                    data: { $ref: '#/components/schemas/StaffAccount' },
                  },
                },
              },
            },
          },
          400: errorResponse('Validation failed'),
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin', {
            success: false,
            error: { message: 'This action requires the admin role' },
          }),
          409: errorResponse('Username already taken', {
            success: false,
            error: { message: 'Moderator "neha.r" already exists' },
          }),
        },
      },
      get: {
        operationId: 'listStaffAccounts',
        tags: ['Admin'],
        summary: 'List staff accounts',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Paginated staff accounts (never includes password hashes)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'array', items: { $ref: '#/components/schemas/StaffAccount' } },
                    meta: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
          400: errorResponse('Invalid paging values'),
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin'),
        },
      },
    },

    '/admin/moderators/{id}/deactivate': {
      patch: {
        operationId: 'deactivateStaffAccount',
        tags: ['Admin'],
        summary: 'Deactivate an account (takes effect on its very next request)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Account deactivated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Account "neha.r" deactivated' },
                    data: { $ref: '#/components/schemas/StaffAccount' },
                  },
                },
              },
            },
          },
          400: errorResponse('Malformed id'),
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin, or is trying to deactivate themselves', {
            success: false,
            error: { message: 'Admins cannot deactivate their own account' },
          }),
          404: errorResponse('Account not found'),
          409: errorResponse('Account is already inactive', {
            success: false,
            error: { message: 'Moderator account is already inactive' },
          }),
        },
      },
    },

    '/admin/moderators/{id}/activate': {
      patch: {
        operationId: 'activateStaffAccount',
        tags: ['Admin'],
        summary: 'Reactivate an account',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Account activated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Account "neha.r" activated' },
                    data: { $ref: '#/components/schemas/StaffAccount' },
                  },
                },
              },
            },
          },
          400: errorResponse('Malformed id'),
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin'),
          404: errorResponse('Account not found'),
          409: errorResponse('Account is already active'),
        },
      },
    },

    '/admin/audit-log': {
      get: {
        operationId: 'listAuditLog',
        tags: ['Admin'],
        summary: 'Read the staff audit log, newest first',
        description:
          'Records LOGIN, VIEW_REPORT, UPDATE_STATUS, ADD_UPDATE and ADMIN_* actions. Each entry is hash-chained to the previous one.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          200: {
            description: 'Paginated audit entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } },
                    meta: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
          400: errorResponse('Invalid paging values'),
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin'),
        },
      },
    },

    '/admin/audit-log/verify': {
      get: {
        operationId: 'verifyAuditLog',
        tags: ['Admin'],
        summary: 'Verify the audit log hash chain',
        description:
          'Recomputes every hash in order. Detects edited, re-hashed, deleted and re-ordered entries.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Verification result (200 whether or not the chain is intact)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    data: { $ref: '#/components/schemas/AuditVerifyResult' },
                  },
                },
                examples: {
                  intact: {
                    value: {
                      success: true,
                      message: 'Audit log is intact',
                      data: { intact: true, checkedEntries: 5, headSeq: 5, headHash: '9c4e…' },
                    },
                  },
                  tampered: {
                    value: {
                      success: true,
                      message: 'Audit log has been tampered with at entry #3',
                      data: {
                        intact: false,
                        checkedEntries: 2,
                        brokenAtSeq: 3,
                        reason: 'CONTENT_HASH_MISMATCH',
                      },
                    },
                  },
                },
              },
            },
          },
          401: errorResponse('Missing, invalid or stale token'),
          403: errorResponse('Caller is not an admin'),
        },
      },
    },
  },
};

/** Swagger UI tweaks: persist the token between reloads, no "try it" noise. */
const swaggerUiOptions = {
  customSiteTitle: 'WhistleDrop API docs',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
  },
};

module.exports = { openApiSpec, swaggerUiOptions };
