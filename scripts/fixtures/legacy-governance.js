// Historical v1 records must remain readable while pending cases finish under their original law.
import { readFileSync } from 'node:fs';
import { renderBootstrapConstitution } from '../../src/governance/config.js';
import { compileConstitution } from '../../src/governance/rules.js';
export function loadBootstrapDocuments({ serverName }) {
  const constitution = renderBootstrapConstitution(readFileSync(new URL('./legacy-constitution.md', import.meta.url), 'utf8'), serverName);
  return { constitution, policy: compileConstitution({ content: constitution }).policy };
}
