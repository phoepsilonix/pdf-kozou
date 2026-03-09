// src/components/ThemeSwitcher.tsx
import { useState, useCallback } from "react";
import { THEMES, getTheme, type ThemeId } from "../lib/themes";

interface Props {
  currentId: ThemeId;
  onChange:  (id: ThemeId) => void;
}

export function ThemeSwitcher({ currentId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const C = getTheme();
  const F = "'JetBrains Mono','Noto Sans JP',monospace";
  const cur = THEMES[currentId];

  const handlePick = useCallback((id: ThemeId) => {
    onChange(id);
    setOpen(false);
  }, [onChange]);

  return (
    <div style={{ position:"relative" }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          display:"flex", alignItems:"center", gap:6,
          padding:"5px 12px",
          background:"transparent", border:`1px solid var(--c-borderHi)`,
          borderRadius:7, color:"var(--c-textSub)", cursor:"pointer",
          fontFamily:F, fontSize:12, transition:"all 0.12s",
        }}
        title="テーマ切り替え"
      >
        <span style={{fontSize:15}}>{cur.emoji}</span>
        <span>{cur.name}</span>
        <span style={{fontSize:10, color:"var(--c-textDim)"}}>▾</span>
      </button>

      {open && (
        <>
          <div style={{position:"fixed",inset:0,zIndex:999}} onClick={() => setOpen(false)}/>
          <div style={{
            position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:1000,
            background:"var(--c-bgCard)", border:`1px solid var(--c-border)`,
            borderRadius:10, boxShadow:"0 8px 32px rgba(0,0,0,0.55)",
            overflow:"hidden", minWidth:190,
          }}>
            <div style={{padding:"8px 14px", fontSize:11, color:"var(--c-textDim)",
              letterSpacing:"0.1em", borderBottom:`1px solid var(--c-border)`,
              background:"var(--c-bgHover)"}}>
              🎨 テーマ
            </div>
            {(Object.values(THEMES) as Array<typeof THEMES[ThemeId]>).map(t => (
              <button key={t.id} onClick={() => handlePick(t.id as ThemeId)}
                style={{
                  display:"flex", alignItems:"center", gap:10,
                  width:"100%", padding:"10px 14px",
                  background: t.id === currentId ? "var(--c-accentBg)" : "transparent",
                  border:"none", borderBottom:`1px solid var(--c-border)`,
                  cursor:"pointer", fontFamily:F, textAlign:"left" as const,
                  transition:"background 0.08s",
                }}>
                {/* カラースウォッチ */}
                <div style={{display:"flex", gap:3, flexShrink:0}}>
                  {[t.bg, t.bgCard, t.accent].map((col, i) => (
                    <div key={i} style={{
                      width:11, height:11, borderRadius:"50%",
                      background:col, border:`1px solid ${t.borderHi}`,
                    }}/>
                  ))}
                </div>
                <span style={{fontSize:14}}>{t.emoji}</span>
                <span style={{
                  fontSize:13, color: t.id===currentId ? "var(--c-accent)" : "var(--c-text)",
                  fontWeight: t.id===currentId ? 700 : 400,
                }}>{t.name}</span>
                {t.id === currentId &&
                  <span style={{marginLeft:"auto", fontSize:13, color:"var(--c-accent)"}}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
