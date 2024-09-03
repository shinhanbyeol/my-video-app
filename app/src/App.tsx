import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { videoSetter } from './state/videoSetter';
import Style from './App.module.scss';
import VideoItem from './components/VideoItem/VideoItem';
import { debounce } from 'lodash';

function App() {
  const [videos, setVideos] = useState<string[]>([]);
  const [fullViewe, setFullView] = useState<string | false>(false);
  const videoLayoutRef = useRef<HTMLDivElement>(null);
  const fullVieweRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    videoSetter(setVideos);
  }, []);

  useEffect(() => {
    // mansory layout
    const videoLayout = videoLayoutRef.current;
    if (videoLayout) {
      const videoItems = videoLayout.children;
      const videoItemsArray = Array.from(videoItems);
      const videoItemsHeight = videoItemsArray.map((item) => item.clientHeight);
      videoItemsArray.forEach((item, idx) => {
        const minIndex = videoItemsHeight.indexOf(
          Math.min(...videoItemsHeight),
        );
        videoItemsHeight[minIndex] += item.clientHeight;
      });
    }
  }, [videoLayoutRef]);

  const handleFullViewe = (videoName: string) => {
    setFullView(videoName);
  };

  const handleScroll = useCallback(
    debounce((e: React.UIEvent<HTMLDivElement, UIEvent>) => {
      const scrollDirection = e?.currentTarget?.scrollTop > 0 ? 'up' : 'down';
      const currentVideoIndex = videos.indexOf(fullViewe as string);
      if (scrollDirection === 'down') {
        const nextVideo = videos[currentVideoIndex + 1];
        setFullView(nextVideo);
      } else if (scrollDirection === 'up') {
        const prevVideo = videos[currentVideoIndex - 1];
        setFullView(prevVideo);
      }
    }, 1000),
    [videos, fullViewe],
  );

  const videoList = () => {
    return videos?.map((videoName: string, idx) => (
      <VideoItem
        key={idx}
        videoName={videoName}
        handleFullViewe={handleFullViewe}
      />
    ));
  };

  return (
    <div className={Style.App}>
      {fullViewe ? (
        <div
          ref={fullVieweRef}
          className={Style.Full}
          style={{
            display: fullViewe ? 'flex' : 'none',
          }}
          onClick={() => {
            setFullView(false);
          }}
        >
          <div
            className={Style.FullView}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div
              className={Style.FullViewVideo}
              style={{
                overflow: 'auto',
              }}
              onScroll={handleScroll}
            >
              <div className={Style.DummyArea}>{`prev`}</div>
              <video
                src={`http://localhost:3001/api/v1/video/${fullViewe}`}
                key={`video-${fullViewe}`}
                controls={true}
                autoPlay={true}
              ></video>
              <div className={Style.DummyArea}>{`next`}</div>
            </div>
            <div className={Style.FullViewInfo}>
              <h3>{fullViewe}</h3>
            </div>
          </div>
        </div>
      ) : (
        <></>
      )}
      <div ref={videoLayoutRef} className={Style.Videos}>
        {videoList()}
      </div>
      <div className={Style.Menu}>
        <section>
          <button>🔍</button>
        </section>
        <section>
          <button>❤️</button>
        </section>
        <section>
          <button>🛒</button>
        </section>
      </div>
    </div>
  );
}

export default App;
