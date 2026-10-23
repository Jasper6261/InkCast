// Synthetic data only. No real IPC, filesystem, screenshots, WebSocket or HTTP.
window.TEST = {
  passed: [], failures: [], calls: [], sent: [], sockets: [], alerts: [], writes: [],
  events: {}, measurements: [], archive: null, confirmResult: true, savePath: 'synthetic-output.png', openPath: 'synthetic-input.wb.json',
  status: { clickthrough: false, shortcut: 'Ctrl+Alt+Shift+A', shortcutRegistered: true, shortcutError: null },
  pass(name) { this.passed.push(name); },
  fail(e) { this.failures.push(String(e?.stack || e)); },
  assert(value, name) { if (!value) throw new Error(name); this.pass(name); },
  receive(socket, message) { socket.onmessage?.({ data: JSON.stringify(message) }); },
  snapshot(socket, strokes) { boards[socket.board] = structuredClone(strokes); this.receive(socket, { t: 'full-state', strokes }); },
  async settle() { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); },
};
TEST.assertAPI = {
  strictEqual(a, b) { if (a !== b) throw new Error(`Expected ${a} === ${b}`); },
  ok(value) { if (!value) throw new Error('Assertion failed'); },
};
// 既有用例按简体中文界面断言；多语言用例在测试中切换语言
try { localStorage.setItem('wb_lang', 'zh-CN'); localStorage.setItem('wb_help_seen', '1'); } catch (e) {}
// v1.0.1 起 iPad 第一次打开默认是白板；既有 iPad 用例从“屏幕”模式开始，这里预设上次用的是屏幕
try { if (location.pathname.endsWith('pad.html')) localStorage.setItem('wb_mode', 'annotate'); } catch (e) {}
// v0.8.7 回归：电脑端旧版本留下的画笔大小（升级时清一次）；主窗口记住的设置（发送屏幕画面关、自定义快捷键）
try {
  if (location.pathname.endsWith('viewer.html')) {
    localStorage.removeItem('wb_pc_sz_rev'); localStorage.setItem('wb_pc_sz_soft', '18'); localStorage.setItem('wb_pc_sz_italic', '18'); localStorage.setItem('wb_pc_sz_marker', '16');
    localStorage.setItem('wb_preview_allowed', '0'); localStorage.setItem('wb_ov_shortcut', 'Ctrl+Alt+Shift+Q');
  }
} catch (e) {}
window.addEventListener('error', e => TEST.fail(e.error || e.message));
window.addEventListener('unhandledrejection', e => TEST.fail(e.reason));
window.alert = message => TEST.alerts.push(String(message));
window.confirm = () => true;
window.prompt = () => 'Ctrl+Alt+Shift+B';
window.fetch = () => Promise.reject(new Error('Network forbidden in this test'));
// Synthetic PointerEvents cannot acquire native pointer capture; keep all rasterization real.
HTMLCanvasElement.prototype.setPointerCapture = function () {};
HTMLCanvasElement.prototype.releasePointerCapture = function () {};
// Headless virtual time does not reliably schedule compositor frames or toBlob tasks.
// Keep real Canvas rasterization; simulate scheduling only, never native screenshot capture.
window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
HTMLCanvasElement.prototype.toBlob = function (callback, type) {
  const g = this.getContext('2d');
  TEST.exportCanvas = { width: this.width, height: this.height,
    center: Array.from(g.getImageData(Math.floor(this.width / 2), Math.floor(this.height / 2), 1, 1).data) };
  const raw = atob(this.toDataURL(type || 'image/png').split(',')[1]);
  callback(new Blob([Uint8Array.from(raw, ch => ch.charCodeAt(0))], { type: type || 'image/png' }));
};
const boards = { main: [], overlay: [] };
window.WebSocket = class {
  static OPEN = 1; static CLOSED = 3;
  constructor(url) {
    this.url = url; this.readyState = 0;
    this.role = new URL(url).searchParams.get('role');
    this.board = this.role === 'overlay' || new URL(url).searchParams.get('board') === 'overlay' ? 'overlay' : 'main';
    TEST.sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(text) {
    const msg = JSON.parse(text);
    TEST.sent.push({ role: this.role, msg });
    if (msg.t === 'hello') {
      TEST.receive(this, { t: 'welcome', role: this.role });
      TEST.snapshot(this, boards[this.board]);
      TEST.receive(this, { t: 'board-usage', points: boards[this.board].reduce((n, s) => n + s.points.length, 0),
        maxPoints: 200000, strokes: boards[this.board].length, maxStrokes: 2000 });
      return;
    }
    if (msg.t === 'preview-req' || msg.t === 'save-shot') return; // 由测试用例手动回复
    let output = msg;
    if (msg.t === 'board-load') {
      output = { t: 'full-state', strokes: msg.strokes };
      boards[this.board] = structuredClone(msg.strokes);
    } else if (msg.t === 'undo') {
      output = { t: 'undo', id: boards[this.board].at(-1)?.id || null };
      Whiteboard.applyMessage(boards[this.board], output);
    } else Whiteboard.applyMessage(boards[this.board], msg);
    for (const socket of TEST.sockets) {
      if (socket.board !== this.board || socket.readyState !== 1) continue;
      if (socket === this && msg.t.startsWith('stroke-')) continue;
      TEST.receive(socket, output);
    }
  }
  close() { this.readyState = 3; this.onclose?.(); }
};
const invoke = async (command, args) => {
  TEST.calls.push({ command, args });
  switch (command) {
    case 'set_language': TEST.language = args.lang; return args.lang;
    case 'get_loopback_port': return 12345;
    case 'get_host_token': return 'synthetic-test-value';
    case 'get_lan_status': return TEST.lan || null;
    case 'get_candidate_ips': return ['192.0.2.1'];
    case 'get_candidate_nets': return TEST.nets || [{ ip: '192.0.2.1', name: 'WLAN', virtual: false }, { ip: '172.18.0.1', name: 'singbox_tun', virtual: true }];
    case 'start_lan': TEST.lan = { ip: args.ip, port: 7749, pairingActive: true }; return { ip: args.ip, port: 7749, pairUrl: 'http://' + args.ip + ':7749/pad#p=synthetic', qrSvg: '<svg id="synthetic-qr"></svg>' };
    case 'stop_lan': TEST.lan = null; return;
    case 'get_app_info': return { version: '0.8.0', dataDir: 'D:/InkCast', shotsDir: 'D:/InkCast/screenshots', portable: true, os: TEST.os || 'windows', shortcut: 'Ctrl+Alt+Shift+A' };
    case 'get_notices': return 'InkCast third-party notices (synthetic)';
    case 'fix_firewall': TEST.firewallFixed = true; return 'ok';
    case 'open_overlay': return TEST.status;
    case 'close_overlay': return;
    case 'switch_to_whiteboard': TEST.switchedToBoard = true; return;
    case 'get_license_status': return TEST.license ? { state: 'active', enforced: false, plan: 'pro', codeHint: 'INK-…-VALID', channel: 'code', verifier: 'dev-checksum', features: ['write'] }
                                                   : { state: 'free', enforced: false, plan: null, codeHint: null, channel: 'code', verifier: 'dev-checksum', features: ['write'] };
    case 'activate_license': if (String(args.code).trim().toUpperCase() !== 'INK-TEST0-TEST0-TEST0-VALID') throw '激活码无效，请核对后重新输入';
      TEST.license = true; return invoke('get_license_status');
    case 'deactivate_license': TEST.license = false; return invoke('get_license_status');
    case 'get_overlay_status': return { ...TEST.status };
    case 'set_overlay_shortcut': TEST.status.shortcut = args.shortcut; return { ...TEST.status };
    case 'set_overlay_clickthrough': TEST.status.clickthrough = args.clickthrough; return args.clickthrough;
    case 'capture_screenshot_png': {
      const toolbar = document.getElementById('ui') || document.getElementById('toolbar');
      const hint = document.getElementById('hint');
      if (toolbar && getComputedStyle(toolbar).visibility !== 'hidden' && getComputedStyle(toolbar).display !== 'none') throw new Error('Toolbar visible during capture');
      if (hint && getComputedStyle(hint).visibility !== 'hidden' && getComputedStyle(hint).display !== 'none') throw new Error('Hint visible during capture');
      return;
    }
    case 'save_captured_screenshot': TEST.savedShot = args; return;
    case 'provide_ink_layer': TEST.inkProvided = args; return;
    case 'set_overlay_hit_rect': TEST.hitRect = args.rect; TEST.hitRectCalls = (TEST.hitRectCalls || 0) + 1; return;
    case 'discard_captured_screenshot': return;
    case 'get_preview_allowed': return TEST.previewAllowed !== false;
    case 'set_preview_allowed': TEST.previewAllowed = args.allowed; return args.allowed;
    case 'get_capture_visible': return TEST.captureVisible ?? true; // v1.0.2：后端默认打开
    case 'set_capture_visible': TEST.captureVisible = args.visible; return args.visible;
    case 'get_annotate_pads': return 0;
    default: throw new Error('Unexpected IPC: ' + command);
  }
};
window.__TAURI__ = {
  core: { invoke },
  event: { listen: async (name, callback) => { TEST.events[name] = callback; return () => {}; } },
  dialog: {
    confirm: async () => TEST.confirmResult,
    message: async message => TEST.alerts.push(String(message)),
    save: async (opts) => { TEST.calls.push({ command: 'dialog.save', opts }); return TEST.savePath; },
    open: async () => { TEST.calls.push({ command: 'dialog.open' }); return TEST.openPath; },
  },
  fs: {
    writeFile: async (file, bytes) => { TEST.writes.push({ file, bytes: Array.from(bytes) }); },
    readFile: async () => new TextEncoder().encode(JSON.stringify(TEST.archive)),
  },
};
