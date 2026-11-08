import { z } from 'zod';
import type { ZodType } from 'zod';
import { errorDescriptions, routes } from './contract.ts';
import type { RouteSpec } from './contract.ts';
import { errorResponse, fileId } from '../files/schemas.ts';

type Json = Record<string, unknown>;

const jsonSchema = (schema: ZodType, io: 'input' | 'output'): Json => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', io, reused: 'inline', unrepresentable: 'any' }) as Json;
  return rest;
};

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');
const pathParams = (path: string) => [...path.matchAll(/:(\w+)/g)].map(match => match[1]!);

function operation(name: string, spec: RouteSpec): Json {
  const queryShape = spec.query ? jsonSchema(spec.query, 'input') as { properties?: Record<string, Json>; required?: string[] } : undefined;
  const parameters: Json[] = [
    ...pathParams(spec.path).map(param => ({ name: param, in: 'path', required: true, schema: jsonSchema(fileId, 'input') })),
    ...Object.entries(queryShape?.properties ?? {}).map(([param, schema]) => {
      const { description, ...rest } = schema as { description?: string };
      return { name: param, in: 'query', required: queryShape?.required?.includes(param) ?? false, description, schema: rest };
    }),
  ];
  if (!spec.open) parameters.push({ $ref: '#/components/parameters/ActorId' });
  const responses: Record<string, Json> = {
    [spec.success.status]: {
      description: spec.success.description,
      ...(spec.success.schema ? { content: { 'application/json': { schema: jsonSchema(spec.success.schema, 'output') } } } : {}),
    },
  };
  // Any authenticated route can fail on malformed JSON (400), an oversized body (413) or an unexpected error (500).
  const errors = spec.open ? spec.errors : [...new Set([...spec.errors, 400, 413, 500])];
  for (const status of errors.sort((a, b) => a - b)) {
    responses[status] = {
      description: errorDescriptions[status] ?? 'Error.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  return {
    operationId: name, summary: spec.summary,
    ...(spec.cron ? { security: [{ CronSecret: [] }] } : spec.open ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(spec.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(spec.body, 'input') } } } } : {}),
    responses,
  };
}

// Generated from the route list and the Zod schemas the routes validate with.
export function buildOpenApiDocument(): Json {
  const paths: Record<string, Json> = {};
  for (const [name, spec] of Object.entries(routes) as [string, RouteSpec][]) {
    (paths[toOpenApiPath(spec.path)] ??= {})[spec.method] = operation(name, spec);
  }
  return {
    openapi: '3.1.0',
    info: { title: 'File storage', version: '1.0.0', description: 'The company\'s single place to keep uploaded files.' },
    security: [{ GatewaySecret: [], SystemCode: [] }],
    paths,
    components: {
      securitySchemes: {
        GatewaySecret: { type: 'http', scheme: 'bearer', description: 'The GATEWAY_SECRET, sent by the gateway on every API request.' },
        CronSecret: { type: 'http', scheme: 'bearer', description: 'The CRON_SECRET, sent by GitHub Actions.' },
        SystemCode: { type: 'apiKey', in: 'header', name: 'X-System-Code', description: 'Code of the calling Client System.' },
      },
      parameters: { ActorId: { name: 'X-Actor-Id', in: 'header', required: false, description: 'Who acted, recorded in the audit history.', schema: { type: 'string' } } },
      schemas: { Error: jsonSchema(errorResponse, 'output') },
    },
  };
}
