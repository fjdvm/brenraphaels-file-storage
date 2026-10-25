# OpenAPI document

`GET /openapi.json` returns an OpenAPI 3.1 document describing every endpoint with its
inputs, responses and errors. It needs no `X-System-Code`.

It is generated, not written by hand:

- `src/files/schemas.ts` holds the Zod schemas. Routes validate request bodies and query
  strings with them (`parseWith` in `src/http/files-router.ts`), and the document is built
  from the same schemas.
- `src/http/contract.ts` lists every route with its schemas, success status and errors.
- `src/http/openapi.ts` turns that list into the document.

Validation failures answer `400` with `{ "error": "<first problem>", "details": [{ "path", "message" }] }`.

Upload and replacement requests accept MP4 (`video/mp4`) and MOV (`video/quicktime`)
alongside the existing image and document types, up to 25 MB. Other video types
are refused with `contentType is not an allowed file type`. Videos are kept
unchanged, without Variants, and viewed through the usual Public or signed Private address.

## Adding a route

Add it to `routes` in `contract.ts`, register it with the same `routes.<name>.path`, and use
its schemas to validate. `tests/integration/openapi.test.ts` fails when the app serves a
route that is missing from the document (or the document lists one the app does not serve).
Path ids are checked by the service (a malformed id answers `404`), so they are documented
as UUIDs but not validated by the schemas.

## Usage guide

`GET /docs` serves a self-contained HTML guide (`docs/guide/index.html`) with Start here and one
section per endpoint, each with a worked example. It needs no `X-System-Code`. Its examples use
`$BASE_URL`, which the box at the top of the page rewrites. The page is written by hand, so update
it when a route changes; `tests/integration/docs.test.ts` fails if a route in `contract.ts` is missing from it.

## MCP endpoint

`POST /mcp` is a stateless remote MCP server (`src/mcp/`). It sits behind the same gateway-secret and `X-System-Code`
checks, so the system code and optional `X-Actor-Id` of the client's configured headers are the
caller of every tool. Each tool in `src/mcp/tools.ts` validates with the same Zod schema as its
route and calls the same function in `src/files/files.ts`; failures come back as tool errors with
the API's message. `request_upload` and `replace_file` add an `uploadCommand` (a `curl` PUT) so the
bytes never pass through the model. Add a tool there when a route should be reachable from agents,
and keep the "Use it from an agent" section of the guide in step.
