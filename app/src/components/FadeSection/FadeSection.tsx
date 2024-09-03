import { useEffect, useRef, useState, } from 'react'
import Style from './FadeSection.module.scss';

function FadeInSection(props: any) {
  const [isVisible, setVisible] = useState(false);
  const domRef = useRef<any>();
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => setVisible(entry.isIntersecting));
    });
    domRef.current && observer.observe(domRef.current);
  }, []);
  return (
    <div
      className={`${isVisible ? Style.Vislble : Style.None}`}
      ref={domRef}
    >      
      {props.children}
    </div>
  );
}

export default FadeInSection