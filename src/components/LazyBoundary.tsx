// src/components/LazyBoundary.tsx
import { Component, type ReactNode } from "react";
export class LazyBoundary extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  render() {
    if (this.state.err)
      return (
        <div style={{ padding: 40, textAlign: "center" }}>
          ツールの読み込みに失敗しました。
          <button onClick={() => location.reload()} style={{ marginLeft: 8 }}>
            再読み込み
          </button>
        </div>
      );
    return this.props.children;
  }
}
