import { useEffect, useRef, useState } from 'react';
import { IconPlayerPlay, IconPhoto } from '@tabler/icons-react';
import Style from './VideoItem.module.scss';
import { logImageError, logPlayRejection, logVideoError } from '../../utils/mediaError';

interface Props {
  videoName: string;
  url: string;
  // 그리드에 실제로 보여줄 작은 미리보기(백엔드가 미리 생성해 캐시해둔
  // JPEG). 원본 이미지/트랜스코딩된 영상(url)은 무겁기 때문에 그리드
  // 단계에서는 절대 직접 로드하지 않는다 — 풀뷰를 열거나(App.tsx) 영상
  // 항목을 호버할 때만 실제 url을 사용한다.
  thumbnailUrl: string;
  onOpen: (url: string) => void;
  // 화면에 실제로 뜬 뒤 진짜 가로세로 비율을 알게 되면 그리드 레이아웃
  // (VirtualizedMasonry)에 되돌려준다. 처음엔 추정치로 칸을 잡아두고,
  // 실측되면 그 값으로 다시 배치한다. 썸네일도 원본과 같은 비율로 생성되므로
  // (백엔드 thumbnail.js) 이 비율만으로 충분히 정확하다.
  onAspectRatio: (url: string, ratio: number) => void;
}

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi'];

function getExtension(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function VideoItem({ videoName, url, thumbnailUrl, onOpen, onAspectRatio }: Props) {
  const isVideo = VIDEO_EXTENSIONS.includes(getExtension(videoName));
  // zip은 이미지 여러 장을 담은 앨범 — 그리드에는 첫 장만 썸네일로 보여주고
  // (백엔드가 미리 만들어둔다), 풀뷰에서 좌우 화살표로 내부 이미지를 넘겨본다.
  const isZip = getExtension(videoName) === 'zip';
  const thumbnailSrc = `http://localhost:8080${thumbnailUrl}`;
  const fullSrc = `http://localhost:8080${url}`;
  const figureRef = useRef<HTMLElement>(null);
  const hoverVideoRef = useRef<HTMLVideoElement>(null);

  // 모든 항목이 항상 DOM에 있는 상태(content-visibility)에서 src를 무조건
  // 걸어두면, 화면 밖 수십~수백 개가 한꺼번에 네트워크 요청을 쏴서 브라우저
  // 커넥션 풀에 줄을 서게 된다. <img loading="lazy">는 네이티브 처리되지만,
  // 화면 근처에 들어올 때만 썸네일을 실제로 걸도록 직접 관찰한다.
  const [isNearViewport, setNearViewport] = useState(false);
  // 실제로 보여줄 준비가 됐는지(썸네일 디코딩 완료). 이게 true가 되기
  // 전까지는 빈 칸 대신 스켈레톤을 보여줘서, 로드되는 동안 화면이 뜬금없이
  // 팝인하는 느낌이 아니라 자연스럽게 이어지게 한다.
  const [isMediaReady, setMediaReady] = useState(false);
  // 화면에 실제로 들어와 있는지 — 스크롤로 들어오고 나갈 때마다 부드럽게
  // 페이드 인/아웃 시키기 위한 상태. 위의 로딩용 observer와 달리 한 번
  // 감지하고 끝나는 게 아니라 계속 관찰한다.
  const [isVisible, setVisible] = useState(false);
  // 영상 항목 위에 마우스를 올리고 있는 동안에만 실제 영상을 잠깐 재생해
  // 미리보기로 보여준다. 이 상태가 true인 동안만 <video>를 마운트한다.
  const [isHovering, setHovering] = useState(false);

  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;

    const loadObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setNearViewport(true);
          loadObserver.disconnect(); // 한 번 로드되면 계속 유지 — 다시 관찰할 필요 없음
        }
      },
      { rootMargin: '600px 0px' }, // 화면에 닿기 전에 미리 로드 시작
    );
    loadObserver.observe(el);
    return () => loadObserver.disconnect();
  }, []);

  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;

    const visibilityObserver = new IntersectionObserver((entries) => {
      setVisible(entries[0]?.isIntersecting ?? false);
    });
    visibilityObserver.observe(el);
    return () => visibilityObserver.disconnect();
  }, []);

  // 호버 미리보기를 끌 때 호출한다. React가 <video>를 그냥 언마운트만
  // 시키면 브라우저가 진행 중이던 버퍼링(네트워크 요청)을 자동으로 취소해
  // 주지 않는다 — 그리드를 스크롤하며 마우스가 여러 썸네일을 스쳐 지나가기만
  // 해도 요청이 계속 쌓여 브라우저의 오리진당 동시 연결 한도(보통 6개)를
  // 채워버리고, 그 뒤로는 어떤 영상/썸네일도 로드되지 않는 문제로 이어진다.
  // pause 후 src를 명시적으로 비우고 load()를 호출해, 언마운트되기 전에
  // 그 자리에서 요청을 즉시 abort한다.
  const stopHoverPreview = () => {
    const video = hoverVideoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    setHovering(false);
  };

  // 컴포넌트가 사라질 때(스크롤로 리스트가 바뀌는 경우 등)도 호버 중이던
  // 미리보기가 있다면 정리한다.
  useEffect(() => () => stopHoverPreview(), []);

  return (
    <figure
      ref={figureRef}
      className={`${Style.VideoItem} ${isVisible ? Style.Visible : ''}`}
      onClick={() => onOpen(url)}
      onMouseEnter={() => {
        if (isVideo) setHovering(true);
      }}
      onMouseLeave={() => {
        if (isVideo) stopHoverPreview();
      }}
    >
      {!isMediaReady && <div className={Style.Skeleton} aria-hidden="true" />}
      <img
        src={isNearViewport ? thumbnailSrc : undefined}
        className={isMediaReady ? Style.Ready : undefined}
        alt={videoName}
        loading="lazy"
        decoding="async"
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          if (naturalWidth && naturalHeight) {
            onAspectRatio(url, naturalHeight / naturalWidth);
          }
          setMediaReady(true);
        }}
        onError={() => logImageError(videoName)}
      />
      {isVideo && (
        <span className={Style.PlayBadge} aria-hidden="true">
          <IconPlayerPlay size={14} strokeWidth={2.4} />
        </span>
      )}
      {isZip && (
        <span className={Style.PlayBadge} aria-hidden="true">
          <IconPhoto size={14} strokeWidth={2.4} />
        </span>
      )}
      {isVideo && isHovering && (
        <video
          ref={hoverVideoRef}
          className={Style.HoverPreview}
          src={fullSrc}
          muted
          loop
          playsInline
          autoPlay
          onCanPlay={(e) => {
            e.currentTarget.play().catch((error) => logPlayRejection(videoName, error));
          }}
          onError={(e) => logVideoError(videoName, e.currentTarget.error)}
        />
      )}
      <figcaption className={Style.Caption}>{videoName}</figcaption>
    </figure>
  );
}

export default VideoItem;
