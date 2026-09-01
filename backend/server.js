// video api server
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const dotenv = require('dotenv');
const morgan = require('morgan');
const logger = require('./logger');
const { ensureTranscoded, needsTranscode, getExtension } = require('./transcode');
const { ensureThumbnail } = require('./thumbnail');
const { listImageEntryNames, getImageEntryBuffer } = require('./zip');

dotenv.config();
let app = express();

// 위에서 놓친 예외가 있더라도 "로그 한 줄 없이 조용히 죽는" 일은 없도록
// 하는 마지막 안전망. (실제 원인은 스트림 에러 리스너 누락이었고 이미
// 아래에서 별도로 처리했지만, 예상 못한 다른 에러를 위해 남겨둔다.)
// 다만 uncaughtException 이후에는 프로세스 상태를 신뢰할 수 없으므로,
// 로그만 남기고 계속 떠 있게 두지 않고 명확히 종료한다. (재시작은
// nodemon/pm2 등 프로세스 매니저에 맡기거나 수동으로 재실행)
process.on('uncaughtException', (error) => {
  logger.error('process', `uncaughtException, 서버를 종료합니다: ${error.message}`, error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', reason);
});

// cors 설정
const corsOptions = {
  origin: '*',
}

const videoFilePath = path.join(process.env.VIDEO_PATH);

// ---- HTTP 접근 로그 --------------------------------------------------------
// morgan은 Express에서 가장 널리 쓰이는 표준 HTTP 요청 로깅 미들웨어다.
// (Apache Combined Log Format을 참고한 포맷 + 응답시간까지 함께 남긴다.)
// 이걸 붙이기 전까지는 API가 호출됐는지, 얼마나 걸렸는지 콘솔에 아무 흔적도
// 없었다 — "동영상 로드가 느리다"를 진단하려 해도 어디서 시간이 드는지
// 볼 방법이 없었던 이유.
morgan.token('date-iso', () => new Date().toISOString());
const HTTP_LOG_FORMAT =
  ':date-iso [INFO] [http] :method :url :status :res[content-length]b :response-time ms';
app.use(morgan(HTTP_LOG_FORMAT));

// 비디오 / 이미지 확장자별 MIME 타입 매핑
const VIDEO_MIME_TYPES = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

const IMAGE_MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

// zip: 이미지 여러 장을 담은 앨범으로 취급한다 — 그리드에는 첫 장을
// 썸네일로 보여주고(thumbnail.js), 풀뷰에서는 좌우 화살표로 내부 이미지를
// 넘겨볼 수 있다(아래 /api/v1/zip/* 라우트).
const ZIP_MIME_TYPES = {
  zip: 'application/zip',
};

const getMimeType = (filename) => {
  const ext = getExtension(filename);
  return VIDEO_MIME_TYPES[ext] || IMAGE_MIME_TYPES[ext] || ZIP_MIME_TYPES[ext] || null;
};
const isImageFile = (filename) => Boolean(IMAGE_MIME_TYPES[getExtension(filename)]);
const isZipFile = (filename) => getExtension(filename) === 'zip';

// 썸네일 생성 전략은 세 갈래(영상 대표 프레임 캡처 / 이미지 리사이즈 / zip
// 내부 첫 이미지 추출 후 리사이즈)로 나뉘므로, 어느 쪽인지 한 번에 판별한다.
const getMediaKind = (filename) => {
  if (VIDEO_MIME_TYPES[getExtension(filename)]) return 'video';
  if (isZipFile(filename)) return 'zip';
  return 'image';
};

// 응답 시간이 이 이상 걸리면(스트리밍 시작까지, 혹은 스트리밍 자체가) 뭔가
// 비정상적으로 느린 것으로 보고 WARN을 남긴다. 기본은 INFO만 남기던 것과
// 달리, "로딩이 느리다"는 증상이 실제로 서버 쪽에서도 관측 가능해야 다음에
// 같은 문제가 생겼을 때 프론트/백엔드 어느 쪽 문제인지 로그만 보고 바로
// 판단할 수 있다.
const SLOW_REQUEST_MS = 3000;

// 오리진당 동시 연결 한도(브라우저 기준 보통 6개)에 근접했는지 서버 쪽에서도
// 알 수 있도록 진행 중인 영상/이미지 스트리밍 요청 수를 추적한다.
let activeStreamCount = 0;
const HIGH_CONCURRENCY_WATERMARK = 5;

// 파일을 읽어 응답으로 스트리밍한다. fs.createReadStream이 내는 'error'
// 이벤트에 리스너가 없으면 Node가 그 에러를 던져서(uncaught exception)
// 프로세스 전체가 죽어버리고, 그마저도 콘솔에 원인이 안 남는 경우가 있었다.
// 여기서 에러를 잡아 로그를 남기고, 응답은 정상적으로 끊어준다.
// 더불어 실제 전송에 걸린 시간/처리량을 로그로 남겨 "영상 로딩이 느리다"를
// 진단할 수 있게 한다(서버 처리 자체가 느린지, 파일이 유독 느린지 등).
function streamFile(req, res, filePath, streamOptions) {
  const stream = fs.createReadStream(filePath, streamOptions);
  const startedAt = process.hrtime.bigint();
  let bytesSent = 0;

  activeStreamCount += 1;
  if (activeStreamCount >= HIGH_CONCURRENCY_WATERMARK) {
    logger.warn(
      'video-stream',
      `동시 스트리밍 요청 ${activeStreamCount}건 — 브라우저의 오리진당 동시 연결 한도(보통 6개)에 근접함. ` +
        `프론트에서 이전 영상 요청이 제대로 abort되지 않고 쌓이고 있을 가능성이 있음.`,
    );
  }

  stream.on('data', (chunk) => {
    bytesSent += chunk.length;
  });

  stream.on('error', (error) => {
    logger.error(
      'video-stream',
      `file="${filePath}" code=${error.code || 'UNKNOWN'} message=${error.message}`,
    );
    if (!res.headersSent) {
      res.status(500).send({ error: 'file read error' });
    } else {
      // 이미 응답 헤더/일부 바디를 보낸 상태라면 연결만 정리한다.
      res.destroy(error);
    }
  });

  stream.on('close', () => {
    activeStreamCount -= 1;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const throughputMBs = durationMs > 0 ? bytesSent / 1024 / 1024 / (durationMs / 1000) : 0;
    const aborted = !res.writableEnded;
    const label = aborted ? 'video-stream(중단됨)' : 'video-stream';
    const log = aborted || durationMs >= SLOW_REQUEST_MS ? logger.warn : logger.info;
    log(
      label,
      `file="${path.basename(filePath)}" bytes=${bytesSent} duration=${durationMs.toFixed(1)}ms throughput=${throughputMBs.toFixed(1)}MB/s`,
    );
  });

  // 클라이언트가 영상을 넘기거나 창을 닫아 연결을 먼저 끊는 경우, 응답이
  // 끝나지 않았다면 파일 스트림을 정리해 열린 핸들이 쌓이지 않게 한다.
  //
  // 주의: req(요청)의 'close'가 아니라 res(응답)의 'close'를 봐야 한다.
  // req.on('close')는 (특히 keep-alive 연결에서) 응답을 아직 다 보내지도
  // 않았는데 조기에 발생할 수 있어서, 그걸로 스트림을 destroy하면 정상
  // 전송 중이던 파일이 중간에 잘려버린다. 브라우저는 이걸 디코딩 에러/
  // 지원하지 않는 형식(MEDIA_ERR_SRC_NOT_SUPPORTED)처럼 보고하는데,
  // 실제로는 응답이 도중에 끊긴 것이라 "간헐적으로만" 재현된다.
  // res.writableEnded로 "이미 정상 종료된 응답인지"를 확인해, 진짜 클라이언트가
  // 먼저 끊은 경우에만 스트림을 정리한다.
  res.on('close', () => {
    if (!res.writableEnded && !stream.destroyed) {
      stream.destroy();
    }
  });

  stream.pipe(res);
  return stream;
}

// ---- 미디어 목록 캐시 -----------------------------------------------------
// 매 요청마다 디렉토리 전체를 동기 스캔(+파일별 stat)하면 파일이 많을수록
// 이벤트 루프를 오래 점유해 동시 요청(그리드의 여러 썸네일/영상 로딩) 처리가
// 느려진다. 디렉토리의 mtime이 바뀌었을 때만 다시 스캔하도록 캐시한다.
let mediaListCache = {
  dirMtimeMs: 0,
  // { name, birthtimeMs }[]. 정렬/필터 순서는 요청마다 다를 수 있으므로
  // (type/sort 쿼리) 여기서는 정렬하지 않은 채로 캐시해두고, 각 요청에서
  // 필요한 순서로 다시 정렬한다.
  files: [],
};

async function getMediaFiles() {
  const dirStat = await fs.promises.stat(videoFilePath);

  if (dirStat.mtimeMs === mediaListCache.dirMtimeMs) {
    return mediaListCache.files;
  }

  // withFileTypes를 쓰면 각 항목의 파일/디렉토리 여부를 readdir 결과에서
  // 바로 알 수 있어, 파일 필터링 자체에는 항목별 stat 호출이 필요 없다.
  const entries = await fs.promises.readdir(videoFilePath, { withFileTypes: true });
  const mediaEntries = entries.filter((entry) => entry.isFile() && getMimeType(entry.name));

  // 생성일자 순 정렬을 위해서는 각 파일의 birthtime이 필요해 파일별 stat이
  // 다시 필요하다. 동기 호출 대신 Promise.all로 병렬 조회해 이벤트 루프
  // 점유를 최소화한다. (디렉토리가 바뀌지 않는 한 이 결과는 캐시되므로,
  // 페이지를 넘길 때마다 매번 다시 계산하지는 않는다.)
  const files = await Promise.all(
    mediaEntries.map(async (entry) => {
      const stat = await fs.promises.stat(path.join(videoFilePath, entry.name));
      return { name: entry.name, birthtimeMs: stat.birthtimeMs };
    }),
  );

  mediaListCache = {
    dirMtimeMs: dirStat.mtimeMs,
    files,
  };
  logger.info('media-list', `디렉토리 재스캔: ${files.length}개 파일`);
  return files;
}

// build path setting
app.use(express.static(path.join(__dirname, '/build')));
// public path setting
app.use('/', express.static(__dirname + '/public', { maxAge: '1d' }));

// get Videoes  api
app.get('/api/v1/videoes', cors(corsOptions), async function (req, res) {
  let files;
  try {
    files = await getMediaFiles();
  } catch (error) {
    logger.error('media-list', `조회 실패: ${error.message}`, error);
    return res.status(500).send({ error: 'server error' });
  }

  // pagination
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;

  // 타입 필터: image/video만 유효한 값으로 받고, 그 외(또는 미지정)는 전체.
  // zip은 이미지 여러 장을 담은 앨범으로 취급하므로(getMediaKind) 'image'
  // 필터에 함께 포함시킨다.
  const typeFilter = req.query.type === 'video' || req.query.type === 'image' ? req.query.type : 'all';
  // 정렬: 파일 생성일자(birthtime) 기준. 기본값은 기존 동작과 같은 최신순(desc).
  const sortOrder = req.query.sort === 'asc' ? 'asc' : 'desc';

  const filteredFiles =
    typeFilter === 'all'
      ? files
      : files.filter((file) => {
          const kind = getMediaKind(file.name);
          return typeFilter === 'video' ? kind === 'video' : kind !== 'video';
        });

  const sortedFiles = [...filteredFiles].sort((a, b) =>
    sortOrder === 'asc' ? a.birthtimeMs - b.birthtimeMs : b.birthtimeMs - a.birthtimeMs,
  );

  const fileNames = sortedFiles.map((file) => file.name);

  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;

  if (startIndex >= fileNames.length) {
    return res.status(404).send({
      error: 'No more videos available',
    });
  }
  const paginatedFileNames = fileNames.slice(startIndex, endIndex);
  if (paginatedFileNames.length === 0) {
    return res.status(404).send({
      error: 'No videos found for the requested page',
    });
  }

  const videoList = paginatedFileNames.map((filename) => {
    const encodedFilename = encodeURIComponent(filename);
    return {
      name: filename,
      url: `/api/v1/video/${encodedFilename}`,
      thumbnailUrl: `/api/v1/thumbnail/${encodedFilename}`,
    };
  });

  res.send({
    videos: videoList,
    totalVideos: fileNames.length,
    currentPage: page,
    totalPages: Math.ceil(fileNames.length / pageSize),
  });
});

// get Thumbnail api — 그리드용 작은 미리보기 이미지. 이미지든 영상이든 항상
// 작은 JPEG 한 장으로 응답한다(영상은 대표 프레임 캡처). 원본/전체 영상은
// 풀뷰를 열 때만 /api/v1/video/:filename 으로 별도 요청된다.
app.use('/api/v1/thumbnail/:filename', cors(corsOptions), async function (req, res) {
  const mediaName = decodeURI(req.params.filename);
  const mediaPath = path.join(videoFilePath, mediaName);
  const mimeType = getMimeType(mediaName);

  if (!mimeType) {
    return res.status(415).send({ error: 'unsupported file type' });
  }

  try {
    const originalStat = await fs.promises.stat(mediaPath).catch(() => null);
    if (!originalStat || !originalStat.isFile()) {
      logger.warn('thumbnail-route', `파일 없음: "${mediaName}"`);
      return res.status(404).send({ error: 'file not found' });
    }

    const thumbPath = await ensureThumbnail(mediaPath, originalStat.mtimeMs, getMediaKind(mediaName));
    const thumbStat = await fs.promises.stat(thumbPath);

    const etag = `W/"${thumbStat.size}-${thumbStat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // 원본이 바뀌지 않는 한(캐시 키가 mtime 기반) 썸네일은 절대 바뀌지
    // 않으므로 아주 길게, immutable로 캐시해도 안전하다.
    res.writeHead(200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'Content-Type': 'image/jpeg',
      'Content-Length': thumbStat.size,
    });
    streamFile(req, res, thumbPath);
  } catch (error) {
    logger.error('thumbnail-route', `file="${mediaName}" message=${error.message}`, error);
    if (!res.headersSent) {
      res.status(500).send({ error: 'server error' });
    }
  }
});

//get Video/Image api
app.use('/api/v1/video/:filename', cors(corsOptions), async function (req, res) {
  const videoName = decodeURI(req.params.filename);

  // 파일네임에 # 이 들어가는경우 버그 처리

  // 클라이언트가 응답을 받기 전에 연결을 끊는 경우(풀뷰를 빠르게 열었다
  // 닫는 식의 사용 패턴에서 흔함) 추적해둔다. 특히 트랜스코딩(mkv/avi/mov
  // → mp4)은 완료까지 몇 초~몇십 초가 걸리는데, 그 사이 클라이언트가 이미
  // 나가버린 요청에 res.writeHead를 시도하면 이미 닫힌 소켓에 쓰기
  // 에러가 나고 그 에러를 처리하려는 catch 블록에서 또 res.status(...)를
  // 시도하며 로그만 낭비하게 된다. transcode 자체(공유 캐시 생성 작업)는
  // 계속 진행해 다음 요청이 캐시를 재사용할 수 있게 두되, 이미 떠난
  // 클라이언트에게 응답을 쓰려는 시도는 건너뛴다.
  const requestStartedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - requestStartedAt) / 1e6;

  let clientAborted = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true;
      logger.warn(
        'video-route',
        `클라이언트가 응답 전에 연결을 끊음: file="${videoName}" elapsed=${elapsedMs().toFixed(1)}ms`,
      );
    }
  });

  const videoPath = path.join(videoFilePath, videoName);
  const mimeType = getMimeType(videoName);

  if (!mimeType) {
    logger.warn('video-route', `지원하지 않는 확장자 요청: "${videoName}"`);
    return res.status(415).send({
      error: "unsupported file type",
    });
  }

  try {
    // existsSync + statSync 두 번 호출하던 것을 stat 한 번으로 통합하고,
    // 동기 호출 대신 비동기 호출로 바꿔 다른 요청의 이벤트 루프 점유를 막는다.
    const originalStat = await fs.promises.stat(videoPath).catch(() => null);
    if (!originalStat || !originalStat.isFile()) {
      logger.warn('video-route', `파일 없음: "${videoName}"`);
      return res.status(404).send({
        error: "file not found",
      });
    }

    // mkv/avi/mov는 코덱이 뭐든 브라우저 <video>가 컨테이너 자체를 재생하지
    // 못하는 경우가 많다(MEDIA_ERR_SRC_NOT_SUPPORTED). 웹 호환 mp4로
    // 변환해서 캐시해두고 그 결과를 대신 서빙한다. (mp4/webm은 대부분
    // 그대로 재생되므로 변환 없이 원본을 바로 서빙한다.)
    let servePath = videoPath;
    let serveMimeType = mimeType;
    let serveStat = originalStat;

    if (needsTranscode(getExtension(videoName))) {
      try {
        servePath = await ensureTranscoded(videoPath, originalStat.mtimeMs);
        serveMimeType = 'video/mp4';
        serveStat = await fs.promises.stat(servePath);
      } catch (transcodeError) {
        logger.error(
          'transcode',
          `변환 실패: file="${videoName}" message=${transcodeError.message}`,
        );
        if (!clientAborted) {
          return res.status(500).send({ error: 'transcode failed' });
        }
        return;
      }
    }

    // 트랜스코딩 등으로 대기하는 동안 클라이언트가 이미 연결을 끊었다면,
    // 변환 결과(캐시)는 그대로 두고 응답 전송만 조용히 생략한다. (연결이
    // 끊긴 시점의 WARN은 위 req.on('close')에서 이미 남겼다.)
    if (clientAborted) {
      return;
    }

    if (elapsedMs() >= SLOW_REQUEST_MS) {
      logger.warn(
        'video-route',
        `응답 준비까지 오래 걸림: file="${videoName}" elapsed=${elapsedMs().toFixed(1)}ms` +
          (needsTranscode(getExtension(videoName)) ? ' (트랜스코딩 대기)' : ''),
      );
    }

    const fileSize = serveStat.size;
    const etag = `W/"${fileSize}-${serveStat.mtimeMs}"`;
    const lastModified = serveStat.mtime.toUTCString();

    // 같은 파일을 다시 요청하는 경우(재방문, 목록 재조회 등) 재전송을 생략해
    // 대역폭과 서버 부하를 아낀다.
    if (req.headers['if-none-match'] === etag) {
      logger.debug('video-route', `304 캐시 히트: "${videoName}"`);
      return res.status(304).end();
    }

    const cacheHeaders = {
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
      'Last-Modified': lastModified,
    };

    // 이미지는 range 스트리밍 없이 파일 전체를 그대로 응답
    if (isImageFile(videoName)) {
      res.writeHead(200, {
        ...cacheHeaders,
        "Content-Length": fileSize,
        "Content-Type": serveMimeType,
      });
      streamFile(req, res, servePath);
      return;
    }

    // 비디오: Range 헤더가 없으면 전체 파일을 응답
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        ...cacheHeaders,
        "Accept-Ranges": "bytes",
        "Content-Length": fileSize,
        "Content-Type": serveMimeType,
      });
      streamFile(req, res, servePath);
      return;
    }

    // Range 헤더를 정확히 파싱한다. 끝 지점이 명시되지 않으면(가장 흔한
    // "bytes=1234-" 형태) 임의로 1MB만 잘라 보내지 않고 파일 끝까지 보내
    // 재생 중 불필요한 재요청(왕복)이 반복되지 않도록 한다.
    const rangeMatch = /bytes=(\d*)-(\d*)/.exec(range);
    const start = rangeMatch && rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
    const end = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;
    const clampedEnd = Math.min(end, fileSize - 1);

    if (Number.isNaN(start) || start > clampedEnd || start >= fileSize) {
      logger.warn('video-route', `잘못된 range 요청: "${videoName}" range=${range}`);
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
      });
      return res.end();
    }

    const contentLength = clampedEnd - start + 1;
    res.writeHead(206, {
      ...cacheHeaders,
      "Content-Range": `bytes ${start}-${clampedEnd}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": serveMimeType,
    });
    streamFile(req, res, servePath, { start, end: clampedEnd });
  } catch (error) {
    logger.error('video-route', `file="${videoName}" message=${error.message}`, error);
    if (!res.headersSent) {
      res.status(500).send({
        error: "server error"
      });
    }
  }
});

// zip 내부 이미지 개수 조회 — 풀뷰를 열 때 좌우 화살표로 넘길 수 있는
// 범위(0 ~ count-1)를 프론트가 알아야 하므로 별도로 제공한다. 목록 API
// (/api/v1/videoes)에서 매 페이지마다 모든 zip을 열어보는 비용을 피하려고,
// 실제로 zip을 풀뷰로 열 때만 조회한다.
app.get('/api/v1/zip/:filename/entries', cors(corsOptions), async function (req, res) {
  const zipName = decodeURI(req.params.filename);
  if (!isZipFile(zipName)) {
    return res.status(415).send({ error: 'unsupported file type' });
  }

  const zipPath = path.join(videoFilePath, zipName);
  try {
    const stat = await fs.promises.stat(zipPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      logger.warn('zip-entries', `파일 없음: "${zipName}"`);
      return res.status(404).send({ error: 'file not found' });
    }
    const names = listImageEntryNames(zipPath, stat.mtimeMs);
    res.send({ count: names.length });
  } catch (error) {
    logger.error('zip-entries', `file="${zipName}" message=${error.message}`, error);
    if (!res.headersSent) {
      res.status(500).send({ error: 'server error' });
    }
  }
});

// zip 내부 index번째 이미지 원본 서빙 — 풀뷰의 좌우 화살표 탐색이 이 라우트를
// index만 바꿔가며 반복 호출한다.
app.get('/api/v1/zip/:filename/image/:index', cors(corsOptions), async function (req, res) {
  const zipName = decodeURI(req.params.filename);
  const index = parseInt(req.params.index, 10);

  if (!isZipFile(zipName)) {
    return res.status(415).send({ error: 'unsupported file type' });
  }

  const zipPath = path.join(videoFilePath, zipName);
  try {
    const stat = await fs.promises.stat(zipPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      logger.warn('zip-image', `파일 없음: "${zipName}"`);
      return res.status(404).send({ error: 'file not found' });
    }

    const names = listImageEntryNames(zipPath, stat.mtimeMs);
    if (!Number.isInteger(index) || index < 0 || index >= names.length) {
      return res.status(404).send({ error: 'image index out of range' });
    }

    const entryName = names[index];
    // zip이 바뀌면(mtime 변경) 같은 index라도 다른 이미지일 수 있으므로
    // ETag에 mtime을 반드시 포함한다.
    const etag = `W/"${stat.mtimeMs}-${index}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    const buffer = getImageEntryBuffer(zipPath, stat.mtimeMs, index);
    if (!buffer) {
      return res.status(404).send({ error: 'entry not found' });
    }

    const mimeType = IMAGE_MIME_TYPES[getExtension(entryName)] || 'application/octet-stream';
    res.writeHead(200, {
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
      'Content-Type': mimeType,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  } catch (error) {
    logger.error('zip-image', `file="${zipName}" index=${index} message=${error.message}`, error);
    if (!res.headersSent) {
      res.status(500).send({ error: 'server error' });
    }
  }
});

// express 에러 핸들링 미들웨어 (라우트에서 next(err)로 넘어오는 에러의 안전망)
app.use((error, req, res, next) => {
  logger.error('express', `path=${req.path} message=${error.message}`, error);
  if (!res.headersSent) {
    res.status(500).send({ error: 'server error' });
  }
});

// ---- 백그라운드 캐시 워밍 ----------------------------------------------------
// 캐시(썸네일/트랜스코딩)는 원본 파일의 mtime을 키로 디스크에 저장되므로
// 서버를 껐다 켜도 그대로 남아있다 — 하지만 "이번에 처음 보는 파일"은
// 여전히 그 순간에 생성해야 한다. 로컬에서 개인이 켰다 껐다 하며 쓰는
// 도구라 매번 수동으로 `pnpm run warm`을 돌리길 기대할 수 없으므로, 서버가
// 뜰 때마다 자동으로 (아직 캐시되지 않은 파일만) 백그라운드에서 준비해둔다.
// 이미 캐시된 파일은 ensureThumbnail/ensureTranscoded가 즉시 스킵하므로,
// 재기동마다 반복해도 비용이 거의 없다. 동시성을 낮게 잡아 사용자가 그
// 사이 직접 요청하는 것과 CPU를 심하게 다투지 않게 한다.
const WARM_CONCURRENCY = 3;

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function next() {
    const i = index++;
    if (i >= items.length) return;
    await worker(items[i]).catch(() => {}); // 개별 실패는 각 함수 내부에서 로그
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

async function warmCachesInBackground() {
  let fileNames;
  try {
    fileNames = (await getMediaFiles()).map((file) => file.name);
  } catch (error) {
    logger.error('cache-warm', `파일 목록 조회 실패: ${error.message}`);
    return;
  }

  const transcodeTargets = fileNames.filter((name) => needsTranscode(getExtension(name)));
  const thumbnailTargets = fileNames; // 이미지 + 영상 전부

  logger.info(
    'cache-warm',
    `백그라운드 캐시 준비 시작 — 트랜스코딩 대상 ${transcodeTargets.length}개, 썸네일 대상 ${thumbnailTargets.length}개 (이미 캐시된 파일은 스킵됨)`,
  );
  const startedAt = Date.now();

  await runWithConcurrency(transcodeTargets, WARM_CONCURRENCY, async (name) => {
    const filePath = path.join(videoFilePath, name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) return;
    await ensureTranscoded(filePath, stat.mtimeMs).catch((error) => {
      logger.warn('cache-warm', `트랜스코딩 워밍 실패: "${name}" - ${error.message}`);
    });
  });

  await runWithConcurrency(thumbnailTargets, WARM_CONCURRENCY, async (name) => {
    const filePath = path.join(videoFilePath, name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat) return;
    await ensureThumbnail(filePath, stat.mtimeMs, getMediaKind(name)).catch((error) => {
      logger.warn('cache-warm', `썸네일 워밍 실패: "${name}" - ${error.message}`);
    });
  });

  logger.info('cache-warm', `백그라운드 캐시 준비 완료 (${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
}

// api path setting
const port = process.env.PORT || 8080;
const host = 'localhost';

// server start
app.listen(port, host, () => {
  logger.info('server', `server is running on http://${host}:${port}`);
  warmCachesInBackground();
});
