// mkv/avi/mov처럼 브라우저 <video> 태그가 "컨테이너" 자체를 지원하지 않는
// 파일을 웹 호환 mp4(h264+aac)로 변환해 캐시해두는 모듈.
//
// 전략:
//   1) 먼저 컨테이너만 mp4로 바꾸는 "리먹스"(-c copy)를 시도한다. 코덱을
//      다시 인코딩하지 않고 그대로 mp4 박스에 담기만 하는 거라 화질 손실이
//      없고 몇 초 안에 끝난다. 원본 안에 이미 h264/aac가 들어있는 경우
//      (흔하다)는 이것만으로 충분히 재생 가능해진다.
//   2) 리먹스가 실패하면(코덱 자체가 브라우저 비호환인 경우) 실제 재인코딩
//      (libx264/aac)으로 폴백한다. 더 오래 걸리지만 항상 재생 가능한 mp4를
//      보장한다.
// 결과는 원본 경로+수정시각 기반 캐시 키로 저장해, 같은 파일을 다시 요청하면
// 재변환 없이 캐시된 mp4를 그대로 돌려준다. 원본이 바뀌면(mtime 변경) 캐시
// 키도 자동으로 바뀐다.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const logger = require('./logger');

const CACHE_DIR = path.join(__dirname, 'transcode-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// 같은 파일에 여러 요청(예: 메타데이터 프리로드 + 실제 재생)이 거의 동시에
// 들어와도 ffmpeg를 중복 실행하지 않도록, 진행 중인 변환의 Promise를 공유한다.
const inFlight = new Map();

function getCachePath(sourcePath, mtimeMs) {
  const key = crypto.createHash('md5').update(`${sourcePath}:${mtimeMs}`).digest('hex');
  return path.join(CACHE_DIR, `${key}.mp4`);
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

async function transcodeOnce(sourcePath, outputPath) {
  // 캐시 디렉터리가 실행 중 지워지는 등 예기치 못하게 사라진 경우를 대비해
  // 매 변환 직전에 다시 만들어둔다(존재하면 아무 일도 하지 않으므로 비용은
  // 무시할 만하다).
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // ffmpeg는 출력 파일의 확장자로 포맷(muxer)을 추론하므로, 임시 파일명도
  // 반드시 .mp4로 끝나야 한다.
  const tmpPath = outputPath.replace(/\.mp4$/, `.tmp-${process.pid}.mp4`);
  const startedAt = Date.now();
  const label = path.basename(sourcePath);

  try {
    await runFfmpeg(
      ['-y', '-i', sourcePath, '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', tmpPath],
      'remux',
    );
    logger.info('transcode', `리먹스 성공 (${Date.now() - startedAt}ms): "${label}"`);
  } catch (remuxError) {
    logger.warn('transcode', `리먹스 실패, 재인코딩으로 폴백: "${label}" (${remuxError.message})`);
    await runFfmpeg(
      [
        '-y', '-i', sourcePath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        tmpPath,
      ],
      're-encode',
    );
    logger.info('transcode', `재인코딩 성공 (${Date.now() - startedAt}ms): "${label}"`);
  }

  await fs.promises.rename(tmpPath, outputPath);
}

// 브라우저가 컨테이너 자체를 지원하지 않는 확장자 목록. (webm/mp4는 대부분의
// 경우 그대로 재생되므로 변환 없이 기존 경로로 서빙한다.)
const CONTAINERS_NEEDING_TRANSCODE = new Set(['mkv', 'avi', 'mov']);

const getExtension = (filename) => path.extname(filename).slice(1).toLowerCase();

function needsTranscode(extension) {
  return CONTAINERS_NEEDING_TRANSCODE.has(extension);
}

async function ensureTranscoded(sourcePath, mtimeMs) {
  const outputPath = getCachePath(sourcePath, mtimeMs);

  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  if (inFlight.has(outputPath)) {
    return inFlight.get(outputPath);
  }

  const job = transcodeOnce(sourcePath, outputPath)
    .then(() => outputPath)
    .finally(() => inFlight.delete(outputPath));

  inFlight.set(outputPath, job);
  return job;
}

module.exports = { ensureTranscoded, needsTranscode, getExtension, CACHE_DIR };
