// Executed in an isolated Chromium renderer after the actual application scripts.
async function runBrowserCases(page) {
  const T = window.TEST;
  const click = async id => { document.getElementById(id).click(); await T.settle(); };
  const sample = { id: 'fixture', color: '#ff0000', size: 12, tool: 'pen', points: [[0.2, 0.2, 0.6], [0.8, 0.8, 0.6]] };
  try {
    await T.settle();
    if (page === 'shared') {
      const valid = { version: 1, strokes: [sample] };
      T.assert(Whiteboard.validateArchive(valid).length === 1, 'legacy archive accepted');
      const cases = [
        { version: 999, strokes: [] },
        { version: 1, strokes: [sample, sample] },
        { version: 1, strokes: [{ ...sample, points: [[2, 0, 0.5]] }] },
        { version: 1, strokes: [{ ...sample, tool: 'invalid' }] },
        { version: 1, strokes: [{ ...sample, size: -1 }] },
      ];
      for (let i = 0; i < cases.length; i++) {
        let rejected = false;
        try { Whiteboard.validateArchive(cases[i]); } catch { rejected = true; }
        T.assert(rejected, 'invalid archive rejected: case ' + (i + 1));
      }
      const state = [structuredClone(sample)];
      Whiteboard.applyMessage(state, { t: 'undo', id: null });
      T.assert(state.length === 1, 'undo null does not remove a stroke');
      T.assert(Whiteboard.validateArchive({ version: 2, board: 'overlay', canvas: { width: 1920, height: 1080 }, strokes: [sample] }).length === 1,
        'v2 overlay archive remains compatible');
      Whiteboard.applyMessage(state, { t: 'stroke-truncate', id: sample.id, len: 10 });
      Whiteboard.applyMessage(state, { t: 'stroke-truncate', id: sample.id, len: -1 });
      T.assert(state[0].points.length === 2, 'truncate never extends a stroke or accepts negative length');
      Whiteboard.applyMessage(state, { t: 'stroke-truncate', id: sample.id, len: 1 });
      T.assert(state[0].points.length === 1, 'truncate retains only the accepted prefix');
      Whiteboard.applyMessage(state, { t: 'stroke-rejected', id: sample.id });
      T.assert(state.length === 0, 'rejected stroke is removed by id');
      // v0.6 笔迹引擎：起笔细、中段粗（笔锋），荧光笔等宽，橡皮宽度为 size×2
      const line = n => Array.from({ length: n }, (_, i) => [0.1 + 0.8 * i / (n - 1), 0.5, 0.8]);
      const xfm = { sx: 1600, sy: 1000, ox: 0, oy: 0, s: 1 };
      const pen = Ink.samplesOf({ tool: 'pen', size: 10, points: line(40) }, xfm, true).samples;
      const mid = pen[Math.floor(pen.length / 2)][2];
      T.assert(pen[0][2] < mid * 0.5 && pen.at(-1)[2] < mid * 0.5, 'pen stroke tapers at both ends (笔锋)');
      const marker = Ink.samplesOf({ tool: 'marker', size: 10, points: line(40) }, xfm, true).samples;
      T.assert(Math.abs(marker[0][2] - marker[Math.floor(marker.length / 2)][2]) < 1e-6, 'marker keeps constant width');
      const eraser = Ink.samplesOf({ tool: 'eraser', size: 10, points: line(40) }, xfm, true).samples;
      T.assert(Math.abs(eraser[5][2] - 10) < 1e-6, 'eraser width is size x 2 (legacy convention)');
      // v0.8.15：来回涂抹的长橡皮在放大后也要整笔画到（以前超过采样上限就截断，放大后擦过的笔迹又露出来）
      {
        const scrub = [];
        for (let k = 0; k < 20; k++) for (let i = 0; i <= 40; i++) { const t = i / 40; scrub.push([k % 2 ? 0.9 - 0.8 * t : 0.1 + 0.8 * t, 0.3 + k * 0.01, 0.5]); }
        let worst = 0;
        for (const zoom of [1, 4]) {
          const W = 1000 * zoom, zx = { sx: W, sy: W, ox: 0, oy: 0, s: W / 1600 };
          const s = Ink.samplesOf({ tool: 'eraser', size: 10, points: scrub }, zx, true).samples;
          let miss = 0;
          for (let i = 1; i < scrub.length; i += 7) { const x = scrub[i][0] * W, y = scrub[i][1] * W;
            if (!s.some(c => Math.hypot(c[0] - x, c[1] - y) <= c[2] + 1)) miss++; }
          worst = Math.max(worst, miss);
        }
        T.assert(worst === 0, 'long eraser scrub is fully drawn when zoomed in (no sample-cap truncation)');
      }
      const light = Ink.samplesOf({ tool: 'pen', size: 10, points: line(40).map((p, i) => [p[0], p[1], i % 2 ? 0.15 : 0.12]) }, xfm, true).samples;
      const heavy = Ink.samplesOf({ tool: 'pen', size: 10, points: line(40).map((p, i) => [p[0], p[1], i % 2 ? 0.95 : 0.9]) }, xfm, true).samples;
      T.assert(light[20][2] < heavy[20][2] * 0.6, 'Pencil pressure changes stroke width');
      // 画笔：糖露是扁笔尖（横细竖粗）；凝胶墨水笔反向压感、越快越实；Looney 收笔尖尾；新画笔存档可读
      const press = line(40).map((p, i) => [p[0], p[1], 0.2 + 0.7 * Math.sin(Math.PI * i / 39)]);
      const syrup = Ink.outline({ tool: 'syrup', size: 10, points: press }, xfm, true);
      T.assert(syrup.nib && syrup.nib.ratio < 1 && syrup.quads.length > 100, 'syrup uses a flat (leaf) nib');
      const vline = line(40).map(p => [0.5, p[0], 0.7]);
      const hq = Ink.outline({ tool: 'syrup', size: 10, points: line(40) }, xfm, true).quads, vq = Ink.outline({ tool: 'syrup', size: 10, points: vline }, xfm, true).quads;
      const thick = q => Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1]);
      T.assert(thick(vq[Math.floor(vq.length / 2)]) > thick(hq[Math.floor(hq.length / 2)]) * 1.4, 'syrup: vertical strokes are thicker than horizontal (横细竖粗)');
      const gel = p => Ink.samplesOf({ tool: 'gel', size: 10, points: line(40).map((q, i) => [q[0], q[1], i % 2 ? p : p - 0.01]) }, xfm, true).samples[20];
      T.assert(gel(0.9)[2] < gel(0.2)[2], 'gel pen: pressing harder makes the line thinner (反向压感)');
      const slow = Ink.samplesOf({ tool: 'gel', size: 10, points: line(400) }, xfm, true).samples, fast = Ink.samplesOf({ tool: 'gel', size: 10, points: line(12) }, xfm, true).samples;
      T.assert(fast[Math.floor(fast.length / 2)][3] > slow[Math.floor(slow.length / 2)][3], 'gel pen: faster strokes are more opaque');
      const loo = Ink.samplesOf({ tool: 'looney', size: 10, points: line(40) }, xfm, true).samples;
      T.assert(loo.at(-1)[2] < 0.5 && loo[0][2] > loo.at(-1)[2] * 3, 'looney: no start taper, long sharp end taper');
      const looNib = Ink.outline({ tool: 'looney', size: 10, points: line(40) }, xfm, true).nib;
      T.assert(looNib && Math.abs(looNib.ratio - 0.482) < 1e-6 && looNib.angle === 0, 'looney uses the horizontal elliptical nib measured from its tip image');
      // v2 自研笔刷：参数串往返、笔感层（压感曲线、防抖、抬笔追尾）
      const enc = Ink.encodeTool(Ink.BRUSHES.callig.render), sp = Ink.specOf(enc);
      T.assert(/^v2\//.test(enc) && sp.baked && Math.abs(sp.nib.ratio - 0.55) < 1e-9 && Math.abs(sp.te - 3.2) < 1e-9, 'v2 render spec encodes and parses');
      T.assert(Whiteboard.validateArchive({ version: 1, strokes: [{ ...sample, tool: enc }] }).length === 1, 'archives accept v2 brush strings');
      let badV2 = false; try { Whiteboard.validateArchive({ version: 1, strokes: [{ ...sample, tool: 'v2/<x>' }] }); } catch { badV2 = true; }
      T.assert(badV2, 'archives reject v2 strings with unsafe characters');
      const feed = (inp, n, f) => { let out = []; for (let i = 0; i < n; i++) out = out.concat(inp.add(...f(i))); return out.concat(inp.finish()); };
      const wOf = pr => { const o = feed(Ink.Input(Ink.BRUSHES.callig.dyn), 30, i => [i, 0, pr, i * 8]); return o[15][2]; };
      T.assert(wOf(0.04) < wOf(0.1) && wOf(0.1) < wOf(0.18), 'v2 width grows with Pencil pressure across the measured everyday range (0.04–0.2)');
      T.assert(wOf(0.22) > 0.95 && wOf(0.03) < 0.3, 'light touch draws a thin line; measured 95th-percentile pressure (0.22) reaches full width');
      // 实测：坐标是整数像素、约 42% 事件重复。模拟一条斜线的整数台阶 + 重复事件
      const stair = stab => { const o = feed(Ink.Input({ ...Ink.BRUSHES.gel05.dyn, stab }), 300, i => [Math.round(i * 0.37), Math.round(i * 0.13), 0.15, Math.floor(i / 2) * 8.3]);
        return Math.max(...o.slice(5, -5).map(p => Math.abs(p[1] - p[0] * 0.13 / 0.37))); };
      T.assert(stair(0.3) < 0.3 && stair(0.8) < stair(0) , 'integer-pixel staircase is smoothed (锯齿): deviation < 0.3 px, more smoothing → smaller');
      const dup = Ink.Input(Ink.BRUSHES.gel05.dyn); let n1 = 0; for (let i = 0; i < 40; i++) { n1 += dup.add(i, 0, 0.1, i * 8).length; n1 += dup.add(i, 0, 0.1, i * 8).length; }
      T.assert(n1 + dup.finish().length === 40, 'duplicate Pencil events are dropped');
      const cu = Ink.Input(Ink.BRUSHES.soft.dyn); let sent = []; for (let i = 0; i < 30; i++) sent = sent.concat(cu.add(i * 8, 0, 0.4, i * 4));
      const liveTail = cu.tail(), tailPts = cu.finish();
      T.assert(sent.length === 30 - cu.R && liveTail.at(-1)[0] === 232 && tailPts.at(-1)[0] === 232,
        'only points with enough look-ahead are finalized; the live tail and pen-up both end exactly at the pen tip');
      T.assert(['pen', 'syrup', 'gel', 'looney', 'marker', 'eraser'].every(t => Ink.TOOLS[t] && Whiteboard.validateArchive({ version: 1, strokes: [{ ...sample, tool: t }] }).length === 1),
        'all brush ids are known to the renderer and accepted in archives');
      const geo = Ink.outline({ tool: 'pen', size: 10, points: line(40) }, xfm, true);
      T.assert(geo.quads.length > 100 && geo.quads.length >= geo.circles.length * 0.9, 'outline is densely resampled (smooth curves)');
    }
    if (page === 'viewer') {
      T.assert(T.sockets.length === 2 && T.sockets.every(s => s.readyState === 1), 'viewer modules initialize both local channels');
      // v0.8.13：使用说明内嵌在窗口里
      {
        const gm = document.getElementById('guide-modal'), gf = document.getElementById('guide-frame');
        T.assert(gm.classList.contains('hidden') && !gf.getAttribute('src'), 'v0.8.13: the user guide is not loaded until opened');
        document.getElementById('btn-guide').click();
        T.assert(!gm.classList.contains('hidden') && gf.getAttribute('src') === 'guide.html?lang=' + I18N.lang(), 'v0.8.13: the guide button opens the built-in guide in the current language');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        T.assert(gm.classList.contains('hidden'), 'v0.8.13: Esc closes the guide');
        document.getElementById('onb-guide').click();
        T.assert(!gm.classList.contains('hidden'), 'v0.8.13: the first-run card links to the guide');
        document.getElementById('guide-close').click();
        T.assert(gm.classList.contains('hidden'), 'v0.8.13: the close button closes the guide');
        const l0 = I18N.lang(); I18N.set('en');
        document.getElementById('btn-guide').click();
        T.assert(gf.getAttribute('src') === 'guide.html?lang=en', 'v0.8.13: after switching language the guide reopens in that language');
        document.getElementById('guide-close').click(); I18N.set(l0);
      }
      // v0.8.4：电脑端工具与 iPad 同一套布局——右上画笔 / 荧光笔 / 橡皮 / 颜色，左侧笔头大小 / 撤销 / 清除
      {
        const $ = id => document.getElementById(id);
        T.assert(!$('btn-tools') && !$('pc-tools') && ['t-pen', 't-marker', 't-eraser', 'custom-color', 'size-val', 'btn-undo', 'btn-clear'].every(id => $(id) && $(id).offsetParent !== null) &&
          $('pc-toolbar').getBoundingClientRect().right > innerWidth - 40 && $('pc-sidebar').getBoundingClientRect().left < 40,
          'PC window uses the iPad layout: tools at the top right, size / undo / clear on the left');
        $('custom-color').click();
        T.assert(!$('pc-picker').hidden && document.querySelectorAll('#colors .swatch[data-color]').length === 9 && $('color-input'), 'color button opens 9 common colors plus a custom color');
        document.querySelector('#colors .swatch[data-color="#2f6fed"]').click();
        T.assert($('pc-picker').hidden && localStorage.getItem('wb_pc_color') === '#2f6fed' && document.querySelector('#colors .swatch[data-color="#2f6fed"]').classList.contains('active'),
          'picking a color closes the picker and remembers it');
        $('t-marker').click(); $('custom-color').click(); document.querySelector('#colors .swatch[data-color="#1f9d55"]').click();
        T.assert(localStorage.getItem('wb_pc_mcolor') === '#1f9d55' && localStorage.getItem('wb_pc_color') === '#2f6fed' && localStorage.getItem('wb_pc_kind') === 'marker',
          'the highlighter keeps its own color, like on the iPad');
        $('t-pen').click();
        T.assert($('pc-brushes').hidden && localStorage.getItem('wb_pc_kind') === 'write', 'pen button switches back to writing');
        localStorage.removeItem('wb_pc_sz_italic'); localStorage.removeItem('wb_pc_sz_soft');
        $('t-pen').click();
        const bm = $('pc-brushes');
        T.assert(!bm.hidden && bm.querySelectorAll('button[data-brush]').length === 2 && bm.querySelector('button[data-brush="soft"] b').textContent === '中国毛笔',
          'tapping the active pen opens the brush menu (英文斜体 / 中国毛笔)');
        bm.querySelector('button[data-brush="soft"]').click();
        const sv = $('size-val');
        T.assert(bm.hidden && sv.value === '9.0' && $('brush-name').textContent === '中国毛笔', 'PC: 中国毛笔 starts at size 9 (' + sv.value + ')');
        $('t-pen').click(); bm.querySelector('button[data-brush="italic"]').click();
        T.assert(sv.value === '6.0', 'PC: 英文斜体 starts at size 6 (' + sv.value + ')');
        sv.focus(); sv.value = '20'; sv.dispatchEvent(new Event('change')); sv.blur();
        await new Promise(r => setTimeout(r, 120));
        const ps = T.sent.filter(x => x.msg.t === 'pen-size').at(-1);
        T.assert(ps && ps.msg.size === 20 && ps.msg.brush === 'italic' && localStorage.getItem('wb_pc_sz_italic') === '20' && sv.value === '20',
          'PC: typing a number sets the size and syncs it to the iPad for that brush');
        sv.value = '500'; sv.dispatchEvent(new Event('change'));
        T.assert(sv.value === '48', 'PC: typed sizes are limited to the allowed range');
        sv.value = 'abc'; sv.dispatchEvent(new Event('change'));
        T.assert(sv.value === '48', 'PC: invalid input is ignored');
        const tr = $('size-track').getBoundingClientRect(), bar = $('sizebar');
        const drag = (type, y) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: tr.left + 3, clientY: y }));
        drag('pointerdown', tr.top + tr.height * 0.5); drag('pointerup', tr.top + tr.height * 0.5);
        T.assert(Math.abs(parseFloat(sv.value) - Math.sqrt(48)) < 0.11, 'PC: the size bar is the same log-scale slider as on the iPad (' + sv.value + ')');
        T.receive(T.sockets.find(x => x.role === 'view'), { t: 'pen-size', size: 12, brush: 'soft' });
        T.receive(T.sockets.find(x => x.role === 'view'), { t: 'pen-size', size: 44 });
        T.assert(localStorage.getItem('wb_pc_sz_soft') === '12' && Math.abs(parseFloat(sv.value) - Math.sqrt(48)) < 0.11, 'PC: sizes are kept per brush; a size without a brush name is ignored');
        T.receive(T.sockets.find(x => x.role === 'view'), { t: 'pen-size', size: 33, brush: 'italic' });
        T.assert(sv.value === '33', 'size changed on the iPad updates the PC size');
        localStorage.removeItem('wb_pc_sz_soft'); localStorage.removeItem('wb_pc_sz_italic');
        $('btn-export').click();
        T.assert(!$('export-pop').hidden && $('btn-png').offsetParent !== null && $('btn-svg').offsetParent !== null, 'save PNG / SVG sit in the header Export menu');
        $('btn-export').click();
        T.assert($('export-pop').hidden, 'Export menu closes again');
      }
      // v0.8.5：屏幕标注的快捷键设置在主窗口“设置”里
      T.events['overlay-status']?.({ payload: { ...T.status, shortcutRegistered: false, shortcutError: 'synthetic conflict' } });
      T.assert(document.getElementById('shortcut-status').textContent.includes('synthetic conflict') && document.getElementById('settings-pop').contains(document.getElementById('shortcut')),
        'shortcut registration failure is shown in Settings');
      T.events['overlay-status']?.({ payload: { ...T.status } });
      T.assert(document.getElementById('shortcut-status').textContent.includes('记住'), 'shortcut recovery updates Settings');
      document.getElementById('shortcut').value = 'Ctrl+Alt+Q'; await click('btn-shortcut');
      T.assert(T.calls.some(c => c.command === 'set_overlay_shortcut' && c.args.shortcut === 'Ctrl+Alt+Q'), 'the shortcut can be changed from Settings');
      TEST.status.shortcut = 'Ctrl+Alt+Shift+A';
      const cap = document.getElementById('capture-visible');
      T.assert(cap && cap.checked && !T.calls.some(c => c.command === 'set_capture_visible'),
        'v1.0.2: “show annotations in recordings / screen sharing” is on by default (nothing saved yet)');
      T.assert(document.getElementById('capture-visible').closest('label, .row, div').textContent.length > 0 &&
        /默认打开/.test(document.body.innerHTML), 'v1.0.2: the setting explains it is on by default');
      cap.checked = false; cap.dispatchEvent(new Event('change')); await T.settle();
      T.assert(T.calls.some(c => c.command === 'set_capture_visible' && c.args && c.args.visible === false) && localStorage.getItem('wb_capture_visible') === '0',
        'v1.0.2: turning it off is remembered');
      cap.checked = true; cap.dispatchEvent(new Event('change')); await T.settle();
      T.assert(T.calls.some(c => c.command === 'set_capture_visible' && c.args && c.args.visible === true), 'toggle invokes set_capture_visible');
      cap.checked = false; cap.dispatchEvent(new Event('change')); await T.settle();
      T.assert(document.getElementById('seg-board').classList.contains('on') && document.getElementById('btn-overlay').textContent === '屏幕' &&
        document.getElementById('pc-mode-seg').contains(document.getElementById('btn-overlay')), 'PC uses the same “屏幕 | 白板” switch as the iPad (白板 selected)');
      await click('btn-overlay');
      T.assert(T.calls.some(c => c.command === 'open_overlay') && document.getElementById('btn-overlay').classList.contains('on'), '“屏幕” opens screen annotation');
      // v0.8.8：屏幕标注时主窗口的白板工具全部收起，只留说明卡片
      { const hid = (id) => { const e = document.getElementById(id); return !e || getComputedStyle(e).display === 'none'; };
        T.assert(document.body.classList.contains('annotating') && hid('pc-toolbar') && hid('pc-sidebar') && hid('btn-export') && hid('board') && hid('onboard') &&
          !document.getElementById('annot-card').hidden, 'v0.8.8: while annotating the screen, the whiteboard tools are hidden and a short card explains where the tools are');
        T.assert(!hid('pc-mode-seg') && !hid('btn-settings') && !hid('btn-about') && !hid('btn-qr'), 'v0.8.8: the 屏幕 | 白板 switch, Settings, About and Connect stay');
        const n0 = T.calls.filter(c => c.command === 'open_overlay').length;
        await click('annot-draw');
        T.assert(T.calls.filter(c => c.command === 'open_overlay').length === n0 + 1, 'v0.8.8: “继续标注” on the card brings the annotation toolbar back');
        const sent0 = T.sent.length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        T.assert(!T.sent.slice(sent0).some(x => x.msg.t === 'undo'), 'v0.8.8: Ctrl+Z in the main window does not touch the whiteboard while annotating'); }
      T.events['overlay-status']?.({ payload: { ...T.status, open: false } });
      T.assert(document.getElementById('seg-board').classList.contains('on'), 'the switch follows the annotation layer being closed');
      T.assert(!document.body.classList.contains('annotating') && document.getElementById('annot-card').hidden && getComputedStyle(document.getElementById('pc-toolbar')).display !== 'none',
        'v0.8.8: back on the whiteboard, its tools return');
      // ---------- v0.8.7 回归 ----------
      {
        T.assert(localStorage.getItem('wb_pc_sz_soft') === null && localStorage.getItem('wb_pc_sz_marker') === '16' && localStorage.getItem('wb_pc_sz_rev') === '1' && Ink.pcSize('soft') === 9,
          'v0.8.7: brush sizes left by old versions (中国毛笔 18) go back to the defaults once; marker / eraser sizes are kept');
        T.assert(!document.getElementById('preview-allowed').checked && TEST.previewAllowed === false, 'v0.8.7: “send screen to iPad” stays off after a restart');
        const pa = document.getElementById('preview-allowed');
        pa.checked = true; pa.dispatchEvent(new Event('change')); await T.settle();
        T.assert(localStorage.getItem('wb_preview_allowed') === '1', 'v0.8.7: turning it back on is remembered');
        T.assert(T.calls.some(c => c.command === 'set_overlay_shortcut' && c.args.shortcut === 'Ctrl+Alt+Shift+Q'), 'v0.8.7: the saved shortcut is applied at start-up');
        document.getElementById('shortcut').value = 'Ctrl+Alt+Shift+A';
        await click('btn-shortcut'); await T.settle();
        T.assert(localStorage.getItem('wb_ov_shortcut') === 'Ctrl+Alt+Shift+A', 'v0.8.7: applying a shortcut remembers it');
        T.assert(document.getElementById('settings-pop').contains(document.getElementById('btn-preview-test')) && !document.getElementById('export-pop').contains(document.getElementById('btn-preview-test')),
          'v0.8.7: the screen-feed test sits in Settings next to the screen-feed switch, not in Export');
        // 重做 + 键盘快捷键
        const vs = T.sockets.find(x => x.role === 'view'), ps = T.sockets.find(x => x.role === 'pad-local');
        T.snapshot(vs, []);
        const redoBtn = document.getElementById('btn-redo');
        T.assert(redoBtn && document.getElementById('pc-sidebar').contains(redoBtn) && redoBtn.disabled, 'v0.8.7: the PC has a Redo button next to Undo (disabled until something is undone)');
        const cr = document.getElementById('board').getBoundingClientRect();
        const mouse = (type, x, y) => document.getElementById('board').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 81, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cr.left + x, clientY: cr.top + y }));
        mouse('pointerdown', cr.width * 0.3, cr.height * 0.3);
        for (let i = 1; i <= 8; i++) mouse('pointermove', cr.width * (0.3 + i * 0.02), cr.height * 0.3 + i * 3);
        mouse('pointerup', cr.width * 0.46, cr.height * 0.3 + 24);
        await T.settle();
        T.assert(document.getElementById('onboard').hidden, 'v0.8.7: writing with the mouse puts the connect card away');
        T.assert(boardsLen() === 1, 'v0.8.7: mouse stroke reaches the board');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        await T.settle();
        T.assert(boardsLen() === 0 && !redoBtn.disabled, 'v0.8.7: Ctrl+Z undoes the last stroke');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
        await T.settle();
        T.assert(boardsLen() === 1 && redoBtn.disabled, 'v0.8.7: Ctrl+Y redoes it (the stroke is sent again)');
        await click('btn-undo'); await T.settle();
        await click('btn-redo'); await T.settle();
        T.assert(boardsLen() === 1, 'v0.8.7: the Redo button brings back the undone stroke');
        T.receive(vs, { t: 'undo', id: 'someone-else' });
        T.assert(redoBtn.disabled, 'v0.8.7: strokes undone from the iPad are not offered for redo here');
        document.getElementById('shortcut').focus();
        const sentBefore = T.sent.length;
        document.getElementById('shortcut').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        T.assert(!T.sent.slice(sentBefore).some(x => x.msg.t === 'undo'), 'v0.8.7: Ctrl+Z inside a text box is left to the text box');
        document.getElementById('shortcut').blur();
        T.snapshot(vs, []);
        function boardsLen() { return document.getElementById('stroke-count').textContent.match(/\d+/) ? +document.getElementById('stroke-count').textContent.match(/\d+/)[0] : -1; }
      }
      // 授权（预留）：关于里输入激活码
      await click('btn-about'); await T.settle(); await T.settle();
      T.assert(document.getElementById('lic-state').textContent.includes('未激活') && !document.getElementById('lic-form').hidden, 'About shows the license state and a code field');
      document.getElementById('lic-code').value = 'INK-AAAAA-BBBBB-CCCCC-DDDDD';
      await click('lic-activate'); await T.settle();
      T.assert(document.getElementById('lic-msg').textContent.includes('激活码无效'), 'an invalid code is rejected with a reason');
      document.getElementById('lic-code').value = 'ink-test0-test0-test0-valid';
      await click('lic-activate'); await T.settle();
      T.assert(document.getElementById('lic-state').textContent.includes('已激活') && document.getElementById('lic-form').hidden && document.getElementById('lic-code-hint').textContent.includes('VALID') &&
        window.InkLicense.isUnlocked('export'), 'a valid code activates; features stay unlocked');
      await click('lic-deactivate'); await T.settle();
      T.assert(TEST.license && document.getElementById('lic-deactivate').textContent.includes('再点一次'), 'deactivate needs a second click to confirm (no accidental loss of the activation)');
      await click('lic-deactivate'); await T.settle();
      T.assert(document.getElementById('lic-state').textContent.includes('未激活') && !document.getElementById('lic-form').hidden, 'deactivate returns to the code field');
      await click('about-close');
      T.assert(document.getElementById('onboard').hidden && document.getElementById('onb-close'), 'v0.8.7: the connect card stays put away for this run after writing with the mouse; it also has a close button');
      await click('onb-connect'); await T.settle();
      T.assert(T.calls.some(c => c.command === 'start_lan' && c.args.ip === '192.0.2.1') && document.getElementById('synthetic-qr'),
        'connecting starts sharing on the best network address and shows the QR code right away');
      document.getElementById('btn-change-ip').click(); await T.settle(); await T.settle();
      {
        const btns = [...document.querySelectorAll('.ip-btn')];
        T.assert(btns.length === 2 && !TEST.lan, 'a different network address can be chosen');
        T.assert(btns[0].textContent.includes('WLAN') && !btns[0].classList.contains('virtual') && btns[1].classList.contains('virtual') &&
          btns[1].textContent.includes('singbox_tun') && btns[1].textContent.includes('虚拟网卡'),
          'v1.0.1: the address list shows each adapter name and marks virtual adapters / VPN');
        btns[1].click(); await T.settle(); await T.settle();
        T.assert(TEST.lan && TEST.lan.ip === '172.18.0.1' && document.getElementById('virtual-warn') && document.getElementById('virtual-warn').textContent.includes('换一个网络地址'),
          'v1.0.1: sharing on a virtual adapter warns that the iPad may not reach it');
        document.getElementById('btn-change-ip').click(); await T.settle(); await T.settle();
        document.querySelector('.ip-btn').click(); await T.settle(); await T.settle();
        T.assert(TEST.lan.ip === '192.0.2.1' && !document.getElementById('virtual-warn') && document.getElementById('pair-body').textContent.includes('(WLAN)'),
          'v1.0.1: the sharing line names the adapter (WLAN)');
      }
      document.querySelector('.trouble summary').click();
      T.assert(document.querySelector('.trouble ul').textContent.includes('v2rayN'), 'v1.0.1: troubleshooting explains VPN / proxy apps on the computer');
      document.getElementById('btn-firewall').click(); await T.settle();
      T.assert(TEST.firewallFixed && document.getElementById('fw-result').textContent.length > 0, 'troubleshooting offers a one-click firewall fix on Windows');
      T.assert(!document.getElementById('qr-modal').classList.contains('hidden'), 'QR window is open while waiting for the iPad');
      T.receive(T.sockets.find(s => s.role === 'view'), { t: 'pad-status', online: 1 });
      T.assert(document.getElementById('qr-modal').classList.contains('hidden') && document.getElementById('board-notice').textContent.includes('iPad 已连接'),
        'v0.8.11: the QR window closes by itself once the iPad has scanned and connected');
      T.assert(document.getElementById('onboard').hidden, 'onboarding card hides once an iPad connects');
      {
        // v1.0.1：iPad 切换“屏幕 | 白板”时会断开再重连——引导卡片不能闪出来，“未连接”也不立刻显示
        const view = T.sockets.find(s => s.role === 'view'), pill = document.getElementById('pad-status');
        T.receive(view, { t: 'pad-status', online: 0 });
        T.assert(document.getElementById('onboard').hidden && pill.classList.contains('on'),
          'v1.0.1: a brief iPad reconnect (switching Screen / Whiteboard) does not flash the connect card or the offline state');
        T.receive(view, { t: 'pad-status', online: 1 });
        T.receive(view, { t: 'pad-status', online: 0 });
        await new Promise(r => setTimeout(r, 2700));
        T.assert(!pill.classList.contains('on') && document.getElementById('onboard').hidden,
          'v1.0.1: a real disconnect shows "iPad not connected" after a moment, without the connect card');
        T.receive(view, { t: 'pad-status', online: 1 });
        T.assert(pill.classList.contains('on'), 'v1.0.1: reconnecting shows connected again');
        // v1.0.2：iPad 时钟比电脑慢 1.3 秒时，延迟不能显示成 1300ms——扣掉两台设备的时钟差
        // 统计窗口 300 个点：同一台 iPad 的时钟差恒定，发满一个窗口
        T.receive(view, { t: 'stroke-start', id: 'lat1', color: '#000000', size: 4, tool: 'pen' });
        for (let i = 0; i < 320; i++) T.receive(view, { t: 'stroke-point', id: 'lat1', x: 0.1 + (i % 60) * 0.01, y: 0.2, p: 0.5, ts: Date.now() - 1300 - (i % 4) * 10 });
        T.receive(view, { t: 'stroke-end', id: 'lat1' });
        await new Promise(r => setTimeout(r, 1200));
        const lat = document.getElementById('latency').textContent, m = lat.match(/p50 (-?\d+)ms \/ p95 (-?\d+)ms/);
        T.assert(m && +m[1] >= 0 && +m[1] < 100 && +m[2] < 100, 'v1.0.2: latency excludes the clock difference between iPad and PC (' + lat + ')');
      }
      await click('btn-about'); await T.settle(); await T.settle();
      T.assert(!document.getElementById('about-modal').classList.contains('hidden') && document.getElementById('about-version').textContent.includes('0.8.0') &&
        document.getElementById('about-notices').textContent.includes('third-party'), 'about dialog shows version, data location and open-source notices');
      await click('about-close');
      const socket = T.sockets.find(s => s.role === 'view');
      T.snapshot(socket, [sample]);
      T.assert(document.getElementById('stroke-count').textContent.includes('1'), 'viewer renders incoming full state');
      const beforeClear = T.sent.length;
      await click('btn-clear');
      T.assert(T.sent.slice(beforeClear).some(x => x.msg.t === 'clear') && !document.getElementById('undo-toast').hidden && document.getElementById('stroke-count').textContent.includes('0'),
        'viewer: one tap clears (no confirm dialog, like the iPad) and offers Undo');
      await click('undo-toast-btn');
      T.assert(T.sent.some(x => x.msg.t === 'board-load') && document.getElementById('stroke-count').textContent.includes('1') && document.getElementById('undo-toast').hidden,
        'viewer: Undo brings the cleared strokes back');
      await click('btn-clear');
      T.assert(document.getElementById('stroke-count').textContent.includes('0'), 'viewer clear control receives server result');
      T.snapshot(socket, [sample, { ...sample, id: 'eraser', tool: 'eraser' }]);
      await click('btn-png');
      for (let i = 0; i < 160 && T.writes.length < 1; i++) await new Promise(r => setTimeout(r, 25));
      T.assert(T.writes.length === 1, 'viewer PNG export writes mock output');
      { const so = T.calls.filter(c => c.command === 'dialog.save').at(-1).opts;
        T.assert(/^白板-\d{8}-\d{6}\.png$/.test(so.defaultPath), 'v0.8.7: export suggests a dated file name (' + so.defaultPath + ')');
        T.assert(document.getElementById('board-notice').textContent.includes('已保存') && document.getElementById('board-notice').textContent.includes('synthetic-output.png'),
          'v0.8.7: a saved notice shows where the file went'); }
      const pixel = T.exportCanvas.center;
      T.assert(pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255 && pixel[3] === 255, 'erased PNG pixel remains opaque white');
      T.assert(T.exportCanvas.width === 3200 && T.exportCanvas.height === 2000, 'viewer PNG dimensions remain 3200 by 2000');
    }
    if (page === 'overlay') {
      T.assert(T.sockets.length === 1 && T.sockets[0].role === 'overlay', 'overlay initializes its independent channel');
      // v0.8.6：与白板、iPad 同一套控件，全部集中在屏幕上方一条工具栏；不再有存档 / 打开 / 导出 PNG、快捷键设置（在主窗口“设置”）
      const $ = id => document.getElementById(id);
      const dockIds = ['seg-screen', 'seg-board', 't-pen', 't-marker', 't-eraser', 'custom-color', 'sizebar', 'size-val', 'btn-undo', 'btn-redo', 'btn-clear', 'btn-shot', 'btn-mode'];
      T.assert(dockIds.every(id => $(id) && $('pc-dock').contains($(id))) && !$('pc-toolbar') && !$('pc-sidebar') &&
        !$('btn-open') && !$('btn-save') && !$('btn-png') && !$('shortcut') && !$('pen-chip'),
        'overlay: every function sits in one toolbar; no archive, layer export or shortcut controls');
      const dr = $('pc-dock').getBoundingClientRect();
      T.assert(dr.top < 30 && Math.abs((dr.left + dr.right) / 2 - innerWidth / 2) < 2 && dr.height < 60, 'overlay: the toolbar is one row at the top centre');
      T.assert($('seg-screen').classList.contains('on') && $('seg-screen').textContent === '屏幕' && $('seg-board').textContent === '白板',
        'overlay: same “屏幕 | 白板” switch as on the iPad');
      T.assert($('overlay-status').hidden, 'overlay: no status line while everything is normal');
      // 工具设置与主窗口共用：这里改，另一个窗口读到同一份
      localStorage.removeItem('wb_pc_sz_soft');
      $('t-pen').click(); $('pc-brushes').querySelector('button[data-brush="soft"]').click();
      T.assert(Ink.pcTool().brush === 'soft' && $('size-val').value === '9.0', 'overlay: choosing a brush here is the same setting as in the main window');
      $('t-pen').click(); $('pc-brushes').querySelector('button[data-brush="italic"]').click();
      // 一键清除 + 撤销（与白板一致）
      T.snapshot(T.sockets[0], [sample]);
      const nc = T.sent.length;
      await click('btn-clear');
      T.assert(T.sent.slice(nc).some(x => x.msg.t === 'clear') && !$('undo-toast').hidden, 'overlay: one tap clears (no confirm dialog) and offers Undo');
      await click('btn-undo');
      T.assert(T.sent.slice(nc).some(x => x.msg.t === 'board-load' && x.msg.strokes.length === 1), 'overlay: Undo brings the cleared annotations back');
      // 横向大小条：向右拖变粗
      { const tr = $('size-track').getBoundingClientRect(), bar = $('sizebar');
        const drag = (type, x) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 72, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: tr.top + 3 }));
        drag('pointerdown', tr.right - 1); drag('pointerup', tr.right - 1);
        T.assert(parseFloat($('size-val').value) > 45, 'overlay: the size slider in the toolbar works (drag right = thicker)');
        $('size-val').value = '6'; $('size-val').dispatchEvent(new Event('change')); }
      // 弹出面板出现在按钮下方
      $('custom-color').click();
      T.assert(!$('pc-picker').hidden && $('pc-picker').getBoundingClientRect().top >= dr.bottom, 'overlay: the colour picker opens right under the toolbar');
      $('custom-color').click();
      await click('btn-mode');
      T.assert($('btn-mode').classList.contains('active') && T.calls.some(c => c.command === 'set_overlay_clickthrough'),
        'click-through button updates from native response');
      T.assert(getComputedStyle($('ui')).display === 'none', 'overlay: tools are hidden in click-through mode');
      // v0.8.8：穿透时屏幕上方留一条小工具栏（屏幕 | 白板、继续标注），并把它的位置告诉程序（鼠标移上去时才可以点）
      { const mini = $('mini'), mr = mini.getBoundingClientRect();
        T.assert(!mini.hidden && mr.top < 30 && Math.abs((mr.left + mr.right) / 2 - innerWidth / 2) < 2 && mr.width < 420 &&
          mini.contains($('mini-screen')) && mini.contains($('mini-board')) && mini.contains($('mini-draw')) && $('mini-screen').classList.contains('on'),
          'v0.8.8: in click-through a small bar stays at the top: 屏幕 | 白板 and “继续标注”');
        T.assert(Array.isArray(TEST.hitRect) && TEST.hitRect.length === 4 && Math.abs(TEST.hitRect[0] - mr.left) <= 1 && Math.abs(TEST.hitRect[2] - mr.width) <= 1,
          'v0.8.8: the small bar reports its position so only it catches the mouse');
        T.assert(!$('corner'), 'v0.8.8: the old corner badge is gone');
        await click('mini-draw'); await T.settle();
        T.assert(T.calls.filter(c => c.command === 'set_overlay_clickthrough').at(-1).args.clickthrough === false && mini.hidden &&
          getComputedStyle($('ui')).display !== 'none' && TEST.hitRect === null, 'v0.8.8: “继续标注” returns to drawing; the full toolbar comes back');
        await click('btn-mode'); await T.settle();
        T.assert(!mini.hidden, 'v0.8.8: switching to click-through again shows the small bar');
        const before = T.calls.length;
        await click('mini-screen'); await T.settle();
        T.assert(T.calls.slice(before).some(c => c.command === 'set_overlay_clickthrough' && c.args.clickthrough === false), 'v0.8.8: 屏幕 on the small bar also returns to drawing');
        await click('btn-mode'); await T.settle();
        TEST.switchedToBoard = false;
        await click('mini-board'); await T.settle();
        T.assert(TEST.switchedToBoard, 'v0.8.8: 白板 on the small bar goes back to the whiteboard'); }
      T.events['overlay-mode']?.({ payload: false });
      await T.settle();
      const before = T.calls.length;
      document.getElementById('btn-shot').click();
      for (let i = 0; i < 80 && !T.calls.slice(before).some(c => c.command === 'discard_captured_screenshot'); i++) await new Promise(r => setTimeout(r, 25));
      await T.settle();
      const commands = T.calls.slice(before).map(c => c.command);
      T.assert(commands.includes('save_captured_screenshot'), 'screenshot flows through cache save');
      { const so = T.calls.slice(before).find(c => c.command === 'dialog.save').opts;
        T.assert(/^标注截图-\d{8}-\d{6}\.png$/.test(so.defaultPath), 'v0.8.7: screenshot suggests a dated file name (' + so.defaultPath + ')');
        const ink = TEST.savedShot && TEST.savedShot.ink;
        T.assert(typeof ink === 'string' && ink.length > 100 && atob(ink).slice(1, 4) === 'PNG', 'v0.8.7: the screenshot carries the annotation layer (transparent PNG) to be merged onto the screen');
        const img = new Image(); img.src = 'data:image/png;base64,' + ink; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let ink1 = 0, clear0 = 0;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) ink1++; else clear0++; }
        T.assert(img.width === document.getElementById('board').width && ink1 > 0 && clear0 > ink1, 'v0.8.7: the annotation layer has the strokes and is transparent elsewhere (' + ink1 + ' ink px)'); }
      T.assert(commands.indexOf('capture_screenshot_png') < commands.indexOf('dialog.save'), 'screenshot is captured before save dialog');
      T.assert(!document.getElementById('btn-shot').disabled, 'screenshot action unlocks after completion');
      T.savePath = null;
      document.getElementById('btn-shot').click();
      await new Promise(r => setTimeout(r, 600)); await T.settle();
      T.assert(T.calls.some(c => c.command === 'discard_captured_screenshot'), 'cancel discards cached screenshot');
      // v0.8.9：橡皮擦逐点擦除（不整屏重画）：iPad 上擦的每一点立刻从标注层上消失
      { const ov = T.sockets[0], bc = document.getElementById('board'), g = bc.getContext('2d');
        T.snapshot(ov, [{ id: 'eb', color: '#000000', size: 30, tool: 'pen', points: Array.from({ length: 30 }, (_, i) => [0.2 + i * 0.02, 0.5, 0.6]) }]);
        await new Promise(r => setTimeout(r, 120));
        const a = (nx, ny) => g.getImageData(Math.round(nx * bc.width), Math.round(ny * bc.height), 1, 1).data[3];
        T.assert(a(0.5, 0.5) > 0, 'v0.8.9: overlay base stroke drawn');
        T.receive(ov, { t: 'stroke-start', id: 'er1', color: '#000000', size: 40, tool: 'eraser' });
        [0.45, 0.48, 0.5, 0.52, 0.55].forEach(x => T.receive(ov, { t: 'stroke-point', id: 'er1', x, y: 0.5, p: 0.5 }));
        T.assert(a(0.5, 0.5) === 0 && a(0.3, 0.5) > 0, 'v0.8.9: overlay erases point by point as the eraser moves (no full redraw needed)');
        T.receive(ov, { t: 'stroke-end', id: 'er1' });
        await new Promise(r => setTimeout(r, 120));
        T.assert(a(0.5, 0.5) === 0 && a(0.3, 0.5) > 0, 'v0.8.9: overlay result is unchanged after the eraser ends'); }
      // iPad 发起的截图：程序向标注层要墨迹层
      TEST.inkProvided = null;
      await T.events['ink-layer-request']?.({ payload: 7 });
      for (let i = 0; i < 40 && !TEST.inkProvided; i++) await new Promise(r => setTimeout(r, 25));
      T.assert(TEST.inkProvided && TEST.inkProvided.id === 7 && TEST.inkProvided.png.length > 100, 'v0.8.7: an iPad screenshot gets the annotation layer from the overlay');
      // 重做（与白板一致）
      { const ov = T.sockets[0], cr = document.getElementById('board').getBoundingClientRect();
        T.snapshot(ov, []);
        const mouse = (type, x, y) => document.getElementById('board').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 82, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cr.left + x, clientY: cr.top + y }));
        mouse('pointerdown', 200, 200); for (let i = 1; i <= 8; i++) mouse('pointermove', 200 + i * 15, 200 + i * 4); mouse('pointerup', 320, 232);
        await T.settle();
        const n0 = T.sent.filter(x => x.msg.t === 'stroke-start').length;
        await click('btn-undo'); await T.settle();
        T.assert(!$('btn-redo').disabled, 'v0.8.7: overlay Redo becomes available after Undo');
        await click('btn-redo'); await T.settle();
        T.assert(T.sent.filter(x => x.msg.t === 'stroke-start').length === n0 + 1 && boardsOverlay() === 1, 'v0.8.7: overlay Redo sends the stroke again and shows it');
        function boardsOverlay() { return window.__ovStrokes(); } }
      await click('seg-board');
      T.assert(TEST.switchedToBoard, '“白板” closes screen annotation and brings back the whiteboard window');
    }
    if (page === 'pad') {
      T.assert(T.sockets.length === 1, 'pad script initializes without external modules');
      const sock = T.sockets[0];
      T.assert(sock.url.includes('board=overlay'), 'pad defaults to screen annotation (overlay board)');
      T.assert(T.sent.some(x => x.msg.t === 'preview-req'), 'pad requests the PC screen preview after sync');
      // 屏幕画面帧：meta + PNG 二进制 → 背景层出现画面
      const c = document.createElement('canvas'); c.width = 160; c.height = 100;
      const cg = c.getContext('2d'); cg.fillStyle = '#ff0000'; cg.fillRect(0, 0, 160, 100);
      const png = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));
      sock.onmessage({ data: JSON.stringify({ t: 'preview-meta', w: 1600, h: 1000, fw: 160, fh: 100 }) });
      const frameBlob = new Blob([png], { type: 'image/png' });
      sock.onmessage({ data: frameBlob });
      await createImageBitmap(frameBlob); // 解码按真实时间进行；先等同一张图解码完成，再检查（测试浏览器用虚拟时钟）
      const bgc = document.getElementById('bg'); let bp = [0, 0, 0, 0];
      for (let i = 0; i < 60 && !(bp[0] > 200 && bp[1] < 60); i++) {
        await new Promise(r => setTimeout(r, 50));
        await createImageBitmap(frameBlob); // 每轮再等一次真实时间的解码，避免虚拟时钟跑在解码前面
        bp = bgc.getContext('2d').getImageData(bgc.width >> 1, bgc.height >> 1, 1, 1).data;
      }
      T.assert(bp[0] > 200 && bp[1] < 60, 'preview frame is drawn as the writing background');
      // v0.8.4：电脑端写的笔画也显示在 iPad 上
      T.receive(sock, { t: 'stroke-start', id: 'pc-stroke', color: '#00ff00', size: 20, tool: 'pen' });
      for (let i = 0; i <= 10; i++) T.receive(sock, { t: 'stroke-point', id: 'pc-stroke', x: 0.1 + i * 0.08, y: 0.9, p: 0.8 });
      T.receive(sock, { t: 'stroke-end', id: 'pc-stroke' });
      await new Promise(r => setTimeout(r, 60));
      const inkc = document.getElementById('ink');
      const colInk = () => { const d = inkc.getContext('2d').getImageData(inkc.width >> 1, Math.floor(inkc.height * 0.6), 1, Math.floor(inkc.height * 0.4)).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
      T.assert(colInk() > 3, 'strokes written on the PC are shown on the iPad too');
      T.receive(sock, { t: 'undo', id: 'pc-stroke' });
      await new Promise(r => setTimeout(r, 60));
      T.assert(colInk() === 0, 'undoing a PC stroke removes it on the iPad');
      // 截图请求
      document.getElementById('btn-shot').click();
      const shot = T.sent.filter(x => x.msg.t === 'save-shot').at(-1);
      T.assert(shot && /^\d{8}-\d{6}$/.test(shot.msg.name), 'screenshot button asks the PC to save with a timestamp name');
      T.receive(sock, { t: 'shot-saved', path: 'D:/x/标注截图-1.png' });
      T.assert(document.getElementById('notice').textContent.includes('标注截图-1.png'), 'saved screenshot path is shown');
      // 画笔菜单：点“钢笔 ▾”展开，选糖露后显示名称，并有示例笔迹
      document.getElementById('t-pen').click();
      const menu = document.getElementById('brushes');
      T.assert(!menu.hidden && menu.querySelectorAll('button[data-brush]').length === 2 && document.getElementById('brush-name').textContent === '英文斜体' &&
        menu.querySelector('button[data-brush="soft"] b').textContent === '中国毛笔',
        'brush menu lists 2 brushes (英文斜体 / 中国毛笔), default 英文斜体');
      const sampleCanvas = menu.querySelector('button[data-brush="soft"] canvas');
      const sd = sampleCanvas.getContext('2d').getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
      let inked = 0; for (let i = 3; i < sd.length; i += 4) if (sd[i] > 0) inked++;
      T.assert(inked > 50, 'brush menu draws a sample stroke for each brush');
      // Apple Pencil 点按钮：按下抬起即一次点击；紧随的原生点击不会重复触发
      {
        document.getElementById('btn-menu').click();
        T.assert(!document.getElementById('appmenu').hidden, 'pad: the logo button opens the app menu (pen only, reset zoom, language, help, clear)');
        const btn = document.getElementById('btn-penonly'), before = btn.classList.contains('active');
        const r0 = btn.getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
        const pp = type => btn.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'pen', clientX: cx, clientY: cy, buttons: type === 'pointerup' ? 0 : 1 }));
        pp('pointerdown'); pp('pointerup');
        T.assert(btn.classList.contains('active') === !before, 'Apple Pencil tap activates a toolbar button');
        btn.click();
        T.assert(btn.classList.contains('active') === !before, 'a native click right after a Pencil tap is not applied twice');
        await new Promise(r => setTimeout(r, 600));
        btn.click();
        T.assert(btn.classList.contains('active') === before, 'normal finger taps still work');
        const tb = document.getElementById('t-marker').getBoundingClientRect(), mb = btn.getBoundingClientRect();
        T.assert(tb.height >= 44 && tb.width >= 44 && document.getElementById('custom-color').getBoundingClientRect().width >= 44 && mb.height >= 44 &&
          document.getElementById('btn-undo').getBoundingClientRect().height >= 44, 'toolbar controls meet the 44px touch target size');
        document.getElementById('live').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 95, pointerType: 'touch', clientX: 600, clientY: 400 }));
        document.getElementById('live').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 95, pointerType: 'touch', clientX: 600, clientY: 400 }));
        T.assert(document.getElementById('appmenu').hidden, 'pad: touching the canvas closes the menu');
      }
      // 笔头大小：左侧竖直滑条无级调节，按画笔分别记住
      {
        const bar = document.getElementById('sizebar'), tr = document.getElementById('size-track').getBoundingClientRect();
        const sz = (type, y) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 70, pointerType: 'touch', clientX: tr.left + 4, clientY: y }));
        sz('pointerdown', tr.top + tr.height * 0.5); sz('pointermove', tr.top + tr.height * 0.25);
        T.assert(!document.getElementById('size-preview').hidden, 'size preview bubble shows while dragging');
        sz('pointerup', tr.top + tr.height * 0.25);
        const v1 = parseFloat(localStorage.getItem('wb_sz_italic'));
        T.assert(Math.abs(v1 - Math.pow(48, 0.75)) < 0.05 && document.getElementById('size-preview').hidden, 'size slider is continuous (log scale) and saved per brush (' + v1 + ')');
        sz('pointerdown', tr.top + tr.height * 0.9); sz('pointerup', tr.top + tr.height * 0.9);
        T.assert(parseFloat(localStorage.getItem('wb_sz_italic')) < v1 / 3, 'dragging down makes the brush smaller');
        await new Promise(r => setTimeout(r, 120));
        T.assert(T.sent.some(x => x.msg.t === 'pen-size' && x.msg.size > 1), 'changing size on the iPad sends pen-size for sync');
        T.assert(T.sent.filter(x => x.msg.t === 'pen-size').at(-1).msg.brush === 'italic', 'iPad size sync says which brush it is for');
        T.receive(T.sockets[0], { t: 'pen-size', size: 30, brush: 'italic' });
        T.assert(parseFloat(localStorage.getItem('wb_sz_italic')) === 30 && document.getElementById('size-val').value === '30', 'size changed on the PC is applied to the same iPad brush');
        T.receive(T.sockets[0], { t: 'pen-size', size: 20, brush: 'soft' });
        T.receive(T.sockets[0], { t: 'pen-size', size: 40 });
        T.assert(parseFloat(localStorage.getItem('wb_sz_soft')) === 20 && document.getElementById('size-val').value === '30',
          'a size for another brush does not touch the current brush, and a size without a brush name is ignored');
        localStorage.removeItem('wb_sz_soft');
        // v0.8.4：点数字可以直接输入大小（Pencil 点一下就能输入）
        {
          const pv = document.getElementById('size-val'), pr = pv.getBoundingClientRect();
          const pp = type => pv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 92, pointerType: 'pen', clientX: pr.left + 5, clientY: pr.top + 5, buttons: type === 'pointerup' ? 0 : 1 }));
          pp('pointerdown'); pp('pointerup');
          T.assert(document.activeElement === pv && pv.tagName === 'INPUT', 'iPad: the size number can be tapped with the Pencil to type a value');
          pv.value = '12.5'; pv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          T.assert(parseFloat(localStorage.getItem('wb_sz_italic')) === 12.5 && pv.value === '12.5' && document.activeElement !== pv, 'iPad: typing a number and pressing Return sets the brush size');
          pv.value = '0'; pv.dispatchEvent(new Event('change'));
          T.assert(parseFloat(localStorage.getItem('wb_sz_italic')) === 12.5 && pv.value === '12.5', 'iPad: an invalid size is ignored');
          pv.value = '999'; pv.dispatchEvent(new Event('change'));
          T.assert(pv.value === '48', 'iPad: typed sizes are limited to the allowed range');
          localStorage.removeItem('wb_sz_italic');
        }
        localStorage.removeItem('wb_sz_italic');
        // 颜色：9 个常用色 + 色盘
        T.assert(document.querySelectorAll('#picker .swatch[data-color]').length === 9 && document.getElementById('custom-color'), 'iPad palette has 9 common colors plus a color picker');
        // 自建色盘：用 Pencil 点开、在色块和色相条上拖动选色
        const cbtn = document.getElementById('custom-color'), cr = cbtn.getBoundingClientRect();
        const penAt = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 93, pointerType: 'pen', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
        penAt(cbtn, 'pointerdown', cr.left + 10, cr.top + 10); penAt(cbtn, 'pointerup', cr.left + 10, cr.top + 10);
        const pk = document.getElementById('picker');
        T.assert(!pk.hidden, 'color picker opens with an Apple Pencil tap');
        const hue = document.getElementById('pk-hue'), hr = hue.getBoundingClientRect();
        penAt(hue, 'pointerdown', hr.left + hr.width * 0.33, hr.top + 10); penAt(hue, 'pointermove', hr.left + hr.width / 3, hr.top + 10); penAt(hue, 'pointerup', hr.left + hr.width / 3, hr.top + 10);
        const sv = document.getElementById('pk-sv'), sr = sv.getBoundingClientRect();
        penAt(sv, 'pointerdown', sr.left + sr.width * 0.9, sr.top + sr.height * 0.1); penAt(sv, 'pointermove', sr.right - 1, sr.top + 1); penAt(sv, 'pointerup', sr.right - 1, sr.top + 1);
        const picked = localStorage.getItem('wb_color');
        T.assert(/^#[0-9a-f]{6}$/.test(picked) && parseInt(picked.slice(3, 5), 16) > 200 && parseInt(picked.slice(1, 3), 16) < 40,
          'dragging the hue bar and saturation square with the Pencil picks a color (' + picked + ')');
        T.assert(document.getElementById('custom-color').classList.contains('active'), 'custom color is shown as the active swatch');
        const dn = document.getElementById('pk-done'), dr = dn.getBoundingClientRect();
        penAt(dn, 'pointerdown', dr.left + 5, dr.top + 5); penAt(dn, 'pointerup', dr.left + 5, dr.top + 5);
        T.assert(pk.hidden && JSON.parse(localStorage.getItem('wb_recent_colors'))[0] === picked, 'closing the picker remembers the color in “最近使用”');
        document.querySelector('#picker .swatch[data-color="#e5484d"]').click();
      }
      // v2：中性笔写一笔——工具串携带渲染参数，宽度在 iPad 上烘焙，抬笔后追到笔尖
      menu.querySelector('button[data-brush="soft"]').click();
      const liveC = document.getElementById('live'), rr = liveC.getBoundingClientRect();
      const pen = (type, x, y, pr, t) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: pr });
        Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); liveC.dispatchEvent(ev); };
      const x0 = rr.left + rr.width * 0.3, y0 = rr.top + rr.height * 0.45;
      pen('pointerdown', x0, y0, 0.03);
      for (let i = 1; i <= 40; i++) pen('pointermove', x0 + i * 6, y0 + Math.sin(i / 6) * 3, 0.03 + 0.2 * Math.sin(Math.PI * i / 40));
      pen('pointerup', x0 + 240, y0, 0);
      const v2start = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg;
      const v2pts = T.sent.filter(x => x.msg.t === 'stroke-point' && x.msg.id === v2start.id).map(x => x.msg);
      T.assert(/^v2\//.test(v2start.tool) && Ink.specOf(v2start.tool).nib, 'v2 stroke carries its render spec (硬笔书法: flat nib)');
      T.assert(v2pts.length > 20 && v2pts.every(m => m.p >= 0 && m.p <= 1), 'v2 points carry baked width factors within 0..1');
      const mid = v2pts[Math.floor(v2pts.length / 2)].p;
      T.assert(mid > v2pts[1].p * 1.5, 'v2: harder pressure mid-stroke gives a wider line than the light start');
      document.getElementById('t-pen').click();
      document.getElementById('btn-tune').click();
      const tune = document.getElementById('tune');
      T.assert(!tune.hidden && tune.querySelectorAll('input[type=range]').length === 11 && tune.querySelectorAll('.tune-sec').length >= 4,
        'brush studio shows 11 sliders in groups (笔感 / 压力 / 笔尖 / 笔锋)');
      // 面板可以滚动：面板内的触摸滑动不被拦截；画布上和试写区里仍然拦截；Pencil 拖动面板会滚动
      {
        const tm = el => { const ev = new TouchEvent('touchmove', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; };
        T.assert(!tm(tune.querySelector('.tune-sec')) && !tm(tune.querySelector('.tune-row small')), 'finger/Pencil scrolling inside the brush studio is not blocked');
        T.assert(tm(document.getElementById('live')) && tm(tune.querySelector('.testpad canvas')), 'touch moves on the canvas and the test pad are still blocked (no page drag)');
        T.assert(tune.scrollHeight > tune.clientHeight + 50, 'brush studio content is taller than the panel (needs scrolling)');
        {
          // iPad 浏览器的地址栏占掉一部分高度：面板按可见高度收短，滚到底能看到最后一行按钮
          const root = document.documentElement, old = root.style.getPropertyValue('--app-h');
          root.style.setProperty('--app-h', '520px');
          const tb = tune.getBoundingClientRect();
          tune.scrollTop = tune.scrollHeight;
          const last = [...tune.querySelectorAll('button')].filter(b => b.offsetParent !== null).pop().getBoundingClientRect();
          T.assert(tb.bottom <= 520 && last.bottom <= tb.bottom && last.top >= tb.top, 'brush studio fits the visible height and scrolls all the way to its last button (' + Math.round(tb.bottom) + ')');
          if (old) root.style.setProperty('--app-h', old); else root.style.removeProperty('--app-h');
          tune.scrollTop = 0;
          T.assert(/^\d+px$/.test(getComputedStyle(root).getPropertyValue('--app-h').trim()), 'visible height is measured from the browser viewport');
        }
        tune.scrollTop = 0;
        const sec = tune.querySelectorAll('.tune-sec')[1], sr = sec.getBoundingClientRect();
        const pp = (type, y) => sec.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 66, pointerType: 'pen', buttons: type === 'pointerup' ? 0 : 1, clientX: sr.left + 40, clientY: y }));
        pp('pointerdown', sr.top + 5); for (let i = 1; i <= 10; i++) pp('pointermove', sr.top + 5 - i * 20); pp('pointerup', sr.top - 195);
        T.assert(tune.scrollTop > 150, 'dragging the brush studio with Apple Pencil scrolls it (' + tune.scrollTop + ')');
        const before = tune.scrollTop, rg = tune.querySelector('.tune-row[data-key=gamma] input'), rgr = rg.getBoundingClientRect();
        const pr = (type, x, y) => rg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 67, pointerType: 'pen', buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
        pr('pointerdown', rgr.left + 5, rgr.top + 5); pr('pointermove', rgr.right - 5, rgr.top - 60); pr('pointerup', rgr.right - 5, rgr.top - 60);
        T.assert(tune.scrollTop === before && +rg.value > 2, 'dragging a slider with Pencil changes the value without scrolling the panel');
        localStorage.removeItem('wb_tune_soft'); tune.scrollTop = 0;
        document.getElementById('t-pen').click(); document.getElementById('t-pen').click(); document.getElementById('btn-tune').click();
      }
      T.assert(T.sent.some(x => x.msg.t === 'brushes-get'), 'on connect the iPad asks the PC for its brush backup');
      const stab = tune.querySelector('input[type=range]'); stab.value = '0.9'; stab.dispatchEvent(new Event('input'));
      T.assert(JSON.parse(localStorage.getItem('wb_tune_soft')).dyn.stab === 0.9, 'tuning is saved per brush on the iPad');
      T.assert(tune.querySelector('.tune-row[data-key=stab]').classList.contains('changed') && !tune.querySelector('.tune-row[data-key=stab] .rs').hidden &&
        tune.querySelector('.tag').textContent.includes('已调整'), 'a changed parameter is marked and offers a one-item restore');
      const resetBtn = tune.querySelector('button[data-act=reset]');
      resetBtn.click();
      T.assert(localStorage.getItem('wb_tune_soft') !== null && resetBtn.classList.contains('armed'), 'restore official defaults asks for a second tap first');
      tune.querySelector('button[data-act=reset]').click();
      T.assert(localStorage.getItem('wb_tune_soft') === null, 'second tap restores the official defaults');
      T.assert(!tune.querySelector('.tune-row[data-key=stab]').classList.contains('changed') && +tune.querySelector('.tune-row[data-key=stab] input').value === Ink.BRUSHES.soft.dyn.stab,
        'sliders show the official values again after restore');
      // 单项恢复
      { const r = tune.querySelector('.tune-row[data-key=te] input'); r.value = '6'; r.dispatchEvent(new Event('input'));
        tune.querySelector('.tune-row[data-key=te] .rs').click();
        const t2 = JSON.parse(localStorage.getItem('wb_tune_soft') || '{}');
        T.assert(!(t2.render && 'te' in t2.render) && +tune.querySelector('.tune-row[data-key=te] input').value === Ink.BRUSHES.soft.render.te, '↺ restores a single parameter'); }
      // 试写板：写一笔有墨迹；改笔尖扁度后按新参数重画
      {
        const tpc = tune.querySelector('.testpad canvas'), tr = tpc.getBoundingClientRect();
        const tpe = (type, x, y, p) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 77, pointerType: 'pen', buttons: type === 'pointerup' ? 0 : 1, clientX: tr.left + x, clientY: tr.top + y, pressure: p });
          Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); tpc.dispatchEvent(ev); };
        const s0 = T.sent.filter(x => x.msg.t === 'stroke-start').length;
        tpe('pointerdown', 30, 40, 0.1);
        for (let i = 1; i <= 40; i++) tpe('pointermove', 30 + i * 7, 40 + i * 2.2, 0.05 + 0.2 * Math.sin(Math.PI * i / 40));
        tpe('pointerup', 310, 128, 0);
        const snap = () => tpc.getContext('2d').getImageData(0, 0, tpc.width, tpc.height).data;
        const d1 = snap(); let ink1 = 0; for (let i = 3; i < d1.length; i += 4) if (d1[i] > 0) ink1++;
        T.assert(ink1 > 200 && T.sent.filter(x => x.msg.t === 'stroke-start').length === s0, 'test pad draws locally and sends nothing to the PC');
        const rr2 = tune.querySelector('.tune-row[data-key=ratio] input'); rr2.value = '0.2'; rr2.dispatchEvent(new Event('input'));
        const d2 = snap(); let diff = 0; for (let i = 3; i < d2.length; i += 4) if ((d1[i] > 0) !== (d2[i] > 0)) diff++;
        T.assert(diff > 50, 'test pad re-renders the same strokes live when a parameter changes (' + diff + ' px changed)');
        tune.querySelector('[data-act=tp-clear]').click();
        const d3 = snap(); let ink3 = 0; for (let i = 3; i < d3.length; i += 4) if (d3[i] > 0) ink3++;
        T.assert(ink3 === 0, 'test pad can be cleared');
      }
      // 另存为新画笔：复制当前参数，切换过去；官方画笔不变
      tune.querySelector('[data-act=saveas]').click();
      const nameIn = tune.querySelector('.tune-name input');
      T.assert(!tune.querySelector('.tune-name').hidden && nameIn.value === '中国毛笔 副本', 'save as new brush asks for a name (default “中国毛笔 副本”)');
      nameIn.value = '我的书法'; tune.querySelector('[data-act=name-ok]').click();
      let cust = JSON.parse(localStorage.getItem('wb_custom_brushes'));
      T.assert(cust.length === 1 && cust[0].label === '我的书法' && cust[0].base === 'soft' && cust[0].render.ratio === 0.2 && /^u_[a-z0-9]+$/.test(cust[0].id),
        'new brush stores a full copy of the current parameters');
      T.assert(localStorage.getItem('wb_brush') === cust[0].id && document.getElementById('brush-name').textContent === '我的书法' &&
        tune.querySelector('.tag').textContent.includes('自定义'), 'the new brush becomes the current brush');
      { const rr3 = tune.querySelector('.tune-row[data-key=ratio] input'); rr3.value = '0.3'; rr3.dispatchEvent(new Event('input')); }
      cust = JSON.parse(localStorage.getItem('wb_custom_brushes'));
      const tc0 = JSON.parse(localStorage.getItem('wb_tune_soft') || '{}');
      T.assert(cust[0].render.ratio === 0.3 && tc0.render.ratio === 0.2, 'editing a custom brush changes only that brush, not the official one');
      pen('pointerdown', x0, y0 + 80, 0.1); for (let i = 1; i <= 20; i++) pen('pointermove', x0 + i * 6, y0 + 80, 0.15); pen('pointerup', x0 + 120, y0 + 80, 0);
      const cst = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg;
      T.assert(Ink.specOf(cst.tool).nib && Math.abs(Ink.specOf(cst.tool).nib.ratio - 0.3) < 1e-6, 'strokes written with a custom brush carry its render parameters to the PC');
      document.getElementById('t-pen').click();
      T.assert(menu.querySelectorAll('button[data-brush]').length === 3 && menu.querySelector('.menu-sec') && menu.querySelector('button.custom[data-brush="' + cust[0].id + '"]'),
        'custom brushes appear in the brush menu under “我的画笔”');
      document.getElementById('t-pen').click();
      // 自动备份到电脑
      await new Promise(r => setTimeout(r, 900));
      const bk = T.sent.filter(x => x.msg.t === 'brushes-save').at(-1);
      const bkd = bk && JSON.parse(bk.msg.data);
      T.assert(bkd && bkd.customs.length === 1 && bkd.customs[0].label === '我的书法' && localStorage.getItem('wb_brush_dirty') === '1', 'brush changes are backed up to the PC automatically');
      T.receive(sock, { t: 'brushes-saved' });
      T.assert(localStorage.getItem('wb_brush_dirty') === null, 'a confirmed backup clears the pending flag');
      // 重命名、删除（删除要二次确认，删除后回到基础画笔）
      tune.querySelector('[data-act=rename]').click();
      tune.querySelector('.tune-name input').value = '书法二号'; tune.querySelector('[data-act=name-ok]').click();
      T.assert(JSON.parse(localStorage.getItem('wb_custom_brushes'))[0].label === '书法二号' && document.getElementById('brush-name').textContent === '书法二号', 'custom brushes can be renamed');
      // 导出 / 导入
      tune.querySelector('[data-act=export]').click();
      const exported = tune.querySelector('textarea').value;
      T.assert(JSON.parse(exported).customs[0].label === '书法二号', 'export all brushes gives a JSON text');
      tune.querySelector('[data-act=delete]').click();
      T.assert(JSON.parse(localStorage.getItem('wb_custom_brushes')).length === 1, 'delete asks for a second tap first');
      tune.querySelector('[data-act=delete]').click();
      T.assert(JSON.parse(localStorage.getItem('wb_custom_brushes')).length === 0 && localStorage.getItem('wb_brush') === 'soft' &&
        document.getElementById('brush-name').textContent === '中国毛笔', 'deleting a custom brush falls back to its base brush');
      tune.querySelector('[data-act=import]').click();
      tune.querySelector('textarea').value = 'not json'; tune.querySelector('[data-act=import-ok]').click();
      T.assert(document.getElementById('notice').textContent.includes('导入失败'), 'import rejects malformed text');
      tune.querySelector('[data-act=import]').click();
      tune.querySelector('textarea').value = exported.replace('"ratio":0.3', '"ratio":99'); tune.querySelector('[data-act=import-ok]').click();
      cust = JSON.parse(localStorage.getItem('wb_custom_brushes'));
      T.assert(cust.length === 1 && cust[0].label === '书法二号', 'import restores exported brushes');
      document.getElementById('t-pen').click(); menu.querySelector('button[data-brush="' + cust[0].id + '"]').click();
      pen('pointerdown', x0, y0 + 90, 0.1); for (let i = 1; i <= 20; i++) pen('pointermove', x0 + i * 6, y0 + 90, 0.15); pen('pointerup', x0 + 120, y0 + 90, 0);
      T.assert(/\/n1\//.test(T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg.tool) && Ink.specOf(T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg.tool).nib === null, 'out-of-range imported values are clamped (ratio 99 → 1)');
      // 从电脑恢复：本机没有的自定义画笔和调节会补回来；无效条目忽略
      localStorage.removeItem('wb_tune_soft');
      T.receive(sock, { t: 'brushes', data: JSON.stringify({ version: 1, customs: [cust[0], { id: 'u_frompc1', label: '电脑上的笔', base: 'soft', dyn: { minW: 0.3 }, render: {} },
        { id: 'u_bad!', label: 'x', base: 'callig', dyn: {}, render: {} }, { id: 'u_abcd12', label: 'y', base: 'nope', dyn: {}, render: {} }],
        tunes: { soft: { dyn: { gamma: 1.1 }, render: {} } } }) });
      cust = JSON.parse(localStorage.getItem('wb_custom_brushes'));
      T.assert(cust.length === 2 && cust[1].id === 'u_frompc1' && JSON.parse(localStorage.getItem('wb_tune_soft')).dyn.gamma === 1.1 &&
        document.getElementById('notice').textContent.includes('从电脑恢复'), 'brushes missing on this iPad are restored from the PC backup');
      T.assert(!menu.querySelector('button[data-brush="u_abcd12"]') && !menu.querySelector('button[data-brush="u_bad!"]'), 'invalid brushes in a backup are ignored');
      // 断线期间改过的画笔：重新连接时先把本机的推给电脑，不用电脑的旧备份覆盖
      localStorage.setItem('wb_brush_dirty', '1');
      const nSave = T.sent.filter(x => x.msg.t === 'brushes-save').length, nGet = T.sent.filter(x => x.msg.t === 'brushes-get').length;
      T.receive(sock, { t: 'full-state', strokes: [] });
      T.assert(T.sent.filter(x => x.msg.t === 'brushes-save').length === nSave + 1 && T.sent.filter(x => x.msg.t === 'brushes-get').length === nGet,
        'reconnect with unsaved brush changes pushes local brushes instead of fetching');
      // 清理：删除测试用自定义画笔，回到硬笔书法
      ['u_frompc1', cust[0].id].forEach(cid => { document.getElementById('t-pen').click(); menu.querySelector('button[data-brush="' + cid + '"]').click();
        tune.querySelector('[data-act=delete]').click(); tune.querySelector('[data-act=delete]').click(); });
      localStorage.removeItem('wb_tune_soft');
      T.assert(JSON.parse(localStorage.getItem('wb_custom_brushes')).length === 0, 'test brushes cleaned up');
      // 笔压校准：样本不足时提示；有足够样本时按 95% 分位设置写满压力
      localStorage.removeItem('wb_pcal');
      tune.querySelector('.cal').click();
      T.assert(localStorage.getItem('wb_pcal') === null && document.getElementById('notice').textContent.includes('样本不够'), 'calibration refuses with too few samples');
      for (let k = 0; k < 6; k++) { pen('pointerdown', x0, y0 + 30 + k * 4, 0.1);
        for (let i = 1; i <= 45; i++) pen('pointermove', x0 + i * 4, y0 + 30 + k * 4, 0.05 + 0.1 * (i % 10) / 10);
        pen('pointerup', x0 + 180, y0 + 30 + k * 4, 0); }
      document.getElementById('t-pen').click(); document.getElementById('btn-tune').click();
      tune.querySelector('.cal').click();
      const cal = parseFloat(localStorage.getItem('wb_pcal'));
      T.assert(cal >= 0.13 && cal <= 0.25 && /→/.test(document.getElementById('notice').textContent),
        'calibration sets full pressure from the 95th percentile of recent Pencil samples and shows old → new (' + cal + ')');
      // 校准真的改变粗细：同样力度（0.15）写一笔，写满压力 0.40 时比 0.12 时细
      {
        tune.querySelector('button[data-act=close]').click();
        const widthAt = (pcal) => { localStorage.setItem('wb_pcal', String(pcal));
          pen('pointerdown', x0, y0 + 120, 0.15); for (let i = 1; i <= 30; i++) pen('pointermove', x0 + i * 5, y0 + 120, 0.15); pen('pointerup', x0 + 150, y0 + 120, 0);
          const sid = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg.id;
          const ws = T.sent.filter(x => x.msg.t === 'stroke-point' && x.msg.id === sid).map(x => x.msg.p).sort((a, b) => a - b);
          return ws[ws.length >> 1]; };
        const heavy = widthAt(0.40), light = widthAt(0.12);
        T.assert(light > heavy + 0.1, 'pressure calibration really changes stroke width for the same pressure (' + heavy + ' → ' + light + ')');
        document.getElementById('t-pen').click(); document.getElementById('btn-tune').click();
      }
      localStorage.removeItem('wb_pcal');
      // 书写诊断是开发用功能：正式版隐藏，地址加 ?dev=1（记在本机）才显示
      T.assert(!tune.querySelector('.diag') && !tune.querySelector('.diag-local'), 'writing diagnostics are hidden in the release build');
      localStorage.setItem('wb_dev', '1');
      tune.querySelector('button[data-act=close]').click();
      // v0.8.11：只有开发模式才记录诊断——打开开发模式后写一笔
      pen('pointerdown', x0, y0 + 160, 0.3); for (let i = 1; i <= 45; i++) pen('pointermove', x0 + i * 4, y0 + 160 + (i % 5), 0.3); pen('pointerup', x0 + 180, y0 + 160, 0);
      document.getElementById('t-pen').click(); document.getElementById('btn-tune').click();
      tune.querySelector('.diag').click();
      const dg = T.sent.filter(x => x.msg.t === 'save-diag').at(-1);
      const rep = dg && JSON.parse(dg.msg.data);
      T.assert(rep && rep.strokes.length >= 1 && rep.strokes.some(st => st.ev.length >= 40 && st.sent.length > 20) && typeof rep.coalescedApi === 'boolean',
        'diagnostics (developer mode) send raw Pencil events, sent points and API support to the PC');
      localStorage.removeItem('wb_dev');
      tune.querySelector('button[data-act=close]').click();
      document.getElementById('t-pen').click();
      menu.querySelector('button[data-brush="italic"]').click();
      T.assert(menu.hidden && document.getElementById('brush-name').textContent === '英文斜体', 'choosing a brush closes the menu and shows its name');
      // 防误触：书写中手掌（两个触点）在屏幕上移动，画布不能动，笔迹仍落在笔尖下
      {
        const lv = document.getElementById('live'), b = lv.getBoundingClientRect();
        const pe = (type, x, y) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 88, pointerType: 'pen', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.3 });
          Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); lv.dispatchEvent(ev); };
        const tc = (type, id, x, y) => lv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 60 + id, pointerType: 'touch', isPrimary: id === 0, clientX: x, clientY: y }));
        const px = b.left + b.width * 0.4, py = b.top + b.height * 0.6;
        const undos0 = T.sent.filter(x => x.msg.t === 'undo').length;
        pe('pointerdown', px, py);
        tc('pointerdown', 0, px + 80, py + 120); tc('pointerdown', 1, px + 200, py + 140);
        for (let i = 1; i <= 10; i++) { tc('pointermove', 0, px + 80 + i * 15, py + 120 + i * 10); tc('pointermove', 1, px + 200 - i * 10, py + 140 + i * 12); pe('pointermove', px + i * 6, py); }
        tc('pointerup', 0, px + 230, py + 220); tc('pointerup', 1, px + 100, py + 260);
        pe('pointerup', px + 60, py);
        const sid = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg.id;
        const lastPt = T.sent.filter(x => x.msg.t === 'stroke-point' && x.msg.id === sid).at(-1).msg;
        const vw = innerWidth, vh = innerHeight; let w = vw - 16, h = vh - 66 - 8; if (w / h > 1.6) w = h * 1.6; else h = w / 1.6;
        const sx = (vw - w) / 2 + lastPt.x * w, sy = 66 + (vh - 66 - 8 - h) / 2 + lastPt.y * h;
        T.assert(Math.abs(sx - (px + 60)) < 1.5 && Math.abs(sy - py) < 1.5 && T.sent.filter(x => x.msg.t === 'undo').length === undos0,
          'palm rejection: touches during a Pencil stroke neither move the canvas nor undo (笔迹不飘)');
        await new Promise(r => setTimeout(r, 600));
        // 预测点：书写中画出浏览器预测的笔尖位置（只在书写层显示，抬笔后消失）
        const ppx = b.left + b.width * 0.3, ppy = b.top + b.height * 0.3;
        const pm = (type, x, y, pred) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 89, pointerType: 'pen', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.2 });
          Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] });
          Object.defineProperty(ev, 'getPredictedEvents', { value: () => pred || [] }); lv.dispatchEvent(ev); };
        pm('pointerdown', ppx, ppy);
        for (let i = 1; i <= 8; i++) pm('pointermove', ppx + i * 4, ppy, [{ clientX: ppx + i * 4 + 30, clientY: ppy }]);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const lctx = lv.getContext('2d'), dprNow = lv.width / b.width;
        const at = x => lctx.getImageData(Math.round((x - b.left) * dprNow), Math.round((ppy - b.top) * dprNow), 1, 1).data[3];
        T.assert(at(ppx + 32 + 20) > 0, 'predicted pen position is drawn ahead of the stroke while writing');
        pm('pointerup', ppx + 32, ppy);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        T.assert(at(ppx + 32 + 20) === 0, 'prediction is not kept after pen-up');
        await new Promise(r => setTimeout(r, 600));
      }
      // 双指轻点 = 撤销
      const live = document.getElementById('live');
      // v0.8.5：真机上手指的接触面约 40–60 CSS 像素（以前大于 44 就当手掌忽略，手势全部失效）
      const touch = (type, id, x, y, wd) => live.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 50 + id, pointerType: 'touch', isPrimary: id === 0,
        clientX: x, clientY: y || 300, width: wd || 52, height: wd || 52 }));
      // v0.8.6：多指轻点用系统触摸事件判定（iPad Safari 上比指针事件可靠）
      const tapFingers = (n, opts) => { opts = opts || {};
        const mk = (i, dx) => new Touch({ identifier: 70 + i, target: live, clientX: 400 + i * 90 + (dx || 0), clientY: 300, radiusX: opts.r || 24, radiusY: opts.r || 24, touchType: opts.stylus ? 'stylus' : 'direct' });
        const all = []; for (let i = 0; i < n; i++) { const t = mk(i); all.push(t); live.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: all.slice(), changedTouches: [t] })); }
        if (opts.move) live.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: all.map((t, i) => mk(i, opts.move)), changedTouches: all.map((t, i) => mk(i, opts.move)) }));
        for (let i = n - 1; i >= 0; i--) { const t = all.pop(); live.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: all.slice(), changedTouches: [t] })); } };
      const undos = T.sent.filter(x => x.msg.t === 'undo').length;
      tapFingers(2);
      T.assert(T.sent.filter(x => x.msg.t === 'undo').length === undos + 1, 'two-finger tap undoes (Procreate gesture), detected from touch events');
      tapFingers(2, { r: 80 });
      T.assert(T.sent.filter(x => x.msg.t === 'undo').length === undos + 1, 'palm-sized contacts are still ignored');
      tapFingers(2, { move: 40 });
      T.assert(T.sent.filter(x => x.msg.t === 'undo').length === undos + 1, 'two fingers that move are a pinch / drag, not a tap');
      tapFingers(1);
      T.assert(T.sent.filter(x => x.msg.t === 'undo').length === undos + 1, 'a one-finger tap does not undo');
      // 双指捏合放大，放大后单指拖动画面；菜单“复位缩放”回到整屏
      {
        const inkC = document.getElementById('ink');
        const sig = () => { const d = inkC.getContext('2d').getImageData(0, 0, inkC.width, inkC.height).data; let h = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) h = (h + i * 7 + d[i]) % 1000000007; return h; };
        T.snapshot(T.sockets[0], [{ id: 'g1', color: '#000000', size: 20, tool: 'pen', points: Array.from({ length: 40 }, (_, i) => [0.1 + i * 0.02, 0.3 + (i % 5) * 0.08, 0.6]) }]);
        await new Promise(r => setTimeout(r, 60));
        const s0 = sig();
        touch('pointerdown', 0, 500, 300); touch('pointerdown', 1, 600, 300);
        for (let i = 1; i <= 10; i++) { touch('pointermove', 0, 500 - i * 10, 300); touch('pointermove', 1, 600 + i * 10, 300); }
        touch('pointerup', 0, 400, 300); touch('pointerup', 1, 700, 300);
        await new Promise(r => setTimeout(r, 60));
        const s1 = sig();
        T.assert(s1 !== s0 && T.sent.filter(x => x.msg.t === 'undo').length === undos + 1, 'two-finger pinch zooms the canvas (and is not taken as a tap)');
        await new Promise(r => setTimeout(r, 400));
        touch('pointerdown', 0, 500, 300); for (let i = 1; i <= 6; i++) touch('pointermove', 0, 500 + i * 15, 300); touch('pointerup', 0, 590, 300);
        await new Promise(r => setTimeout(r, 60));
        T.assert(sig() !== s1 && !T.sent.slice(-5).some(x => x.msg.t === 'stroke-start'), 'when zoomed in, one finger drags the canvas (and does not draw)');
        document.getElementById('btn-fit').click();
        await new Promise(r => setTimeout(r, 60));
        T.assert(sig() === s0, '“Reset zoom” returns to the full view');
      }
      // 三指轻点 = 重做
      {
        T.snapshot(T.sockets[0], []);
        const lv2 = document.getElementById('live'), r2 = lv2.getBoundingClientRect();
        const pn = (type, x) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 82, pointerType: 'pen', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: r2.top + r2.height * 0.5, pressure: 0.2 });
          Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); lv2.dispatchEvent(ev); };
        pn('pointerdown', r2.left + 200); for (let i = 1; i <= 10; i++) pn('pointermove', r2.left + 200 + i * 8); pn('pointerup', r2.left + 280);
        await new Promise(r => setTimeout(r, 600));
        tapFingers(2);
        const starts = T.sent.filter(x => x.msg.t === 'stroke-start').length;
        tapFingers(3);
        T.assert(T.sent.filter(x => x.msg.t === 'stroke-start').length === starts + 1, 'three-finger tap redoes (Procreate gesture)');
      }
      T.snapshot(T.sockets[0], [sample]);
      const sentBefore = T.sent.length;
      T.snapshot(T.sockets[0], []);
      T.assert(T.sent.filter(x => x.msg.t.startsWith('stroke-')).length === T.sent.slice(0, sentBefore).filter(x => x.msg.t.startsWith('stroke-')).length,
        'authoritative reconnect snapshot does not resurrect cleared strokes');
    }
    if (page !== 'shared') {
      const ids = Array.from(document.querySelectorAll('[id]')).map(e => e.id), dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      T.assert(!dup.length, page + ': every element id on the page is unique (' + dup.join(',') + ')');
    }
    if (page === 'pad') await runPadUiCases();
    await runI18nCases(page);
    if (page !== 'shared') await runDrawingCases(page);
    if (page === 'pad') await runPadSyncCases();
  } catch (e) { T.fail(e); }
  await T.settle();
  document.documentElement.setAttribute('data-verification', btoa(unescape(encodeURIComponent(JSON.stringify({ passed: T.passed, failures: T.failures, measurements: T.measurements })))));
}

// Exercise the actual three application scripts through DOM input and mock wire messages.
// No product state is exported for tests: wire point counts and real Canvas pixels are the evidence.
async function runDrawingCases(page) {
  const T = window.TEST, WB = window.Whiteboard;
  const canvas = document.getElementById(page === 'pad' ? 'live' : 'board');
  const inkCanvases = (page === 'pad' ? ['ink', 'live'] : page === 'overlay' ? ['board', 'live'] : ['board']).map(id => document.getElementById(id));
  const noticeId = page === 'pad' ? 'notice' : 'board-notice';
  // iPad 页面：世界矩形 = 视口去掉顶部工具组（66px）和底部边距（8px）后按 16:10 居中（与 pad.js 一致）
  function padRect() {
    const vw = innerWidth, vh = innerHeight; let w = vw - 16, h = vh - 66 - 8;
    if (w / h > 1.6) w = h * 1.6; else h = w / 1.6;
    return { left: (vw - w) / 2, top: 66 + (vh - 66 - 8 - h) / 2, width: w, height: h };
  }
  const sender = T.sockets.find(s => s.role === (page === 'viewer' ? 'pad-local' : page));
  const receiver = page === 'viewer' ? T.sockets.find(s => s.role === 'view') : sender;
  const reset = () => T.snapshot(receiver, []);
  function position(x, y) {
    const r = canvas.getBoundingClientRect();
    if (page === 'overlay') return { x: r.left + x * r.width, y: r.top + y * r.height };
    if (page === 'pad') { const b = padRect(); return { x: b.left + x * b.width, y: b.top + y * b.height }; }
    const scale = Math.min(r.width / WB.VW, r.height / WB.VH);
    return { x: r.left + (r.width - WB.VW * scale) / 2 + x * WB.VW * scale,
      y: r.top + (r.height - WB.VH * scale) / 2 + y * WB.VH * scale };
  }
  function eventAt(type, at, pressure = 0.5, pointerId = 1, coalesced) {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true,
      pointerType: 'pen', pointerId, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: at.x, clientY: at.y, pressure });
    if (coalesced !== undefined) Object.defineProperty(event, 'getCoalescedEvents', { value: () => coalesced });
    return event;
  }
  const input = (type, at, pressure, pointerId, coalesced) => canvas.dispatchEvent(eventAt(type, at, pressure, pointerId, coalesced));
  const lastId = () => T.sent.filter(x => x.role === sender.role && x.msg.t === 'stroke-start').at(-1).msg.id;
  const messages = id => T.sent.filter(x => x.role === sender.role && x.msg.id === id).map(x => x.msg);
  const points = id => messages(id).filter(m => m.t === 'stroke-point');
  // v0.6：笔迹在下一帧渲染，并可能位于分层画布（已完成层 + 书写层）
  async function ink(at) {
    await new Promise(r => setTimeout(r, 40));
    return inkCanvases.some(c => {
      const r = c.getBoundingClientRect();
      const pixel = c.getContext('2d').getImageData(Math.floor((at.x - r.left) * c.width / r.width),
        Math.floor((at.y - r.top) * c.height / r.height), 1, 1).data;
      return page === 'viewer' ? pixel[3] > 0 && Math.min(pixel[0], pixel[1], pixel[2]) < 180 : pixel[3] > 0;
    });
  }
  function beginLine(y = 0.5) {
    input('pointerdown', position(0.2, y));
    const id = lastId();
    input('pointermove', position(0.5, y));
    input('pointermove', position(0.8, y));
    const tail = position(0.8, y);
    // v0.8.2：电脑端画笔也走笔感层（居中平滑会等后面几个采样再定稿），所以在终点附近多给几个采样
    for (let k = 1; k <= 3; k++) input('pointermove', { x: tail.x + 0.3 * k, y: tail.y });
    return id;
  }


  reset();
  const truncated = beginLine();
  T.assert(await ink(position(0.35, 0.5)) && await ink(position(0.7, 0.5)), page + ': real canvas contains both segments before truncate');
  T.receive(sender, { t: 'stroke-truncate', id: truncated, len: 2, reason: '单笔达到上限，请先存档再清屏' });
  T.assert(await ink(position(0.35, 0.5)) && !(await ink(position(0.72, 0.5))), page + ': directed truncate redraws only accepted prefix');
  const afterTruncate = points(truncated).length;
  input('pointermove', position(0.9, 0.5)); input('pointerup', position(0.9, 0.5), 0);
  T.assert(points(truncated).length === afterTruncate && messages(truncated).filter(m => m.t === 'stroke-end').length === 1,
    page + ': truncate stops active pointer and sends exactly one end');
  T.assert(document.getElementById(noticeId).textContent.includes('单笔达到上限'), page + ': truncate reason is visible');

  reset();
  const rejected = beginLine(0.6);
  T.receive(sender, { t: 'stroke-rejected', id: rejected, reason: '白板已满，请先存档再清屏' });
  T.assert(!(await ink(position(0.5, 0.6))) && document.getElementById(noticeId).textContent.includes('白板已满'),
    page + ': directed rejection deletes and redraws stroke with a visible reason');
  if (page === 'viewer') T.assert(document.getElementById('stroke-count').textContent === '0 笔', 'viewer: pad-local rejection updates viewer stroke count');
  const rejectedPoints = points(rejected).length;
  input('pointermove', position(0.9, 0.6)); input('pointerup', position(0.9, 0.6), 0);
  T.assert(points(rejected).length === rejectedPoints && messages(rejected).filter(m => m.t === 'stroke-end').length === 1,
    page + ': rejection stops active pointer and sends exactly one end');

  input('pointerdown', position(0.2, 0.7));
  const recovered = lastId();
  T.receive(sender, { t: 'stroke-truncate', id: truncated, len: 1, reason: '迟到的旧笔消息' });
  T.receive(sender, { t: 'stroke-rejected', id: rejected, reason: '迟到的旧笔消息' });
  input('pointermove', position(0.8, 0.7)); input('pointerup', position(0.8, 0.7), 0);
  T.assert(points(recovered).length === 2 && await ink(position(0.5, 0.7)), page + ': input recovers and late old ids do not stop the new stroke');

  const statusId = page === 'viewer' ? 'server-url' : page === 'overlay' ? 'overlay-status' : 'conn';
  const status = document.getElementById(statusId);
  status.textContent = 'synthetic connection error must remain';
  const usage = document.getElementById(page === 'pad' ? 'usage' : 'board-usage');
  for (const [n, level] of [[160000, 'warning'], [190000, 'critical'], [200000, 'full'], [190000, 'critical'], [160000, 'warning']]) {
    T.receive(receiver, { t: 'board-usage', points: n, maxPoints: 200000, strokes: 10, maxStrokes: 2000 });
    T.assert(!usage.hidden && usage.dataset.level === level && status.textContent === 'synthetic connection error must remain',
      page + ': usage ' + n + ' appears without hiding connection errors');
  }
  T.receive(receiver, { t: 'board-usage', points: 0, maxPoints: 200000, strokes: 1900, maxStrokes: 2000 });
  T.assert(usage.dataset.level === 'critical', page + ': stroke count also drives capacity warning');
  T.receive(receiver, { t: 'board-usage', points: 0, maxPoints: 200000, strokes: 0, maxStrokes: 2000 });
  T.assert(usage.hidden && !usage.textContent, page + ': capacity notice clears below 80 percent');

  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  window.dispatchEvent(new Event('resize'));
  reset();
  const start = position(0.25, 0.3), at = dx => ({ x: start.x + dx, y: start.y });
  input('pointerdown', at(0), 0.5, 2, []); // empty coalesced list must retain first point
  const sampled = lastId();
  if (page === 'pad') {
    // iPad：笔感层先去重、居中平滑，再抽稀；只检查结果性质
    input('pointermove', at(0.4), 0.5, 2, []); input('pointermove', at(0.8), 0.5, 2, []);
    input('pointermove', at(0.9), 0.6, 2, []); input('pointermove', at(0.95), 0.7, 2, []); input('pointermove', at(1.0), 0.7, 2, []);
    input('pointerup', at(1.1), 0, 2, []);
    const sp = points(sampled), sm = messages(sampled), b0 = padRect();
    T.assert(sp.length >= 2 && sp.length <= 6 && sm.at(-1).t === 'stroke-end' && Math.abs(b0.left + sp.at(-1).x * b0.width - at(1.0).x) < 0.6,
      'pad: micro-moves are smoothed and thinned, the stroke ends at the pen tip, and zero pen-up pressure is not used');
  } else {
    // v0.8.2：电脑端画笔也走笔感层（去重 + 居中平滑 + 抽稀），只检查结果性质
    input('pointermove', at(0.4), 0.5, 2, []); input('pointermove', at(0.8), 0.5, 2, []);
    input('pointermove', at(0.9), 0.6, 2, []); input('pointermove', at(0.95), 0.7, 2, []); input('pointermove', at(1.0), 0.7, 2, []);
    input('pointerup', at(1.1), 0, 2, []);
    const sp = points(sampled), sm = messages(sampled), r0 = canvas.getBoundingClientRect();
    const cssX = page === 'overlay' ? r0.left + sp.at(-1).x * r0.width :
      r0.left + (r0.width - WB.VW * Math.min(r0.width / WB.VW, r0.height / WB.VH)) / 2 + sp.at(-1).x * WB.VW * Math.min(r0.width / WB.VW, r0.height / WB.VH);
    T.assert(sp.length >= 2 && sp.length <= 6 && sm.at(-1).t === 'stroke-end' && sm.filter(m => m.t === 'stroke-end').length === 1 &&
      Math.abs(cssX - at(1.0).x) < 0.6 && sp.every(q => q.p > 0.05),
      page + ': micro-moves are smoothed and thinned, the stroke ends at the pen tip, and zero pen-up pressure is not used');
  }

  // A four-second 240 Hz synthetic trace, 960 raw positions, 0.2 CSS px per sample.
  reset();
  const traceStart = position(0.2, 0.4), traceAt = i => ({ x: traceStart.x + i * 0.2, y: traceStart.y });
  input('pointerdown', traceAt(0), 0.5, 3, []);
  const traceId = lastId(), inputPoints = 960;
  if (page === 'pad') {
    for (let i = 1; i < inputPoints; i += 8) {
      const samples = Array.from({ length: Math.min(8, inputPoints - i) }, (_, j) => eventAt('pointermove', traceAt(i + j), 0.5, 3));
      input('pointermove', traceAt(i + samples.length - 1), 0.5, 3, samples);
    }
  } else for (let i = 1; i < inputPoints; i++) input('pointermove', traceAt(i), 0.5, 3);
  input('pointerup', traceAt(inputPoints - 1), 0, 3);
  const outputPoints = points(traceId);
  T.measurements.push({ page, sampleRateHz: 240, nominalSeconds: 4, spacingCssPx: 0.2, dpr: 2,
    inputPoints, outputPoints: outputPoints.length, coalesced: page === 'pad' });
  T.assert(outputPoints.length < inputPoints && outputPoints.length > 1 && messages(traceId).at(-1).t === 'stroke-end',
    page + ': measured 240 Hz trace reduces wire points and retains stroke end');
  const lastPoint = outputPoints.at(-1), r = page === 'pad' ? padRect() : canvas.getBoundingClientRect();
  const finalCssX = page === 'overlay' || page === 'pad' ? r.left + lastPoint.x * r.width :
    r.left + (r.width - WB.VW * Math.min(r.width / WB.VW, r.height / WB.VH)) / 2 + lastPoint.x * WB.VW * Math.min(r.width / WB.VW, r.height / WB.VH);
  T.assert(Math.abs(finalCssX - traceAt(inputPoints - 1).x) < 0.01, page + ': last raw/coalesced point survives thinning');

  // v0.8.2：电脑端画笔——和 iPad 同款（英文斜体 / 中国毛笔 / 荧光笔），鼠标按书写速度变化粗细
  if (page !== 'pad') {
    // 主窗口用工具栏选；标注层没有自己的画笔选择，沿用主窗口存下的设置
    const usePc = (kind, brush) => Ink.savePcTool({ ...Ink.pcTool(), kind, brush: brush || Ink.pcTool().brush });
    // 两个窗口共用同一份设置：另一个窗口选了中国毛笔，这里获得焦点时跟着变
    localStorage.removeItem('wb_pc_sz_soft');
    usePc('write', 'soft'); window.dispatchEvent(new Event('focus'));
    T.assert(document.getElementById('brush-name').textContent === '中国毛笔' && document.getElementById('size-val').value === '9.0',
      page + ': follows the pen chosen in the other window (' + document.getElementById('size-val').value + ')');
    reset();
    const p0 = position(0.2, 0.6);
    let tms = 1000;
    const mouse = (type, x) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerType: 'mouse', pointerId: 9, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, clientX: p0.x + x, clientY: p0.y, pressure: type === 'pointerup' ? 0 : 0.5 });
      Object.defineProperty(ev, 'timeStamp', { value: tms }); Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); canvas.dispatchEvent(ev); };
    mouse('pointerdown', 0);
    const bid = lastId();
    let x = 0;
    for (let i = 0; i < 30; i++) { x += 2; tms += 16; mouse('pointermove', x); }   // 慢写：重
    for (let i = 0; i < 30; i++) { x += 30; tms += 8; mouse('pointermove', x); }   // 快写：轻
    mouse('pointerup', x);
    const st = messages(bid)[0], ws = points(bid).map(q => q.p);
    T.assert(st.t === 'stroke-start' && st.tool === Ink.encodeTool(Ink.BRUSHES.soft.render), page + ': a 中国毛笔 stroke carries the same rendering parameters as on the iPad');
    T.assert(Math.max(...ws) - Math.min(...ws) > 0.3, page + ': with a mouse, slow writing is thicker and fast writing thinner (width ' +
      Math.min(...ws).toFixed(2) + '–' + Math.max(...ws).toFixed(2) + ')');
    // 合并采样的坐标整体错开时（部分 WebView2 / 缩放组合），笔迹仍以鼠标位置为准，不会漂开
    {
      reset();
      const q0 = position(0.3, 0.3);
      const mk = (type, x, y, extra) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerType: 'mouse', pointerId: 11, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5 });
        Object.defineProperty(ev, 'getCoalescedEvents', { value: () => extra || [] }); return ev; };
      canvas.dispatchEvent(mk('pointerdown', q0.x, q0.y));
      const did = lastId();
      for (let i = 1; i <= 12; i++) {
        const x = q0.x + i * 12, y = q0.y;
        const co = [mk('pointermove', x - 6 + 70, y + 40), mk('pointermove', x + 70, y + 40)]; // 合并采样整体偏 (70, 40)
        canvas.dispatchEvent(mk('pointermove', x, y, co));
      }
      canvas.dispatchEvent(mk('pointerup', q0.x + 144, q0.y));
      const r1 = canvas.getBoundingClientRect(), ps = points(did);
      const cssOf = q => page === 'overlay' ? [r1.left + q.x * r1.width, r1.top + q.y * r1.height] :
        (() => { const sc = Math.min(r1.width / WB.VW, r1.height / WB.VH); return [r1.left + (r1.width - WB.VW * sc) / 2 + q.x * WB.VW * sc, r1.top + (r1.height - WB.VH * sc) / 2 + q.y * WB.VH * sc]; })();
      const worst = Math.max(...ps.map(q => Math.abs(cssOf(q)[1] - q0.y)));
      T.assert(ps.length > 5 && worst < 1.5, page + ': strokes stay under the mouse even if coalesced samples are offset (worst ' + worst.toFixed(1) + ' px)');
    }
    document.getElementById('t-marker').click();
    reset();
    mouse('pointerdown', 0); const mid = lastId(); mouse('pointerup', 0);
    T.assert(messages(mid)[0].tool === 'marker' && messages(mid)[0].size === 16 && messages(mid)[0].color === Ink.pcTool().markerColor,
      page + ': 荧光笔 draws a semi-transparent marker stroke in its own color and size');
    document.getElementById('t-eraser').click();
    mouse('pointerdown', 0); const eid = lastId(); mouse('pointerup', 0);
    T.assert(messages(eid)[0].tool === 'eraser', page + ': the eraser button works');
    usePc('write', 'italic'); window.dispatchEvent(new Event('focus'));
    reset();
  }

  // State replacement and disconnection must discard an unsent tail instead of reviving it.
  for (const action of ['clear', 'full-state', 'disconnect']) {
    reset();
    input('pointerdown', at(0), 0.5, 4, []);
    const id = lastId();
    input('pointermove', at(0.4), 0.5, 4, []);
    const count = points(id).length;
    if (action === 'disconnect') sender.close();
    else T.receive(receiver, action === 'clear' ? { t: 'clear' } : { t: 'full-state', strokes: [] });
    input('pointerup', at(0.4), 0, 4);
    T.assert(points(id).length === count, page + ': ' + action + ' discards pending tail');
  }

}

// 多语言：词条完整、占位符一致、程序本体提示可翻译；三端切换语言后界面无中文残留（日语外）
async function runI18nCases(page) {
  const T = window.TEST, I = window.I18N;
  const HAN = /[\u4e00-\u9fff]/;
  const textOf = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || e.tagName === 'TITLE')
    .map(e => (e.children.length && e.tagName !== 'BUTTON' && e.tagName !== 'LABEL' ? '' : e.textContent) + ' ' + (e.title || '') + ' ' + (e.getAttribute('aria-label') || '')).join(' ');
  if (page === 'shared') {
    const D = I._dict, keys = Object.keys(D);
    const ph = s => (s.match(/\{\w+\}/g) || []).sort().join();
    T.assert(keys.length > 300 && I.langs().length === 8, 'i18n: 8 languages, ' + keys.length + ' entries');
    T.assert(keys.every(k => D[k].length === 8 && D[k].every(x => typeof x === 'string' && x.length)), 'i18n: every entry has all 8 languages');
    T.assert(keys.every(k => D[k].every(x => ph(x) === ph(D[k][0]))), 'i18n: placeholders match in every language');
    T.assert(keys.every(k => [2, 4, 5, 6, 7].every(i => !HAN.test(D[k][i]))), 'i18n: no Chinese characters in en/ko/de/fr/es');
    T.assert(I.norm('zh-HK') === 'zh-TW' && I.norm('zh-Hans-CN') === 'zh-CN' && I.norm('de-AT') === 'de' && I.norm('pt-BR') === null, 'i18n: browser language codes map to supported languages');
    I.set('en');
    T.assert(I.msg('Error: 白板已满，请先存档再清屏') === 'The whiteboard is full. Save it, then clear it.' && I.msg('快捷键格式无效：Foo') === 'Invalid shortcut format: Foo' &&
      I.msg('unknown text') === 'unknown text', 'i18n: messages from the app core are translated (exact and with details)');
    T.assert(WB_usageText() === 'The whiteboard is full. Save it and clear it, or undo to continue.', 'i18n: capacity warnings follow the language');
    try { window.Whiteboard.validateArchive({ version: 9, strokes: [] }); } catch (e) { T.assert(e.message === 'Unsupported file format or version (v1 / v2 supported)', 'i18n: archive errors follow the language'); }
    I.set('zh-CN');
    T.assert(I.msg('白板已满，请先存档再清屏') === '白板已满，请先存档再清屏' && WB_usageText() === '白板已满，请先存档再清屏，或撤销后继续', 'i18n: Chinese stays unchanged');
    function WB_usageText() { return window.Whiteboard.usageNotice({ points: 10, maxPoints: 10, strokes: 0, maxStrokes: 10 }).text; }
    return;
  }
  if (page === 'viewer') {
    const sel = document.getElementById('lang-select');
    T.assert(sel && sel.options.length === 8 && sel.value === 'zh-CN' && TEST.language === 'zh-CN', 'viewer: language picker lists 8 languages and reports the language to the app');
    sel.value = 'en'; sel.dispatchEvent(new Event('change')); await T.settle();
    T.assert(document.getElementById('btn-qr').textContent === 'Connect iPad' && document.getElementById('btn-overlay').textContent === 'Screen' &&
      TEST.language === 'en' && localStorage.getItem('wb_lang') === 'en' && document.documentElement.lang === 'en', 'viewer: switching to English updates the window and the app core');
    const leftover = textOf('#toolbar button, #toolbar span, #toolbar label, #statusbar span');
    T.assert(!HAN.test(leftover), 'viewer: no Chinese left in English UI (' + (leftover.match(/\S*[\u4e00-\u9fff]\S*/) || [''])[0] + ')');
    T.assert(document.getElementById('btn-undo').getAttribute('aria-label') === 'Undo' && document.querySelector('#colors .swatch[data-color]').title === 'Red' &&
      document.querySelector('#pc-brushes button[data-brush="soft"] b').textContent === 'Chinese Brush' && !HAN.test(textOf('#export-pop button')),
      'viewer: drawing tools, brush names and color names are translated');
    sel.value = 'zh-CN'; sel.dispatchEvent(new Event('change')); await T.settle();
    T.assert(document.getElementById('btn-qr').textContent === '连接 iPad', 'viewer: switching back to Chinese');
    return;
  }
  if (page === 'overlay') {
    I.set('de'); await T.settle();
    T.assert(document.getElementById('seg-screen').textContent === 'Bildschirm' && document.getElementById('btn-mode').getAttribute('aria-label') === 'Durchklicken' &&
      document.getElementById('btn-mode').title.includes('Ctrl+Alt+Shift+A'), 'overlay: German labels including mode switch and shortcut hint');
    const leftover = textOf('#ui button, #ui span, #hint') + document.getElementById('hint').textContent;
    T.assert(!HAN.test(leftover), 'overlay: no Chinese left in German UI (' + (leftover.match(/\S*[\u4e00-\u9fff]\S*/) || [''])[0] + ')');
    window.dispatchEvent(new StorageEvent('storage', { key: 'wb_lang', newValue: 'fr' })); await T.settle();
    T.assert(document.getElementById('seg-screen').textContent === 'Écran', 'overlay: follows a language change made in the main window');
    I.set('zh-CN'); await T.settle();
    T.assert(document.getElementById('seg-screen').textContent === '屏幕', 'overlay: switching back to Chinese');
    return;
  }
  if (page === 'pad') {
    const lb = document.getElementById('btn-lang'), menu = document.getElementById('langmenu');
    T.assert(lb && document.getElementById('lang-val').textContent === '简体中文', 'pad: the menu shows the current language');
    lb.click();
    T.assert(!menu.hidden && menu.querySelectorAll('button[data-lang]').length === 8, 'pad: language menu lists 8 languages');
    menu.querySelector('button[data-lang="en"]').click(); await T.settle();
    T.assert(menu.hidden && document.getElementById('t-marker').getAttribute('aria-label') === 'Highlighter' && document.getElementById('brush-name').textContent === 'Italic Nib' &&
      /^Connected/.test(document.getElementById('conn').textContent) && localStorage.getItem('wb_lang') === 'en', 'pad: switching to English relabels toolbar, brush and connection status');
    document.getElementById('t-pen').click();
    const bm = document.getElementById('brushes');
    T.assert(bm.querySelector('button[data-brush="soft"] b').textContent.startsWith('Chinese Brush') && bm.querySelector('#btn-tune').textContent.startsWith('Brush Studio'), 'pad: brush menu is translated');
    bm.querySelector('#btn-tune').click();
    const tune = document.getElementById('tune');
    const studio = textOf('#tune button, #tune .tune-sec, #tune .nm, #tune small, #tune b, #tune .tag, #tune .pr, #tune .tp-hint, #tune .tune-tip');
    T.assert(!HAN.test(studio) && /Smoothing/.test(studio) && /Restore defaults|Save as new brush/.test(studio), 'pad: Brush Studio is fully translated (' + (studio.match(/\S*[\u4e00-\u9fff]\S*/) || [''])[0] + ')');
    const leftover = textOf('#bar-left button, #toolbar button, #sidebar button, #sizebar, #conn');
    T.assert(!HAN.test(leftover), 'pad: no Chinese left in the English toolbar (' + (leftover.match(/\S*[\u4e00-\u9fff]\S*/) || [''])[0] + ')');
    lb.click(); menu.querySelector('button[data-lang="ja"]').click(); await T.settle();
    T.assert(document.getElementById('t-marker').getAttribute('aria-label') === '蛍光ペン' && tune.querySelector('b').textContent.startsWith('ブラシスタジオ'), 'pad: Japanese relabels the open Brush Studio too');
    T.receive(T.sockets[0], { t: 'error', message: '白板已满，请先存档再清屏' });
    T.assert(document.getElementById('notice').textContent.includes('ホワイトボードがいっぱいです'), 'pad: messages from the PC are shown in the iPad language');
    tune.querySelector('[data-act=close]').click();
    lb.click(); menu.querySelector('button[data-lang="zh-CN"]').click(); await T.settle();
    T.assert(document.getElementById('t-marker').getAttribute('aria-label') === '荧光' && document.getElementById('brush-name').textContent === '英文斜体', 'pad: switching back to Chinese');
  }
}

// iPad 新界面（v0.8）：模式切换、重做、手势提示
async function runPadUiCases() {
  const T = window.TEST;
  T.assert(document.querySelector('#mode-seg button[data-mode="annotate"]').classList.contains('on') && !document.querySelector('#mode-seg button[data-mode="board"]').classList.contains('on'),
    'pad: the mode switch shows Screen as the current mode');
  T.assert(!document.getElementById('bottom-toolbar') && document.getElementById('toolbar').getBoundingClientRect().top < 80, 'pad: tools sit in the top-right cluster (no bottom toolbar)');
  // 重做
  T.snapshot(T.sockets[0], []);
  const live = document.getElementById('live'), r = live.getBoundingClientRect();
  const pen = (type, x, y) => { const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 96, pointerType: 'pen', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.2 });
    Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); live.dispatchEvent(ev); };
  await new Promise(res => setTimeout(res, 600));
  const x0 = r.left + r.width * 0.4, y0 = r.top + r.height * 0.5;
  pen('pointerdown', x0, y0); for (let i = 1; i <= 25; i++) pen('pointermove', x0 + i * 5, y0 + i * 2); pen('pointerup', x0 + 125, y0 + 50);
  const first = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg;
  const n1 = T.sent.filter(x => x.msg.t === 'stroke-point' && x.msg.id === first.id).length;
  const redoBtn = document.getElementById('btn-redo');
  T.assert(redoBtn.disabled, 'pad: redo is disabled before anything is undone');
  document.getElementById('btn-undo').click();
  T.assert(!redoBtn.disabled, 'pad: after undo, redo becomes available');
  redoBtn.click();
  const again = T.sent.filter(x => x.msg.t === 'stroke-start').at(-1).msg;
  const n2 = T.sent.filter(x => x.msg.t === 'stroke-point' && x.msg.id === again.id).length;
  T.assert(again.id !== first.id && again.tool === first.tool && again.color === first.color && n2 === n1 && T.sent.at(-1).msg.t === 'stroke-end' && redoBtn.disabled,
    'pad: redo re-sends the undone stroke as a new stroke (' + n1 + ' points)');
  document.getElementById('btn-undo').click(); document.getElementById('btn-redo').click();
  pen('pointerdown', x0, y0 + 80); pen('pointermove', x0 + 20, y0 + 80); pen('pointerup', x0 + 40, y0 + 80);
  document.getElementById('btn-undo').click();
  T.assert(!redoBtn.disabled, 'pad: redo only holds strokes undone since the last new stroke');
  T.snapshot(T.sockets[0], []);
  T.assert(redoBtn.disabled, 'pad: a fresh board snapshot clears redo');
  // v0.8.2：画笔只有英文斜体（默认 6）和中国毛笔（默认 9）
  T.assert(Ink.BRUSHES.italic.sizes[1] === 6 && Ink.BRUSHES.soft.sizes[1] === 9 && localStorage.getItem('wb_sz_rev') === '3' &&
    !T.sent.some(x => x.msg.t === 'pen-size-get'),
    'pad: default sizes are 6 for 英文斜体 and 9 for 中国毛笔 (old saved sizes reset once)');
  // v0.8.2：一键清除——点一下就清，不弹确认；“撤销”整板恢复
  {
    const qc = document.getElementById('btn-quickclear'), toast = document.getElementById('undo-toast');
    pen('pointerdown', x0, y0); for (let i = 1; i <= 10; i++) pen('pointermove', x0 + i * 6, y0); pen('pointerup', x0 + 60, y0);
    T.assert(qc && qc.offsetParent !== null && qc.getBoundingClientRect().height >= 44, 'pad: a clear-all button sits in the left sidebar');
    let confirms = 0; const oc = window.confirm; window.confirm = () => { confirms++; return true; };
    let n0 = T.sent.length; qc.click();
    T.assert(T.sent.slice(n0).some(x => x.msg.t === 'clear') && confirms === 0 && !toast.hidden, 'pad: one tap clears everything (no confirm dialog) and shows an Undo bar');
    n0 = T.sent.length; document.getElementById('undo-toast-btn').click();
    const bl = T.sent.slice(n0).find(x => x.msg.t === 'board-load');
    T.assert(bl && bl.msg.strokes.length === 1 && bl.msg.strokes[0].points.length > 2 && toast.hidden, 'pad: Undo restores what was cleared in one board-load');
    qc.click(); n0 = T.sent.length; document.getElementById('btn-undo').click();
    T.assert(T.sent.slice(n0).some(x => x.msg.t === 'board-load') && !T.sent.slice(n0).some(x => x.msg.t === 'undo'), 'pad: the undo button also brings back a clear');
    qc.click();
    pen('pointerdown', x0, y0 + 60); pen('pointermove', x0 + 30, y0 + 60); pen('pointerup', x0 + 60, y0 + 60);
    n0 = T.sent.length; document.getElementById('btn-undo').click();
    T.assert(T.sent.slice(n0).some(x => x.msg.t === 'undo') && !T.sent.slice(n0).some(x => x.msg.t === 'board-load') && toast.hidden,
      'pad: after writing something new, undo undoes that stroke instead of the clear');
    document.getElementById('btn-menu').click(); n0 = T.sent.length; document.getElementById('btn-clear').click();
    T.assert(T.sent.slice(n0).some(x => x.msg.t === 'clear') && confirms === 0, 'pad: “Clear all” in the menu also clears in one tap');
    window.confirm = oc;
  }
  // v0.8.2：橡皮擦增量擦除——擦的过程中不再整层重画全部笔画
  {
    T.snapshot(T.sockets[0], []);
    const ys = y0 + 40;
    for (let k = 0; k < 6; k++) { pen('pointerdown', x0 - 40, ys + k * 6); for (let i = 1; i <= 20; i++) pen('pointermove', x0 - 40 + i * 8, ys + k * 6); pen('pointerup', x0 + 120, ys + k * 6); }
    await new Promise(res => setTimeout(res, 60));
    const inkC = document.getElementById('ink'), ir = inkC.getBoundingClientRect();
    const alphaAt = (x, y) => inkC.getContext('2d').getImageData(Math.floor((x - ir.left) * inkC.width / ir.width), Math.floor((y - ir.top) * inkC.height / ir.height), 1, 1).data[3];
    const cx = x0 + 40, cy = ys + 12;
    T.assert(alphaAt(cx, cy) > 0, 'pad: ink is there before erasing');
    document.getElementById('t-eraser').click();
    let draws = 0; const od = Ink.drawStroke; Ink.drawStroke = function () { draws++; return od.apply(this, arguments); };
    const n0 = T.sent.length;
    pen('pointerdown', cx, ys - 20);
    for (let i = 1; i <= 20; i++) { pen('pointermove', cx, ys - 20 + i * 4); if (i % 5 === 0) await new Promise(res => setTimeout(res, 20)); }
    await new Promise(res => setTimeout(res, 40));
    T.assert(alphaAt(cx, cy) === 0 && draws === 0, 'pad: the eraser removes ink while the pen is still down without redrawing every stroke (' + draws + ' redraws)');
    pen('pointerup', cx, ys + 60);
    T.assert(draws === 1 && alphaAt(cx, cy) === 0, 'pad: lifting the eraser applies its final shape once');
    Ink.drawStroke = od;
    const ep = T.sent.slice(n0).filter(x => x.msg.t === 'stroke-point').map(x => x.msg);
    T.assert(T.sent.slice(n0).find(x => x.msg.t === 'stroke-start').msg.tool === 'eraser' && ep.length > 5 && ep.every(q => q.p === 0.5),
      'pad: the eraser follows the pen with no smoothing delay and no pressure');
    document.getElementById('t-pen').click();
    T.snapshot(T.sockets[0], []);
  }
  // 手势提示
  const help = document.getElementById('help');
  T.assert(help.hidden, 'pad: tips do not reappear once seen');
  document.getElementById('btn-help').click();
  T.assert(!help.hidden && help.querySelectorAll('li').length === 5, 'pad: Gestures & tips can be opened from the menu');
  localStorage.removeItem('wb_help_seen');
  document.getElementById('help-ok').click();
  T.assert(help.hidden && localStorage.getItem('wb_help_seen') === '1', 'pad: closing the tips remembers it');
  // v0.8.13：菜单 › 使用说明——浮在本页上面（iframe /guide），不离开书写页
  document.getElementById('btn-menu').click();
  T.assert(!document.getElementById('appmenu').hidden && document.getElementById('btn-guide'), 'v0.8.13: the iPad menu has a user guide item');
  document.getElementById('btn-guide').click();
  T.assert(!document.getElementById('guide').hidden && document.getElementById('appmenu').hidden && document.getElementById('guide-frame').getAttribute('src') === '/guide?lang=' + I18N.lang(),
    'v0.8.13: the guide opens over the page from the computer (/guide), and the menu closes');
  document.getElementById('guide-close').click();
  T.assert(document.getElementById('guide').hidden, 'v0.8.13: closing the guide returns to writing');
}


// v0.8.9：iPad 和电脑的“屏幕 | 白板”双向同步；电脑上橡皮擦在 iPad 上增量擦除
async function runPadSyncCases() {
  const T = window.TEST;
  localStorage.removeItem('wb_dev'); localStorage.removeItem('wb_diag'); // 正式版
  const on = () => document.querySelector('#mode-seg button.on').dataset.mode;
  const cur = () => T.sockets.filter(x => x.role === 'pad' && x.readyState !== 3).at(-1);
  for (let i = 0; i < 100 && !cur(); i++) await new Promise(r => setTimeout(r, 50));
  if (!cur()) throw new Error('no open pad socket: ' + JSON.stringify(T.sockets.map(x => [x.role, x.readyState, x.board])));
  // 电脑端 → iPad
  const m0 = on(), other = m0 === 'annotate' ? 'board' : 'annotate';
  let sent0 = T.sent.length;
  T.receive(cur(), { t: 'pc-mode', mode: other });
  await new Promise(r => setTimeout(r, 50));
  T.assert(on() === other && !T.sent.slice(sent0).some(x => x.msg.t === 'pad-mode') && /电脑切换到了/.test(document.getElementById('notice').textContent),
    'v0.8.9: when the computer switches 屏幕 / 白板, the iPad follows (without echoing back)');
  T.assert(cur().board === (other === 'annotate' ? 'overlay' : 'main'), 'v0.8.9: the iPad reconnects to the matching board');
  const n = T.sockets.length;
  T.receive(cur(), { t: 'pc-mode', mode: other });
  T.assert(T.sockets.length === n && on() === other, 'v0.8.9: a repeated pc-mode for the current mode changes nothing');
  T.receive(cur(), { t: 'pc-mode', mode: 'weird' });
  T.assert(on() === other, 'v0.8.9: unknown modes are ignored');
  // iPad → 电脑：自己切换时先告诉电脑
  await new Promise(r => setTimeout(r, 50));
  const before = cur();
  sent0 = T.sent.length;
  document.querySelector('#mode-seg button[data-mode="' + m0 + '"]').click();
  const pm = T.sent.slice(sent0).find(x => x.msg.t === 'pad-mode');
  T.assert(pm && pm.msg.mode === m0 && on() === m0 && before.readyState === 3, 'v0.8.9: switching on the iPad tells the computer (pad-mode) before reconnecting');
  // 电脑上用橡皮擦：iPad 上逐点擦掉（不等抬笔）
  await new Promise(r => setTimeout(r, 100));
  const ink = document.getElementById('ink'), g = ink.getContext('2d');
  T.snapshot(cur(), [{ id: 'base', color: '#000000', size: 30, tool: 'pen', points: Array.from({ length: 30 }, (_, i) => [0.2 + i * 0.02, 0.5, 0.6]) }]);
  await new Promise(r => setTimeout(r, 120));
  const vw = innerWidth, vh = innerHeight; let w = vw - 16, h = vh - 66 - 8; const asp = parseFloat(localStorage.getItem('wb_aspect')) || 1.6;
  if (m0 === 'annotate') { if (w / h > asp) w = h * asp; else h = w / asp; } else { if (w / h > 1.6) w = h * 1.6; else h = w / 1.6; }
  const px = (nx, ny) => { const d = devicePixelRatio || 1; return g.getImageData(Math.round(((vw - w) / 2 + nx * w) * d), Math.round((66 + (vh - 66 - 8 - h) / 2 + ny * h) * d), 1, 1).data[3]; };
  T.assert(px(0.5, 0.5) > 0, 'v0.8.9: the base stroke is drawn');
  T.receive(cur(), { t: 'stroke-start', id: 'pc-er', color: '#000000', size: 40, tool: 'eraser' });
  [0.45, 0.48, 0.5, 0.52, 0.55].forEach(x => T.receive(cur(), { t: 'stroke-point', id: 'pc-er', x, y: 0.5, p: 0.5 }));
  T.assert(px(0.5, 0.5) === 0 && px(0.3, 0.5) > 0, 'v0.8.9: the computer\'s eraser clears the iPad ink point by point, before the eraser is lifted');
  T.receive(cur(), { t: 'stroke-end', id: 'pc-er' });
  await new Promise(r => setTimeout(r, 120));
  T.assert(px(0.5, 0.5) === 0 && px(0.3, 0.5) > 0, 'v0.8.9: after the eraser ends the result stays the same');
  // v0.8.10：书写 / 擦除中不换屏幕画面——收到的新画面等抬笔一会儿后再换上，期间也不请求新画面
  if (on() === 'annotate') {
    const mk = (col) => { const c = document.createElement('canvas'); c.width = 160; c.height = 100; const cg = c.getContext('2d'); cg.fillStyle = col; cg.fillRect(0, 0, 160, 100);
      return new Blob([Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0))], { type: 'image/png' }); };
    const bgc = document.getElementById('bg'), mid = () => bgc.getContext('2d').getImageData(bgc.width >> 1, bgc.height >> 1, 1, 1).data;
    const live = document.getElementById('live'), lr = live.getBoundingClientRect();
    const pen = (t, x, y) => { const ev = new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 97, pointerType: 'pen', isPrimary: true, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pressure: t === 'pointerup' ? 0 : 0.3 });
      Object.defineProperty(ev, 'getCoalescedEvents', { value: () => [] }); live.dispatchEvent(ev); };
    document.getElementById('t-eraser').click();
    const x0 = lr.left + lr.width * 0.2, y0 = lr.top + lr.height * 0.2;
    pen('pointerdown', x0, y0); pen('pointermove', x0 + 10, y0 + 5);
    const req0 = T.sent.filter(x => x.msg.t === 'preview-req').length;
    const blue = mk('#0000ff');
    cur().onmessage({ data: JSON.stringify({ t: 'preview-meta', w: 1600, h: 1000, fw: 160, fh: 100 }) });
    cur().onmessage({ data: blue });
    for (let i = 0; i < 8; i++) { await createImageBitmap(blue); await new Promise(r => setTimeout(r, 50)); pen('pointermove', x0 + 10 + i * 4, y0 + 5); }
    const during = mid();
    T.assert(!(during[2] > 200 && during[0] < 60), 'v0.8.10: a new screen frame is not swapped in while erasing');
    pen('pointerup', x0 + 50, y0 + 10);
    let after = during;
    for (let i = 0; i < 80 && !(after[2] > 200 && after[0] < 60); i++) { await new Promise(r => setTimeout(r, 50)); await createImageBitmap(blue); after = mid(); }
    T.assert(after[2] > 200 && after[0] < 60, 'v0.8.10: the held frame appears after the pen is lifted');
    T.assert(T.sent.filter(x => x.msg.t === 'preview-req').length >= req0, 'v0.8.10: frame requests resume afterwards');
    document.getElementById('t-pen').click();
    await new Promise(r => setTimeout(r, 2300));
    T.assert(localStorage.getItem('wb_diag') === null && JSON.parse(localStorage.getItem('wb_press') || '[]').length > 0,
      'v0.8.11: the release build keeps only pen pressures for calibration (saved after a pause), not full diagnostics on every pen-up');
    // v0.8.12：画面里带着标注（电脑开着“录屏/共享时显示标注”）——提示一次；擦完抬笔马上要新画面，不再等 1.2 秒
    const reqs = () => T.sent.filter(x => x.msg.t === 'preview-req').length;
    const waitReq = async (n0, ms) => { const t0 = performance.now(); while (reqs() <= n0 && performance.now() - t0 < ms) await new Promise(r => setTimeout(r, 20)); return reqs() > n0 ? performance.now() - t0 : -1; };
    const red = mk('#ff0000');
    let r0 = reqs();
    cur().onmessage({ data: JSON.stringify({ t: 'preview-meta', w: 1600, h: 1000, fw: 160, fh: 100, ink: true }) });
    cur().onmessage({ data: red });
    T.assert(/录屏\/共享时显示标注/.test(document.getElementById('notice').textContent) && localStorage.getItem('wb_inkframe_seen') === '1',
      'v0.8.12 / v1.0.2: when the screen image contains the annotations, the iPad explains it once (remembered on this iPad)');
    T.assert(await waitReq(r0, 3000) >= 0, 'v0.8.12: the next frame is requested after the ink frame');
    cur().onmessage({ data: JSON.stringify({ t: 'preview-same' }) });
    await new Promise(r => setTimeout(r, 50));
    document.getElementById('t-eraser').click();
    pen('pointerdown', x0, y0 + 40); pen('pointermove', x0 + 30, y0 + 40); pen('pointermove', x0 + 60, y0 + 40);
    r0 = reqs();
    pen('pointerup', x0 + 60, y0 + 40);
    const dt = await waitReq(r0, 1000);
    T.assert(dt >= 0 && dt < 500, 'v0.8.12: with annotations in the screen image, a fresh frame is requested right after the eraser is lifted (' + Math.round(dt) + ' ms)');
    cur().onmessage({ data: JSON.stringify({ t: 'preview-same' }) });
    r0 = reqs();
    T.receive(cur(), { t: 'undo', id: 'nonexistent' });
    T.receive(cur(), { t: 'clear' });
    T.assert(await waitReq(r0, 1000) >= 0, 'v0.8.12: undo / clear also ask for a fresh frame when the image contains annotations');
    cur().onmessage({ data: JSON.stringify({ t: 'preview-meta', w: 1600, h: 1000, fw: 160, fh: 100, ink: false }) });
    cur().onmessage({ data: blue });
    await new Promise(r => setTimeout(r, 300));
    cur().onmessage({ data: JSON.stringify({ t: 'preview-same' }) });
    pen('pointerdown', x0, y0 + 60); pen('pointermove', x0 + 40, y0 + 60);
    await new Promise(r => setTimeout(r, 20));
    r0 = reqs();
    pen('pointerup', x0 + 40, y0 + 60);
    T.assert(await waitReq(r0, 700) < 0, 'v0.8.12: without annotations in the image, the 1.2 s pause after writing still applies');
    document.getElementById('t-pen').click();
  }
}
