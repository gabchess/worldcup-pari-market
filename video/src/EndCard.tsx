import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadCinzel } from "@remotion/google-fonts/Cinzel";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

const cinzelFont = loadCinzel();
const geistFont = loadGeist();
const geistMonoFont = loadGeistMono();

// DESIGN.md tokens verbatim.
const T = {
  parchment: "#f0ebe3",
  ivory: "#faf7f0",
  ink: "#2c2926",
  inkProse: "#57564f",
  inkMuted: "#87867f",
  border: "#e0dacf",
  ochre: "#c4a574",
};

const FONT_CINZEL = `'Cinzel', Georgia, serif`;
const FONT_GEIST = `'Geist', -apple-system, system-ui, sans-serif`;
const FONT_GEIST_MONO = `'Geist Mono', 'SF Mono', monospace`;

// Beat 7 overlay content - program ID (devnet-config.json pari-market) +
// repo/track line, VERBATIM from the locked script's Beat 7 overlay spec.
const PARI_MARKET_PROGRAM_ID = "565SYmLeQ64r8kNujRpVhnfGgAybQrXz72knMyUj1xc3";

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  void cinzelFont;
  void geistFont;
  void geistMonoFont;

  const sfOpacity = spring({
    frame,
    fps,
    config: { stiffness: 80, damping: 18 },
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = sfOpacity * fadeOut;

  return (
    <AbsoluteFill style={{ background: T.parchment }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 32,
          padding: "0 120px",
          opacity,
        }}
      >
        <h2
          style={{
            fontFamily: FONT_CINZEL,
            fontSize: 64,
            fontWeight: 600,
            color: T.ink,
            letterSpacing: "0.01em",
            margin: 0,
            textAlign: "center",
          }}
        >
          This market settled by verifiable fact.
        </h2>
        <div
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 26,
            fontWeight: 400,
            color: T.inkProse,
            lineHeight: 1.6,
            textAlign: "center",
          }}
        >
          Settlement track, built solo.
        </div>

        <div
          style={{
            background: T.ivory,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: "16px 30px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
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
            }}
          >
            Pari-Market Program
          </div>
          <span
            style={{
              fontFamily: FONT_GEIST_MONO,
              fontSize: 18,
              color: T.ink,
              letterSpacing: "0.005em",
            }}
          >
            {PARI_MARKET_PROGRAM_ID}
          </span>
        </div>

        <div
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 17,
            fontWeight: 500,
            color: T.inkMuted,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            textAlign: "center",
          }}
        >
          Superteam Earn · Settlement Track
        </div>

        <div style={{ color: T.ochre, fontSize: 16 }}>◆</div>
      </div>
    </AbsoluteFill>
  );
};
