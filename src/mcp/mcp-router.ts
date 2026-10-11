import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Caller, FileDeps } from '../files/files.ts';
import { HttpError } from '../http/errors.ts';
import { routes } from '../http/contract.ts';
import { tools } from './tools.ts';

function serverFor(deps: FileDeps, caller: Caller) {
  const server = new Server({ name: 'file-storage', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) as { type: 'object' },
    })),
  }));
  // A failure is a tool result the model can read and react to, with the same message the API would answer.
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.find(candidate => candidate.name === params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] };
    try {
      const result = await tool.run(deps, caller, params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof HttpError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      console.error(error);
      return { isError: true, content: [{ type: 'text', text: 'Internal server error' }] };
    }
  });
  return server;
}

// Stateless: every request gets its own server and transport, acting as the system and actor named in the headers.
export function mcpRouter(deps: FileDeps) {
  const router = Router();
  router.post(routes.mcp.path, async (req, res, next) => {
    try {
      const caller: Caller = { systemCode: res.locals.systemCode, actorId: res.locals.actorId };
      const server = serverFor(deps, caller);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) { next(error); }
  });
  return router;
}
