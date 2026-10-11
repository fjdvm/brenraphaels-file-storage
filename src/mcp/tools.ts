import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';
import { confirmReplacement, confirmUpload, deleteFile, editFile, listFiles, requestReplacement, requestUpload, viewFile } from '../files/files.ts';
import type { Caller, FileDeps } from '../files/files.ts';
import { editRequest, fileId, recordQuery, replacementRequest, uploadRequest } from '../files/schemas.ts';
import { parseWith } from '../http/files-router.ts';

type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  input: ZodObject<ZodRawShape>;
  run(deps: FileDeps, caller: Caller, args: Args): Promise<unknown>;
}

const id = { id: fileId };
const localPath = z.string().optional()
  .describe('Where the bytes are on this machine. Put into the returned command so it can be run as is.');

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The model never carries the bytes: it hands this command to a shell, which PUTs the file to the signed address.
function withCommand<T extends { uploadUrl: string }>(result: T, contentType: string, path: unknown) {
  const file = typeof path === 'string' && path ? path : '<path-to-file>';
  return { ...result, uploadCommand: `curl -X PUT -H ${shellQuote(`Content-Type: ${contentType}`)} --upload-file ${shellQuote(file)} ${shellQuote(result.uploadUrl)}` };
}

// Splits the File id and the upload hint off, leaving what the matching API route would receive as its body.
function split({ id: fileIdValue, localPath: path, ...body }: Args) {
  return { fileId: String(fileIdValue ?? ''), path, body };
}

export const tools: Tool[] = [
  {
    name: 'request_upload',
    description: 'Request an address to upload a new File. Pass localPath so the returned uploadCommand can run as is. Run the returned uploadCommand, then call confirm_upload.',
    input: uploadRequest.extend({ localPath }),
    async run(deps, caller, args) {
      const { localPath: path, ...body } = args;
      const input = parseWith(uploadRequest, body);
      return withCommand(await requestUpload(deps, caller, input), input.contentType, path);
    },
  },
  {
    name: 'confirm_upload',
    description: 'Confirm that the bytes were uploaded, so the File becomes Active.',
    input: z.object(id),
    run: (deps, caller, args) => confirmUpload(deps, caller, split(args).fileId),
  },
  {
    name: 'view_file',
    description: 'View an Active File and get an address to open it from.',
    input: z.object(id),
    run: (deps, caller, args) => viewFile(deps, caller, split(args).fileId),
  },
  {
    name: 'list_files',
    description: 'List the Active Files linked to a record, 50 at a time.',
    input: recordQuery,
    run: (deps, _caller, args) => listFiles(deps, parseWith(recordQuery, args)),
  },
  {
    name: 'edit_file',
    description: 'Change a File\'s filename or Retention type.',
    input: z.object({ ...id, ...editRequest.shape }),
    run(deps, caller, args) {
      const { fileId: target, body } = split(args);
      return editFile(deps, caller, target, parseWith(editRequest, body));
    },
  },
  {
    name: 'replace_file',
    description: 'Request an address to replace a File\'s contents. Pass localPath so the returned uploadCommand can run as is. Run the returned uploadCommand, then call confirm_replacement.',
    input: z.object({ ...id, ...replacementRequest.shape, localPath }),
    async run(deps, caller, args) {
      const { fileId: target, path, body } = split(args);
      const input = parseWith(replacementRequest, body);
      return withCommand(await requestReplacement(deps, caller, target, input), input.contentType, path);
    },
  },
  {
    name: 'confirm_replacement',
    description: 'Confirm that the replacement bytes were uploaded.',
    input: z.object(id),
    run: (deps, caller, args) => confirmReplacement(deps, caller, split(args).fileId),
  },
  {
    name: 'delete_file',
    description: 'Delete a File for everyone.',
    input: z.object(id),
    async run(deps, caller, args) {
      await deleteFile(deps, caller, split(args).fileId);
      return { deleted: true };
    },
  },
];
