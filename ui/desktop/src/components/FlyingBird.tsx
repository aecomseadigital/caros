import { useState, useEffect } from 'react';
import frame1 from '../images/loading-caros/1.svg';
import frame2 from '../images/loading-caros/2.svg';
import frame3 from '../images/loading-caros/3.svg';
import frame4 from '../images/loading-caros/4.svg';
import frame5 from '../images/loading-caros/5.svg';
import frame6 from '../images/loading-caros/6.svg';
import frame7 from '../images/loading-caros/7.svg';

interface FlyingBirdProps {
  className?: string;
  cycleInterval?: number; // milliseconds between frame changes
}

const frames = [frame1, frame2, frame3, frame4, frame5, frame6, frame7];

export default function FlyingBird({ className = '', cycleInterval = 150 }: FlyingBirdProps) {
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentFrameIndex((prevIndex) => (prevIndex + 1) % frames.length);
    }, cycleInterval);

    return () => clearInterval(interval);
  }, [cycleInterval]);

  return (
    <div className={`transition-opacity duration-75 ${className}`}>
      <img src={frames[currentFrameIndex]} alt="" className="h-4 w-auto dark:invert" />
    </div>
  );
}
