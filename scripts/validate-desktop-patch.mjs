/**
 * Validate the desktop profile's patch file with DSH's OWN entry-list YAML
 * dialect (the `!!js` type included), and report the preset row it declares.
 *
 * Run with the desktop runtime's Node + extracted dsh modules, or plain node
 * if the npm-global dsh copy is present (same schema).
 *
 * Usage: node scripts/validate-desktop-patch.mjs [profileName]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const profileName = process.argv[2] ?? 'desktop';
const patchPath = path.join(os.homedir(), '.dsh', 'profiles', profileName, 'cordis.patch.yml');

if (!existsSync(patchPath)) {
  console.error(`✗ patch file not found: ${patchPath}`);
  process.exit(1);
}

// dsh-app-boot exports the exact entry-list dialect (yaml.JSON_SCHEMA + !!js).
const DSH_MODULES = 'D:\\Software\\nvm\\npm_global\\global\\node_modules\\@deepseek-ai\\dsh\\node_modules';
const require = createRequire(path.join(DSH_MODULES, 'noop.js'));
const boot = require(path.join(DSH_MODULES, '@deepseek-ai', 'dsh-app-boot'));
const registry = require(path.join(DSH_MODULES, '@deepseek-ai', 'dsh-agent-preset-registry'));

console.log('app-boot exports:', Object.keys(boot).join(', '));

// Rebuild the entry-list dialect exactly as dsh-app-boot does:
//   entryListSchema = jsYaml.JSON_SCHEMA.extend(JsExpr)
// where JsExpr is the vendored `!!js` type (tag:yaml.org,2002:js).
const jsYaml = require(path.join(DSH_MODULES, 'js-yaml'));
const { isJsExpr } = require(path.join(DSH_MODULES, '@deepseek-ai', 'cordis-plugin-loader'));
const JsExpr = new jsYaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data.__jsExpr,
});
const entryListSchema = jsYaml.JSON_SCHEMA.extend(JsExpr);

let patches;
try {
  patches = jsYaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema });
} catch (e) {
  console.error(`✗ parse failed: ${e.message}`);
  process.exit(1);
}
console.log(`parsed ${profileName} patch -> ${Array.isArray(patches) ? patches.length : typeof patches} top-level entries`);

let presetRow;
for (const entry of patches) {
  for (const ins of entry.insert ?? []) {
    if (ins.id === 'preset-a-share-assistant') presetRow = ins;
  }
}
if (!presetRow) {
  console.error('✗ preset-a-share-assistant row NOT found in patch');
  process.exit(1);
}

console.log(`✔ found preset row: id=${presetRow.config.id} name=${presetRow.config.name}`);
console.log(`  plugins: ${presetRow.config.plugins.length}`);

const problem = registry.entryListProblem(presetRow.config.plugins);
console.log(`  entryListProblem => ${problem === undefined ? 'OK (valid)' : problem}`);

// Prove !!js survived as an expression node (not a bare string).
for (const r of presetRow.config.plugins) {
  if (r.disabled !== undefined) {
    const isExpr = typeof r.disabled === 'object' && r.disabled !== null && '__jsExpr' in r.disabled;
    console.log(`  row ${r.id}: disabled is ${isExpr ? 'JS-EXPRESSION (correct)' : `RAW ${typeof r.disabled} (WRONG)`} -> ${JSON.stringify(r.disabled.__jsExpr ?? r.disabled)}`);
  }
}
process.exit(problem === undefined ? 0 : 1);
