// 그리드(매소너리)에 쓸 작은 썸네일을 생성해 캐시해두는 모듈.
//
// 지금까지는 그리드 썸네일조차 이미지 원본(수백 KB~1MB)이나 트랜스코딩된
// 영상 원본(수십 MB)을 그대로 내려보내고 있었다 — 화면에는 200~300px짜리
// 작은 셀로 표시될 뿐인데 필요한 것보다 훨씬 큰 데이터를 매번 받는 구조였고,
// 이게 "목록 로딩이 느리다"의 가장 큰 원인이었다. 여기서 폭 480px 정도의
// 작은 JPEG 썸네일을 만들어 캐시해두고, 그리드는 항상 이 썸네일만 쓰도록
// 한다(원본/전체 영상은 풀뷰에서 열 때만 요청됨).
//
// ffmpeg는 이미지 리사이즈도 그대로 처리할 수 있어서(비디오 트랜스코딩에
// 이미 쓰고 있는 것과 동일한 바이너리), sharp 같은 별도 네이티브 의존성을
// 추가하지 않고 이미지/영상 썸네일을 같은 방식으로 만든다.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const logger = require('./logger');
const { getFirstImageEntry } = require('./zip');

const CACHE_DIR = path.join(__dirname, 'thumbnail-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const THUMBNAIL_WIDTH = 480;

const inFlight = new Map();

function getCachePath(sourcePath, mtimeMs) {
  const key = crypto
    .createHash('md5')
    .update(`thumb:${sourcePath}:${mtimeMs}:${THUMBNAIL_WIDTH}`)
    .digest('hex');
  return path.join(CACHE_DIR, `${key}.jpg`);
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg(${label}) exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

// 가로/세로 어느 쪽이 더 크든 긴 변을 THUMBNAIL_WIDTH로 맞추고 비율은 유지한다.
// (세로로 긴 사진/영상이 많은 라이브러리라 가로 기준으로만 scale하면 세로가
// 과도하게 커질 수 있어, 가로세로 중 큰 쪽을 기준으로 맞춘다.)
const SCALE_FILTER = `scale='if(gt(iw,ih),${THUMBNAIL_WIDTH},-2)':'if(gt(iw,ih),-2,${THUMBNAIL_WIDTH})'`;

// 확장 WebP(애니메이션)는 RIFF 컨테이너 안에 VP8X + ANIM + ANMF(프레임들)
// 청크로 구성되는데, ffmpeg에 내장된 webp 디코더는 정지 WebP(단순 포맷)만
// 읽을 수 있고 이 애니메이션 구조는 디코딩하지 못한다("skipping unsupported
// chunk: ANIM/ANMF" 후 디코딩 실패) — libwebp 인코더는 있어도 디코더가
// 없는 오래된 ffmpeg 제약이다(https://trac.ffmpeg.org/ticket/4907).
// sharp 같은 별도 네이티브 의존성을 추가하는 대신, 첫 프레임의 압축
// 이미지 데이터(VP8/VP8L 청크)만 컨테이너에서 직접 꺼내 단순 포맷 WebP로
// 재포장해서 ffmpeg에 넘긴다. 정지 WebP는 애초에 ANMF가 없으므로 그대로
// 원본 경로를 타고, 그 외 포맷(jpg/png/gif 등)은 이 함수가 호출되지 않는다.
function extractFirstAnimatedWebpFrame(buffer) {
  try {
    if (
      buffer.length < 12 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return null;
    }

    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const fourCC = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkStart + chunkSize > buffer.length) return null;

      if (fourCC === 'ANMF') {
        // ANMF 프레임 헤더는 16바이트 고정이고, 그 뒤에 그 프레임의 이미지
        // 청크(선택적 ALPH + VP8 또는 VP8L)가 온다. 알파는 무시해도
        // 된다 — 어차피 최종 출력은 알파가 없는 JPEG다.
        let subOffset = chunkStart + 16;
        const subEnd = chunkStart + chunkSize;
        while (subOffset + 8 <= subEnd) {
          const subFourCC = buffer.toString('ascii', subOffset, subOffset + 4);
          const subSize = buffer.readUInt32LE(subOffset + 4);
          const subStart = subOffset + 8;
          if (subFourCC === 'VP8 ' || subFourCC === 'VP8L') {
            return buildSimpleWebp(subFourCC, buffer.subarray(subStart, subStart + subSize));
          }
          subOffset = subStart + subSize + (subSize % 2);
        }
        return null; // ANMF는 찾았는데 그 안에 이미지 청크가 없음(손상된 파일)
      }

      offset = chunkStart + chunkSize + (chunkSize % 2);
    }
    return null; // ANMF가 없음 = 애니메이션이 아닌 정지 WebP
  } catch (error) {
    return null; // 파싱 중 어떤 문제든 생기면 원본 경로로 폴백(기존 동작 유지)
  }
}

// RIFF/WEBP + 이미지 청크 하나만 담은 "단순 포맷" WebP를 만든다. ffmpeg의
// webp 디코더는 이 포맷은 문제없이 읽는다.
function buildSimpleWebp(fourCC, payload) {
  const pad = payload.length % 2;
  const out = Buffer.alloc(20 + payload.length + pad);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(12 + payload.length + pad, 4);
  out.write('WEBP', 8, 'ascii');
  out.write(fourCC, 12, 'ascii');
  out.writeUInt32LE(payload.length, 16);
  payload.copy(out, 20);
  return out;
}

async function generateImageThumbnail(sourcePath, tmpPath) {
  let ffmpegInputPath = sourcePath;
  let extractedFramePath = null;

  if (path.extname(sourcePath).toLowerCase() === '.webp') {
    const buffer = await fs.promises.readFile(sourcePath);
    const firstFrame = extractFirstAnimatedWebpFrame(buffer);
    if (firstFrame) {
      extractedFramePath = tmpPath.replace(/\.jpg$/, `.frame0-${process.pid}.webp`);
      await fs.promises.writeFile(extractedFramePath, firstFrame);
      ffmpegInputPath = extractedFramePath;
    }
  }

  try {
    await runFfmpeg(
      ['-y', '-i', ffmpegInputPath, '-frames:v', '1', '-vf', SCALE_FILTER, '-q:v', '4', tmpPath],
      'thumb-image',
    );
  } finally {
    if (extractedFramePath) {
      await fs.promises.unlink(extractedFramePath).catch(() => {});
    }
  }
}

async function generateVideoThumbnail(sourcePath, tmpPath) {
  // 1초 지점 프레임을 우선 시도한다 — 영상 시작 부분은 종종 암전/전환
  // 효과라 대표 프레임으로 부적절한 경우가 많다. 1초보다 짧은 영상이면
  // ffmpeg가 프레임을 못 찾고 실패하므로, 그 경우 0초 지점으로 재시도한다.
  try {
    await runFfmpeg(
      ['-y', '-ss', '00:00:01', '-i', sourcePath, '-frames:v', '1', '-vf', SCALE_FILTER, '-q:v', '4', tmpPath],
      'thumb-video@1s',
    );
  } catch (error) {
    await runFfmpeg(
      ['-y', '-i', sourcePath, '-frames:v', '1', '-vf', SCALE_FILTER, '-q:v', '4', tmpPath],
      'thumb-video@0s',
    );
  }
}

// zip은 이미지 파일들을 담은 컨테이너라 직접 리사이즈할 수 없다 — 첫 이미지
// 항목을 꺼내 임시 파일로 풀어둔 뒤, 이미지 썸네일 생성과 동일한 경로를 탄다.
async function generateZipThumbnail(sourcePath, tmpPath) {
  const first = getFirstImageEntry(sourcePath);
  if (!first) {
    throw new Error('zip 안에 이미지가 없음');
  }
  const ext = path.extname(first.entryName) || '.jpg';
  const extractedTmpPath = tmpPath.replace(/\.jpg$/, `.src-${process.pid}${ext}`);
  await fs.promises.writeFile(extractedTmpPath, first.buffer);
  try {
    await generateImageThumbnail(extractedTmpPath, tmpPath);
  } finally {
    await fs.promises.unlink(extractedTmpPath).catch(() => {});
  }
}

async function ensureThumbnail(sourcePath, mtimeMs, kind) {
  const outputPath = getCachePath(sourcePath, mtimeMs);

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  if (inFlight.has(outputPath)) {
    return inFlight.get(outputPath);
  }

  const job = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmpPath = outputPath.replace(/\.jpg$/, `.tmp-${process.pid}.jpg`);
    const label = path.basename(sourcePath);
    const startedAt = Date.now();

    if (kind === 'video') {
      await generateVideoThumbnail(sourcePath, tmpPath);
    } else if (kind === 'zip') {
      await generateZipThumbnail(sourcePath, tmpPath);
    } else {
      await generateImageThumbnail(sourcePath, tmpPath);
    }

    await fs.promises.rename(tmpPath, outputPath);
    logger.info('thumbnail', `생성 완료 (${Date.now() - startedAt}ms): "${label}"`);
    return outputPath;
  })().finally(() => inFlight.delete(outputPath));

  inFlight.set(outputPath, job);
  return job;
}

module.exports = { ensureThumbnail, CACHE_DIR };
