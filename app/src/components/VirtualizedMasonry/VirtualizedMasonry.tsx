import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { debounce } from 'lodash';
import VideoItem from '../VideoItem/VideoItem';
import Style from './VirtualizedMasonry.module.scss';

export interface MediaItem {
  name: string;
  url: string;
  thumbnailUrl: string;
}

interface Props {
  items: MediaItem[];
  onOpen: (url: string) => void;
  // 스크롤이 바닥에 가깝거나, 콘텐츠가 화면을 다 못 채울 때 다음 페이지를
  // 더 불러오라는 신호. 실제로 더 불러올지는 호출하는 쪽(App)이 결정한다.
  onNearEnd: () => void;
  // 하단 페이지네이션(Prev/Next) 버튼을 눌렀을 때, 그 페이지의 첫 항목
  // 인덱스로 스크롤해달라는 요청. 아직 그 인덱스의 항목이 로드되지 않았으면
  // (Next로 새 페이지를 막 요청한 직후 등) items가 갱신될 때마다 다시
  // 시도하다가, 로드되는 즉시 스크롤한다.
  scrollToIndex?: number | null;
  // 스크롤 요청을 실제로 처리했을 때 호출 — 부모가 scrollToIndex를 다시
  // null로 리셋해서, 이후 다른 이유로 목록이 갱신돼도 재스크롤하지 않게 한다.
  onScrollHandled?: () => void;
  // 카드 하나가 대략 이 너비(px)가 되도록 열 수를 계산한다 — 그리드 크기
  // 조절 슬라이더(App.tsx)가 이 값을 바꿔서 "몇 열로 보여줄지"를 제어한다.
  // 생략하면 DEFAULT_TARGET_ITEM_WIDTH를 쓴다.
  targetItemWidth?: number;
  // 실제로 계산된 열 수가 바뀔 때마다 알려준다 — 부모가 이 값으로 한
  // 페이지에 몇 개를 불러올지(pageSize)를 그리드 밀도에 맞게 정한다.
  onColumnCountChange?: (columnCount: number) => void;
}

// 항목을 화면 밖으로 나갔다고 React에서 언마운트하는 방식(JS 가상화)은
// 시도해봤지만, 언마운트되는 순간 진행 중이던 비디오/이미지 로드가 취소되고
// 다시 마운트될 때 처음부터 다시 받아오면서 "스크롤을 왔다갔다 하면 끊기고
// 콘텐츠가 사라지는" 문제로 이어졌다. 대신 항목은 항상 DOM에 유지하고,
// CSS `content-visibility: auto`로 화면 밖 항목의 레이아웃/페인트 계산만
// 브라우저가 알아서 건너뛰게 한다 — 언마운트가 없으니 로딩이 취소될 일도
// 없다. `contain-intrinsic-size`로 예상 크기를 미리 알려줘야, 아직 한 번도
// 화면에 들어오지 않은 항목도 스크롤바 길이 계산이 어긋나지 않는다.
const GAP = 20; // px, 칸 사이 간격
// 실측 전 칸 높이를 잡기 위한 기본 세로:가로 비율 추정치. 이 라이브러리는
// 세로형(폰 촬영) 영상/사진이 많아 1(정사각형)보다 세로로 긴 값을 기본값으로
// 잡는다. 실제 메타데이터가 로드되면 바로 정확한 값으로 재배치된다.
const DEFAULT_ASPECT_RATIO = 1.5;

// 그리드 크기 슬라이더가 안 건드렸을 때 쓰는 기본 카드 너비.
export const DEFAULT_TARGET_ITEM_WIDTH = 280;
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 8;

// 원래는 뷰포트 기준 CSS 미디어쿼리로 고정 컬럼 수를 잡았지만, 지금은
// 그리드 컨테이너의 실제 너비를 "카드 하나당 목표 너비(targetItemWidth)"로
// 나눠 열 수를 구한다 — 컨테이너가 좁아지면(반응형) 자동으로 열이
// 줄어들고, targetItemWidth를 슬라이더로 조절하면 같은 너비에서도 카드가
// 커지거나 작아지며 열 수가 바뀐다.
function getColumnCount(containerWidth: number, targetItemWidth: number): number {
  if (containerWidth <= 0) return MIN_COLUMNS;
  const raw = Math.round((containerWidth + GAP) / (targetItemWidth + GAP));
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, raw));
}

interface Position {
  item: MediaItem;
  top: number;
  left: number;
  width: number;
  height: number;
}

function computeLayout(
  items: MediaItem[],
  aspectRatios: Record<string, number>,
  columnCount: number,
  containerWidth: number,
): { positions: Position[]; totalHeight: number } {
  if (containerWidth <= 0 || items.length === 0) {
    return { positions: [], totalHeight: 0 };
  }

  const columnWidth = (containerWidth - GAP * (columnCount - 1)) / columnCount;
  const columnHeights = new Array(columnCount).fill(0);

  const positions = items.map((item) => {
    const col = columnHeights.indexOf(Math.min(...columnHeights));
    const ratio = aspectRatios[item.url] ?? DEFAULT_ASPECT_RATIO;
    const height = Math.round(columnWidth * ratio);
    const top = columnHeights[col];
    const left = col * (columnWidth + GAP);
    columnHeights[col] = top + height + GAP;
    return { item, top, left, width: columnWidth, height };
  });

  return { positions, totalHeight: Math.max(0, Math.max(...columnHeights) - GAP) };
}

function VirtualizedMasonry({
  items,
  onOpen,
  onNearEnd,
  scrollToIndex,
  onScrollHandled,
  targetItemWidth = DEFAULT_TARGET_ITEM_WIDTH,
  onColumnCountChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // url -> (height / width). 항목이 한 번 언마운트됐다가 다시 붙어도(예:
  // key가 바뀌는 경우) 값이 남아있도록 부모가 보관한다.
  const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      // width가 순간적으로 0으로 읽히는 드문 경우(부모 flex 레이아웃이
      // 재계산되는 찰나 등)를 무시해, 레이아웃 전체가 비워지는 걸 막는다.
      if (entry && entry.contentRect.width > 0) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleAspectRatio = useCallback((url: string, ratio: number) => {
    setAspectRatios((prev) => (prev[url] === ratio ? prev : { ...prev, [url]: ratio }));
  }, []);

  const columnCount = getColumnCount(containerWidth, targetItemWidth);

  // 열 수가 실제로 바뀔 때마다 부모에 알린다 — 부모는 이 값으로 한 페이지에
  // 몇 개를 불러올지(pageSize)를 그리드 밀도에 맞게 다시 계산한다.
  useEffect(() => {
    onColumnCountChange?.(columnCount);
  }, [columnCount, onColumnCountChange]);

  const { positions, totalHeight } = useMemo(
    () => computeLayout(items, aspectRatios, columnCount, containerWidth),
    [items, aspectRatios, columnCount, containerWidth],
  );

  // "다음 페이지를 더 불러올지"만 스크롤에서 체크하면 된다 — 렌더링 범위를
  // 스크롤에 맞춰 바꾸지 않으므로(모든 항목이 항상 DOM에 있음) 매 프레임
  // 반응할 필요 없이 가볍게 디바운스해도 충분하다.
  const handleNearEndCheck = useMemo(
    () =>
      debounce((el: HTMLDivElement) => {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 800) {
          onNearEnd();
        }
      }, 150),
    [onNearEnd],
  );

  useEffect(() => () => handleNearEndCheck.cancel(), [handleNearEndCheck]);

  // 페이지네이션 버튼으로 들어온 스크롤 요청 처리. 대상 인덱스가 아직
  // positions에 없으면(예: Next로 방금 요청한 페이지가 아직 도착 전) 아무것도
  // 안 하고 기다렸다가, items/positions가 갱신되면 이 effect가 다시 실행돼
  // 그때 스크롤한다.
  useEffect(() => {
    if (scrollToIndex == null) return;
    const target = positions[scrollToIndex];
    const el = containerRef.current;
    if (!target || !el) return;

    el.scrollTo({ top: Math.max(0, target.top - GAP), behavior: 'smooth' });
    onScrollHandled?.();
  }, [scrollToIndex, positions, onScrollHandled]);

  return (
    <div
      ref={containerRef}
      className={Style.Grid}
      onScroll={(e) => handleNearEndCheck(e.currentTarget)}
    >
      <div className={Style.Canvas} style={{ height: totalHeight }}>
        {positions.map(({ item, top, left, width, height }) => (
          <div
            key={item.url}
            className={Style.Cell}
            style={{
              top,
              left,
              width,
              height,
              // 화면 밖에 있는 동안은 브라우저가 레이아웃/스타일/페인트를
              // 건너뛴다(언마운트는 아니라서 로딩이 취소되지 않는다).
              // contain-intrinsic-size로 실제 렌더링 전에도 이 칸의 크기를
              // 미리 알려줘야 스크롤 길이가 화면에 들어올 때마다 들썩이지
              // 않는다.
              contentVisibility: 'auto',
              containIntrinsicSize: `${width}px ${height}px`,
            }}
          >
            <VideoItem
              videoName={item.name}
              url={item.url}
              thumbnailUrl={item.thumbnailUrl}
              onOpen={onOpen}
              onAspectRatio={handleAspectRatio}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default VirtualizedMasonry;
