# XObject 対応 隠しテキスト無害化 仕様書

## 背景・問題

### 現状の制限

`sanitize_hidden` はページのトップレベルコンテンツストリームのみを対象として
BT〜ET ブロックを書き換えるため、**XObject の内部にある隠しテキストを無害化できない**。

### 具体例（このPDFで確認済み）

```
X32（ページ全体 Form XObject）
  ├── X24（xref=123）← 文字列 Form XObject
  │     ├── BT /F36 ... <08><06><13><11> ET  ← 白色 Type3（不可視）
  │     └── BT /F37 ... <0008><0006><0013><0011> ET  ← 赤色（可視だが後で隠される）
  ├── X11（xref=43）← 緑ヘッダー帯  ★X24より後に描画 → 文字列を覆う
  └── X13（xref=48）← 写真
```

- 検出時: MuPDF stext はページ座標系の origin を返す → 検出は正しく機能
- 無害化時: ページ座標でコンテンツストリームを検索しても XObject 内部は見つからない → 失敗

---

## 設計方針

### 基本原則

「**どの XObject の、どの BT ブロックか**」を検出時に記録し、
無害化時にそのストリームをピンポイントで書き換える。

- XObject xref 番号は PDF 内でユニーク
- xref + XObject 内部座標の組み合わせは実質的に一意
- 異なる XObject に同じ内部座標が存在しても xref が異なれば別物として処理できる

---

## 変更内容

### 1. C層（mupdf_safe.c）

#### 1-1. テキストイベント構造体に XObject 情報を追加

```c
typedef struct {
    int   event_index;
    int   xobj_xref;      // 所属 XObject の xref（0 = ページトップレベル）
    float ix, iy;         // XObject 内部座標系での origin
    float ox, oy;         // ページ座標系での origin（既存）
    float x0, y0, x1, y1; // グリフ bbox（ページ座標系）
} KozouTextEvent;
```

#### 1-2. カバーオブジェクト構造体に XObject 情報を追加

```c
typedef struct {
    int   event_index;
    int   xobj_xref;      // 所属 XObject の xref
    float x0, y0, x1, y1; // ページ座標系での bbox
} KozouCoverRect;
```

#### 1-3. begin_group / end_group で XObject xref を追跡

```c
// XObject スタック（最大深度 32）
typedef struct {
    int xref;
    fz_matrix ctm;  // XObject → ページへの変換行列
} KozouXObjFrame;

// fill_text ハンドラ内で現在の xref を記録
te->xobj_xref = dev->xobj_stack[dev->xobj_depth].xref;
te->ix = /* ctm の逆変換を使って内部座標を計算 */;
te->iy = /* 同上 */;
```

#### 1-4. JSON 出力に xobj_xref と内部座標を追加

全検出関数（transparent / low_contrast / tiny / buried）の JSON 出力に追加：

```json
{
  "char": "文",
  "origin": [443.56, 661.12],
  "xobj_xref": 123,
  "internal_origin": [0.0, 125.0],
  "quad": [...],
  "size": 10.16,
  "is_type3": false
}
```

#### 1-5. kozou_sanitize_hidden_text の拡張

```c
typedef struct {
    float   page_x, page_y;     // ページ座標系での origin（既存）
    int     xobj_xref;           // 対象 XObject の xref（0 = トップレベル）
    float   internal_x, internal_y; // XObject 内部座標系での origin
} KozouSanitizeTarget;
```

処理フロー：

```
for each target:
  if target.xobj_xref == 0:
    // 従来通りページトップレベルのストリームを書き換え
    sanitize_in_stream(page_stream, target.page_x, target.page_y)
  else:
    // XObject のストリームを取得して書き換え
    stream = pdf_load_stream(doc, target.xobj_xref)
    sanitize_in_stream(stream, target.internal_x, target.internal_y)
    pdf_update_stream(doc, target.xobj_xref, stream)
```

### 2. Rust 層（stext.rs）

#### 2-1. Hit 構造体に xobj_xref と内部座標を追加

```rust
pub struct TransparentChar {
    // ...既存フィールド...
    #[serde(default)]
    pub xobj_xref: i32,          // 0 = トップレベル
    #[serde(default)]
    pub internal_origin: [f32; 2], // XObject 内部座標
}
// LowContrastChar / TinyChar / BuriedChar も同様
```

#### 2-2. SanitizeOrigin に xobj_xref と内部座標を追加

```rust
pub struct SanitizeOrigin {
    pub x: f32,               // ページ座標（既存）
    pub y: f32,               // ページ座標（既存）
    #[serde(default)]
    pub xobj_xref: i32,       // 0 = トップレベル
    #[serde(default)]
    pub internal_x: f32,      // XObject 内部座標
    #[serde(default)]
    pub internal_y: f32,      // XObject 内部座標
}
```

### 3. TS 層（tauri.ts / HiddenTextPage.tsx）

#### 3-1. AnyHit に xobj_xref と内部座標を追加

```ts
type AnyHit = {
  // ...既存フィールド...
  xobjXref: number; // 0 = トップレベル
  internalOrigin: [number, number];
};
```

#### 3-2. toAnyHits で xobjXref と internalOrigin をマッピング

```ts
xobjXref: h.xobj_xref ?? 0,
internalOrigin: h.internal_origin ?? [h.origin[0], h.origin[1]],
```

#### 3-3. sanitizeHiddenText に渡す SanitizeOrigin に xobj 情報を含める

```ts
const targets: SanitizeOrigin[] = hits
  .filter(...)
  .map(h => ({
    x: h.origin[0],
    y: h.origin[1],
    xobj_xref: h.xobjXref,
    internal_x: h.internalOrigin[0],
    internal_y: h.internalOrigin[1],
  }));
```

---

## 座標変換の詳細

XObject の内部座標系とページ座標系の変換は `fz_matrix` で管理される。

```
ページ座標 = ctm × 内部座標

内部座標 = ctm^(-1) × ページ座標
```

`begin_group` ハンドラで受け取る `ctm` が「XObject → ページ」の変換行列。
`fz_invert_matrix` でその逆変換を得て、fill_text 時のページ座標から内部座標を計算する。

---

## エラーケースの処理

| ケース                                 | 対応                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| `xobj_xref` のストリームが取得できない | ページ座標での書き換えにフォールバック               |
| 内部座標でのマッチングに失敗           | その target をスキップ（ログ出力）                   |
| ネスト XObject（XObject 内の XObject） | 現フェーズでは深さ 1 まで対応（最外 XObject を対象） |
| `xobj_xref == 0`（トップレベル）       | 従来の処理を使用                                     |

---

## 実装対象外（将来課題）

- **XObject のネスト深さ 2 以上**への対応（現実の PDF では稀）
- **Type3 フォントの BT ブロック選択的削除**（可視グリフと不可視グリフが混在する場合）

---

## テストケース

| PDF                        | 検出種別                | 期待結果                  |
| -------------------------- | ----------------------- | ------------------------- |
| 文字列                     | buried / XObject内部    | 無害化成功                |
| 文字列                     | transparent / Type3重複 | Type3スキップ（既存仕様） |
| トップレベルの隠しテキスト | 全種別                  | 従来通り無害化成功        |

---

## 実装完了内容（追記）

### 共通化アプローチ

全4検出関数で統一した実装パターンを適用。

#### `KozouXObjDevice`（共通コンポーネント）

```c
typedef struct {
    fz_device      base;
    KozouXObjFrame stack[KOZOU_XOBJ_MAX_DEPTH];
    int            depth;
    KozouCharXObj  chars[KOZOU_XOBJ_CHAR_MAX]; // (page_x, page_y, xref, ix, iy)
    int            char_count;
} KozouXObjDevice;
```

- `kozou_xobj_fill_text`: 文字ごとに `(page_x, page_y, xobj_xref, ix, iy)` を記録
- `kozou_xobj_begin_group` / `kozou_xobj_end_group`: XObject スタック管理
- `kozou_xobj_lookup(dev, px, py, tol)`: ページ座標でルックアップ → `KozouCharXObj*` を返す

#### 各検出関数の処理フロー（transparent / low_contrast / tiny）

```
1. fz_new_stext_page_from_page() → stext 取得
2. kozou_new_xobj_device() + fz_run_page() → XObject情報を収集
3. stext をスキャンして文字を検出
4. ch->origin で kozou_xobj_lookup() → xobj_xref と内部座標を取得
5. JSON に "xobj_xref" と "internal_origin" を出力
6. fz_drop_device(xobj_dev) でクリーンアップ
```

#### buried 関数の処理フロー

buried は既存の `KozouTextEvt` 自体に xobj 情報を記録する方式（`matched->xobj_xref`）。
stext-based 3関数とは実装経路が異なるが、出力 JSON の形式は同一。

#### JSON 出力形式（全4関数共通）

```json
{
  "char": "文",
  "origin": [443.56, 661.12],
  "xobj_xref": 123,
  "internal_origin": [0.0, 125.0],
  "quad": [...],
  "size": 10.16,
  "is_type3": false
}
```

### 取り違えが起きない理由

- `xobj_xref` は PDF 内でユニークな整数
- 同一 `xobj_xref` 内でも `(ix, iy)` の内部座標で文字を特定
- `kozou_sanitize_is_xobj_target()` が `(xref, ix, iy, tolerance)` の4条件でマッチング
- トップレベル（`xobj_xref == 0`）と XObject 内部は完全に分離して処理
