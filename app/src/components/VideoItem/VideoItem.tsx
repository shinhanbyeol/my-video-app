import { useEffect, useRef, useState } from 'react';
import Style from './VideoItem.module.scss';

interface props {
  key: number;
  videoName: string;
  handleFullViewe: (videoName: string) => void;
}

function VideoItem({ key, videoName, handleFullViewe }: props) {
  const [isVisible, setVisible] = useState(false);
  const [isLoaded, setLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const domRef = useRef<any>();

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) {
          setLoaded(true);
        }
      });
    });
    domRef.current && observer.observe(domRef.current);
  }, []);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      const videoHeight = videoRef.current?.getBoundingClientRect().height;
      const imgHeight = imgRef.current?.getBoundingClientRect().height;
      if (videoHeight) {
        domRef.current.style.gridRowEnd = `span ${Math.ceil(
          (videoHeight + 18) / (18 * 2),
        )}`;
      }
      if (imgHeight) {
        domRef.current.style.gridRowEnd = `span ${Math.ceil(
          (imgHeight + 18) / (18 * 2),
        )}`;
      }
    });
    domRef.current && resizeObserver.observe(domRef.current);
  }, []);

  useEffect(() => {
    videoRef.current?.addEventListener('loadeddata', () => {
      const videoHeight = videoRef.current?.getBoundingClientRect().height;
      const imgHeight = imgRef.current?.getBoundingClientRect().height;
      if (videoHeight) {
        domRef.current.style.gridRowEnd = `span ${Math.ceil(
          (videoHeight + 18) / (18 * 2),
        )}`;
      }
      if (imgHeight) {
        domRef.current.style.gridRowEnd = `span ${Math.ceil(
          (imgHeight + 18) / (18 * 2),
        )}`;
      }
    });

    return () => {
      videoRef.current?.removeEventListener('loadeddata', () => {});
    };
  }, [videoRef, domRef]);

  return (
    <>
      <figure
        ref={domRef}
        className={`${Style.VideoItem} ${
          isVisible ? Style.Vislble : Style.None
        }`}
      >
        <div>
          <label>{videoName}</label>
        </div>
        {['mp4', 'mkv'].includes(videoName.split('.')[videoName.split('.').length - 1])  ? (
          <video
            ref={videoRef}
            onClick={(e) => {
              e.preventDefault();
              handleFullViewe(videoName);
            }}
            src={isLoaded ? `http://localhost:3001/api/v1/video/${videoName}` : undefined}
            key={`video-${key}`}
            autoPlay={false}
            muted
            loop
            onMouseEnter={(e) => {
              e.currentTarget.play();
            }}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : (
          <img
            ref={imgRef}
            src={isLoaded ? `http://localhost:3001/api/v1/video/${videoName}` : undefined}
            alt={videoName}
            onClick={(e) => {
              e.preventDefault();
              handleFullViewe(videoName);
            }}
          />
        )}
      </figure>
    </>
  );
}

export default VideoItem;
