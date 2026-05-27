# PDF小僧 — 隠しテキスト検出・無害化 仕様書

> ⚠ **試験的機能**  
> 全ての隠しテキスト手法を網羅できる保証はありません。  
> 特殊なプロパティ・要素・フォントに潜ませたテキストは検出・置換できない場合があります。  
> 本機能の使用による損害について開発者は責任を負いません。

---

## 1. 検出コマンド一覧

### 1-1. `detect_transparent` — 透明テキスト検出

alpha値が閾値以下、または Rendering Mode が不可視（Tr=3/7）のテキストを検出する。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象PDFファイルパス |
| `page` | int | 必須 | 0始まりのページ番号 |
| `alpha_threshold` | int (0-255) | `13` (≈5%) | この値以下の alpha を検出 |

**CLIテスト例**
```bash
echo '{"cmd":"detect_transparent","path":"file.pdf","page":0}' | ./pdf-kozou-core json
echo '{"cmd":"detect_transparent","path":"file.pdf","page":0,"alpha_threshold":26}' | ./pdf-kozou-core json
```

**出力フィールド（hits 配列の各要素）**

| フィールド | 型 | 説明 |
|---|---|---|
| `char` | string | Unicode文字 |
| `alpha` | int (0-255) | fill alpha 値 |
| `color_rgb` | [R,G,B] | 文字色 (各 0-255) |
| `flags` | int | MuPDF stextフラグ |
| `reason` | string | 検出理由（後述） |
| `origin` | [x, y] | 文字原点座標 pt |
| `quad` | [8 floats] | 四隅座標 pt |
| `size` | float | フォントサイズ pt |

**reason 値**

| reason | 条件 |
|---|---|
| `invisible_mode` | `flags == 0` (Tr=3: 完全不可視) |
| `clip_only_mode` | `flags & 64` (Tr=7: クリップのみ) |
| `transparent` | ExtGState fill alpha=0 |
| `whitespace_only` | U+00A0, U+3000 等の空白系コードポイント（U+0020以外） |

---

### 1-2. `detect_low_contrast` — 低コントラストテキスト検出

WCAG コントラスト比が閾値以下のテキストを検出する（文字色と背景色がほぼ同色）。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象PDFファイルパス |
| `page` | int | 必須 | 0始まりのページ番号 |
| `contrast_threshold` | float (1.0-21.0) | `1.5` | この値以下のコントラスト比を検出 |

**CLIテスト例**
```bash
echo '{"cmd":"detect_low_contrast","path":"file.pdf","page":0}' | ./pdf-kozou-core json
echo '{"cmd":"detect_low_contrast","path":"file.pdf","page":0,"contrast_threshold":2.0}' | ./pdf-kozou-core json
```

**出力フィールド（hits の各要素）**

| フィールド | 型 | 説明 |
|---|---|---|
| `char` | string | Unicode文字 |
| `color_rgb` | [R,G,B] | 文字色 |
| `bg_color_rgb` | [R,G,B] | 背景色 |
| `contrast` | float | WCAGコントラスト比 (1.0=同色, 21.0=白黒) |
| `reason` | string | 検出理由 |
| `origin` | [x, y] | 文字原点座標 pt |
| `quad` | [8 floats] | 四隅座標 pt |
| `size` | float | フォントサイズ pt |

**reason 値**

| reason | 条件 |
|---|---|
| `low_contrast` | コントラスト比が閾値以下 |
| `whitespace_only` | 空白系コードポイント |

---

### 1-3. `detect_tiny` — 極小フォント検出

フォントサイズが閾値以下のテキストを検出する。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象PDFファイルパス |
| `page` | int | 必須 | 0始まりのページ番号 |
| `size_threshold` | float (pt) | `2.0` | この値以下のフォントサイズを検出 |

**CLIテスト例**
```bash
echo '{"cmd":"detect_tiny","path":"file.pdf","page":0}' | ./pdf-kozou-core json
echo '{"cmd":"detect_tiny","path":"file.pdf","page":0,"size_threshold":1.0}' | ./pdf-kozou-core json
```

**出力フィールド（hits の各要素）**

| フィールド | 型 | 説明 |
|---|---|---|
| `char` | string | Unicode文字 |
| `size` | float | フォントサイズ pt |
| `color_rgb` | [R,G,B] | 文字色 |
| `reason` | string | 検出理由 |
| `origin` | [x, y] | 文字原点座標 pt |
| `quad` | [8 floats] | 四隅座標 pt |

**reason 値**

| reason | 条件 |
|---|---|
| `tiny_font` | フォントサイズが閾値以下 |
| `whitespace_only` | 空白系コードポイント |

---

### 1-4. `detect_buried` — オブジェクト裏隠蔽テキスト検出

テキスト描画後に不透明な図形や画像で覆われているテキストを検出する（描画順による隠蔽）。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象PDFファイルパス |
| `page` | int | 必須 | 0始まりのページ番号 |
| `cover_ratio` | float (0.0-1.0) | `0.8` | 文字bboxの何割以上が覆われていれば検出するか |

**CLIテスト例**
```bash
echo '{"cmd":"detect_buried","path":"file.pdf","page":0}' | ./pdf-kozou-core json
echo '{"cmd":"detect_buried","path":"file.pdf","page":0,"cover_ratio":0.5}' | ./pdf-kozou-core json
```

**出力フィールド（hits の各要素）**

| フィールド | 型 | 説明 |
|---|---|---|
| `char` | string | Unicode文字 |
| `color_rgb` | [R,G,B] | 文字色 |
| `size` | float | フォントサイズ pt |
| `reason` | string | 検出理由 |
| `origin` | [x, y] | 文字原点座標 pt |
| `quad` | [8 floats] | 四隅座標 pt |

**reason 値**

| reason | 条件 |
|---|---|
| `buried` | 後から描画された図形・画像に覆われている |
| `whitespace_only` | 空白系コードポイント |

**検出アルゴリズム**

1. Pass0: `fz_stext_page` から全文字の `origin → quad幅` マップを構築
2. Pass1: `fz_run_page` で描画イベントを記録（`event_index` を付番）
3. 各文字の `event_index` より大きい `event_index` を持つ不透明図形が  
   文字bboxを `cover_ratio` 以上覆っている場合に「buried」と判定

---

### 1-5. `detect_control_chars` — 特殊制御文字検出

AIへの悪意ある注入や表示偽装に使われる特殊なUnicode制御文字を検出する。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象PDFファイルパス |
| `page` | int | 必須 | 0始まりのページ番号 |

**CLIテスト例**
```bash
echo '{"cmd":"detect_control_chars","path":"file.pdf","page":0}' | ./pdf-kozou-core json
```

**出力フィールド（hits の各要素）**

| フィールド | 型 | 説明 |
|---|---|---|
| `char` | string | コードポイント表記（例: `"U+200B"`） |
| `codepoint` | int | コードポイント十進数 |
| `category` | string | 分類（後述） |
| `reason` | string | `"control_char"` 固定 |
| `origin` | [x, y] | 文字原点座標 pt |
| `quad` | [8 floats] | 四隅座標 pt |
| `size` | float | フォントサイズ pt |

**検出対象コードポイントと category**

| category | コードポイント | 名称 |
|---|---|---|
| `zero_width` | U+200B〜U+200F | ゼロ幅スペース・LRM・RLM 等 |
| `bidi_control` | U+202A〜U+202E | 双方向制御文字（LRE/RLE/LRO/RLO/PDF） |
| `line_separator` | U+2028, U+2029 | 行区切り・段落区切り |
| `bom_zwnbsp` | U+FEFF | BOM / ゼロ幅ノーブレークスペース |
| `tag_char` | U+E0000〜U+E007F | Unicode タグ文字 |

**除外コードポイント**（正常用途が多いため検出しない）

- U+000A (LF 改行)
- U+000D (CR 復帰)
- U+0009 (TAB タブ)

---

## 2. 無害化コマンド

### `sanitize_hidden` — 隠しテキストの無害化

> ⚠ **試験的機能** — 本機能の使用による損害について開発者は責任を負いません。

検出した隠しテキストの文字コードを **U+0020（半角スペース）** に置き換え、  
フォントを **Helvetica（内蔵 Type1）** に統一し、  
**Tr=0（通常描画）・fill alpha=1.0（KOZOU_NORMAL gs）** で描画状態を正規化する。  
元のグリフ幅との差分は **TJ カーニング** で補正してレイアウトを維持する。

**入力パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `input` | string | 必須 | 入力PDFファイルパス |
| `output` | string | 必須 | 出力PDFファイルパス |
| `targets` | [{x, y}] | 必須 | 置き換え対象の文字 origin 座標リスト |
| `tolerance` | float | `1.0` | 座標照合の許容距離 pt |

**CLIテスト例（detect → sanitize の一連フロー）**
```bash
# Step1: 検出
RESULT=$(echo '{"cmd":"detect_transparent","path":"file.pdf","page":0}' | ./pdf-kozou-core json)

# Step2: targets を抽出して sanitize
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
targets = [{'x': h['origin'][0], 'y': h['origin'][1]} for h in d['hits']]
payload = {
    'cmd': 'sanitize_hidden',
    'input': 'file.pdf',
    'output': 'file_sanitized.pdf',
    'targets': targets,
    'tolerance': 1.0,
}
print(json.dumps(payload))
" | ./pdf-kozou-core json

# Step3: 再検出（0件確認）
echo '{"cmd":"detect_transparent","path":"file_sanitized.pdf","page":0}' | ./pdf-kozou-core json
```

**出力フィールド**

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | bool | 成功フラグ |
| `replaced` | int | 置き換えを試みた文字数 |
| `warning` | string | 試験的機能の免責文（常に付与） |

**KOZOU_NORMAL gs（ExtGState）**

ページリソースに自動登録される正規化用グラフィクス状態：
```
/KOZOU_NORMAL << /Type /ExtGState /ca 1.0 /CA 1.0 >>
```
各置き換え直前に `/KOZOU_NORMAL gs` を挿入して fill/stroke alpha を 1.0 に設定する。

**幅補正アルゴリズム**

1. fz_stext_page の quad から実際の描画幅を取得（RTL・縦書き・合字・CIDフォント対応）
2. Helvetica U+0020 の標準幅 = **278/1000em**
3. `diff = orig_width - 278 * n_chars`
4. `|diff| > 0.5` の場合は TJ カーニングで補正：`[(スペース列) -diff] TJ`
5. `|diff| > 200/1000em` の場合は `result.message` にワーニングを設定

**CIDフォント（Type0）対応**

- `/DescendantFonts` → `/W` 配列をパース（形式A: `[cid [w0 w1...]]`、形式B: `[c1 c2 w]`）
- `/WMode=1`（縦書き）: quad の縦方向幅を使用
- マルチバイト文字列: 2バイト = 1文字として処理

---

## 3. sanitized 判定ルール

無害化済みの文字は各検出関数で **hits から除外** される（再検出されない）。

**sanitized 判定条件（C実装）**
```c
static int kozou_is_sanitized_space(int cp) {
    return (cp == 0x0020); // U+0020 のみ
}

static int kozou_is_helvetica_font(fz_context *ctx, fz_font *font) {
    const char *name = fz_font_name(ctx, font);
    return (strstr(name, "Helvetica") != NULL ||
            strstr(name, "KOZOU_HV") != NULL);
}
// 判定: kozou_is_sanitized_space(cp) && kozou_is_helvetica_font(ctx, font)
```

つまり **Helvetica（または KOZOU_HV）フォントかつ U+0020** の文字が sanitized と判定される。  
これ以外のフォントの U+0020 や、Helvetica の U+0020 以外の文字は sanitized とみなされない。

---

## 4. reason 値の完全一覧

| reason | 検出関数 | 意味 | 無害化対象 |
|---|---|---|---|
| `invisible_mode` | transparent | Tr=3（完全不可視） | ◎ |
| `clip_only_mode` | transparent | Tr=7（クリップのみ） | ◎ |
| `transparent` | transparent | ExtGState fill alpha=0 | ◎ |
| `low_contrast` | low_contrast | 背景色とほぼ同色 | ◎ |
| `tiny_font` | tiny | 極小フォント | ◎ |
| `buried` | buried | オブジェクト裏に隠蔽 | △（デザイン意図の可能性あり） |
| `control_char` | control_chars | 特殊Unicode制御文字 | ◎ |
| `whitespace_only` | 全検出関数 | 空白系文字（無害化推奨） | △（要確認） |

---

## 5. whitespace_only の扱い

`whitespace_only` は以下のコードポイントに対して付与される（U+0020は除く）：

| コードポイント | 名称 |
|---|---|
| U+00A0 | ノーブレークスペース |
| U+3000 | 全角スペース |
| U+2000〜U+200A | 各種幅スペース |
| U+0009 | タブ |
| U+000D | CR |

`whitespace_only` の文字は **hits に含まれるが**、GUI 上では無害化の自動選択対象外となる。  
ユーザーが明示的に選択した場合のみ無害化できる。

---

## 6. 検出されない可能性がある隠しテキスト手法

以下の手法は現時点で検出対象外または検出精度が低い可能性がある：

- PDF の XObject（フォームや画像オブジェクト）内に埋め込まれたテキスト
- Optional Content（PDF レイヤー）で非表示にされたテキスト
- JavaScript や AcroForm フィールドに格納されたテキスト
- メタデータ（XMP, DocInfo）に埋め込まれたテキスト
- 特殊な CMap エンコーディングで意図的に誤マップされたテキスト
- ページコンテンツ外の構造（PDF ツリー、注釈、添付ファイル等）

---

## 7. テスト用サンプルPDF

| ファイル名 | 内容 | 検出コマンド |
|---|---|---|
| `test_transparent2.pdf` | alpha=0 / alpha=5% の透明テキスト | `detect_transparent` |
| `test_tr3.pdf` | Tr=3（invisible_mode）/ Tr=7（clip_only_mode） | `detect_transparent` |
| `test_color.pdf` | 白地白字・黒地黒字・赤地赤字・近似青 | `detect_low_contrast` |
| `test_tiny.pdf` | 2pt以下の極小フォント | `detect_tiny` |
| `test_buried.pdf` | 白・灰色矩形で覆われた水平テキスト | `detect_buried` |
| `test_buried_v.pdf` | 下半分・ほぼ全体を覆った縦横混合 | `detect_buried` |
| `test_control_malicious.pdf` | ZWSP(U+200B)・LRM(U+200E)・RLO(U+202E) | `detect_control_chars` |

---

## 8. Tauri コマンド（フロントエンド）

```typescript
import {
  detectTransparentText,   // (path, page, alphaThreshold?, options?) => DetectTransparentResponse
  detectLowContrastText,   // (path, page, contrastThreshold?, options?) => DetectLowContrastResponse
  detectTinyText,          // (path, page, sizeThreshold?, options?) => DetectTinyResponse
  detectBuriedText,        // (path, page, coverRatio?, options?) => DetectBuriedResponse
  detectControlChars,      // (path, page, options?) => DetectControlCharsResponse
  sanitizeHiddenText,      // (req: SanitizeRequest) => SanitizeResponse
} from "../lib/tauri";

// 使用例
const detected = await detectTransparentText("file.pdf", 0, 0.05);
const targets = detected.hits
  .filter(h => h.reason !== "whitespace_only")
  .map(h => ({ x: h.origin[0], y: h.origin[1] }));

const result = await sanitizeHiddenText({
  input: "file.pdf",
  output: "file_sanitized.pdf",
  targets,
  tolerance: 1.0,
});
```
