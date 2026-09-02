#!/usr/bin/env node
// fetch-raw：CLI 崩溃时的官方降级取数工具（直接调用 fuyao.js + cache.js，绕过 cli 入口解析）。
// 用法:
//   node scripts/fetch-raw.mjs <kind> '<json-params>' [--save <type>] [--code <thscode>] [--date YYYY-MM-DD]
// 例:
//   node scripts/fetch-raw.mjs price-snapshot '{"thscodes":"600396.SH,001258.SZ"}' --save quote --code 600396.SH
//   node scripts/fetch-raw.mjs income-statements '{"thscode":"600396.SH","period":"quarterly","limit":8}'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getData } from '../src/fuyao.js';
import * as cache from '../src/cache.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const kind = args[0];
if (!kind) {
  console.error('用法: node scripts/fetch-raw.mjs <kind> \'<json-params>\' [--save T] [--code X] [--date D]');
  process.exit(1);
}
let params = {};
try {
  params = args[1] ? JSON.parse(args[1]) : {};
} catch (e) {
  console.error(`参数 JSON 解析失败（Windows 下请用单引号包裹）: ${e.message}`);
  process.exit(1);
}
const rest = args.slice(2);
const pick = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
};
const save = pick('--save');
const code = pick('--code');
const date = pick('--date') || new Date().toISOString().slice(0, 10);

try {
  const result = await getData(kind, params);
  if (result && result.code !== undefined && result.code !== 0) {
    console.error(`业务错误 code=${result.code} message=${result.message}`);
    process.exit(1);
  }
  if (save) {
    const data = result?.data ?? result;
    if (code) {
      const f = cache.saveStock({ code, type: save, data });
      console.log(`已取数并缓存(个股): ${f}`);
    } else {
      const f = cache.saveSnapshot({ type: save, date, data });
      console.log(`已取数并缓存: ${f}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(`取数失败: ${e.message}`);
  console.error('提示: 若 src/ 模块本身损坏，请先修复项目（重跑 install-preset.js 或 git 恢复）。');
  process.exit(1);
}