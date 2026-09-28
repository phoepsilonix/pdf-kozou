// src/lib/trimCompress.ts
// トリミング結果に対する「redact + オブジェクトストリーム有効の標準圧縮」。
// トリミングは CropBox を設定するだけで領域外の内容が残るため、圧縮(redact)と
// 連携させて物理的に削除する。単体トリミングのプレビュー時と、バッチトリミングの
// 各ファイル出力時の両方から同じ設定で呼び出す。

import { usePdfStore } from "../store/usePdfStore";
import { type CompressRequest, type CompressResponse, compressPdf } from "./tauri";

export interface TrimCompressLayout {
  layoutW?: number;
  layoutH?: number;
  layoutEm?: number;
}

/**
 * `inputPath`(トリミング済み PDF) を redact + オブジェクトストリーム有効の
 * 標準プリセットで圧縮して `outputPath` に書き出す。
 * redact の余白は圧縮画面の設定(usePdfStore)に従う。
 */
export async function compressTrimmedPdf(
  inputPath: string,
  outputPath: string,
  layout: TrimCompressLayout = {},
): Promise<CompressResponse> {
  const st = usePdfStore.getState();
  const redactMarginOpts: Pick<
    CompressRequest,
    | "redact_margin_pt"
    | "redact_margin_top"
    | "redact_margin_bottom"
    | "redact_margin_left"
    | "redact_margin_right"
  > = st.redactMarginLinked
    ? { redact_margin_pt: st.redactMarginPt }
    : {
        redact_margin_pt: st.redactMarginPt,
        redact_margin_top: st.redactMarginTop,
        redact_margin_bottom: st.redactMarginBottom,
        redact_margin_left: st.redactMarginLeft,
        redact_margin_right: st.redactMarginRight,
      };
  return compressPdf(inputPath, outputPath, {
    preset: "standard",
    // object_stream は garbage_level >= 2 が必須(compress.rs で検証される)。
    // プリセットの中身に暗黙に頼らないよう明示する。
    garbage_level: 2,
    redact_outside_crop: true,
    object_stream: true,
    ...redactMarginOpts,
    layout_w: layout.layoutW,
    layout_h: layout.layoutH,
    layout_em: layout.layoutEm,
  });
}
