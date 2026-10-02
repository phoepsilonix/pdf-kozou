// src/components/NumInput.tsx
// IME(全角入力)・多言語キーボードに対応した数値入力欄。
// type="number" は IME 確定後の全角数字を受け付けず value が空になってしまうため、
// type="text" + inputMode で数字キーボードを出しつつ、全角→半角の正規化を行う。

import { useEffect, useRef, useState } from "react";
import { normalizeNumberText, parseNumberText } from "../lib/numInput";

export interface NumInputProps {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  /** ↑↓キーでの増減幅(既定 1) */
  step?: number;
  /** true なら小数を許さず四捨五入する(既定 true) */
  integer?: boolean;
  /** true なら入力中も有効な値のたびに onChange する。false なら blur/Enter で確定 */
  live?: boolean;
  /** blur 時に空・不正だった場合の値。省略時は直前の value に戻す */
  fallback?: number;
  id?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  "aria-label"?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function NumInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  integer = true,
  live = false,
  fallback,
  id,
  style,
  disabled,
  "aria-label": ariaLabel,
  inputRef,
}: NumInputProps) {
  const [text, setText] = useState(String(value));
  const composing = useRef(false);

  // 外部から値が変わったときだけ表示を同期(入力途中の "1." などは壊さない)
  useEffect(() => {
    setText((cur) => (parseNumberText(cur) === value ? cur : String(value)));
  }, [value]);

  const clamp = (n: number) => {
    let v = integer ? Math.round(n) : n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const handleText = (raw: string) => {
    const norm = normalizeNumberText(raw);
    setText(norm);
    if (live) {
      const n = parseNumberText(norm);
      if (Number.isFinite(n)) onChange(integer ? Math.round(n) : n);
    }
  };

  const commit = () => {
    const n = parseNumberText(text);
    const v = Number.isFinite(n) ? clamp(n) : (fallback ?? value);
    setText(String(v));
    if (v !== value || live) onChange(v);
  };

  const bump = (dir: 1 | -1) => {
    const cur = parseNumberText(text);
    const base = Number.isFinite(cur) ? cur : value;
    const v = clamp(base + dir * step);
    setText(String(v));
    onChange(v);
  };

  return (
    <input
      id={id}
      ref={inputRef}
      type="text"
      inputMode={integer && (min === undefined || min >= 0) ? "numeric" : "decimal"}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="done"
      aria-label={ariaLabel}
      disabled={disabled}
      style={style}
      value={text}
      onChange={(e) => {
        // IME 変換中は触らず、確定(compositionend)で正規化する
        if (composing.current || (e.nativeEvent as InputEvent).isComposing) {
          setText(e.target.value);
          return;
        }
        handleText(e.target.value);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        handleText(e.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          bump(1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          bump(-1);
        }
      }}
    />
  );
}
