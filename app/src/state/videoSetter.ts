import axios from 'axios';
const video = axios.create({
  baseURL: 'http://localhost:8080',
});

// 그리드 크기(열 수)에 따라 한 페이지에 몇 개를 불러올지가 동적으로
// 바뀐다(App.tsx 참고) — 실제 그리드 폭을 아직 측정하기 전(첫 로드) 쓸
// 기본값일 뿐, 더 이상 모든 요청에 고정으로 쓰이는 값이 아니다. 그래도
// 프론트가 매 요청에 실제 pageSize를 명시적으로 실어 보내므로 백엔드
// 기본값에 암묵적으로 의존하지는 않는다.
export const DEFAULT_PAGE_SIZE = 10;

export const videoSetter = async (
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<{
  videos: {
    name: string;
    url: string;
    thumbnailUrl: string;
  }[];
  totalVideos: number;
  currentPage: number;
  totalPages: number;
}> => {
  return await video
    .get('/api/v1/videoes' + `?page=${page}&pageSize=${pageSize}`)
    .then((res) => {
      return res.data;
    })
    .catch((error) => {
      console.log(error.message);
    });
};
