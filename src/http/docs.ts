import { readFileSync } from 'node:fs';

// A literal URL relative to this module resolves the same from src/ and dist/.
export const guide = () => readFileSync(new URL('../../docs/guide/index.html', import.meta.url), 'utf8');
