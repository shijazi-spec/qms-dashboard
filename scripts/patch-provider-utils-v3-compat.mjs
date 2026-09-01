#!/usr/bin/env node
/**
 * Restores the small legacy AI SDK v5 export surface on the patched
 * provider-utils v4 release. The provider-utils v3 line has no secure release.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';

const PACKAGE_DIR = 'node_modules/@ai-sdk/provider-utils';
const BOUND_PREFIX = `node_modules${sep}@ai-sdk${sep}provider-utils${sep}`;
const SENTINEL = 'patched-by-patch-provider-utils-v3-compat.mjs';
const NAMES = [
  'asValidator',
  'createProviderDefinedToolFactory',
  'createProviderDefinedToolFactoryWithOutputSchema',
  'isValidator',
  'lazyValidator',
  'standardSchemaValidator',
  'validator',
];
const RUNTIME = `
// ${SENTINEL}
function validator(validate) { return jsonSchema({}, { validate }); }
function isValidator(value) { return isSchema(value); }
function lazyValidator(createValidator) { return lazySchema(createValidator); }
function asValidator(value) { return asSchema(value); }
function standardSchemaValidator(value) { return standardSchema(value); }
function createProviderDefinedToolFactory({ id, name, inputSchema }) {
  return ({ execute, outputSchema, toModelOutput, onInputStart, onInputDelta, onInputAvailable, ...args }) => tool({
    type: "provider-defined", id, name, args, inputSchema, outputSchema, execute,
    toModelOutput, onInputStart, onInputDelta, onInputAvailable
  });
}
function createProviderDefinedToolFactoryWithOutputSchema({ id, name, inputSchema, outputSchema }) {
  return ({ execute, toModelOutput, onInputStart, onInputDelta, onInputAvailable, ...args }) => tool({
    type: "provider-defined", id, name, args, inputSchema, outputSchema, execute,
    toModelOutput, onInputStart, onInputDelta, onInputAvailable
  });
}
`;

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}
function assertBounded(cwd, target) {
  const relative = target.substring(cwd.length + 1);
  if (!relative.startsWith(BOUND_PREFIX)) throw new Error(`refusing path: ${relative}`);
}
function patchEsm(source) {
  if (source.includes(SENTINEL)) return source;
  const marker = '// src/index.ts\nimport {\n  EventSourceParserStream as EventSourceParserStream2';
  if (!source.includes(marker)) throw new Error('ESM marker changed upstream');
  return source
    .replace(marker, `${RUNTIME}\n${marker}`)
    .replace('export {\n  DEFAULT_MAX_DOWNLOAD_SIZE,', `export {\n${NAMES.map(n => `  ${n},`).join('\n')}\n  DEFAULT_MAX_DOWNLOAD_SIZE,`);
}
function patchCjs(source) {
  if (source.includes(SENTINEL)) return source;
  const marker = '// src/index.ts\nvar import_stream2 = require("eventsource-parser/stream");';
  if (!source.includes(marker)) throw new Error('CJS marker changed upstream');
  return source
    .replace('  DEFAULT_MAX_DOWNLOAD_SIZE: () => DEFAULT_MAX_DOWNLOAD_SIZE,', `${NAMES.map(n => `  ${n}: () => ${n},`).join('\n')}\n  DEFAULT_MAX_DOWNLOAD_SIZE: () => DEFAULT_MAX_DOWNLOAD_SIZE,`)
    .replace(marker, `${RUNTIME}\n${marker}`);
}
function patchTypes(source) {
  if (source.includes(SENTINEL)) return source;
  const declarations = `
// ${SENTINEL}
declare function validator<OBJECT>(validate: (value: unknown) => Promise<ValidationResult<OBJECT>>): Validator<OBJECT>;
declare function isValidator(value: unknown): value is Validator<unknown>;
declare function lazyValidator<OBJECT>(createValidator: () => Validator<OBJECT>): LazyValidator<OBJECT>;
type LazyValidator<OBJECT> = () => Validator<OBJECT>;
type FlexibleValidator<OBJECT> = Validator<OBJECT> | LazyValidator<OBJECT> | StandardSchemaV1<unknown, OBJECT>;
type InferValidator<SCHEMA> = SCHEMA extends StandardSchemaV1<unknown, infer T> ? T : SCHEMA extends LazyValidator<infer T> ? T : SCHEMA extends Validator<infer T> ? T : never;
declare function asValidator<OBJECT>(value: FlexibleValidator<OBJECT>): Validator<OBJECT>;
declare function standardSchemaValidator<OBJECT>(value: StandardSchemaV1<unknown, OBJECT>): Validator<OBJECT>;
declare const createProviderDefinedToolFactory: typeof createProviderToolFactory;
declare const createProviderDefinedToolFactoryWithOutputSchema: typeof createProviderToolFactoryWithOutputSchema;
`;
  const index = source.lastIndexOf('export {');
  if (index === -1) throw new Error('type marker changed upstream');
  const finalExport = source.slice(index).replace(
    'export {',
    `export { ${NAMES.join(', ')}, type FlexibleValidator, type InferValidator, type LazyValidator,`,
  );
  return `${source.slice(0, index)}${declarations}\n${finalExport}`;
}

async function main() {
  const cwd = process.cwd();
  const packageJsonPath = resolve(cwd, PACKAGE_DIR, 'package.json');
  if (!(await exists(packageJsonPath))) return;
  const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (!String(metadata.version).startsWith('4.')) throw new Error(`expected v4, found ${metadata.version}`);
  for (const [file, patch] of [['dist/index.mjs', patchEsm], ['dist/index.js', patchCjs], ['dist/index.d.ts', patchTypes]]) {
    const target = resolve(cwd, PACKAGE_DIR, file);
    assertBounded(cwd, target);
    const before = await readFile(target, 'utf8');
    const after = patch(before);
    if (after !== before) await writeFile(target, after, 'utf8');
  }
  console.log(`[patch-provider-utils-v3-compat] provider-utils ${metadata.version} ready`);
}
main().catch(error => { console.error(error.message); process.exit(1); });