// src/components/PageSelector.tsx — 共通ページ範囲指定コンポーネント
// 対応表記: "1-3,5,7-", "odd", "even", "-5" (末尾から5ページ), "all"

import { useState, useCallback } from "react";
//import { getTheme } from "../lib/themes";

export interface PageSelectorProps {
  totalPages:  number;
  value:       string;        // "" = 全ページ
  onChange:    (v: string) => void;
  label?:      string;
  compact?:    boolean;
}

type Mode = "" | "all" | "odd" | "even" | "range";
type Mode2 = "" | "all" | "odd" | "even" | "range";

function modeOf(v: string): Mode {
  if (!v || v === "" || v === "all") return "all";
  if (v === "odd")  return "odd";
  if (v === "even") return "even";
  return "range";
}

function modeOf2(v: string): Mode {
  if (!v || v === "") return "";
  if (v === "odd")  return "odd";
  if (v === "even") return "even";
  if (v === "all") return "all";
  return "range";
}

export function PageSelector({ totalPages, value, onChange, label, type, compact }: PageSelectorProps) {
  //const C = getTheme();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  let mode;
  if ( type === "1" ) {
     mode = modeOf(value);
  } else {
     mode = modeOf2(value);
  }

  const [rangeText, setRangeText] = useState(
    mode === "range" ? value : ""
  );
  let handleMode;
  if ( type === "1" ) {
  handleMode = useCallback((m: Mode) => {
    if (m === "")  { onChange("all"); }
    if (m === "all")  { onChange("all"); }
    if (m === "odd")  { onChange("odd"); }
    if (m === "even") { onChange("even"); }
    if (m === "range"){ onChange(rangeText || "1"); }
  }, [rangeText, onChange]);
  } else {
  handleMode = useCallback((m: Mode) => {
    if (m === "")  { onChange(""); }
    if (m === "all")  { onChange("all"); }
    if (m === "odd")  { onChange("odd"); }
    if (m === "even") { onChange("even"); }
    if (m === "range"){ onChange(rangeText || "1"); }
  }, [rangeText, onChange]);
  }
  const handleRange = useCallback((v: string) => {
    setRangeText(v);
    onChange(v);
  }, [onChange]);

  const btnBase: React.CSSProperties = {
    padding: compact ? "4px 10px" : "5px 13px",
    border: `1px solid var(--c-border)`,
    borderRadius: 6, cursor: "pointer", fontFamily: F,
    fontSize: compact ? 12 : 13, transition: "all 0.1s",
    background: "var(--c-bgCard)", color: "var(--c-textSub)",
  };
  const btnOn: React.CSSProperties = {
    ...btnBase,
    background: "var(--c-accentBg)", border: `1px solid var(--c-accentBd)`,
    color: "var(--c-accent)", fontWeight: 700,
  };
  if ( type === "1" ) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap: compact ? 4 : 6 }}>
      {label && (
        <span style={{ fontSize:11, color:"var(--c-textDim)", letterSpacing:"0.08em",
          textTransform:"uppercase" }}>
          {label}
        </span>
      )}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
        {(["all","odd","even","range"] as Mode[]).map(m => (
          <button key={m} style={mode===m ? btnOn : btnBase}
            onClick={() => handleMode(m)}>
            { m==="all"   ? "全ページ"
            : m==="odd"   ? "奇数"
            : m==="even"  ? "偶数"
            : "範囲指定" }
          </button>
        ))}
      </div>
      {mode === "range" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <input
            value={rangeText}
            onChange={e => handleRange(e.target.value)}
            placeholder="例: 1-3,5,8-10"
            style={{
              padding:"6px 10px", background:"var(--c-bgCard)",
              border:`1px solid var(--c-borderHi)`, borderRadius:6,
              color:"var(--c-text)", fontSize:13, fontFamily:F,
              width:"100%", boxSizing:"border-box",
            }}
          />
          <span style={{ fontSize:11, color:"var(--c-textDim)", lineHeight:1.5 }}>
            書式: <code style={{color:"var(--c-textSub)"}}>1-3,5,8-</code> (ハイフン末尾=最終ページまで)
          </span>
        </div>
      )}
      {totalPages > 0 && (
        <span style={{ fontSize:11, color:"var(--c-textDim)" }}>
          全 {totalPages} ページ
          {value && value !== "all" && ` / 指定: "${value}"`}
        </span>
      )}
    </div>
  );
  } else {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap: compact ? 4 : 6 }}>
      {label && (
        <span style={{ fontSize:11, color:"var(--c-textDim)", letterSpacing:"0.08em",
          textTransform:"uppercase" }}>
          {label}
        </span>
      )}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
        {(["", "odd","even", "all", "range"] as Mode2[]).map(m => (
          <button key={m} style={mode===m ? btnOn : btnBase}
            onClick={() => handleMode(m)}>
            { m===""   ? "除外なし"
            : m==="odd"   ? "奇数"
            : m==="even"  ? "偶数"
            : m==="all"   ? "全ページ"
            : "範囲指定" }
          </button>
        ))}
      </div>
      {mode === "range" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <input
            value={rangeText}
            onChange={e => handleRange(e.target.value)}
            placeholder="例: 1-3,5,8-10"
            style={{
              padding:"6px 10px", background:"var(--c-bgCard)",
              border:`1px solid var(--c-borderHi)`, borderRadius:6,
              color:"var(--c-text)", fontSize:13, fontFamily:F,
              width:"100%", boxSizing:"border-box",
            }}
          />
          <span style={{ fontSize:11, color:"var(--c-textDim)", lineHeight:1.5 }}>
            書式: <code style={{color:"var(--c-textSub)"}}>1-3,5,8-</code> (ハイフン末尾=最終ページまで)
          </span>
        </div>
      )}
      {totalPages > 0 && (
        <span style={{ fontSize:11, color:"var(--c-textDim)" }}>
          全 {totalPages} ページ
          {value && value !== "all" && ` / 指定: "${value}"`}
        </span>
      )}
    </div>
  );
  }
}

export function PageSelectorB({ totalPages, value, onChange, label, compact }: PageSelectorProps) {
  //const C = getTheme();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  const mode = modeOf2(value);
  const [rangeText, setRangeText] = useState(
    mode === "range" ? value : ""
  );

  const handleMode = useCallback((m: Mode2) => {
    if (m === "") { onChange(""); }
    if (m === "all")  { onChange("all"); }
    if (m === "odd")  { onChange("odd"); }
    if (m === "even") { onChange("even"); }
    if (m === "range"){ onChange(rangeText || "1"); }
  }, [rangeText, onChange]);

  const handleRange = useCallback((v: string) => {
    setRangeText(v);
    onChange(v);
  }, [onChange]);

  const btnBase: React.CSSProperties = {
    padding: compact ? "4px 10px" : "5px 13px",
    border: `1px solid var(--c-border)`,
    borderRadius: 6, cursor: "pointer", fontFamily: F,
    fontSize: compact ? 12 : 13, transition: "all 0.1s",
    background: "var(--c-bgCard)", color: "var(--c-textSub)",
  };
  const btnOn: React.CSSProperties = {
    ...btnBase,
    background: "var(--c-accentBg)", border: `1px solid var(--c-accentBd)`,
    color: "var(--c-accent)", fontWeight: 700,
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap: compact ? 4 : 6 }}>
      {label && (
        <span style={{ fontSize:11, color:"var(--c-textDim)", letterSpacing:"0.08em",
          textTransform:"uppercase" }}>
          {label}
        </span>
      )}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
        {(["", "odd","even", "all", "range"] as Mode2[]).map(m => (
          <button key={m} style={mode===m ? btnOn : btnBase}
            onClick={() => handleMode(m)}>
            { m===""   ? "除外なし"
            : m==="odd"   ? "奇数"
            : m==="even"  ? "偶数"
            : m==="all"   ? "全ページ"
            : "範囲指定" }
          </button>
        ))}
      </div>
      {mode === "range" && (
        <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
          <input
            value={rangeText}
            onChange={e => handleRange(e.target.value)}
            placeholder="例: 1-3,5,8-10"
            style={{
              padding:"6px 10px", background:"var(--c-bgCard)",
              border:`1px solid var(--c-borderHi)`, borderRadius:6,
              color:"var(--c-text)", fontSize:13, fontFamily:F,
              width:"100%", boxSizing:"border-box",
            }}
          />
          <span style={{ fontSize:11, color:"var(--c-textDim)", lineHeight:1.5 }}>
            書式: <code style={{color:"var(--c-textSub)"}}>1-3,5,8-</code> (ハイフン末尾=最終ページまで)
          </span>
        </div>
      )}
      {totalPages > 0 && (
        <span style={{ fontSize:11, color:"var(--c-textDim)" }}>
          全 {totalPages} ページ
          {value && value !== "all" && ` / 指定: "${value}"`}
        </span>
      )}
    </div>
  );
}

// ページ指定文字列を実際のページインデックス配列に展開
export function resolvePageSpec(spec: string, total: number): number[] {
  if (!spec || spec === "all") return Array.from({length:total},(_,i)=>i);
  if (spec === "odd")  return Array.from({length:total},(_,i)=>i).filter(i=>(i+1)%2===1);
  if (spec === "even") return Array.from({length:total},(_,i)=>i).filter(i=>(i+1)%2===0);

  // 除外ページを収集: ^N
  const excluded = new Set<number>();
  const parts = spec.split(",").map(s=>s.trim()).filter(Boolean);
  const included: number[] = [];

  for (const part of parts) {
    if (part.startsWith("^")) {
      const n = parseInt(part.slice(1));
      if (!isNaN(n) && n>=1 && n<=total) excluded.add(n-1);
      continue;
    }
    if (part.includes("-")) {
      const [a,b] = part.split("-");
      const from = a ? parseInt(a)-1 : 0;
      const to   = b ? parseInt(b)-1 : total-1;
      for (let i=Math.max(0,from); i<=Math.min(total-1,to); i++) included.push(i);
    } else {
      const n = parseInt(part)-1;
      if (!isNaN(n) && n>=0 && n<total) included.push(n);
    }
  }
  // 重複除去 + 除外適用
  return [...new Set(included)].filter(i=>!excluded.has(i)).sort((a,b)=>a-b);
}
