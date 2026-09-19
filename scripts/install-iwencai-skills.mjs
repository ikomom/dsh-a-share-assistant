#!/usr/bin/env node
// 安装问财（iwencai）渠道技能：公告 / 新闻。
//
// 为什么要有这个脚本：`AI_INSTALL.md` 让 AI「一句话装完」时，这几步（找 python → 下载官方
// SkillHub CLI → 解压 → 逐个 install 技能 → 校验）如果都写成散命令，AI 容易漏步或写错路径。
// 收敛成一条命令，可重复执行（幂等），失败会说清是哪一步、怎么办。
//
// 用法：
//   node scripts/install-iwencai-skills.mjs                # 装公告+新闻到 ~/.agents/skills
//   node scripts/install-iwencai-skills.mjs --check        # 只体检，不下载不安装
//   node scripts/install-iwencai-skills.mjs --skills announcement-search
//   node scripts/install-iwencai-skills.mjs --dir <技能目录> --cli-dir <CLI 存放目录>
//
// 安全边界（重要，不要改成"静默后台安装"）：
//   - 只从同花顺官方 CDN 取 CLI：https://www.iwencai.com/skillhub/static/0.0.4/iwencai-skillhub-cli.zip
//   - 技能包由该 CLI 从 http://ms.10jqka.com.cn/gateway/market/api/v1/skills/square/download?name=<slug> 拉取
//   - 不接收、不读写任何 API Key（Key 由用户/AI 写进 .a-share-assistant/config.json）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ZIP_URL = 'https://www.iwencai.com/skillhub/static/0.0.4/iwencai-skillhub-cli.zip';
const DEFAULT_SKILLS = ['announcement-search', 'news-search'];

function parseArgs(argv) {
  const o = { skills: DEFAULT_SKILLS.slice(), dir: path.join(os.homedir(), '.agents', 'skills'), cliDir: path.join(os.homedir(), '.iwencai-skillhub'), python: process.env.A_SHARE_PYTHON || '', check: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--force') o.force = true;
    else if (a === '--skills') o.skills = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dir') o.dir = path.resolve(argv[++i] || '');
    else if (a === '--cli-dir') o.cliDir = path.resolve(argv[++i] || '');
    else if (a === '--python') o.python = argv[++i] || '';
    else if (a === '-h' || a === '--help') { console.log('用法: node scripts/install-iwencai-skills.mjs [--check] [--force] [--skills a,b] [--dir D] [--cli-dir D] [--python EXE]'); process.exit(0); }
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return o;
}

const log = (m) => console.log(m);
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);

/** 找一个能用的 python（3.x）：优先 --python / A_SHARE_PYTHON，再试常见命令 */
function findPython(preferred) {
  const cands = preferred ? [preferred] : (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']);
  for (const c of cands) {
    const args = c === 'py' ? ['-3', '--version'] : ['--version'];
    const r = spawnSync(c, args, { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout || ''}${r.stderr || ''}`)) {
      return { bin: c, prefix: c === 'py' ? ['-3'] : [] };
    }
  }
  return null;
}

/** 解压 zip：Windows 用 tar（Win10+ 自带）→ 退 Expand-Archive；其他平台 unzip */
function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tries = process.platform === 'win32'
    ? [['tar', ['-xf', zip, '-C', dest]], ['powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]]]
    : [['unzip', ['-q', '-o', zip, '-d', dest]], ['tar', ['-xf', zip, '-C', dest]]];
  const errs = [];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0) return true;
    errs.push(`${cmd}: ${(r.stderr || r.error?.message || '').toString().trim().split('\n')[0]}`);
  }
  throw new Error(`解压失败（试过 ${tries.map((t) => t[0]).join(' / ')}）：${errs.join(' | ')}`);
}

/** 在解压结果里定位主 CLI 脚本 */
function findCli(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'aime_skillhub_cli.py') return p;
    }
  }
  return null;
}

function skillScript(dir, slug) {
  const sdir = path.join(dir, slug, 'scripts');
  const direct = path.join(sdir, slug.replace(/-/g, '_') + '.py');
  if (fs.existsSync(direct)) return direct;
  try {
    const py = fs.readdirSync(sdir).filter((f) => f.endsWith('.py'));
    return py.length ? path.join(sdir, py[0]) : null;
  } catch { return null; }
}

function status(dir, skills) {
  return skills.map((s) => ({ slug: s, installed: Boolean(skillScript(dir, s)) }));
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error(`下载内容过小（${buf.length} 字节），可能被拦截/重定向到错误页`);
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  log('== 问财渠道技能安装（公告 / 新闻）==');
  log(`技能目录: ${o.dir}`);
  log(`待装技能: ${o.skills.join(', ')}`);

  const before = status(o.dir, o.skills);
  if (o.check) {
    for (const s of before) log(`  ${s.installed ? '✔' : '✘'} ${s.slug}`);
    log(`Python: ${findPython(o.python) ? '✔ 可用' : '✘ 未找到 Python 3（本步骤必需）'}`);
    log(`CLI: ${fs.existsSync(path.join(o.cliDir, 'aime_skillhub_cli.py')) ? '✔ 已就位' : '✘ 未安装（去掉 --check 即会自动下载）'}`);
    log('提示: Key 不在本脚本处理范围——写进 .a-share-assistant/config.json 的 iwencai.apiKey');
    return;
  }

  // ① python
  const py = findPython(o.python);
  if (!py) {
    console.error('\n✘ 未找到 Python 3。问财技能脚本是 Python 写的，必须要有：');
    console.error('  Windows: winget install Python.Python.3.12   （或 https://www.python.org/downloads/）');
    console.error('  macOS:   brew install python');
    console.error('  Linux:   sudo apt install python3');
    console.error('装完重跑本命令即可。主链路（行情/财务/复盘）不需要 Python，不受影响。');
    process.exit(1);
  }
  ok(`Python: ${py.bin} ${py.prefix.join(' ')}`);

  // ② CLI：已在则复用（--force 强制重下）
  const cliFile = path.join(o.cliDir, 'aime_skillhub_cli.py');
  if (fs.existsSync(cliFile) && !o.force) {
    ok(`SkillHub CLI 已就位，跳过下载: ${cliFile}`);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwencai-cli-'));
    const zip = path.join(tmp, 'iwencai-skillhub-cli.zip');
    log(`下载官方 SkillHub CLI: ${ZIP_URL}`);
    const bytes = await download(ZIP_URL, zip);
    ok(`下载完成（${(bytes / 1024).toFixed(0)} KB）`);
    unzip(zip, tmp);
    const found = findCli(tmp);
    if (!found) throw new Error('压缩包里没找到 aime_skillhub_cli.py（官方包结构可能变了，请手动检查）');
    fs.mkdirSync(o.cliDir, { recursive: true });
    const srcDir = path.dirname(found);
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      fs.cpSync(path.join(srcDir, e.name), path.join(o.cliDir, e.name), { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    ok(`CLI 已安装: ${cliFile}`);
  }

  // ③ 逐个装技能
  let failed = 0;
  for (const slug of o.skills) {
    log(`安装技能: ${slug}`);
    const r = spawnSync(py.bin, [...py.prefix, cliFile, '--dir', o.dir, 'install', slug, '--force'], { stdio: 'inherit' });
    if (r.status !== 0) { warn(`${slug} 安装失败（退出码 ${r.status}）——检查网络，或到 ${o.dir} 看是否半成品目录后重试`); failed++; }
  }

  // ④ 校验
  log('\n-- 校验 --');
  const after = status(o.dir, o.skills);
  for (const s of after) log(`  ${s.installed ? '✔' : '✘'} ${s.slug}${s.installed ? ` → ${path.dirname(skillScript(o.dir, s.slug))}` : ''}`);
  const allOk = after.every((s) => s.installed);
  log('');
  if (allOk && failed === 0) {
    log('✔ 技能就绪。还差两件事才算真的能用：');
    log('  1) 把问财 Key 写进 .a-share-assistant/config.json 的 iwencai.apiKey（https://www.iwencai.com/skillhub 获取）');
    log('  2) 验收：node src/cli.js search --channel announcement --q "贵州茅台 分红公告" --size 2 --summary');
    log('  （装完新开会话；本机没配 Key 时 check 会显示「⚠缺Key」，不影响行情/财务主链路）');
  } else {
    log('✘ 有技能未装成功，请按上面的提示处理后重跑本命令。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n✘ 安装失败: ${e.message}`);
  console.error('排查：网络能否访问 iwencai.com / 10jqka.com.cn；代理环境下可设 HTTPS_PROXY 后重试。');
  process.exitCode = 1;
});
