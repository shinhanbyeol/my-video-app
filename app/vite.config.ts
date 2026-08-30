import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // backend/server.js가 정적 파일을 backend/build 에서 서빙하도록 되어
    // 있으므로, 빌드 결과물을 바로 그 위치로 출력한다(복사 단계 불필요).
    outDir: '../backend/build',
    emptyOutDir: true,
  },
})
