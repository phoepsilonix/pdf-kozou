// src/components/LazyBoundary.tsx
// lazy() で読み込むツールページのチャンク読み込み失敗を捕捉するエラーバウンダリ。
// Suspense の外側に置くことで、チャンク読み込みエラー時に例外がルートまで伝播して
// アプリ全体(上部メニュー含む)が白画面になるのを防ぐ。
//
// 改良点:
//  - 「再試行」(エラー状態のみ解除) と「再読み込み」(location.reload) の2ボタン。
//  - resetKey(= activeTool 等) が変わったらエラー状態を自動解除する。
//    これにより、あるツールで読み込みエラーが出ても、別ツールへ切り替えれば
//    再読み込みなしで自動復帰する。
import { Component, type ReactNode } from "react";
import { FS } from "../lib/typography";

type Props = {
  children: ReactNode;
  /** これが変化するとエラー状態を自動解除する(例: activeTool)。 */
  resetKey?: string | number;
};
type State = {
  hasError: boolean;
  message: string;
  /** 直近に観測した resetKey。 */
  key?: string | number;
};

export class LazyBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  // resetKey が変わったらエラーを解除(ツール切替で自動復帰)。
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) {
      return { key: props.resetKey, hasError: false, message: "" };
    }
    return null;
  }

  componentDidCatch(err: unknown) {
    console.error("[LazyBoundary] tool failed to load:", err);
  }

  private retry = () => this.setState({ hasError: false, message: "" });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 40,
          textAlign: "center",
          color: "var(--c-text)",
        }}
      >
        <span style={{ fontSize: 32 }}>⚠</span>
        <div style={{ fontSize: FS.label, fontWeight: 600 }}>ツールの読み込みに失敗しました</div>
        {this.state.message && (
          <div
            style={{
              fontSize: FS.small,
              color: "var(--c-textDim)",
              maxWidth: 420,
              wordBreak: "break-word",
            }}
          >
            {this.state.message}
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={this.retry} style={btn(false)}>
            再試行
          </button>
          <button type="button" onClick={() => location.reload()} style={btn(true)}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }
}

function btn(accent: boolean): React.CSSProperties {
  return {
    padding: "9px 22px",
    borderRadius: 8,
    border: `1px solid ${accent ? "var(--c-accentBd)" : "var(--c-border)"}`,
    background: accent ? "var(--c-accentBg)" : "var(--c-bgCard)",
    color: accent ? "var(--c-accent)" : "var(--c-text)",
    fontWeight: 600,
    cursor: "pointer",
  };
}
