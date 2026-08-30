// <video>/<img> 로드·재생 실패를 사람이 읽을 수 있는 로그로 남기기 위한 유틸.
//
// 브라우저는 autoPlay 속성이 정책에 막히거나 코덱/컨테이너를 지원하지 않을 때
// 콘솔에 아무것도 남기지 않고 조용히 멈춘다. 여기서 명시적으로 play()의 실패
// 사유(Promise reject)와 <video>의 error 이벤트(MediaError)를 잡아 로그로
// 남겨야 "왜 재생이 안 되는지"를 구분할 수 있다.
const MEDIA_ERROR_MESSAGES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED (재생이 중단됨)',
  2: 'MEDIA_ERR_NETWORK (네트워크 오류로 로드 실패)',
  3: 'MEDIA_ERR_DECODE (디코딩 실패 - 파일 손상 가능성)',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED (코덱/컨테이너를 브라우저가 지원하지 않음)',
};

export function logVideoError(fileName: string, error: MediaError | null) {
  if (!error) return;
  const label = MEDIA_ERROR_MESSAGES[error.code] || `알 수 없는 에러 코드 ${error.code}`;
  console.error(`[video error] file="${fileName}" ${label} message="${error.message}"`);
}

export function logImageError(fileName: string) {
  console.error(`[image error] file="${fileName}" 이미지를 불러오지 못했습니다`);
}

export function logPlayRejection(fileName: string, error: unknown) {
  // 마우스를 빠르게 올렸다 떼는 것처럼 play() 직후 pause()가 호출되면
  // 브라우저가 "AbortError"로 재생 요청을 정상 취소한다. 실제 재생 실패가
  // 아니라 흔히 발생하는 정상적인 상호작용이므로 에러로 남기지 않는다.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return;
  }

  if (error instanceof DOMException) {
    console.error(
      `[video play error] file="${fileName}" name=${error.name} message="${error.message}"`,
    );
  } else {
    console.error(`[video play error] file="${fileName}"`, error);
  }
}
