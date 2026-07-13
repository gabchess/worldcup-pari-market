import React from "react";
import { Composition } from "remotion";
import { PiPDiagram } from "./PiPDiagram";
import { EndCard } from "./EndCard";
import { Disclosure } from "./Disclosure";

const FPS = 30;

// Disclosure text used in the recorded demo.
const D1_TEXT =
  "Demo deposits, operator-seeded to show both sides of the pool. Final payout math is what you'll see resolve on-chain.";
const D2_TEXT =
  "Historical World Cup fixture, TxODDS devnet feed (SL=1, delayed test data), not a live match.";
const D3_TEXT =
  "validate_stat CPI · txoracle program · one proof, one on-chain check.";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Beat-4 PiP diagram overlay - 3-node CPI diagram, ~7s, rendered on
          transparent background for ffmpeg overlay compositing. */}
      <Composition
        id="pip-diagram"
        component={PiPDiagram}
        durationInFrames={7 * FPS}
        fps={FPS}
        width={900}
        height={520}
      />

      {/* End card with program and project links (program ID +
          repo/track line), 8s. */}
      <Composition
        id="end-card"
        component={EndCard}
        durationInFrames={12 * FPS}
        fps={FPS}
        width={1920}
        height={1080}
      />

      {/* Disclosure lower-thirds - transparent overlays, ffmpeg-composited
          at the exact windows named in the brief (D1/D2/D3). */}
      <Composition
        id="disclosure-d1"
        component={Disclosure}
        durationInFrames={85 * FPS}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ text: D1_TEXT }}
      />
      <Composition
        id="disclosure-d2"
        component={Disclosure}
        durationInFrames={55 * FPS}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ text: D2_TEXT }}
      />
      <Composition
        id="disclosure-d3"
        component={Disclosure}
        durationInFrames={35 * FPS}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ text: D3_TEXT }}
      />
    </>
  );
};
