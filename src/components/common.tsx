// src/components/common.tsx — 共通 UI コンポーネント
import { C, F } from "../lib/theme";

export function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", height:"100%", gap:18, background:C.bg }}>
      <div style={{ width:36, height:36, border:`3px solid ${C.border}`,
                    borderTop:`3px solid ${C.accent}`, borderRadius:"50%",
                    animation:"spin 0.8s linear infinite" }} />
      {label && <span style={{ color:C.textSub, fontSize:14, fontFamily:F }}>{label}</span>}
    </div>
  );
}

export function ErrorView({ msg, onBack }: { msg: string; onBack: () => void }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                  justifyContent:"center", height:"100%", gap:16,
                  background:C.bg, fontFamily:F }}>
      <span style={{ fontSize:42, color:C.err }}>✕</span>
      <span style={{ fontSize:16, fontWeight:600, color:"#ff7070" }}>エラーが発生しました</span>
      <pre style={{ fontSize:12, color:"#cc5555", background:C.errBg,
                    border:`1px solid ${C.errBd}`, borderRadius:8,
                    padding:"12px 18px", maxWidth:520,
                    whiteSpace:"pre-wrap", wordBreak:"break-all" }}>{msg}</pre>
      <button style={{ padding:"9px 24px", background:"transparent",
                       border:`1px solid ${C.errBd}`, borderRadius:8,
                       color:"#cc5555", cursor:"pointer", fontSize:14, fontFamily:F }}
        onClick={onBack}>← 戻る</button>
    </div>
  );
}

export function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12,
                  padding:"0 22px", height:52, borderBottom:`1px solid ${C.border}`,
                  flexShrink:0, background:C.bg }}>
      {children}
    </div>
  );
}

export function BtnBack({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ padding:"6px 16px", background:"transparent",
               border:`1px solid ${C.borderHi}`, borderRadius:7,
               color:C.textSub, cursor:"pointer", fontSize:13, fontFamily:F }}>
      ← 戻る
    </button>
  );
}

export function BtnPrimary({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding:"11px 28px", background: disabled ? C.bgCard : C.accentBg,
               border:`1px solid ${disabled ? C.border : C.accentBd}`, borderRadius:8,
               color: disabled ? C.textDim : C.accent,
               fontWeight:700, cursor: disabled ? "not-allowed" : "pointer",
               fontSize:14, fontFamily:F, opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}

// サムネイルカード (共通)
export function ThumbCard({ b64, pageNum, width=80, selected=false,
                            onClick }: {
  b64?: string; pageNum: number; width?: number;
  selected?: boolean; onClick?: () => void;
}) {
  const h = Math.round(width * 1.414);
  return (
    <button onClick={onClick}
      style={{ display:"flex", flexDirection:"column", alignItems:"center",
               gap:5, padding:"6px 5px", borderRadius:7,
               border:`1px solid ${selected ? C.accent : C.border}`,
               background: selected ? C.accentBg : C.bgCard,
               cursor: onClick ? "pointer" : "default",
               transition:"all 0.1s", fontFamily:F }}>
      {b64
        ? <img src={`data:image/jpeg;base64,${b64}`}
               style={{ width, height:h, objectFit:"cover", borderRadius:3, display:"block" }} alt="" />
        : <div style={{ width, height:h, background:C.border, borderRadius:3 }} />}
      <span style={{ fontSize:11, color: selected ? C.accent : C.textDim }}>{pageNum}</span>
    </button>
  );
}
