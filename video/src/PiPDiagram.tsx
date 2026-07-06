import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

const geistFont = loadGeist();
const geistMonoFont = loadGeistMono();

// DESIGN.md tokens verbatim — no shader, no new color pairs.
const T = {
  ivory: "#faf7f0",
  ink: "#2c2926",
  inkMuted: "#87867f",
  border: "#e0dacf",
  ochre: "#c4a574",
};

const FONT_GEIST = `'Geist', -apple-system, system-ui, sans-serif`;
const FONT_GEIST_MONO = `'Geist Mono', 'SF Mono', monospace`;

// Frozen scope per addendum-1: exactly ONE diagram, exactly 3 nodes.
// Pari-Market program -> validate_stat CPI -> TxODDS oracle / Merkle root
const NODES = [
  { label: "Pari-Market\nprogram", mono: true },
  { label: "validate_stat\nCPI", mono: false },
  { label: "TxODDS oracle /\nMerkle root", mono: true },
];

const NodeBox: React.FC<{
  label: string;
  mono: boolean;
  frame: number;
  appearAt: number;
}> = ({ label, mono, frame, appearAt }) => {
  const sf = spring({
    frame: frame - appearAt,
    fps: 30,
    config: { stiffness: 140, damping: 18 },
  });
  const opacity = interpolate(frame - appearAt, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(sf, [0, 1], [0.85, 1]);

  return (
    <div
      style={{
        opacity: frame >= appearAt ? opacity : 0,
        transform: `scale(${scale})`,
        background: T.ivory,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: "18px 22px",
        minWidth: 220,
        textAlign: "center",
        boxShadow: "0 2px 8px rgba(44,41,38,.10)",
      }}
    >
      <div
        style={{
          fontFamily: mono ? FONT_GEIST_MONO : FONT_GEIST,
          fontSize: mono ? 17 : 19,
          fontWeight: mono ? 500 : 600,
          color: T.ink,
          whiteSpace: "pre-line",
          lineHeight: 1.35,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const Arrow: React.FC<{ frame: number; appearAt: number }> = ({
  frame,
  appearAt,
}) => {
  const opacity = interpolate(frame - appearAt, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const drawLen = interpolate(frame - appearAt, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        opacity: frame >= appearAt ? opacity : 0,
        display: "flex",
        alignItems: "center",
        width: 60,
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 40 * drawLen,
          height: 2,
          background: T.ochre,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: -1,
            top: -4,
            width: 0,
            height: 0,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            borderLeft: `7px solid ${T.ochre}`,
            opacity: drawLen > 0.9 ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
};

export const PiPDiagram: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  void geistFont;
  void geistMonoFont;

  // Whole-diagram fade in/out inside its ~7s window.
  const fadeIn = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 12, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const containerOpacity = fadeIn * fadeOut;

  return (
    <AbsoluteFill style={{ background: "transparent" }}>
      <div
        style={{
          opacity: containerOpacity,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            background: T.ivory,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            padding: "28px 32px",
            boxShadow: "0 8px 24px rgba(44,41,38,.14)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_GEIST,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: T.inkMuted,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            One proof, one on-chain check
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <NodeBox
              label={NODES[0].label}
              mono={NODES[0].mono}
              frame={frame}
              appearAt={4}
            />
            <Arrow frame={frame} appearAt={14} />
            <NodeBox
              label={NODES[1].label}
              mono={NODES[1].mono}
              frame={frame}
              appearAt={20}
            />
            <Arrow frame={frame} appearAt={34} />
            <NodeBox
              label={NODES[2].label}
              mono={NODES[2].mono}
              frame={frame}
              appearAt={40}
            />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
