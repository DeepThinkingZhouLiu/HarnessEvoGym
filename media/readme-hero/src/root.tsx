import React from 'react';
import {Composition} from 'remotion';
import {HarnessEvoGymHero} from './HarnessEvoGymHero';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="HarnessEvoGymHero"
      component={HarnessEvoGymHero}
      durationInFrames={180}
      fps={30}
      width={1200}
      height={560}
    />
  );
};
