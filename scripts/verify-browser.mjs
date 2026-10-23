// Uses an installed Chromium browser. No packages, backend, real dialogs or network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {
  if (value.startsWith('--')) out.push([value.slice(2), all[index + 1]]);
  return out;
}, []));
if (!args.browser || !args.temp || !fs.existsSync(args.browser)) {
  throw new Error('Required: --browser <installed Chromium executable> --temp <temporary directory>');
}
const temp = path.resolve(args.temp);
fs.mkdirSync(temp, { recursive: true });
const cases = fs.readFileSync(path.join(root, 'tests/browser-cases.js'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'tests/browser-shim.js'), 'utf8');
const originalSharedTest = fs.readFileSync(path.join(root, 'tests/test_shared.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
function moduleSource(file) {
  return fs.readFileSync(file, 'utf8').replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, before, relative, after) => before + 'data:text/javascript;base64,' +
      Buffer.from(moduleSource(path.resolve(path.dirname(file), relative))).toString('base64') + after);
}
function safeScript(source) { return source.replace(/<\/script/gi, '<\\/script'); }
const results = [];
for (const page of ['shared', 'viewer', 'overlay', 'pad']) {
  const file = page === 'pad' ? 'pad/pad.html' : page === 'overlay' ? 'src/overlay.html' : 'src/index.html';
  const full = path.join(root, file);
  let html = page === 'shared' ? '<!doctype html><html><head></head><body><script src="i18n.js"></script><script src="shared.js"></script><script src="ink.js"></script></body></html>' : fs.readFileSync(full, 'utf8');
  html = html.replace(/<link[^>]*href="([^"]+)"[^>]*>/g, (_, relative) =>
    '<style>' + fs.readFileSync(path.resolve(path.dirname(full), relative), 'utf8') + '</style>');
  html = html.replace(/<script([^>]*)src="([^"]+)"([^>]*)><\/script>/g, (_, a, relative, b) => {
    const scriptFile = relative === '/shared.js' ? path.join(root, 'src/shared.js') :
      relative === '/pad.js' ? path.join(root, 'pad/pad.js') : relative === '/ink.js' ? path.join(root, 'src/ink.js') : relative === '/i18n.js' ? path.join(root, 'src/i18n.js') : path.resolve(path.dirname(full), relative);
    return '<script' + a + b + '>' + safeScript(moduleSource(scriptFile)) + '</script>';
  });
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
  html = html.replace('<head>', '<head>' + csp + '<script>' + safeScript(shim) + '</script>');
  const sharedRun = page === 'shared' ? `try { const assert = TEST.assertAPI; ${originalSharedTest}\nTEST.pass('original shared state machine: 9 assertion groups'); } catch(e) { TEST.fail(e); }` : '';
  html = html.replace('</body>', `<script type="module">${safeScript(sharedRun)}\n${safeScript(cases)}\nawait runBrowserCases(${JSON.stringify(page)});</script></body>`);
  const target = path.join(temp, page + '.html');
  fs.writeFileSync(target, html);
  // 无头浏览器的虚拟时钟遇到真实时间的异步操作（如 iPad 页解码屏幕画面）时，偶尔在测试结束前就用完预算；
  // 这种“没有产出结果”的情况最多重试 3 次（只重试无结果，不掩盖任何断言失败）。
  for (let attempt = 1; attempt <= 3; attempt++) {
  const profile = path.join(temp, 'profile-' + page + '-' + Date.now());
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { TEMP: temp, TMP: temp, USERPROFILE: profile, LOCALAPPDATA: path.join(profile, 'local'), APPDATA: path.join(profile, 'roaming') });
  const run = spawnSync(args.browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-default-browser-check',
    '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', '--user-data-dir=' + profile,
    '--virtual-time-budget=180000', '--dump-dom', pathToFileURL(target).href],
    { encoding: 'utf8', timeout: 280000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env });
  const match = (run.stdout || '').match(/data-verification="([A-Za-z0-9+/=]+)"/);
  if (!match) {
    fs.writeFileSync(path.join(temp, page + '-diagnostic.txt'), (run.stderr || '') + '\n' + (run.stdout || ''));
    if (attempt < 3) { console.log(`${page}: no result on attempt ${attempt}, retrying`); continue; }
    results.push({ page, failures: ['Browser did not produce results: ' + (run.error?.message || `exit ${run.status}`)], passed: [] });
  } else results.push({ page, ...JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) });
  break;
  }
}
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results/browser-results.json'), JSON.stringify(results, null, 2));
for (const result of results) {
  console.log(`${result.page}: ${result.passed.length} passed, ${result.failures.length} failed`);
  for (const failure of result.failures) console.log('  FAIL: ' + failure);
}
if (results.some(r => r.failures.length)) process.exitCode = 1;
