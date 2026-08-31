// zip 파일 내부의 이미지 목록을 열람하고 개별 이미지를 꺼내기 위한 모듈.
//
// adm-zip은 zip 파일 전체를 메모리에 올려 중앙 디렉터리를 파싱하고, 각
// entry.getData()는 요청한 항목만 그때그때 압축 해제한다 — 풀뷰에서 좌우
// 화살표로 이미지를 한 장씩 넘길 때마다 zip 전체를 다시 읽지 않도록, 최근에
// 연 zip 몇 개는 (경로+mtime 키로) 메모리에 캐시해둔다.
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { getExtension } = require('./transcode');

const IMAGE_ENTRY_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

function isImageEntryName(entryName) {
  const base = path.basename(entryName);
  // macOS가 압축할 때 넣는 리소스 포크(._로 시작)/메타데이터 폴더는 실제
  // 볼 수 있는 이미지가 아니므로 목록에서 제외한다.
  if (base.startsWith('.') || entryName.startsWith('__MACOSX/')) return false;
  return IMAGE_ENTRY_EXTENSIONS.has(getExtension(entryName));
}

// 자연 정렬(숫자를 문자열이 아닌 수치로 비교) — "2.jpg"가 "10.jpg"보다 앞에
// 오도록 해서 파일탐색기에서 보이는 순서와 좌우 화살표로 넘기는 순서가
// 일치하게 한다.
function compareEntryNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// AdmZip에 경로를 그대로 넘기면 내부적으로 fs.readFileSync(path)로 전체
// 파일을 읽는데, Node의 readFileSync/readFile은 2GiB(2^31-1바이트)를 넘는
// 파일에 대해 "File size (N) is greater than 2 GiB"라는 하드 리밋 에러를
// 던진다 — Buffer 자체의 한계가 아니라 readFileSync 구현에 박힌 안전장치일
// 뿐이다(buffer.constants.MAX_LENGTH는 이보다 훨씬 크다). 사진/영상을 잔뜩
// 담은 앨범 zip은 2GiB를 쉽게 넘기므로, fs.readSync로 직접 청크 단위로 읽어
// Buffer를 만들어 그 리밋을 우회한 뒤 AdmZip에는 경로 대신 Buffer로 넘긴다.
function readFileNoSizeLimit(filePath) {
  const { size } = fs.statSync(filePath);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK_SIZE = 64 * 1024 * 1024;
    let readTotal = 0;
    while (readTotal < size) {
      const toRead = Math.min(CHUNK_SIZE, size - readTotal);
      const bytesRead = fs.readSync(fd, buffer, readTotal, toRead, readTotal);
      if (bytesRead === 0) break; // 파일이 stat 시점보다 짧아진 경우 방어
      readTotal += bytesRead;
    }
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

const ZIP_CACHE_LIMIT = 3;
const zipCache = new Map(); // key: `${zipPath}:${mtimeMs}` -> { entries: AdmZip.IZipEntry[] }

function getCachedZip(zipPath, mtimeMs) {
  const key = `${zipPath}:${mtimeMs}`;
  const cached = zipCache.get(key);
  if (cached) {
    // LRU: 최근 사용으로 갱신(Map은 삽입 순서를 유지하므로 재삽입으로 표현)
    zipCache.delete(key);
    zipCache.set(key, cached);
    return cached;
  }

  const zip = new AdmZip(readFileNoSizeLimit(zipPath));
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && isImageEntryName(entry.entryName))
    .sort((a, b) => compareEntryNames(a.entryName, b.entryName));

  const value = { entries };
  zipCache.set(key, value);
  if (zipCache.size > ZIP_CACHE_LIMIT) {
    const oldestKey = zipCache.keys().next().value;
    zipCache.delete(oldestKey);
  }
  return value;
}

function listImageEntryNames(zipPath, mtimeMs) {
  return getCachedZip(zipPath, mtimeMs).entries.map((entry) => entry.entryName);
}

function getImageEntryBuffer(zipPath, mtimeMs, index) {
  const { entries } = getCachedZip(zipPath, mtimeMs);
  const entry = entries[index];
  if (!entry) return null;
  return entry.getData();
}

// 썸네일 생성용 — zip의 첫 이미지 항목을 꺼낸다.
function getFirstImageEntry(zipPath) {
  const mtimeMs = fs.statSync(zipPath).mtimeMs;
  const { entries } = getCachedZip(zipPath, mtimeMs);
  if (entries.length === 0) return null;
  const entry = entries[0];
  return { entryName: entry.entryName, buffer: entry.getData() };
}

module.exports = { listImageEntryNames, getImageEntryBuffer, getFirstImageEntry };
