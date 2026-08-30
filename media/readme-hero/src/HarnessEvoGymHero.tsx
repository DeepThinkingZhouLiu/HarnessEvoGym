import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const FormulaCard: React.FC<{
  name: string;
  detail: string;
  accent: string;
  start: number;
}> = ({name, detail, accent, start}) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        width: 270,
        height: 92,
        borderRadius: 22,
        border: `1px solid ${accent}66`,
        background: 'linear-gradient(145deg, rgba(18,31,58,0.95), rgba(8,17,35,0.98))',
        boxShadow: `0 18px 50px ${accent}17, inset 0 1px 0 rgba(255,255,255,0.06)`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 24px',
        opacity: interpolate(frame, [start, start + 18, 164, 179], [0, 1, 1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        translate: interpolate(frame, [start, start + 20], ['0px 24px', '0px 0px'], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
      }}
    >
      <div style={{fontSize: 28, fontWeight: 760, color: '#f8fbff', letterSpacing: '-0.5px'}}>
        {name}
      </div>
      <div style={{fontSize: 15, color: '#91a6c7', marginTop: 7, letterSpacing: '0.3px'}}>
        {detail}
      </div>
    </div>
  );
};

const FlowStep: React.FC<{
  name: string;
  label: string;
  start: number;
  accent: string;
}> = ({name, label, start, accent}) => {
  const frame = useCurrentFrame();

  return (
    <Interactive.Div
      name={`${name} step`}
      style={{
        height: 52,
        minWidth: 142,
        borderRadius: 16,
        border: `1px solid ${accent}70`,
        backgroundColor: '#0c1830',
        color: '#edf5ff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        fontWeight: 680,
        letterSpacing: '0.2px',
        boxShadow: `0 10px 32px ${accent}12`,
        opacity: interpolate(frame, [start, start + 14, 164, 179], [0, 1, 1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        scale: interpolate(frame, [start, start + 14], [0.92, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.spring({damping: 180}),
          output: 'perceptual-scale',
        }),
      }}
    >
      {label}
    </Interactive.Div>
  );
};

export const HarnessEvoGymHero: React.FC = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  return (
    <AbsoluteFill
      name="HarnessEvoGym hero"
      style={{
        overflow: 'hidden',
        backgroundColor: '#07101f',
        fontFamily: 'Arial, Helvetica, sans-serif',
      }}
    >
      <Interactive.Div
        name="Ambient glow"
        style={{
          position: 'absolute',
          width: 760,
          height: 760,
          borderRadius: 999,
          left: 220,
          top: -430,
          background: 'radial-gradient(circle, rgba(47,129,247,0.24) 0%, rgba(109,94,252,0.08) 38%, rgba(7,16,31,0) 72%)',
          translate: interpolate(frame, [0, durationInFrames - 1], ['-60px 0px', '60px 18px'], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.45, 0, 0.55, 1),
          }),
        }}
      />

      <Interactive.Div
        name="Grid"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.2,
          backgroundImage: 'linear-gradient(rgba(116,150,195,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(116,150,195,0.09) 1px, transparent 1px)',
          backgroundSize: '42px 42px',
          translate: interpolate(frame, [0, durationInFrames - 1], ['0px 0px', '42px 42px'], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.linear,
          }),
        }}
      />

      <Interactive.Div
        name="Brand"
        style={{
          position: 'absolute',
          top: 40,
          left: 70,
          right: 70,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          opacity: interpolate(frame, [0, 18, 164, 179], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 13,
              background: 'linear-gradient(135deg, #2f81f7, #8b5cf6)',
              boxShadow: '0 10px 28px rgba(47,129,247,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 22,
              fontWeight: 850,
            }}
          >
            H
          </div>
          <div>
            <div style={{fontSize: 34, fontWeight: 780, color: '#f8fbff', letterSpacing: '-1.1px'}}>
              HarnessEvoGym
            </div>
            <div style={{fontSize: 13, color: '#7991b5', marginTop: 2, letterSpacing: '1.8px'}}>
              TRUSTED HARNESS SELF-EVOLUTION
            </div>
          </div>
        </div>
        <div
          style={{
            border: '1px solid rgba(72,205,159,0.4)',
            color: '#7ee2ba',
            backgroundColor: 'rgba(32,129,94,0.12)',
            borderRadius: 999,
            padding: '9px 16px',
            fontSize: 14,
            fontWeight: 650,
            letterSpacing: '0.3px',
          }}
        >
          measurable · reproducible · pluggable
        </div>
      </Interactive.Div>

      <div
        style={{
          position: 'absolute',
          top: 132,
          left: 70,
          right: 70,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <FormulaCard name="Target" detail="what evolves" accent="#2f81f7" start={12} />
        <div style={{fontSize: 32, color: '#58739d', fontWeight: 350}}>×</div>
        <FormulaCard name="Environment" detail="where it is evaluated" accent="#20c997" start={20} />
        <div style={{fontSize: 32, color: '#58739d', fontWeight: 350}}>×</div>
        <FormulaCard name="Evolution Recipe" detail="how the search runs" accent="#9b72ff" start={28} />
      </div>

      <Interactive.Div
        name="Controller connector"
        style={{
          position: 'absolute',
          left: 599,
          top: 226,
          width: 2,
          height: interpolate(frame, [40, 63], [0, 65], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          background: 'linear-gradient(#5779ad, #7b61ff)',
          opacity: interpolate(frame, [38, 50, 164, 179], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: 424,
          top: 278,
          width: 352,
          height: 70,
          borderRadius: 22,
          border: '1px solid rgba(155,114,255,0.72)',
          background: 'linear-gradient(135deg, rgba(72,55,145,0.9), rgba(33,48,91,0.96))',
          boxShadow: '0 18px 52px rgba(91,72,212,0.28), inset 0 1px 0 rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 13,
          color: '#ffffff',
          fontSize: 23,
          fontWeight: 760,
          letterSpacing: '-0.2px',
          opacity: interpolate(frame, [52, 68, 164, 179], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [52, 72], [0.9, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.spring({damping: 170}),
            output: 'perceptual-scale',
          }),
        }}
      >
        <span style={{fontSize: 25}}>◇</span>
        Trusted Controller
      </div>

      <div
        style={{
          position: 'absolute',
          left: 92,
          right: 92,
          top: 389,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <FlowStep name="Solve" label="Solve" start={72} accent="#2f81f7" />
        <div style={{color: '#526b90', fontSize: 22}}>→</div>
        <FlowStep name="Evaluate" label="Evaluate" start={80} accent="#20c997" />
        <div style={{color: '#526b90', fontSize: 22}}>→</div>
        <FlowStep name="Update" label="Update" start={88} accent="#f59f00" />
        <div style={{color: '#526b90', fontSize: 22}}>→</div>
        <FlowStep name="Candidate" label="Candidate" start={96} accent="#9b72ff" />
        <div style={{color: '#526b90', fontSize: 22}}>→</div>
        <FlowStep name="Promote" label="Promote / Rollback" start={104} accent="#48cd9f" />
      </div>

      <Interactive.Div
        name="Progress pulse"
        style={{
          position: 'absolute',
          left: interpolate(frame, [76, 136], [92, 1084], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.45, 0, 0.55, 1),
          }),
          top: 448,
          width: 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: '#7ee2ba',
          boxShadow: '0 0 0 7px rgba(72,205,159,0.12), 0 0 22px rgba(72,205,159,0.9)',
          opacity: interpolate(frame, [74, 84, 137, 148], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />

      <Interactive.Div
        name="Population modes"
        style={{
          position: 'absolute',
          left: 70,
          right: 70,
          bottom: 34,
          display: 'flex',
          justifyContent: 'center',
          gap: 12,
          opacity: interpolate(frame, [112, 128, 164, 179], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {['single', 'independent', 'mutualism', 'competition', 'combined'].map((mode) => (
          <div
            key={mode}
            style={{
              border: '1px solid rgba(101,130,174,0.35)',
              backgroundColor: 'rgba(12,24,48,0.8)',
              color: '#91a6c7',
              borderRadius: 999,
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '0.2px',
            }}
          >
            {mode}
          </div>
        ))}
      </Interactive.Div>
    </AbsoluteFill>
  );
};
