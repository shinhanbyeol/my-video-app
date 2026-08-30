// 라이브러리의 모든 이미지/영상에 대해 그리드용 썸네일을 미리 생성해
// 캐시에 저장해두는 스크립트.
//
// 평소엔 그리드에 처음 스크롤되어 들어오는 시점에 그때그때 생성하지만
// (thumbnail.js의 ensureThumbnail), 빌드/배포 전에 미리 한 번 돌려두면
// 실제 사용 중에는 캐시된 작은 JPEG만 내려주면 되므로 목록이 항상 빠르게
// 뜬다. 로컬에서 혼자 쓰는 도구라 CDN/HTTP2 같은 인프라 없이도, 이 워밍
// 단계 하나로 "목록 로딩 체감 속도"의 대부분을 해결할 수 있다.
//
// 사용: node scripts/warm-thumbnail-cache.js  (backend 디렉터리 기준)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { ensureThumbnail } = require('../thumbnail');
const logger = require('../logger');

const videoFilePath = path.join(process.env.VIDEO_PATH);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const ZIP_EXTENSIONS = new Set(['zip']);
const getExtension = (filename) => path.extname(filename).slice(1).toLowerCase();

function getMediaKind(filename) {
  const ext = getExtension(filename);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ZIP_EXTENSIONS.has(ext)) return 'zip';
  return 'image';
}

// ffmpeg 프로세스를 한 번에 너무 많이 띄우면 CPU를 다 잡아먹으므로 동시
// 실행 개수를 제한한다. 썸네일 생성 자체는 가벼운 편이라 트랜스코딩보다는
// 넉넉하게 잡는다.
const CONCURRENCY = 4;

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
      logger.error('thumbnail-warm', `실패: "${items[i].name}" - ${error.message}`);
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
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const ext = getExtension(entry.name);
      return VIDEO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || ZIP_EXTENSIONS.has(ext);
    })
    .map((entry) => ({ name: entry.name, kind: getMediaKind(entry.name) }));

  if (targets.length === 0) {
    logger.info('thumbnail-warm', '썸네일을 생성할 이미지/영상 파일이 없습니다.');
    return;
  }

  logger.info(
    'thumbnail-warm',
    `${targets.length}개 파일 썸네일 생성 시작 (동시 ${CONCURRENCY}개씩 진행)`,
  );
  const startedAt = Date.now();
  let done = 0;

  const { succeeded, failed } = await runWithConcurrency(targets, CONCURRENCY, async (target) => {
    const filePath = path.join(videoFilePath, target.name);
    const stat = await fs.promises.stat(filePath);
    await ensureThumbnail(filePath, stat.mtimeMs, target.kind);
    done++;
    logger.info('thumbnail-warm', `진행 ${done}/${targets.length}: "${target.name}"`);
  });

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info('thumbnail-warm', `완료: 성공 ${succeeded}개, 실패 ${failed}개 (${durationSec}초)`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error('thumbnail-warm', `치명적 오류: ${error.message}`, error);
  process.exit(1);
});
