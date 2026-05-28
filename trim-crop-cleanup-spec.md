# トリミング後 CropBox 外リソース削除 仕様書

## 背景・問題

MuPDF の `trim`（CropBox 設定）は表示領域を変えるだけでコンテンツを削除しない。
トリミング後も CropBox 外の描画命令・画像・フォントがストリーム内に残るため、
ファイルサイズが元ファイルとほぼ変わらない。

gs の再構築と異なり、本機能は**レイアウトを維持したまま**不要なリソースを除去する。

---

## 削除対象の判定基準

**「CropBox と矩形が全く重ならない XObject の Do 命令」のみ削除する。**

- 一部でも CropBox と重なる XObject は**残す**（レイアウト破壊を防ぐ）
- テキスト BT〜ET ブロックは**削除しない**（座標追跡が複雑で誤削除リスクが高い）
- 図形パス命令（`re` / `l` / `c`）は**削除しない**（同上）
- 完全に CropBox 外の Do 命令を削除 → 未参照になった XObject を GC で除去

### 判定フロー

```
for each ページ:
  crop = CropBox 座標 (PDF 座標系, Y上向き)
  CTM = 単位行列で開始

  コンテンツストリームをトークン解析:
    q  → CTM スタックに push
    Q  → CTM スタックから pop
    cm → CTM を更新
    /Name Do:
      xobj_bbox = XObject の /BBox (PDF 座標系)
      xobj_rect = CTM × xobj_bbox をページ座標に変換
      if NOT intersects(crop, xobj_rect):
        この Do 命令を削除（前の /Name も削除）

  doc.compress() で未参照 XObject を GC 削除
```

---

## 座標変換の詳細

PDF のコンテンツストリームでは CTM（Current Transformation Matrix）が累積される。

```
ページ座標 = CTM × XObject内部座標
```

`q` / `Q` でスタック管理、`a b c d e f cm` で行列を左乗算：

```
新CTM = [a b c d e f] × 現在のCTM
```

XObject の `/BBox [x0 y0 x1 y1]` を 4隅の点に変換して CTM を適用し、
その外接矩形と CropBox の交差を判定する。

### 交差判定

```
intersects(crop, rect):
  rect.x1 > crop.x0 AND rect.x0 < crop.x1
  AND rect.y1 > crop.y0 AND rect.y0 < crop.y1
```

厳密に「完全に外側」のときのみ削除する（部分重なりは保持）。

---

## 実装

### Rust モジュール

`pdf-kozou-core/src/crop_cleanup.rs`（新規）

```rust
pub fn remove_out_of_crop_resources(
    input: &str,
    output: &str,
) -> Result<CleanupStats, String>

pub struct CleanupStats {
    pub pages_processed: usize,
    pub do_ops_removed: usize,   // 削除した Do 命令数
    pub objects_gc: usize,       // GC で削除したオブジェクト数
}
```

### trim.rs との統合

`trim()` 関数の `copy_metadata_after_write` の直前に呼び出す：

```rust
// トリミング後に CropBox 外リソースを削除
let cleanup = crop_cleanup::remove_out_of_crop_resources(&tmp_path, output)?;
```

---

## エラーケース

| ケース                            | 対応                                               |
| --------------------------------- | -------------------------------------------------- |
| `/BBox` がない XObject            | 保持する（安全側に倒す）                           |
| CTM が特異行列（スケール=0）      | 保持する                                           |
| ネスト XObject（XObject 内の Do） | 現フェーズでは対応しない（ページトップレベルのみ） |
| 複数コンテンツストリーム          | すべて結合して処理                                 |

---

## 期待効果

Canva 等で作成した PDF をトリミングした場合：

- ページ全体の XObject が多数ある（写真・装飾ブロックごとに独立）
- 上半分だけを残したとき、下半分の写真・装飾 XObject が丸ごと削除される
- 削除された XObject に固有のフォント・画像も GC で連鎖削除される

**期待削減率：トリミング割合に比例（例：50% トリミング → 約 40〜50% 削減）**
