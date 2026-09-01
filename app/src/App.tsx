import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Group, Menu, SegmentedControl, Slider, Text } from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconGridDots,
  IconLayoutGrid,
  IconMaximize,
  IconMinimize,
  IconPlayerPause,
  IconPlayerPlay,
  IconSortAscending,
  IconSortDescending,
  IconVolume,
  IconVolume2,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import './App.css';
import {
  DEFAULT_PAGE_SIZE,
  MediaTypeFilter,
  SortOrder,
  videoSetter,
} from './state/videoSetter';
import Style from './App.module.scss';
import VirtualizedMasonry, {
  DEFAULT_TARGET_ITEM_WIDTH,
  MediaItem,
} from './components/VirtualizedMasonry/VirtualizedMasonry';
import { logImageError, logPlayRejection, logVideoError } from './utils/mediaError';

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi'];
// zip: 이미지 여러 장을 담은 앨범으로 취급한다. 그리드에는 첫 장만 썸네일로
// 보여주고, 풀뷰에서는 좌우 화살표로 내부 이미지를 한 장씩 넘겨본다.
const ZIP_EXTENSIONS = ['zip'];

function getExtension(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

// /api/v1/video/:filename 형태의 url을 zip 내부 이미지 API 기준
// 경로(/api/v1/zip/:filename)로 바꾼다. 목록 API가 모든 미디어에 같은
// 모양의 url을 내려주므로, zip 항목의 식별자(파일명)를 새로 인코딩하지 않고
// 그대로 재사용할 수 있다.
function toZipBaseUrl(url: string) {
  return url.replace('/api/v1/video/', '/api/v1/zip/');
}

// 커스텀 플레이어의 시간 표시(0:00, 1:02:03 형식)용 포맷터.
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedSecs = String(secs).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSecs}`;
  }
  return `${minutes}:${paddedSecs}`;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
// 좌우 화살표 키 한 번에 앞/뒤로 이동하는 초 단위 간격.
const SEEK_STEP_SECONDS = 5;

// ── 그리드 크기 조절 ─────────────────────────────────────────────────────
// 슬라이더로 "카드 하나의 목표 너비"를 조절한다 — 값이 작을수록 카드가
// 작아지고 한 화면에 더 많은 열이 들어간다(구글 포토 방식).
const MIN_GRID_ITEM_WIDTH = 160;
const MAX_GRID_ITEM_WIDTH = 420;
const GRID_ITEM_WIDTH_STORAGE_KEY = 'my-video-app:grid-item-width';

function loadStoredGridItemWidth(): number {
  try {
    const raw = window.localStorage.getItem(GRID_ITEM_WIDTH_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_GRID_ITEM_WIDTH, Math.max(MIN_GRID_ITEM_WIDTH, parsed));
    }
  } catch {
    // localStorage를 못 쓰는 환경(프라이빗 모드 등)이면 그냥 기본값을 쓴다.
  }
  return DEFAULT_TARGET_ITEM_WIDTH;
}

// 그리드 열 수에 맞춰 한 번에 몇 개를 불러올지(pageSize) 계산한다. 열이
// 많을수록(카드가 작을수록) 한 번에 채워야 할 개수가 많아지므로 열 수에
// 비례시키되, 요청이 너무 잦거나(너무 작음) 너무 무거워지지(너무 큼)
// 않도록 위아래로 clamp한다.
const ROWS_PER_PAGE = 3;
const MIN_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 48;

function computePageSize(columnCount: number): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, columnCount * ROWS_PER_PAGE));
}

function App() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [totalVideos, setTotalVideos] = useState(0);

  // ── 타입 필터 / 정렬 ─────────────────────────────────────────────────
  // 'all'은 이미지/영상 구분 없이 전체를 보여준다. 정렬은 파일 생성일자
  // 기준이며 'desc'(최신순)가 기존 기본 동작이다. 둘 다 서버에 쿼리로
  // 전달되어 페이지네이션 전에 필터/정렬이 적용된다.
  const [mediaType, setMediaType] = useState<MediaTypeFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // 그리드 카드 목표 너비 — 슬라이더가 즉시 바꾸는 "시각적" 값. 그리드
  // 재배치(VirtualizedMasonry)에는 곧바로 반영돼 드래그하는 동안에도
  // 부드럽게 카드 크기가 바뀐다. 새로고침해도 유지되도록 localStorage에서
  // 초기값을 읽는다.
  const [gridItemWidth, setGridItemWidth] = useState(loadStoredGridItemWidth);
  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_ITEM_WIDTH_STORAGE_KEY, String(gridItemWidth));
    } catch {
      // 무시 — 다음에 다시 시도한다.
    }
  }, [gridItemWidth]);

  // VirtualizedMasonry가 실제로 계산한 열 수. 컨테이너 너비(반응형)와
  // gridItemWidth(슬라이더) 둘 다에 따라 바뀐다 — 이 값으로 아래에서
  // pageSize(한 페이지당 개수)를 결정한다.
  const [columnCount, setColumnCount] = useState(0);
  const handleColumnCountChange = useCallback((columns: number) => {
    setColumnCount(columns);
  }, []);

  // 실제로 요청에 실어 보내는 페이지 크기. 그리드 열 수가 바뀌어도 이미
  // 불러온 페이지들과 앞으로 부를 페이지 번호 계산(handleMenuPrev/Next의
  // (targetPage - 1) * pageSize)이 어긋나지 않으려면, pageSize가 바뀔 때
  // 기존에 불러온 항목을 전부 비우고 1페이지부터 새 pageSize로 다시
  // 불러와야 한다 — 아래 effect가 그 리셋을 담당한다.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // 열 수가 바뀔 때마다 곧바로 리셋하면, 창 크기를 드래그하거나 슬라이더를
  // 움직이는 동안 열이 오갈 때마다 목록이 계속 초기화돼 버린다. 잠깐
  // 멈췄을 때만(디바운스) 실제로 다시 불러오도록 한다.
  const prevColumnCountRef = useRef(0);
  const pageSizeResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (columnCount <= 0 || columnCount === prevColumnCountRef.current) return;
    prevColumnCountRef.current = columnCount;

    if (pageSizeResetTimerRef.current) clearTimeout(pageSizeResetTimerRef.current);
    pageSizeResetTimerRef.current = setTimeout(() => {
      const nextPageSize = computePageSize(columnCount);
      setPageSize((prev) => {
        if (prev === nextPageSize) return prev;
        loadedPagesRef.current.clear();
        setItems([]);
        setTotalPages(0);
        setTotalVideos(0);
        setPage(1);
        return nextPageSize;
      });
    }, 400);

    return () => {
      if (pageSizeResetTimerRef.current) clearTimeout(pageSizeResetTimerRef.current);
    };
  }, [columnCount]);

  const [fullViewe, setFullView] = useState<string | false>(false);
  // 지금 풀뷰로 열려 있는 항목이 zip인지 — 렌더/키보드 핸들러 여러 곳에서
  // 반복해서 필요하므로 fullViewe로부터 매 렌더 계산한다.
  const isZipView = fullViewe ? ZIP_EXTENSIONS.includes(getExtension(fullViewe)) : false;
  const fullViewVideoRef = useRef<HTMLVideoElement | null>(null);
  // 실제로 화면에 그려지는 미디어 요소(video 또는 img) — 줌 원점을 계산할 때
  // 이 요소의 실측 크기/위치(getBoundingClientRect)가 필요하다. video/img는
  // object-fit 없이 max-width/max-height로 비율을 유지하며 렌더링되므로,
  // 감싸는 컨테이너가 아니라 이 요소 자체의 rect를 기준으로 삼아야 커서
  // 위치가 정확히 들어맞는다.
  const mediaElRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  // 풀뷰 전체(오버레이) 컨테이너 — 여기에 non-passive wheel 리스너를 직접
  // 붙여서, ctrl/cmd+휠(트랙패드 핀치 포함)일 때 브라우저 기본 페이지 줌을
  // preventDefault로 막을 수 있게 한다. React의 onWheel prop은 내부적으로
  // passive 리스너로 등록돼 preventDefault가 씹힌다.
  const fullContainerRef = useRef<HTMLDivElement>(null);

  // 풀뷰 UI 크롬(상단 제목 바 + 하단 플레이어 컨트롤 바)을 보여줄지 여부.
  // 화면(영상/이미지 영역)을 클릭할 때마다 함께 켜고 끈다 — 맥 동영상
  // 플레이어처럼 화면을 가리지 않게 숨겼다가 다시 보고 싶을 때 클릭으로
  // 불러올 수 있게 하기 위함.
  const [showFullChrome, setShowFullChrome] = useState(true);
  // 트랙패드/마우스 휠 한 번의 "제스처"가 여러 wheel 이벤트를 연달아 쏘기
  // 때문에, 이동 직후 잠깐 동안은 추가 이벤트를 무시해 한 번 스크롤에 여러
  // 페이지를 건너뛰지 않도록 한다.
  const wheelLockRef = useRef(false);

  // 풀뷰 확대(줌) 상태. scale은 1(원본 크기)~4배, originX/Y는 확대의 기준점
  // (transform-origin, %)이다 — 마우스 포인터가 있던 위치를 기준점으로 잡아
  // "커서를 향해" 확대/축소되게 한다.
  const [zoom, setZoom] = useState({ scale: 1, originX: 50, originY: 50 });

  // ── zip 풀뷰 상태 ────────────────────────────────────────────────────
  // 지금 보고 있는 zip 안에서 몇 번째 이미지인지(0-based), 그리고 그 zip
  // 안에 이미지가 총 몇 장인지. 개수는 zip을 열 때 서버에 물어봐야 알 수
  // 있으므로(목록 API는 매번 모든 zip을 열어보지 않는다) 비동기로 채워진다.
  const [zipImageIndex, setZipImageIndex] = useState(0);
  const [zipImageCount, setZipImageCount] = useState(0);

  // ── 커스텀 비디오 플레이어 상태 ──────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 진행 바(진행률 트랙) DOM — 클릭/드래그 위치를 시간으로 환산할 때 필요.
  const progressTrackRef = useRef<HTMLDivElement>(null);
  // 진행 바를 드래그하는 중인지. pointer capture로 트랙 밖으로 나가도
  // 계속 추적하지만, "드래그 중" 여부는 별도로 기억해야 한다.
  const isSeekingRef = useRef(false);
  // 영상 + 컨트롤 바를 함께 감싸는 컨테이너 — 전체화면 진입 대상. video
  // 요소만 전체화면으로 만들면 우리 커스텀 컨트롤 바(video의 형제 요소)가
  // 전체화면 안에 같이 들어가지 못하므로, 그 부모 컨테이너를 대상으로 한다.
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  // 볼륨/음소거/재생속도는 영상이 바뀌어도 사용자가 맞춰둔 값을 유지하고
  // 싶은 "선호 설정"이다. 하지만 이 값을 새로 마운트되는 <video> 요소에
  // 적용하는 effect는 fullViewe가 바뀔 때만 실행돼야 하며, 볼륨을 조절할
  // 때마다(같은 영상을 보는 중에) 다시 실행되면 안 된다(video.play()를
  // 매번 다시 호출해 재생을 방해한다). 그래서 반응형 state가 아니라 ref에
  // 최신값을 담아두고 effect 안에서 그 시점의 값을 읽기만 한다.
  const playerPrefsRef = useRef({ volume: 1, isMuted: false, playbackRate: 1 });
  useEffect(() => {
    playerPrefsRef.current = { volume, isMuted, playbackRate };
  }, [volume, isMuted, playbackRate]);

  // 하단 Prev/Next 버튼을 눌렀을 때 그 페이지의 시작 지점으로 스크롤하기
  // 위한 요청값. VirtualizedMasonry가 처리하고 나면 다시 null로 리셋된다.
  const [scrollRequestIndex, setScrollRequestIndex] = useState<number | null>(null);

  // 이미 불러온 페이지를 다시 요청하지 않도록 추적한다. (Prev/Next 버튼으로
  // 이전 페이지 번호로 돌아갔을 때 같은 항목이 중복으로 쌓이는 걸 방지)
  const loadedPagesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (loadedPagesRef.current.has(page)) return;
    // 네트워크 응답이 오기 전에 동기적으로 먼저 마킹해야 한다. React
    // StrictMode(개발 모드)는 effect를 마운트→클린업→재마운트로 두 번
    // 실행하는데, 응답이 온 뒤(then 콜백)에만 마킹하면 두 번째 실행이
    // 아직 false인 상태를 보고 또 fetch해 항목이 중복으로 쌓인다.
    loadedPagesRef.current.add(page);

    // pageSize/mediaType/sortOrder도 의존성에 넣어야 한다 — 이 값들이
    // 바뀌면 아래 리셋 effect가 items/page를 리셋하지만 page 값 자체는
    // 이미 1일 수 있어(값이 안 바뀌면 이 effect가 재실행되지 않는다) 값
    // 변화 자체가 새 요청을 트리거하는 신호 역할을 한다.
    videoSetter(page, pageSize, mediaType, sortOrder).then((data) => {
      if (data) {
        setItems((prev) => [...prev, ...data.videos]);
        setTotalPages(data.totalPages);
        setTotalVideos(data.totalVideos);
      }
    });
  }, [page, pageSize, mediaType, sortOrder]);

  // 타입 필터/정렬 순서가 바뀌면 지금까지 불러온 목록은 더 이상 유효하지
  // 않다(다른 조건으로 다시 페이지 1부터 불러와야 한다) — pageSize 변경
  // 리셋과 같은 방식이지만, 슬라이더 드래그처럼 값이 연달아 바뀌지 않는
  // 이산적인 조작이라 디바운스 없이 바로 리셋한다.
  const isFirstFilterSortRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstFilterSortRenderRef.current) {
      isFirstFilterSortRenderRef.current = false;
      return;
    }
    loadedPagesRef.current.clear();
    setItems([]);
    setTotalPages(0);
    setTotalVideos(0);
    setPage(1);
  }, [mediaType, sortOrder]);

  // autoPlay 속성에만 맡기면 브라우저 자동재생 정책에 막혔을 때 아무 로그도
  // 없이 조용히 멈춰버린다. 명시적으로 play()를 호출해 실패 사유(Promise
  // reject)를 콘솔에서 확인할 수 있게 한다. 새로 마운트된 video 요소에는
  // 기본값(볼륨 1, 음소거 해제, 배속 1x)이 적용돼 있으므로, 사용자가
  // 이전 영상에서 맞춰둔 선호 설정(playerPrefsRef)을 재생 전에 그대로
  // 옮겨 적용한다.
  useEffect(() => {
    if (!fullViewe) return;
    const video = fullViewVideoRef.current;
    if (!video) return;
    const prefs = playerPrefsRef.current;
    video.volume = prefs.volume;
    video.muted = prefs.isMuted;
    video.playbackRate = prefs.playbackRate;
    video.play().catch((error) => logPlayRejection(fullViewe, error));
  }, [fullViewe]);

  // 새 항목을 열거나 다음/이전으로 전환할 때마다 제목 바/플레이어 컨트롤을
  // 다시 보이는 상태로, 재생 진행 상태도 처음(0초, 재생 중)으로 리셋한다 —
  // 이전 항목에서 숨겨뒀거나 되감아뒀다고 새 항목까지 그 상태로 시작되면
  // 안 된다. (볼륨/음소거/배속은 의도적으로 리셋하지 않는다 — 위 effect가
  // 옮겨 적용하는 사용자 선호 설정이다.)
  useEffect(() => {
    if (fullViewe) {
      setShowFullChrome(true);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(true);
    }
  }, [fullViewe]);

  // 풀뷰 영상을 닫거나 다른 영상으로 전환하기 직전에 호출한다. <video>를
  // 그냥 언마운트/src 교체만 하면 브라우저가 진행 중이던 다운로드 요청을
  // 자동으로 취소해주지 않는다 — 스펙상 DOM에서 제거돼도 리소스 요청은
  // 백그라운드에서 계속 진행된다. 열기→빠르게 닫기→열기를 반복하면 이렇게
  // 취소되지 않은 요청이 계속 쌓이고, 브라우저의 오리진당 동시 연결 제한
  // (HTTP/1.1 기준 보통 6개)에 걸리는 순간 그 이후로는 어떤 영상/썸네일
  // 요청도 응답을 받지 못하고 멈춰버린다. pause 후 src를 명시적으로 비우고
  // load()를 호출해야 브라우저가 그 자리에서 요청을 즉시 중단(abort)한다.
  const stopFullViewVideo = useCallback(() => {
    const video = fullViewVideoRef.current;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }, []);

  const handleOpen = useCallback((url: string) => {
    setFullView(url);
  }, []);

  const handleClose = useCallback(() => {
    stopFullViewVideo();
    setFullView(false);
  }, [stopFullViewVideo]);

  const handleNearEnd = useCallback(() => {
    setPage((prev) => (totalPages && prev < totalPages ? prev + 1 : prev));
  }, [totalPages]);

  // 하단 Prev/Next 버튼: 페이지 번호만 바꾸는 게 아니라, 해당 페이지의 첫
  // 항목이 있는 위치로 그리드 스크롤도 함께 이동시킨다.
  const handleMenuPrev = useCallback(() => {
    setPage((prev) => {
      if (prev <= 1) return prev;
      const targetPage = prev - 1;
      setScrollRequestIndex((targetPage - 1) * pageSize);
      return targetPage;
    });
  }, [pageSize]);

  const handleMenuNext = useCallback(() => {
    setPage((prev) => {
      if (!totalPages || prev >= totalPages) return prev;
      const targetPage = prev + 1;
      setScrollRequestIndex((targetPage - 1) * pageSize);
      return targetPage;
    });
  }, [totalPages, pageSize]);

  const handlePrevVideo = useCallback(
    (currentUrl: string) => {
      stopFullViewVideo();
      const idx = items.findIndex((item) => item.url === currentUrl);
      if (idx > 0) {
        setFullView(items[idx - 1].url);
      } else {
        setFullView(false);
      }
    },
    [items, stopFullViewVideo],
  );

  const handleNextVideo = useCallback(
    (currentUrl: string) => {
      stopFullViewVideo();
      const idx = items.findIndex((item) => item.url === currentUrl);
      if (idx !== -1 && idx < items.length - 1) {
        setFullView(items[idx + 1].url);
      } else {
        setPage((prev) => (prev < totalPages ? prev + 1 : prev));
      }
    },
    [items, totalPages, stopFullViewVideo],
  );

  // 컴포넌트가 언마운트되는 경우(예: 라우팅)에도 마지막으로 열려 있던
  // 영상의 진행 중인 요청을 정리한다.
  useEffect(() => () => stopFullViewVideo(), [stopFullViewVideo]);

  const handleToggleFullChrome = useCallback(() => {
    setShowFullChrome((prev) => !prev);
  }, []);

  // ── 커스텀 플레이어 핸들러 ──────────────────────────────────────────

  const handleTogglePlay = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      const video = fullViewVideoRef.current;
      if (!video) return;
      if (video.paused) {
        video.play().catch((error) => fullViewe && logPlayRejection(fullViewe, error));
      } else {
        video.pause();
      }
    },
    [fullViewe],
  );

  // 진행 바 위 클릭/드래그 위치(clientX)를 실제 재생 시각으로 환산해
  // video.currentTime에 반영한다.
  const seekFromClientX = useCallback((clientX: number) => {
    const track = progressTrackRef.current;
    const video = fullViewVideoRef.current;
    if (!track || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setCurrentTime(video.currentTime);
  }, []);

  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isSeekingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const handleProgressPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isSeekingRef.current) return;
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const handleProgressPointerUp = useCallback(() => {
    isSeekingRef.current = false;
  }, []);

  // 좌우 화살표 키로 진행 바를 앞/뒤로 이동시킨다 (다음/이전 영상 전환은
  // 위/아래 화살표가 맡는다).
  const handleSeekBy = useCallback((deltaSeconds: number) => {
    const video = fullViewVideoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + deltaSeconds));
    setCurrentTime(video.currentTime);
  }, []);

  // zip 풀뷰에서 좌우 화살표로 내부 이미지를 한 장씩 넘긴다. 첫/마지막
  // 장에서는 그냥 멈춘다 — 다음/이전 미디어로의 전환은 위/아래 화살표(또는
  // 좌우 화살표 버튼)가 이미 맡고 있으므로 여기서 넘어가면 두 조작이 섞여
  // 헷갈린다.
  const handleZipStepBy = useCallback(
    (delta: number) => {
      setZipImageIndex((prev) => {
        const next = prev + delta;
        if (next < 0 || next >= zipImageCount) return prev;
        return next;
      });
    },
    [zipImageCount],
  );

  // zip을 열 때(혹은 zip끼리 넘나들 때)마다 그 zip 안의 이미지 개수를
  // 서버에 물어보고, 탐색 위치는 항상 처음(0번째)으로 되돌린다.
  useEffect(() => {
    if (!fullViewe || !isZipView) {
      setZipImageCount(0);
      setZipImageIndex(0);
      return;
    }

    setZipImageIndex(0);
    let cancelled = false;

    fetch(`http://localhost:8080${toZipBaseUrl(fullViewe)}/entries`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setZipImageCount(typeof data?.count === 'number' ? data.count : 0);
      })
      .catch((error) => {
        if (!cancelled) setZipImageCount(0);
        console.error(`[zip entries error] file="${fullViewe}"`, error);
      });

    return () => {
      cancelled = true;
    };
  }, [fullViewe, isZipView]);

  const handleVolumeChange = useCallback((value: number) => {
    const video = fullViewVideoRef.current;
    if (video) {
      video.volume = value;
      video.muted = value === 0;
    }
    setVolume(value);
    setIsMuted(value === 0);
  }, []);

  const handleToggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const video = fullViewVideoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

  const handleSetPlaybackRate = useCallback((rate: number) => {
    const video = fullViewVideoRef.current;
    if (video) video.playbackRate = rate;
    setPlaybackRate(rate);
  }, []);

  const handleToggleFullscreen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const el = mediaContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  // 전체화면 진입/종료는 우리 버튼뿐 아니라 브라우저 자체 단축키(F11 등)
  // 로도 일어날 수 있으므로, 버튼 클릭에서 직접 상태를 바꾸지 않고 이
  // 브라우저 이벤트를 구독해 상태를 동기화한다.
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === mediaContainerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 풀뷰가 열려 있는 동안 키보드 위/아래 화살표로 이전/다음 항목 이동,
  // 좌/우 화살표로 진행 바 되감기/빨리감기, 스페이스로 재생/일시정지,
  // Esc로 닫기를 지원한다.
  useEffect(() => {
    if (!fullViewe) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        handlePrevVideo(fullViewe);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleNextVideo(fullViewe);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isZipView) {
          handleZipStepBy(-1);
        } else {
          handleSeekBy(-SEEK_STEP_SECONDS);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (isZipView) {
          handleZipStepBy(1);
        } else {
          handleSeekBy(SEEK_STEP_SECONDS);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    fullViewe,
    isZipView,
    handlePrevVideo,
    handleNextVideo,
    handleClose,
    handleTogglePlay,
    handleSeekBy,
    handleZipStepBy,
  ]);

  // 새 항목을 열거나 다음/이전으로 전환할 때마다 줌 상태도 원본 크기로
  // 리셋한다 — 이전 항목에서 확대해둔 채로 다음 항목이 확대된 채 열리면
  // 안 된다.
  useEffect(() => {
    if (fullViewe) setZoom({ scale: 1, originX: 50, originY: 50 });
  }, [fullViewe]);

  // 풀뷰 위에서 마우스 휠/트랙패드 스크롤로 이전/다음 항목 이동 + ctrl(또는
  // cmd)+휠로 커서 위치를 기준으로 확대/축소한다. 브라우저 기본 페이지 줌
  // (ctrl+휠, 트랙패드 핀치)을 막으려면 non-passive 리스너가 필요한데,
  // React의 onWheel prop은 내부적으로 passive로 등록돼 preventDefault가
  // 통하지 않아 DOM에 직접 붙인다.
  useEffect(() => {
    if (!fullViewe) return;
    const el = fullContainerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // 확대/축소: 트랙패드 핀치 제스처도 ctrlKey=true인 wheel 이벤트로
        // 들어온다. 브라우저의 기본 페이지 줌으로 새지 않게 막는다.
        e.preventDefault();

        const mediaEl = mediaElRef.current;
        const rect = mediaEl?.getBoundingClientRect();

        setZoom((prev) => {
          const nextScale = Math.min(4, Math.max(1, prev.scale - e.deltaY * 0.0025));
          if (!rect || rect.width === 0 || rect.height === 0) {
            return { ...prev, scale: nextScale };
          }
          // 커서가 실제 미디어 요소 위 어디에 있는지를 %로 환산해 그 지점을
          // 기준(transform-origin)으로 삼는다 — 계속 커서를 향해 확대된다.
          const originX = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
          const originY = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
          return { scale: nextScale, originX, originY };
        });
        return;
      }

      if (wheelLockRef.current) return;
      if (Math.abs(e.deltaY) < 12) return;

      wheelLockRef.current = true;
      if (e.deltaY > 0) {
        handleNextVideo(fullViewe);
      } else {
        handlePrevVideo(fullViewe);
      }
      setTimeout(() => {
        wheelLockRef.current = false;
      }, 450);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [fullViewe, handleNextVideo, handlePrevVideo]);

  // 더블클릭으로 언제든 원본 크기(줌 리셋)로 빠르게 돌아올 수 있게 한다.
  const handleResetZoom = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setZoom({ scale: 1, originX: 50, originY: 50 });
  }, []);

  // 크게 보는 중인 항목의 파일명 — 상단 타이틀 바에 표기하기 위함.
  const fullViewName = useMemo(
    () => (fullViewe ? items.find((item) => item.url === fullViewe)?.name ?? '' : ''),
    [fullViewe, items],
  );

  return (
    <div className={Style.App}>
      <header className={Style.Header}>
        <Group gap="xs" className={Style.Brand}>
          <IconPlayerPlay size={20} strokeWidth={2.2} />
          <Text fw={700} size="lg">
            My Video App
          </Text>
        </Group>
        <Group gap="lg" className={Style.Controls}>
          <Group gap="xs" className={Style.GridSizeControl} aria-label="그리드 크기 조절">
            <IconGridDots size={16} />
            <Slider
              className={Style.GridSizeSlider}
              value={gridItemWidth}
              onChange={setGridItemWidth}
              min={MIN_GRID_ITEM_WIDTH}
              max={MAX_GRID_ITEM_WIDTH}
              step={10}
              label={null}
              size="xs"
              color="blue"
              aria-label="그리드 카드 크기"
            />
            <IconLayoutGrid size={18} />
          </Group>
          <SegmentedControl
            className={Style.TypeFilter}
            size="xs"
            value={mediaType}
            onChange={(value) => setMediaType(value as MediaTypeFilter)}
            data={[
              { label: '전체', value: 'all' },
              { label: '이미지', value: 'image' },
              { label: '영상', value: 'video' },
            ]}
            aria-label="미디어 타입 필터"
          />
          <ActionIcon
            variant="light"
            color="gray"
            size="lg"
            radius="xl"
            onClick={() => setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
            aria-label={sortOrder === 'desc' ? '최신순 정렬 중 — 오래된순으로 바꾸기' : '오래된순 정렬 중 — 최신순으로 바꾸기'}
            title={sortOrder === 'desc' ? '최신순' : '오래된순'}
          >
            {sortOrder === 'desc' ? (
              <IconSortDescending size={18} />
            ) : (
              <IconSortAscending size={18} />
            )}
          </ActionIcon>
        </Group>
        <Text className={Style.HeaderCount} size="sm">
          {totalVideos.toLocaleString()}개
        </Text>
      </header>

      {fullViewe ? (
        <div className={Style.Full} onClick={handleClose} ref={fullContainerRef}>
          <div
            className={`${Style.FullTopBar} ${showFullChrome ? '' : Style.FullTopBarHidden}`}
            onClick={(e) => e.stopPropagation()}
          >
            <Text className={Style.FullTitle} fw={600} size="sm" truncate>
              {fullViewName}
            </Text>
            {isZipView && zipImageCount > 0 && (
              <Text className={Style.ZipCounter} size="xs" fw={600}>
                {zipImageIndex + 1} / {zipImageCount}
              </Text>
            )}
            <ActionIcon
              className={Style.Close}
              variant="subtle"
              color="gray"
              size="lg"
              radius="xl"
              onClick={handleClose}
              aria-label="닫기"
            >
              <IconX size={20} />
            </ActionIcon>
          </div>
          <div
            className={Style.FullView}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleFullChrome();
            }}
          >
            <ActionIcon
              className={Style.Prev}
              variant="subtle"
              color="gray"
              size="xl"
              radius="xl"
              onClick={(e) => {
                e.stopPropagation();
                handlePrevVideo(fullViewe);
              }}
              aria-label="이전"
            >
              <IconChevronLeft size={26} />
            </ActionIcon>
            <div
              className={Style.FullViewVideo}
              ref={mediaContainerRef}
              onDoubleClick={handleResetZoom}
            >
              {VIDEO_EXTENSIONS.includes(getExtension(fullViewe)) ? (
                <video
                  ref={(el) => {
                    fullViewVideoRef.current = el;
                    mediaElRef.current = el;
                  }}
                  src={`http://localhost:8080${fullViewe}`}
                  key={`video-${fullViewe}`}
                  loop
                  style={{
                    transform: `scale(${zoom.scale})`,
                    transformOrigin: `${zoom.originX}% ${zoom.originY}%`,
                  }}
                  onError={(e) => logVideoError(fullViewe, e.currentTarget.error)}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    if (!isSeekingRef.current) setCurrentTime(e.currentTarget.currentTime);
                  }}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onVolumeChange={(e) => {
                    setVolume(e.currentTarget.volume);
                    setIsMuted(e.currentTarget.muted);
                  }}
                  onRateChange={(e) => setPlaybackRate(e.currentTarget.playbackRate)}
                ></video>
              ) : isZipView ? (
                <img
                  ref={(el) => {
                    mediaElRef.current = el;
                  }}
                  src={`http://localhost:8080${toZipBaseUrl(fullViewe)}/image/${zipImageIndex}`}
                  key={`zip-${fullViewe}-${zipImageIndex}`}
                  alt={`${fullViewName} (${zipImageIndex + 1}/${zipImageCount || '?'})`}
                  style={{
                    transform: `scale(${zoom.scale})`,
                    transformOrigin: `${zoom.originX}% ${zoom.originY}%`,
                  }}
                  onError={() => logImageError(fullViewe)}
                />
              ) : (
                <img
                  ref={(el) => {
                    mediaElRef.current = el;
                  }}
                  src={`http://localhost:8080${fullViewe}`}
                  alt={fullViewe}
                  style={{
                    transform: `scale(${zoom.scale})`,
                    transformOrigin: `${zoom.originX}% ${zoom.originY}%`,
                  }}
                />
              )}

              {VIDEO_EXTENSIONS.includes(getExtension(fullViewe)) && (
                <div
                  className={`${Style.PlayerControls} ${
                    showFullChrome ? '' : Style.PlayerControlsHidden
                  }`}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="md"
                    radius="xl"
                    onClick={handleTogglePlay}
                    aria-label={isPlaying ? '일시정지' : '재생'}
                  >
                    {isPlaying ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
                  </ActionIcon>

                  <Text className={Style.TimeText} size="xs">
                    {formatTime(currentTime)}
                  </Text>

                  <div
                    ref={progressTrackRef}
                    className={Style.ProgressTrack}
                    onPointerDown={handleProgressPointerDown}
                    onPointerMove={handleProgressPointerMove}
                    onPointerUp={handleProgressPointerUp}
                  >
                    <div className={Style.ProgressTrackLine} />
                    <div
                      className={Style.ProgressFill}
                      style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                    />
                    <div
                      className={Style.ProgressThumb}
                      style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                    />
                  </div>

                  <Text className={Style.TimeText} size="xs">
                    {formatTime(duration)}
                  </Text>

                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="md"
                    radius="xl"
                    onClick={handleToggleMute}
                    aria-label={isMuted ? '음소거 해제' : '음소거'}
                  >
                    {isMuted || volume === 0 ? (
                      <IconVolumeOff size={18} />
                    ) : volume < 0.5 ? (
                      <IconVolume2 size={18} />
                    ) : (
                      <IconVolume size={18} />
                    )}
                  </ActionIcon>

                  <Slider
                    className={Style.VolumeSlider}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    min={0}
                    max={1}
                    step={0.01}
                    label={null}
                    size="xs"
                    color="gray"
                  />

                  <Menu position="top" withArrow shadow="md" width={90}>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="md"
                        radius="xl"
                        aria-label="재생 속도"
                      >
                        <Text size="xs" fw={600}>
                          {playbackRate}x
                        </Text>
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {PLAYBACK_RATES.map((rate) => (
                        <Menu.Item
                          key={rate}
                          onClick={() => handleSetPlaybackRate(rate)}
                          fw={rate === playbackRate ? 700 : 400}
                        >
                          {rate}x
                        </Menu.Item>
                      ))}
                    </Menu.Dropdown>
                  </Menu>

                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="md"
                    radius="xl"
                    onClick={handleToggleFullscreen}
                    aria-label={isFullscreen ? '전체화면 종료' : '전체화면'}
                  >
                    {isFullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
                  </ActionIcon>
                </div>
              )}
            </div>
            <ActionIcon
              className={Style.Next}
              variant="subtle"
              color="gray"
              size="xl"
              radius="xl"
              onClick={(e) => {
                e.stopPropagation();
                handleNextVideo(fullViewe);
              }}
              aria-label="다음"
            >
              <IconChevronRight size={26} />
            </ActionIcon>
          </div>
        </div>
      ) : null}
      <div className={Style.Videos}>
        <VirtualizedMasonry
          items={items}
          onOpen={handleOpen}
          onNearEnd={handleNearEnd}
          scrollToIndex={scrollRequestIndex}
          onScrollHandled={() => setScrollRequestIndex(null)}
          targetItemWidth={gridItemWidth}
          onColumnCountChange={handleColumnCountChange}
        />
      </div>
      <div className={Style.Menu}>
        <ActionIcon
          variant="light"
          color="gray"
          size="lg"
          radius="xl"
          onClick={handleMenuPrev}
          disabled={page <= 1}
          aria-label="이전 페이지"
        >
          <IconChevronLeft size={18} />
        </ActionIcon>
        <Text className={Style.MenuPage} size="sm">
          {page} / {totalPages}
        </Text>
        <ActionIcon
          variant="light"
          color="gray"
          size="lg"
          radius="xl"
          onClick={handleMenuNext}
          disabled={page >= totalPages}
          aria-label="다음 페이지"
        >
          <IconChevronRight size={18} />
        </ActionIcon>
        <Text className={Style.MenuTotal} size="sm">
          전체 {totalVideos.toLocaleString()}개
        </Text>
      </div>
    </div>
  );
}

export default App;
