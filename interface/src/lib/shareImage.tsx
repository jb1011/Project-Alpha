import { ImageResponse } from "next/og";

const size = { width: 1200, height: 630 };

export function shareImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#090909",
          color: "#f2f0ea",
          padding: "72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "14px",
              height: "14px",
              borderRadius: "999px",
              background: "#93c5fd",
            }}
          />
          <div
            style={{
              fontSize: "28px",
              letterSpacing: "0.14em",
              color: "#9c9a92",
            }}
          >
            NOVI CORPUS
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxWidth: "980px" }}>
          <div
            style={{
              fontSize: "76px",
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
            }}
          >
            A company for your agent.
          </div>
          <div
            style={{
              marginTop: "28px",
              fontSize: "32px",
              lineHeight: 1.35,
              color: "#9c9a92",
            }}
          >
            Agents can already pay. Nobody will sign a contract with one,
            because there is nobody to sue.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: "26px", color: "#93c5fd" }}>
          Live on Arc testnet
        </div>
      </div>
    ),
    { ...size },
  );
}
