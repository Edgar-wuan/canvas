// 传输协议：定义帧格式、分块、CRC32 校验、字节与二进制字符串互转
// 帧格式（大端序）：
//   公共头: magic[2]='TX' + type[1]
//   HEADER 帧 (type=0):
//     magic[2] + type[1] + version[1] + flags[1] + totalFrames[2] + fileSize[4]
//     + txSize[4] + chunkSize[2] + nameLen[1] + name[N] + fileCrc[4] + frameCrc[4]
//     flags bit0=gzip压缩, bit1=color模式(0=BW/1=多色), bit2-3=文件名编码(0=UTF-8,1=GBK); fileSize=原始大小, txSize=传输字节大小
//   DATA 帧 (type=1):
//     magic[2] + type[1] + frameIndex[2] + totalFrames[2]
//     + payloadLen[2] + payload[N] + frameCrc[4]
// 每帧尾部 frameCrc 为对本帧（除 frameCrc 外）所有字节的 CRC32。

const MAGIC = 0x5458; // 'T','X'
const TYPE_HEADER = 0;
const TYPE_DATA = 1;
const PROTOCOL_VERSION = 4;
const FLAG_GZIP = 0x01;
const FLAG_COLOR = 0x02;       // bit1: 0=黑白, 1=多色
const FLAG_TEXTENC_MASK = 0x0C; // bit2-3: 文件名编码
const TEXT_ENC_UTF8 = 0;        // 00 UTF-8
const TEXT_ENC_GBK = 1;         // 01 GBK/GB18030

// --- CRC32（IEEE 802.3 多项式）---
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = _crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- 字节 <-> 二进制字符串（每字符码点 0-255），用于 QR 字节模式编解码 ---
function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// --- gzip 压缩/解压（浏览器原生 CompressionStream，纯前端）---
async function compressGzip(bytes) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function decompressGzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// --- 文件分块 ---
function chunkFile(fileBytes, chunkSize) {
  const chunks = [];
  for (let i = 0; i < fileBytes.length; i += chunkSize) {
    chunks.push(fileBytes.subarray(i, Math.min(i + chunkSize, fileBytes.length)));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0)); // 空文件至少 1 块
  return chunks;
}

// --- 帧打包 ---
function packHeader({ version, flags = 0, textEncoding = TEXT_ENC_UTF8, totalFrames, fileSize, txSize, chunkSize, name, fileCrc }) {
  let nameBytes;
  if (name) {
    if (textEncoding === TEXT_ENC_GBK) {
      // GBK 编码需要 TextEncoder polyfill，浏览器不原生支持，兜底用 UTF-8
      try {
        nameBytes = new Uint8Array(new TextEncoder('gbk').encode(name));
      } catch {
        nameBytes = new TextEncoder().encode(name);
        textEncoding = TEXT_ENC_UTF8;
      }
    } else {
      nameBytes = new TextEncoder().encode(name);
      textEncoding = TEXT_ENC_UTF8;
    }
  } else {
    nameBytes = new Uint8Array(0);
  }
  if (nameBytes.length > 255) throw new Error('文件名过长');
  // 把文件名编码写入 flags bit2-3
  const finalFlags = (flags & 0xf3) | ((textEncoding & 0x03) << 2);
  const bodyLen = 2 + 1 + 1 + 1 + 2 + 4 + 4 + 2 + 1 + nameBytes.length + 4;
  const buf = new Uint8Array(bodyLen + 4);
  const dv = new DataView(buf.buffer);
  let p = 0;
  dv.setUint16(p, MAGIC); p += 2;
  dv.setUint8(p, TYPE_HEADER); p += 1;
  dv.setUint8(p, version); p += 1;
  dv.setUint8(p, finalFlags); p += 1;
  dv.setUint16(p, totalFrames); p += 2;
  dv.setUint32(p, fileSize); p += 4;
  dv.setUint32(p, txSize); p += 4;
  dv.setUint16(p, chunkSize); p += 2;
  dv.setUint8(p, nameBytes.length); p += 1;
  buf.set(nameBytes, p); p += nameBytes.length;
  dv.setUint32(p, fileCrc); p += 4;
  const crc = crc32(buf, 0, p);
  dv.setUint32(p, crc); p += 4;
  return buf.slice(0, p);
}

function packData({ frameIndex, totalFrames, payload }) {
  const bodyLen = 2 + 1 + 2 + 2 + 2 + payload.length + 4;
  const buf = new Uint8Array(bodyLen + 4);
  const dv = new DataView(buf.buffer);
  let p = 0;
  dv.setUint16(p, MAGIC); p += 2;
  dv.setUint8(p, TYPE_DATA); p += 1;
  dv.setUint16(p, frameIndex); p += 2;
  dv.setUint16(p, totalFrames); p += 2;
  dv.setUint16(p, payload.length); p += 2;
  buf.set(payload, p); p += payload.length;
  const crc = crc32(buf, 0, p);
  dv.setUint32(p, crc); p += 4;
  return buf.slice(0, p);
}

// --- 帧解析（返回 {kind, ...} 或 null 表示校验失败/非本协议帧）---
function parseFrame(bytes) {
  if (!bytes || bytes.length < 7) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== MAGIC) return null;
  const type = dv.getUint8(2);
  // 校验尾部 CRC
  const crcOff = bytes.length - 4;
  if (crcOff < 3) return null;
  const want = dv.getUint32(crcOff);
  const got = crc32(bytes, 0, crcOff);
  if (want !== got) return null;

  if (type === TYPE_HEADER) {
    let p = 3;
    const version = dv.getUint8(p); p += 1;
    const flags = dv.getUint8(p); p += 1;
    const textEncoding = (flags >> 2) & 0x03;
    const totalFrames = dv.getUint16(p); p += 2;
    const fileSize = dv.getUint32(p); p += 4;
    const txSize = dv.getUint32(p); p += 4;
    const chunkSize = dv.getUint16(p); p += 2;
    const nameLen = dv.getUint8(p); p += 1;
    let name;
    try {
      const encLabel = textEncoding === TEXT_ENC_GBK ? 'gbk' : 'utf-8';
      name = new TextDecoder(encLabel).decode(bytes.subarray(p, p + nameLen));
    } catch {
      name = new TextDecoder().decode(bytes.subarray(p, p + nameLen));
    }
    p += nameLen;
    const fileCrc = dv.getUint32(p); p += 4;
    return { kind: 'header', version, flags, textEncoding, totalFrames, fileSize, txSize, chunkSize, name, fileCrc };
  }
  if (type === TYPE_DATA) {
    let p = 3;
    const frameIndex = dv.getUint16(p); p += 2;
    const totalFrames = dv.getUint16(p); p += 2;
    const payloadLen = dv.getUint16(p); p += 2;
    const payload = bytes.subarray(p, p + payloadLen);
    p += payloadLen;
    return { kind: 'data', frameIndex, totalFrames, payload };
  }
  return null;
}

// --- 重组：从已收数据帧（按 frameIndex）还原传输字节 ---
function assembleFile(chunksMap, totalFrames, txSize) {
  const out = new Uint8Array(txSize);
  let off = 0;
  for (let i = 0; i < totalFrames; i++) {
    const c = chunksMap.get(i);
    if (!c) throw new Error(`缺失第 ${i} 块`);
    out.set(c, off);
    off += c.length;
  }
  return out.slice(0, txSize);
}

window.AirProtocol = {
  MAGIC, TYPE_HEADER, TYPE_DATA, PROTOCOL_VERSION, FLAG_GZIP, FLAG_COLOR, FLAG_TEXTENC_MASK, TEXT_ENC_UTF8, TEXT_ENC_GBK,
  crc32, bytesToBinaryString, binaryStringToBytes,
  compressGzip, decompressGzip,
  chunkFile, packHeader, packData, parseFrame, assembleFile,
};
