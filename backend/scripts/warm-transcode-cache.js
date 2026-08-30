// mkv/avi/mov 파일들을 전부 미리 mp4로 변환해 캐시에 저장해두는 스크립트.
//
// 평소엔 브라우저가 처음 그 파일을 재생 요청하는 시점에 그때그때 변환하지만
// (transcode.js의 ensureTranscoded), 빌드/배포 과정에 미리 한 번 돌려두면
// 실제 사용자가 처음 눌렀을 때 변환 대기 없이 바로 재생된다.
//
// 사용: node scripts/warm-transcode-cache.js  (backend 디렉터리 기준)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { ensureTranscoded, needsTranscode, getExtension } = require('../transcode');
const logger = require('../logger');

const videoFilePath = path.join(process.env.VIDEO_PATH);

// 한 번에 너무 많은 ffmpeg 프로세스를 동시에 띄우면 CPU를 다 잡아먹으므로
// 동시 실행 개수를 제한한다. 리먹스는 가볍지만 재인코딩 폴백은 무거우니
// 보수적으로 잡는다.
const CONCURRENCY = 2;

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  let succeeded = 0;
  let failed = 0;

  async function runNext() {
    const i = index++;
    if (i >= items.length) return;
    try {
      await worker(items[i], i, items.length);
      succeeded++;
    } catch (error) {
      failed++;
      logger.error('transcode-warm', `실패: "${items[i]}" - ${error.message}`);
    }
    await runNext();
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return { succeeded, failed };
}

async function main() {
  const entries = await fs.promises.readdir(videoFilePath, { withFileTypes: true });
  const targets = entries
    .filter((entry) => entry.isFile() && needsTranscode(getExtension(entry.name)))
    .map((entry) => entry.name);

  if (targets.length === 0) {
    logger.info('transcode-warm', '변환이 필요한(mkv/avi/mov) 파일이 없습니다.');
    return;
  }

  logger.info(
    'transcode-warm',
    `${targets.length}개 파일 사전 변환 시작 (동시 ${CONCURRENCY}개씩 진행)`,
  );
  const startedAt = Date.now();
  let done = 0;

  const { succeeded, failed } = await runWithConcurrency(targets, CONCURRENCY, async (name) => {
    const filePath = path.join(videoFilePath, name);
    const stat = await fs.promises.stat(filePath);
    await ensureTranscoded(filePath, stat.mtimeMs);
    done++;
    logger.info('transcode-warm', `진행 ${done}/${targets.length}: "${name}"`);
  });

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info('transcode-warm', `완료: 성공 ${succeeded}개, 실패 ${failed}개 (${durationSec}초)`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error('transcode-warm', `치명적 오류: ${error.message}`, error);
  process.exit(1);
});
