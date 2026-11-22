import type { z, ZodType } from 'zod';
import {
  cleanupResponse, editRequest, mcpRequest, fileListResponse, fileResponse, healthResponse, linkInput, recordQuery,
  replacementRequest, uploadAddressResponse, uploadRequest, viewedFileResponse,
} from '../files/schemas.ts';

export interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Express-style path, e.g. `/files/:id`. */
  path: string;
  summary: string;
  /** Validated against the JSON body. */
  body?: ZodType;
  /** Validated against the query string. */
  query?: z.ZodObject;
  success: { status: 200 | 201 | 204; description: string; schema?: ZodType };
  /** Error statuses this route can answer with; all use the Error schema. */
  errors: number[];
  /** Skips the Client System check. */
  open?: boolean;
  /** Called by GitHub Actions with a bearer secret instead of a Client System code. */
  cron?: boolean;
}

const notFound = 'File not found.';
const FILE_ERRORS = [401, 404];

// Every route the app serves. The router and the OpenAPI document are both built from this list,
// and a test fails if the app serves a route that is not here.
export const routes = {
  health: {
    method: 'get', path: '/health', summary: 'Check the service is running',
    success: { status: 200, description: 'The service is up.', schema: healthResponse }, errors: [], open: true,
  },
  openapi: {
    method: 'get', path: '/openapi.json', summary: 'This OpenAPI document',
    success: { status: 200, description: 'The OpenAPI document.' }, errors: [], open: true,
  },
  docs: {
    method: 'get', path: '/docs', summary: 'The usage guide (an HTML page)',
    success: { status: 200, description: 'The guide page.' }, errors: [], open: true,
  },
  cleanup: {
    method: 'get', path: '/cron/cleanup', summary: 'Remove expired Files and stale uploads (called daily by GitHub Actions)',
    success: { status: 200, description: 'Everything due was removed.', schema: cleanupResponse },
    errors: [401, 500], open: true, cron: true,
  },
  mcp: {
    method: 'post', path: '/mcp', summary: 'MCP endpoint (JSON-RPC) whose tools mirror the Files routes',
    body: mcpRequest,
    success: { status: 200, description: 'The JSON-RPC response. Tool failures are results with isError set.' },
    errors: [400, 401],
  },
  requestUpload: {
    method: 'post', path: '/files', summary: 'Request an upload address for a new File',
    body: uploadRequest,
    success: { status: 201, description: 'A Pending upload with a signed address to upload the bytes to.', schema: uploadAddressResponse },
    errors: [400, 401],
  },
  confirmUpload: {
    method: 'post', path: '/files/:id/confirm', summary: 'Confirm an upload so the File becomes Active',
    success: { status: 200, description: 'The Active File, with Variants for pictures.', schema: fileResponse },
    errors: [...FILE_ERRORS, 409, 422],
  },
  requestReplacement: {
    method: 'post', path: '/files/:id/replacement', summary: 'Request an upload address to replace a File\'s contents',
    body: replacementRequest,
    success: { status: 201, description: 'The File with a signed address to upload the replacement bytes to.', schema: uploadAddressResponse },
    errors: [400, ...FILE_ERRORS],
  },
  confirmReplacement: {
    method: 'post', path: '/files/:id/replacement/confirm', summary: 'Confirm a replacement upload',
    success: { status: 200, description: 'The File with its new contents.', schema: fileResponse },
    errors: [...FILE_ERRORS, 409, 422],
  },
  viewFile: {
    method: 'get', path: '/files/:id', summary: 'View an Active File and get its address',
    success: { status: 200, description: 'The File with an address to view it from.', schema: viewedFileResponse },
    errors: FILE_ERRORS,
  },
  editFile: {
    method: 'patch', path: '/files/:id', summary: 'Edit a File\'s filename or Retention type',
    body: editRequest,
    success: { status: 200, description: 'The edited File.', schema: fileResponse },
    errors: [400, ...FILE_ERRORS],
  },
  deleteFile: {
    method: 'delete', path: '/files/:id', summary: 'Delete a File for everyone',
    success: { status: 204, description: 'The File is deleted (also when it already was).' },
    errors: [401, 404],
  },
  listFiles: {
    method: 'get', path: '/files', summary: 'List a record\'s Active Files by Link',
    query: recordQuery,
    success: { status: 200, description: 'Up to 50 Files, ordered by id.', schema: fileListResponse },
    errors: [400, 401],
  },
  addLink: {
    method: 'post', path: '/files/:id/links', summary: 'Add a Link to a File',
    body: linkInput,
    success: { status: 204, description: 'The Link exists on the File (also when it already did).' },
    errors: [400, ...FILE_ERRORS],
  },
  removeLink: {
    method: 'delete', path: '/files/:id/links', summary: 'Remove a Link from a File',
    body: linkInput,
    success: { status: 204, description: 'The Link is gone from the File (also when it never existed).' },
    errors: [400, ...FILE_ERRORS],
  },
} satisfies Record<string, RouteSpec>;

export const errorDescriptions: Record<number, string> = {
  400: 'The request is invalid.',
  401: 'The gateway secret is missing or wrong, or X-System-Code is missing or names an unknown Client System.',
  404: notFound,
  413: 'The JSON body is larger than 16 kb.',
  409: 'The File is not in a state that allows this, for example nothing has been uploaded yet.',
  422: 'The uploaded object does not match what was declared; it was removed.',
  500: 'Unexpected error, or the cleanup could not remove some objects (the body then holds the counts).',
};
