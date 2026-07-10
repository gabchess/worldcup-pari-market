import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";

const geistFont = loadGeist();
const FONT_GEIST = `'Geist', -apple-system, system-ui, sans-serif`;

// Shared lower-third disclosure shell. Text is VERBATIM from the locked
// script (D1/D2/D3) - passed in as a prop, never re-authored here.
export const Disclosure: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  void geistFont;

  const opacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "transparent" }}>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: "100%",
          padding: "28px 80px 40px",
          background:
            "linear-gradient(to top, rgba(0,0,0,0.62) 60%, rgba(0,0,0,0))",
          opacity,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT_GEIST,
            fontSize: 27,
            fontWeight: 500,
            color: "#ffffff",
            textAlign: "center",
            lineHeight: 1.45,
            maxWidth: 1500,
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
