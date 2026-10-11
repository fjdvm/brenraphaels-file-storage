import { z } from 'zod';

// The Zod schemas below are the single source of truth: routes validate requests with them
// and the OpenAPI document is generated from them.

export const MAX_SIZE = 25 * 1024 * 1024;
export const ALLOWED_TYPE_LIST = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export const ALLOWED_TYPES: ReadonlySet<string> = new Set(ALLOWED_TYPE_LIST);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (id: string) => UUID_PATTERN.test(id);

const text = (field: string, message = `${field} must be a non-empty string`) =>
  z.string({ error: message }).trim().min(1, message);
const choice = <T extends readonly [string, ...string[]]>(field: string, values: T) =>
  z.enum(values, { error: issue => issue.input === undefined || issue.input === null || issue.input === ''
    ? `${field} is required (${values.join(' or ')})` : `${field} must be ${values.join(' or ')}` });

const VISIBILITY = ['public', 'private'] as const;
const RETENTION = ['permanent', 'temporary'] as const;
const visibility = choice('visibility', VISIBILITY).describe('Fixed when the File is created.');
const retentionType = choice('retentionType', RETENTION);
const contentType = z.enum(ALLOWED_TYPE_LIST, { error: 'contentType is not an allowed file type' });
const size = z.number({ error: 'size must be a positive number of bytes' })
  .int('size must be a positive number of bytes').positive('size must be a positive number of bytes')
  .max(MAX_SIZE, 'size must be 25 MB or less').describe('Size in bytes, at most 25 MB.');

const VISIBILITY_FROZEN = 'Visibility cannot be changed after a File is created';
const exactFields = (allowed: string) => ({
  error: (issue: { code: string; keys?: string[] }) => issue.code !== 'unrecognized_keys' ? undefined
    : issue.keys?.includes('visibility') ? VISIBILITY_FROZEN : `Only ${allowed} can be provided`,
});

// ── Requests ──────────────────────────────────────────────────────────────

export const linkInput = z.object({
  system: text('system').describe('Code of a known Client System.'),
  entityType: text('entityType'),
  entityId: text('entityId'),
  role: text('role').describe('For example "cover image".'),
}, { error: 'link must be an object' });

export const uploadRequest = z.object({
  filename: text('filename', 'filename is required'),
  contentType,
  size,
  visibility,
  retentionType,
  link: linkInput.optional().describe('Saved with the Pending upload; shown in record lookups after confirmation.'),
});

export const replacementRequest = z.strictObject({ contentType, size }, exactFields('contentType and size'))
  ;

export const editRequest = z.strictObject({
  filename: text('filename').optional(),
  retentionType: retentionType.optional(),
}, exactFields('filename and retentionType'))
  .refine(body => body.filename !== undefined || body.retentionType !== undefined, 'Provide filename or retentionType to edit')
  ;

export const recordQuery = z.object({
  system: linkInput.shape.system,
  entityType: linkInput.shape.entityType,
  entityId: linkInput.shape.entityId,
  role: linkInput.shape.role.optional().describe('Only Files linked with this role.'),
  page: z.string({ error: 'page must be a File id from nextPage' })
    .regex(UUID_PATTERN, 'page must be a File id from nextPage').meta({ format: 'uuid' }).optional()
    .describe('The nextPage value of the previous result.'),
});

export const fileId = z.string().meta({ format: 'uuid' }).describe('File id.');

// ── Responses ─────────────────────────────────────────────────────────────

export const variant = z.object({
  name: z.enum(['small', 'medium', 'large']),
  status: z.enum(['ready', 'failed']),
  url: z.string().nullable().describe('Null unless the Variant is ready.'),
});

export const fileResponse = z.object({
  id: z.string().meta({ format: 'uuid' }),
  status: z.enum(['pending', 'active']),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  visibility: z.enum(VISIBILITY),
  retentionType: z.enum(RETENTION),
  expiresAt: z.string().meta({ format: 'date-time' }).nullable().describe('Set while the File is Temporary.'),
  variants: z.array(variant),
});

export const uploadAddressResponse = fileResponse.extend({
  uploadUrl: z.string().describe('Signed address to PUT the bytes to.'),
  uploadUrlExpiresInSeconds: z.number().int(),
});

export const viewedFileResponse = fileResponse.extend({
  url: z.string().describe('Public address, or a short-lived signed address for a Private File.'),
});

export const fileListResponse = z.object({
  files: z.array(fileResponse),
  nextPage: z.string().nullable().describe('Pass as `page` to get the next 50 Files; null on the last page.'),
});

export const healthResponse = z.object({ status: z.literal('ok') });

export const errorResponse = z.object({
  error: z.string().describe('Short message.'),
  details: z.unknown().optional().describe('For validation errors, the list of failing fields.'),
});
