// src/components/common.tsx — 共通 UI コンポーネント
import { C, F } from "../lib/theme";

export function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", height:"100%", gap:18, background:"var(--c-bg)" }}>
      <div style={{ width:36, height:36, border:`3px solid var(--c-border)`,
                    borderTop:`3px solid var(--c-accent)`, borderRadius:"50%",
                    animation:"spin 0.8s linear infinite" }} />
      {label && <span style={{ color:"var(--c-textSub)", fontSize:14, fontFamily:F }}>{label}</span>}
    </div>
  );
}

export function ErrorView({ msg, onBack }: { msg: string; onBack: () => void }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", height:"100%", gap:16,
                  background:"var(--c-bg)", fontFamily:F }}>
      <span style={{ fontSize:42, color:"var(--c-err)" }}>✕</span>
      <span style={{ fontSize:16, fontWeight:600, color:"#ff7070" }}>エラーが発生しました</span>
      <pre style={{ fontSize:12, color:"#cc5555", background:"var(--c-errBg)",
                    border:`1px solid var(--c-errBd)`, borderRadius:8,
                    padding:"12px 18px", maxWidth:520,
                    whiteSpace:"pre-wrap", wordBreak:"break-all" }}>{msg}</pre>
      <button style={{ padding:"9px 24px", background:"transparent",
                       border:`1px solid var(--c-errBd)`, borderRadius:8,
                       color:"#cc5555", cursor:"pointer", fontSize:14, fontFamily:F }}
        onClick={onBack}>← 戻る</button>
    </div>
  );
}

export function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12,
                  padding:"0 22px", height:52, borderBottom:`1px solid var(--c-border)`,
                  flexShrink:0, background:"var(--c-bg)" }}>
      {children}
    </div>
  );
}

export function BtnBack({ onClick }: { onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button onClick={onClick}
      style={{ padding:"6px 16px", background:"transparent",
               border:`1px solid var(--c-borderHi)`, borderRadius:7,
               color:"var(--c-textSub)", cursor:"pointer", fontSize:13, fontFamily:F }}>
      ← 戻る
    </button>
  );
}

export function BtnPrimary({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding:"11px 28px", background: disabled ? "var(--c-bgCard)" : "var(--c-accentBg)",
               border:`1px solid ${disabled ? "var(--c-border)" : "var(--c-accentBd)"}`, borderRadius:8,
               color: disabled ? "var(--c-textDim)" : "var(--c-accent)",
               fontWeight:700, cursor: disabled ? "not-allowed" : "pointer",
               fontSize:14, fontFamily:F, opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}

// サムネイルカード (共通)
export function ThumbCard({ b64, pageNum, width=80, selected=false,
                            aspectRatio, onClick }: {
  b64?: string; pageNum: number; width?: number;
  selected?: boolean; aspectRatio?: number; onClick?: () => void;
}) {
  // aspectRatio = w/h。横長(>1)でも縦長(<1)でも適切な高さに
  const ratio = aspectRatio ?? (1 / 1.414);
  const h = Math.round(width / ratio);
  return (
    <button onClick={onClick}
      style={{ display:"flex", flexDirection:"column", alignItems:"center",
               gap:5, padding:"6px 5px", borderRadius:7,
               border:`1px solid ${selected ? "var(--c-accent)" : "var(--c-border)"}`,
               background: selected ? "var(--c-accentBg)" : "var(--c-bgCard)",
               cursor: onClick ? "pointer" : "default",
               transition:"all 0.1s", fontFamily:F }}>
      <div style={{ width, height:h, background:"var(--c-bgCard)", borderRadius:3,
                   display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
        {b64
          ? <img src={`data:image/jpeg;base64,${b64}`}
                 style={{ maxWidth:width, maxHeight:h, objectFit:"contain", borderRadius:3, display:"block" }} alt="" />
          : <div style={{ width, height:h, background:"var(--c-border)", borderRadius:3 }} />}
      </div>
      <span style={{ fontSize:13, color: selected ? "var(--c-accent)" : "var(--c-textDim)" }}>{pageNum}</span>
    </button>
  );
}
