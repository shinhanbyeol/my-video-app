// 표준화된 로그 포맷 유틸리티
//
// 형식: <ISO-8601 타임스탬프> [LEVEL] [tag] message
// - 타임스탬프: ISO 8601(RFC 3339) — 로그 수집기/grep에서 시간순 정렬이 쉬움
// - LEVEL: syslog 계열에서 흔히 쓰는 ERROR > WARN > INFO > DEBUG 4단계
// - tag: 로그가 발생한 영역(예: http, video-stream, media-list)을 짧게 표기
//
// LOG_LEVEL 환경변수(기본 INFO)로 출력 레벨을 조절할 수 있다.
const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function write(level, tag, message, meta) {
  if (LEVELS[level] > currentLevel) return;

  const line = `${new Date().toISOString()} [${level}] [${tag}] ${message}`;
  const consoleMethod =
    level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;

  if (meta !== undefined) {
    consoleMethod(line, meta);
  } else {
    consoleMethod(line);
  }
}

module.exports = {
  error: (tag, message, meta) => write('ERROR', tag, message, meta),
  warn: (tag, message, meta) => write('WARN', tag, message, meta),
  info: (tag, message, meta) => write('INFO', tag, message, meta),
  debug: (tag, message, meta) => write('DEBUG', tag, message, meta),
};
