// 接收端：摄像头 -> 抓帧 -> jsQR 解码 -> 重组文件 -> 下载
(function () {
  const P = window.AirProtocol;

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const scanCanvas = $('scanCanvas');
  const scanOverlay = $('scanOverlay');
  const scanStatus = $('scanStatus');
  const camBtn = $('camBtn');
  const camSel = $('camSel');
  const colorModeRecv = $('colorModeRecv');
  const resetBtn = $('resetBtn');
  const progFill = $('progFill');
  const progText = $('progText');
  const recvStats = $('recvStats');
  const fileCard = $('fileCard');
  const fileName = $('fileName');
  const fileSize = $('fileSize');
  const fileChunks = $('fileChunks');
  const fileCrc = $('fileCrc');
  const downloadBtn = $('downloadBtn');

  let stream = null;
  let rafId = null;
  let procCanvas = document.createElement('canvas');
  let procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
  const debugView = $('debugView');
  const debugCanvas = $('debugCanvas');
  const debugCtx = debugCanvas.getContext('2d', { willReadFrequently: true });
  const saveFrameBtn = $('saveFrameBtn');
  let lastImgData = null; // 保存最近一帧用于诊断

  // 接收状态
  let header = null;       // {totalFrames, fileSize, chunkSize, name, fileCrc}
  let chunks = new Map();  // frameIndex -> Uint8Array(payload)
  let lastSeenIdx = -1;
  let totalDecoded = 0;
  let done = false;
  let blobUrl = null;

  function setStatus(s, ok = true) {
    scanStatus.textContent = s;
    scanStatus.style.color = ok ? 'var(--accent)' : 'var(--warn)';
  }

  // --- 摄像头开启 ---
  async function startCamera(deviceId) {
    stopCamera();
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      camBtn.textContent = '关闭摄像头';
      setStatus('扫描中…');
      loop();
      // 枚举摄像头列表
      populateCameras();
    } catch (e) {
      setStatus('摄像头开启失败：' + e.message, false);
    }
  }
  function stopCamera() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
    camBtn.textContent = '开启摄像头';
    setStatus('未开启');
  }

  async function populateCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter((d) => d.kind === 'videoinput');
      camSel.innerHTML = '';
      cams.forEach((c, i) => {
        const opt = document.createElement('option');
        opt.value = c.deviceId;
        opt.textContent = c.label || ('摄像头 ' + (i + 1));
        camSel.appendChild(opt);
      });
    } catch (e) {}
  }

  camBtn.addEventListener('click', () => {
    if (stream) stopCamera();
    else startCamera(camSel.value || undefined);
  });
  camSel.addEventListener('change', () => {
    if (stream) startCamera(camSel.value);
  });

  // --- 主循环：抓帧 + 解码 ---
  let _busy = false;     // jsQR 同步执行，防 rAF 堆积
  let _attempts = 0;    // 解码尝试次数（诊断）
  let _okCount = 0;     // 成功解码次数（诊断）
  let _diagTimer = 0;   // 诊断刷新节流

  // 将图像数据转为灰度
  function toGray(src, w, h) {
    const n = w * h;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const g = (src[j] * 299 + src[j + 1] * 587 + src[j + 2] * 114) / 1000;
      out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
    }
    return out;
  }

  // 将单通道数据用 Otsu 自适应阈值二值化
  function thresholdChannel(src, w, h, chIdx) {
    const n = w * h;
    const gray = new Uint8ClampedArray(n);
    // 直方图
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = src[j + chIdx];
      gray[i] = v;
      hist[v]++;
    }
    // Otsu 阈值算法
    let sum = 0, sumB = 0, wB = 0, maxVar = 0, threshold = 128;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      const wF = n - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = i; }
    }
    // 二值化
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = gray[i] < threshold ? 0 : 255;
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    }
    return out;
  }

  // 尝试解码：返回 true 表示成功
  function tryDecode(data, w, h) {
    _attempts++;
    const code = jsQR(data, w, h, { inversionAttempts: 'attemptBoth' });
    if (code && code.binaryData && code.binaryData.length > 1) {
      const bytes = new Uint8Array(code.binaryData);
      const fr = P.parseFrame(bytes);
      if (fr) {
        _okCount++;
        handleBytes(bytes);
        return true;
      }
    }
    return false;
  }

  function loop() {
    if (!stream) return;
    if (!_busy && video.readyState >= 2 && !done) {
      _busy = true;
      const color = colorModeRecv.checked;
      const maxW = 1920;
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, maxW / Math.max(vw, vh)) || 1;
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      if (procCanvas.width !== w || procCanvas.height !== h) {
        procCanvas.width = w; procCanvas.height = h;
      }
      procCtx.drawImage(video, 0, 0, w, h);
      const img = procCtx.getImageData(0, 0, w, h);
      lastImgData = img;

      // 策略：先灰度化 BW 解码，失败后尝试 Otsu 二值化，最后多色通道
      let decoded = false;

      // 1. 灰度化 BW 解码（兼容 BW 发送端，让 jsQR 自己处理二值化）
      if (!decoded) {
        const gray = toGray(img.data, w, h);
        decoded = tryDecode(gray, w, h);
      }

      // 2. Otsu 二值化 BW 解码（抗光照不均）
      if (!decoded) {
        const bin = thresholdChannel(img.data, w, h, 0); // 用 R 通道做 BW 二值化
        // thresholdChannel 返回灰度二值图，可直接给 jsQR
        decoded = tryDecode(bin, w, h);
      }

      // 3. 如果用户勾选多色模式，尝试 R/G/B 通道
      if (color && !decoded) {
        for (let ch = 0; ch < 3 && !decoded; ch++) {
          const chData = thresholdChannel(img.data, w, h, ch);
          decoded = tryDecode(chData, w, h);
        }
      }

      _busy = false;

      // 调试画面：显示灰度化结果
      if (debugView.checked) {
        if (debugCanvas.hidden) debugCanvas.hidden = false;
        const gray = toGray(img.data, w, h);
        debugCanvas.width = w; debugCanvas.height = h;
        debugCtx.putImageData(new ImageData(gray, w, h), 0, 0);
      } else if (!debugCanvas.hidden) {
        debugCanvas.hidden = true;
      }

      // 诊断信息
      _diagTimer++;
      if (_diagTimer % 15 === 0 && !header) {
        setStatus(`扫描中 · 尝试 ${_attempts} · 解出 ${_okCount} · ${w}×${h}`);
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  // --- 处理一帧字节 ---
  function handleBytes(bytes) {
    const fr = P.parseFrame(bytes);
    if (!fr) return;
    if (fr.kind === 'header') {
      if (!header || header._partial) {
        // 首次收到完整头，或从“临时头”升级：若块数一致则保留已收数据
        const keepChunks = header && header._partial && header.totalFrames === fr.totalFrames;
        if (!keepChunks) resetState();
        header = fr;
        showFileCard();
        updateProgress();
        recvStats.textContent = `收到文件头：${fr.name} · ${fr.totalFrames} 块 · ${formatSize(fr.fileSize)}`;
        if (chunks.size >= header.totalFrames) finish();
      } else if (header.fileCrc !== fr.fileCrc || header.totalFrames !== fr.totalFrames) {
        // 文件变了，重置
        resetState();
        header = fr;
        showFileCard();
      }
      return;
    }
    if (fr.kind !== 'data') return;
    if (!header) {
      // 没有头也能暂存：用帧自带的 totalFrames
      header = { totalFrames: fr.totalFrames, fileSize: 0, chunkSize: 0, name: '', fileCrc: 0, _partial: true };
    }
    if (header._partial && header.totalFrames !== fr.totalFrames) {
      header.totalFrames = fr.totalFrames;
    }
    if (chunks.has(fr.frameIndex)) return;
    chunks.set(fr.frameIndex, new Uint8Array(fr.payload));
    totalDecoded++;
    lastSeenIdx = fr.frameIndex;
    updateProgress();
    recvStats.textContent = `已收 ${chunks.size}/${header.totalFrames} 块 · 累计解码 ${totalDecoded} · 最近块 #${fr.frameIndex}`;
    setStatus(`已收 ${chunks.size}/${header.totalFrames}`);
    if (!header._partial && chunks.size >= header.totalFrames) {
      finish();
    }
  }

  function showFileCard() {
    fileCard.hidden = false;
    fileName.textContent = header.name || '(未知)';
    fileSize.textContent = formatSize(header.fileSize);
    fileChunks.textContent = header.totalFrames;
    fileCrc.textContent = header.fileCrc ? '0x' + header.fileCrc.toString(16).padStart(8, '0') : '—';
  }

  function updateProgress() {
    const total = header ? header.totalFrames : 0;
    const got = chunks.size;
    const pct = total ? Math.min(100, (got / total) * 100) : 0;
    progFill.style.width = pct + '%';
    progText.textContent = `${got} / ${total}`;
  }

  async function finish() {
    if (done) return;
    done = true;
    let assembled;
    try {
      assembled = P.assembleFile(chunks, header.totalFrames, header.txSize || header.fileSize);
    } catch (e) {
      setStatus('重组失败：' + e.message, false);
      done = false;
      return;
    }
    const compressed = header.flags & P.FLAG_GZIP;
    const finalize = (rawBytes) => {
      if (header.fileSize && rawBytes.length !== header.fileSize) {
        setStatus(`大小不匹配！期望 ${header.fileSize} 实际 ${rawBytes.length}`, false);
        done = false;
        return;
      }
      const crc = P.crc32(rawBytes);
      if (header.fileCrc && crc !== header.fileCrc) {
        setStatus(`CRC 校验失败！期望 ${header.fileCrc.toString(16)} 实际 ${crc.toString(16)}`, false);
        done = false;
        return;
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      const blob = new Blob([rawBytes], { type: 'application/octet-stream' });
      blobUrl = URL.createObjectURL(blob);
      downloadBtn.disabled = false;
      setStatus('✓ 接收完成，可下载');
      recvStats.textContent += ` · CRC 校验通过`;
    };
    if (compressed) {
      setStatus('解压中…');
      try {
        const raw = await P.decompressGzip(assembled);
        finalize(raw);
      } catch (e) {
        setStatus('解压失败：' + e.message, false);
        done = false;
      }
    } else {
      finalize(assembled);
    }
  }

  downloadBtn.addEventListener('click', () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = header.name || ('received_' + Date.now());
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  function resetState() {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    header = null;
    chunks = new Map();
    totalDecoded = 0;
    done = false;
    lastSeenIdx = -1;
    _attempts = 0;
    _okCount = 0;
    downloadBtn.disabled = true;
    progFill.style.width = '0%';
    progText.textContent = '0 / 0';
    fileCard.hidden = true;
    recvStats.textContent = '等待文件头…';
    setStatus(stream ? '扫描中…' : '未开启');
  }
  resetBtn.addEventListener('click', resetState);

  // 保存当前帧用于离线分析
  saveFrameBtn.addEventListener('click', () => {
    if (!lastImgData) { setStatus('无帧可保存', false); return; }
    const cv = document.createElement('canvas');
    cv.width = lastImgData.width; cv.height = lastImgData.height;
    cv.getContext('2d').putImageData(lastImgData, 0, 0);
    cv.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `frame_${Date.now()}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('已保存当前帧，可发送给我分析');
    });
  });

  function formatSize(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // 切换 Tab 时不停止摄像头（保留以便来回看），但卸载时停止
  window.addEventListener('beforeunload', stopCamera);
})();
