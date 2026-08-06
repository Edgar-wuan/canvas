// 发送端：文件 -> 分块 -> 帧 -> QR/RGB 图 -> 轮播
(function () {
  const P = window.AirProtocol;

  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  const fileMeta = $('fileMeta');
  const modeSel = $('modeSel');
  const chunkSize = $('chunkSize');
  const eccSel = $('eccSel');
  const frameMs = $('frameMs');
  const scaleSel = $('scaleSel');
  const versionMax = $('versionMax');
  const startBtn = $('startBtn');
  const pauseBtn = $('pauseBtn');
  const stopBtn = $('stopBtn');
  const sendStats = $('sendStats');
  const qrCanvas = $('qrCanvas');
  const stageInfo = $('stageInfo');
  const turboBtn = $('turboBtn');
  const balanceBtn = $('balanceBtn');
  const safeBtn = $('safeBtn');
  const capHint = $('capHint');

  let fileBytes = null;        // 原始字节（用于 CRC）
  let fileBytesForTx = null;   // 实际传输字节（可能压缩）
  let fileObj = null;
  let timer = null;
  let screens = []; // 每项: {kind, draw: ()=>在 qrCanvas 上绘制}
  let screenIdx = 0;
  let running = false;
  let paused = false;
  let phase = 'idle'; // 'idle' | 'header' | 'data'
  let headerQr = null;
  const startDataBtn = $('startDataBtn');

  // --- 文件选择（含 gzip 压缩）---
  async function setFile(f) {
    fileObj = f;
    if (!f) { fileBytes = null; fileBytesForTx = null; fileMeta.textContent = '未选择文件'; return; }
    try {
      const buf = await f.arrayBuffer();
      fileBytes = new Uint8Array(buf);
      // 尝试 gzip 压缩
      let compressed = null;
      try { compressed = await P.compressGzip(fileBytes); } catch (e) {}
      if (compressed && compressed.length < fileBytes.length) {
        fileBytesForTx = compressed;
        const ratio = (compressed.length / fileBytes.length * 100).toFixed(0);
        fileMeta.textContent = `${f.name} · ${formatSize(f.size)} · 压缩后 ${formatSize(compressed.length)} (${ratio}%)`;
      } else {
        fileBytesForTx = fileBytes;
        fileMeta.textContent = `${f.name} · ${formatSize(f.size)} · 无需压缩`;
      }
      sendStats.textContent = `已加载，可点击“开始播放”`;
    } catch (e) {
      fileMeta.textContent = '读取失败：' + e.message;
    }
  }
  fileInput.addEventListener('change', (e) => setFile(e.target.files[0] || null));
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
  );
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  // --- QR 编码辅助 ---
  function makeQR(binaryStr, ecc, version) {
    const qr = qrcode(version, ecc);
    qr.addData(binaryStr, 'Byte');
    qr.make();
    return qr;
  }

  // QR 字节模式容量缓存（按 ECC 级别预计算一次，后续查表 O(1)）
  const _capCache = {};
  function getCapacity(ecc) {
    if (_capCache[ecc]) return _capCache[ecc];
    const arr = [0];
    for (let v = 1; v <= 40; v++) {
      let lo = 0, hi = 3000;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        try {
          const qr = qrcode(v, ecc);
          qr.addData('x'.repeat(mid), 'Byte');
          qr.make();
          lo = mid;
        } catch { hi = mid - 1; }
      }
      arr[v] = lo;
    }
    _capCache[ecc] = arr;
    return arr;
  }

  // 查表找最小版本（不再逐块试探创建 QR 对象）
  function minVersion(byteLen, ecc, maxV) {
    const cap = getCapacity(ecc);
    for (let v = 1; v <= maxV; v++) {
      if (cap[v] >= byteLen) return v;
    }
    return -1;
  }

  // 取 QR 模块数（qrcode-generator 仅暴露 getModuleCount()）
  function modN(qr) { return qr.getModuleCount(); }

  // 静区宽度（QR 规范要求四周至少 4 模块白边）
  const QUIET_ZONE = 4;

  // 把单个 QR 渲染到 ctx（黑白），带静区
  function drawQRBW(ctx, qr) {
    const n = modN(qr);
    const total = n + QUIET_ZONE * 2;
    ctx.canvas.width = total;
    ctx.canvas.height = total;
    const img = ctx.createImageData(total, total);
    for (let r = 0; r < total; r++) {
      for (let c = 0; c < total; c++) {
        const idx = (r * total + c) * 4;
        if (r < QUIET_ZONE || r >= n + QUIET_ZONE || c < QUIET_ZONE || c >= n + QUIET_ZONE) {
          // 静区：白色
          img.data[idx] = 255; img.data[idx + 1] = 255; img.data[idx + 2] = 255; img.data[idx + 3] = 255;
        } else {
          const dark = qr.isDark(r - QUIET_ZONE, c - QUIET_ZONE);
          const v = dark ? 0 : 255;
          img.data[idx] = v; img.data[idx + 1] = v; img.data[idx + 2] = v; img.data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // 把 3 个 QR 组合为 RGB 通道渲染（多色模式），带静区
  function drawQRColor(ctx, qrR, qrG, qrB) {
    const n = modN(qrR);
    const total = n + QUIET_ZONE * 2;
    ctx.canvas.width = total;
    ctx.canvas.height = total;
    const img = ctx.createImageData(total, total);
    for (let r = 0; r < total; r++) {
      for (let c = 0; c < total; c++) {
        const idx = (r * total + c) * 4;
        if (r < QUIET_ZONE || r >= n + QUIET_ZONE || c < QUIET_ZONE || c >= n + QUIET_ZONE) {
          // 静区：白色
          img.data[idx] = 255; img.data[idx + 1] = 255; img.data[idx + 2] = 255; img.data[idx + 3] = 255;
        } else {
          const rr = r - QUIET_ZONE, cc = c - QUIET_ZONE;
          img.data[idx] = qrR.isDark(rr, cc) ? 0 : 255;
          img.data[idx + 1] = qrG.isDark(rr, cc) ? 0 : 255;
          img.data[idx + 2] = qrB.isDark(rr, cc) ? 0 : 255;
          img.data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // 构造一个空 QR（占位用，全白模块）
  function blankQR(version, ecc) {
    const qr = qrcode(version, ecc);
    qr.addData(' ', 'Byte');
    qr.make();
    return qr;
  }

  // --- 构建播放序列 ---
  function buildScreens() {
    const mode = modeSel.value;
    const ecc = eccSel.value;
    const cs = parseInt(chunkSize.value, 10) || 80;
    const maxV = parseInt(versionMax.value, 10) || 12;
    const txBytes = fileBytesForTx || fileBytes;
    const compressed = fileBytesForTx && fileBytesForTx !== fileBytes;
    const chunks = P.chunkFile(txBytes, cs);
    const totalFrames = chunks.length;
    const fileCrc = P.crc32(fileBytes); // 原始字节 CRC（接收端解压后校验）
    let flags = compressed ? P.FLAG_GZIP : 0;
    if (mode === 'color') flags |= P.FLAG_COLOR;
    // 浏览器默认 UTF-8，未来可通过 UI 让用户选择文件编码
    const textEncoding = P.TEXT_ENC_UTF8;
    const headerBytes = P.packHeader({
      version: P.PROTOCOL_VERSION,
      flags,
      textEncoding,
      totalFrames,
      fileSize: fileBytes.length,   // 原始大小
      txSize: txBytes.length,       // 传输字节大小
      chunkSize: cs,
      name: fileObj.name,
      fileCrc,
    });
    const headerStr = P.bytesToBinaryString(headerBytes);

    // 数据帧字符串
    const dataStrs = chunks.map((c, i) =>
      P.bytesToBinaryString(P.packData({ frameIndex: i, totalFrames, payload: c }))
    );

    // 数据帧字节长度固定（头 13 字节 + payload），所有块大小一致
    // 只需查表一次，不再逐块试探（修卡死 bug）
    const dataFrameLen = 13 + cs;
    let dataVer = minVersion(dataFrameLen, ecc, maxV);
    if (dataVer < 0) throw new Error('数据帧过大，请减小"每帧数据字节"或提高"版本上限"');
    const headerVer = Math.min(maxV, Math.max(dataVer, minVersion(headerBytes.length, ecc, maxV)));
    if (headerVer < 0) throw new Error('文件头过大，请缩短文件名');

    const screens = [];
    const HEADER_EVERY = 16; // 每 16 个数据屏插一次头，占比 ~6%（原 8 = 12.5%）

    function pushDataScreenBW(str) {
      const qr = makeQR(str, ecc, dataVer);
      const n = modN(qr);
      screens.push({
        kind: 'data',
        n,
        draw: (ctx) => drawQRBW(ctx, qr),
        info: `BW · v${dataVer} · ${n}×${n}`,
      });
    }
    function pushHeaderScreenBW() {
      const qr = makeQR(headerStr, ecc, headerVer);
      const n = modN(qr);
      screens.push({
        kind: 'header',
        n,
        draw: (ctx) => drawQRBW(ctx, qr),
        info: `BW · 文件头 · v${headerVer}`,
      });
    }
    function pushDataScreenColor(strs) {
      // 补齐到 3 个
      while (strs.length < 3) strs.push(P.bytesToBinaryString(new Uint8Array(0)));
      // 所有数据帧块大小一致，直接用 dataVer，不再逐通道试探
      const qR = makeQR(strs[0], ecc, dataVer);
      const qG = makeQR(strs[1], ecc, dataVer);
      const qB = makeQR(strs[2], ecc, dataVer);
      const n = modN(qR);
      screens.push({
        kind: 'data',
        n,
        draw: (ctx) => drawQRColor(ctx, qR, qG, qB),
        info: `RGB · v${dataVer} · ${n}×${n}`,
      });
    }
    function pushHeaderScreenColor() {
      // 头放 R 通道，G/B 用空 QR
      const v = Math.max(headerVer, dataVer);
      const qR = makeQR(headerStr, ecc, v);
      const qG = blankQR(v, ecc);
      const qB = blankQR(v, ecc);
      const n = modN(qR);
      screens.push({
        kind: 'header',
        n,
        draw: (ctx) => drawQRColor(ctx, qR, qG, qB),
        info: `RGB · 文件头 · v${v}`,
      });
    }

    // 只构建纯数据帧序列，头帧由 start() 单独固定显示
    // 数据帧序列 0% 头帧插入，最大化有效传输
    for (let i = 0; i < totalFrames; ) {
      if (mode === 'bw') {
        pushDataScreenBW(dataStrs[i]);
        i += 1;
      } else {
        const grp = dataStrs.slice(i, i + 3);
        pushDataScreenColor(grp);
        i += grp.length;
      }
    }
    return { screens, totalFrames, dataVer, headerVer, fileCrc, compressed, headerStr, ecc };
  }

  // --- 渲染当前帧 ---
  function renderCurrent() {
    if (!screens.length) return;
    const sc = screens[screenIdx];
    const scale = parseInt(scaleSel.value, 10) || 6;
    // 先以 1px/module 绘制到离屏，再放大到显示 canvas
    // 离屏画布初始大小设为 sc.n（不含静区），drawQRBW 会扩展到含静区的尺寸
    const off = document.createElement('canvas');
    off.width = sc.n; off.height = sc.n;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    sc.draw(octx);
    // 绘制后，离屏画布大小可能已被 draw 函数扩展（加入静区）
    const total = off.width; // 实际画布大小（含静区）
    qrCanvas.width = total * scale;
    qrCanvas.height = total * scale;
    const ctx = qrCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
    ctx.drawImage(off, 0, 0, qrCanvas.width, qrCanvas.height);

    stageInfo.textContent = `屏 ${screenIdx + 1}/${screens.length} · ${sc.info}`;
  }

  function tick() {
    if (!running || paused) return;
    renderCurrent();
    screenIdx = (screenIdx + 1) % screens.length;
  }

  // --- 控制 ---
  // 阶段1：固定显示文件头，等接收端确认
  function start() {
    if (!fileBytesForTx) { alert('请先选择文件'); return; }
    try {
      const r = buildScreens();
      screens = r.screens;
      headerQr = makeQR(r.headerStr, r.ecc, r.headerVer);
      const zipTag = r.compressed ? ' · gzip' : '';
      sendStats.textContent = `文件头就绪 · ${r.totalFrames} 数据帧 · 数据v${r.dataVer} 头v${r.headerVer}${zipTag} · CRC ${r.fileCrc.toString(16).padStart(8, '0')}`;
    } catch (e) {
      alert(e.message); return;
    }
    phase = 'header';
    running = true; paused = false;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    startDataBtn.disabled = false;
    renderHeader();
    stageInfo.textContent = '固定显示文件头 · 等接收端确认后点"开始传输数据"';
  }

  // 渲染固定头帧
  function renderHeader() {
    if (!headerQr) return;
    const scale = parseInt(scaleSel.value, 10) || 6;
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    const mode = modeSel.value;
    if (mode === 'color') {
      // 多色模式头帧：放 R 通道，G/B 用空白 QR
      const blankQ = blankQR(versionMax.value || 20, eccSel.value);
      const blankB = blankQR(versionMax.value || 20, eccSel.value);
      drawQRColor(octx, headerQr, blankQ, blankB);
    } else {
      drawQRBW(octx, headerQr);
    }
    const total = off.width;
    qrCanvas.width = total * scale;
    qrCanvas.height = total * scale;
    const ctx = qrCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
    ctx.drawImage(off, 0, 0, qrCanvas.width, qrCanvas.height);
  }

  // 阶段2：开始轮播数据帧
  function startData() {
    if (phase !== 'header') return;
    phase = 'data';
    screenIdx = 0;
    const ms = parseInt(frameMs.value, 10) || 180;
    timer = setInterval(tick, ms);
    startDataBtn.disabled = true;
    pauseBtn.disabled = false;
    sendStats.textContent = `传输中 · 共 ${screens.length} 屏`;
    renderCurrent();
  }
  startDataBtn.addEventListener('click', startData);
  function pause() {
    if (!running) return;
    paused = !paused;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    stageInfo.textContent = paused ? '已暂停' : stageInfo.textContent;
  }
  function stop() {
    running = false; paused = false;
    phase = 'idle';
    if (timer) { clearInterval(timer); timer = null; }
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    pauseBtn.textContent = '暂停';
    stopBtn.disabled = true;
    startDataBtn.disabled = true;
    headerQr = null;
    const ctx = qrCanvas.getContext('2d');
    ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
    stageInfo.textContent = '已停止';
  }
  startBtn.addEventListener('click', start);
  pauseBtn.addEventListener('click', pause);
  stopBtn.addEventListener('click', stop);

  // --- Turbo / 安全预设 ---
  function applyPreset(p) {
    modeSel.value = p.mode;
    chunkSize.value = p.cs;
    eccSel.value = p.ecc;
    versionMax.value = p.vm;
    frameMs.value = p.ms;
    scaleSel.value = p.scale;
    updateCapHint();
  }
  turboBtn.addEventListener('click', () =>
    applyPreset({ mode: 'bw', cs: 960, ecc: 'M', vm: 25, ms: 150, scale: 8 })
  );
  balanceBtn.addEventListener('click', () =>
    applyPreset({ mode: 'bw', cs: 450, ecc: 'Q', vm: 20, ms: 180, scale: 8 })
  );
  safeBtn.addEventListener('click', () =>
    applyPreset({ mode: 'bw', cs: 200, ecc: 'M', vm: 15, ms: 200, scale: 6 })
  );
  // 参数变化时更新容量提示
  [modeSel, chunkSize, eccSel, versionMax].forEach((el) =>
    el.addEventListener('change', updateCapHint)
  );
  function updateCapHint() {
    const ecc = eccSel.value;
    const vm = parseInt(versionMax.value, 10) || 40;
    const cs = parseInt(chunkSize.value, 10) || 80;
    const cap = getCapacity(ecc);
    let v = -1;
    for (let i = 1; i <= vm; i++) { if (cap[i] >= 13 + cs) { v = i; break; } }
    if (v < 0) { capHint.textContent = `⚠ 帧过大：v${vm} ${ecc} 纠错最多容纳 ${cap[vm] - 13} 字节，请减小每帧字节或提高版本上限`; return; }
    const perCh = Math.min(cs, cap[v] - 13);
    const channels = modeSel.value === 'color' ? 3 : 1;
    const perScreen = perCh * channels;
    const ms = parseInt(frameMs.value, 10) || 120;
    const secs1mb = Math.ceil(1048576 / perScreen * ms / 1000);
    capHint.textContent = `当前：v${v} ${modeSel.value === 'color' ? 'RGB 3 通道' : '黑白'} · ${perScreen} B/屏 · 纠错 ${ecc} · 1MB 约 ${secs1mb} 秒`;
  }
  updateCapHint();

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
})();
