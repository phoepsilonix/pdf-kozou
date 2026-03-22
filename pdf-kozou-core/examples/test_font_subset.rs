// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// examples/test_font_subset.rs
//
// font_subset の FFI 実装を単体でテストする。
//
// 使い方:
//   cargo run --example test_font_subset -- input.pdf output.pdf [--gc 2] [--sanitize]
//
// テスト観点:
//   1. C ラッパー経由で longjmp が Rust スタックに漏れないか
//   2. 出力 PDF が正しく生成されるか (ファイルサイズ > 0)
//   3. Type3 フォント含有 PDF で適切にフォールバックするか
//   4. エラー時 (不正パス等) に panic せず Err を返すか

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!("使い方: {} <input.pdf> <output.pdf> [--gc N] [--sanitize] [--no-compress-images] [--no-compress-fonts]", args[0]);
        eprintln!();
        eprintln!("オプション:");
        eprintln!("  --gc N              ガベージコレクションレベル 0-4 (デフォルト: 2)");
        eprintln!("  --sanitize          ストリーム再解釈を有効にする");
        eprintln!("  --no-compress-images 画像を圧縮しない");
        eprintln!("  --no-compress-fonts  フォントストリームを圧縮しない");
        eprintln!();
        eprintln!("テスト 1: 通常 PDF");
        eprintln!("  cargo run --example test_font_subset -- normal.pdf out_normal.pdf");
        eprintln!();
        eprintln!("テスト 2: Type3 フォント含有 PDF");
        eprintln!("  cargo run --example test_font_subset -- type3.pdf out_type3.pdf");
        eprintln!();
        eprintln!("テスト 3: エラーハンドリング (存在しないファイル)");
        eprintln!("  cargo run --example test_font_subset -- /nonexistent.pdf /tmp/out.pdf");
        std::process::exit(1);
    }

    let input = &args[1];
    let output = &args[2];

    // オプション解析
    let mut gc = 2i32;
    let mut clean = false;
    let mut sanitize = false;
    let mut compress_images = true;
    let mut compress_fonts = true;

    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--gc" => {
                i += 1;
                gc = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(2);
            }
            "--clean" => clean = true,
            "--sanitize" => sanitize = true,
            "--no-compress-images" => compress_images = false,
            "--no-compress-fonts" => compress_fonts = false,
            other => eprintln!("不明なオプション: {other} (無視)"),
        }
        i += 1;
    }

    println!("=== font_subset FFI テスト ===");
    println!("入力:  {input}");
    println!("出力:  {output}");
    println!("gc={gc}, clean={clean}, sanitize={sanitize}, compress_images={compress_images}, compress_fonts={compress_fonts}");
    println!();

    // --- テスト 1: Type3 フォント検出 ---
    let has_t3 = pdf_kozou_core::compress::has_type3_fonts(input);
    println!(
        "[1] Type3 フォント検出: {}",
        if has_t3 {
            "あり → フォールバック動作"
        } else {
            "なし → フルサブセット化"
        }
    );

    // --- テスト 2: subset_and_write 実行 ---
    println!("[2] subset_and_write 実行中...");
    match pdf_kozou_core::font_subset::subset_and_write(
        input,
        output,
        gc,
        clean,
        sanitize,
        compress_images,
        compress_fonts,
    ) {
        Ok(result) => {
            println!("    ✓ 成功");
            println!("    入力サイズ:  {} バイト", result.input_bytes);
            println!("    出力サイズ:  {} バイト", result.output_bytes);
            let ratio = if result.input_bytes > 0 {
                result.output_bytes as f64 / result.input_bytes as f64 * 100.0
            } else {
                0.0
            };
            println!("    圧縮率:      {:.1}%", ratio);
            println!("    has_type3:   {}", result.has_type3);
            println!("    fell_back:   {}", result.fell_back);
            println!("    effective_gc:       {}", result.effective_gc);
            println!("    effective_clean:    {}", result.effective_clean);
            println!("    effective_sanitize: {}", result.effective_sanitize);

            if result.output_bytes == 0 {
                eprintln!("    ⚠ 出力ファイルが空です！C ラッパーのエラーハンドリングを確認してください。");
                std::process::exit(2);
            }
        }
        Err(e) => {
            println!("    ✗ エラー: {e}");
            println!("    (エラーが適切に返されたことを確認 — panic でないことが重要)");
            // エラーは想定内 (存在しないファイル等) なので exit code 0
        }
    }

    // --- テスト 3: rewrite 経由の統合テスト ---
    println!();
    println!("[3] compress::rewrite 経由のテスト...");
    let fallback = pdf_kozou_core::compress::RewriteFallbackParams {
        garbage_level: Some(gc),
        clean: false,
        sanitize,
        compress_images: Some(compress_images),
        compress_fonts: Some(compress_fonts),
    };
    let opts = pdf_kozou_core::compress::REWRITE_OPTIONS_DEFAULT;
    match pdf_kozou_core::compress::rewrite(input, output, opts, &fallback) {
        Ok(resp) => {
            println!("    ✓ 成功");
            println!("    ok={}, ratio={:.3}", resp.ok, resp.ratio);
            println!(
                "    rewrite_fallback: {}",
                resp.params_used.rewrite_fallback
            );
            if let Some(w) = &resp.warning {
                println!("    警告: {w}");
            }
        }
        Err(e) => {
            println!("    ✗ エラー: {e}");
        }
    }

    println!();
    println!("=== テスト完了 ===");
}
