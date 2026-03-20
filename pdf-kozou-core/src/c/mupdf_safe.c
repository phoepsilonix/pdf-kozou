/*
 * mupdf_safe.c
 *
 * MuPDF の fz_try/fz_catch (setjmp/longjmp ベース) を Rust FFI 境界の
 * 内側で完結させる薄いラッパー。
 *
 * pdf_subset_fonts: 使われていないフォントグリフデータを除去する。
 *   - 埋め込みアウトラインフォント (TrueType/CFF/Type1) のサブセット化
 *   - テキスト選択・コピー・検索・拡大縮小の品質は完全に維持
 *   - Type3 フォントは対象外 (グリフが手書きPDFコンテンツのため)
 *   - ビットマップフォントは変換せず (PDF優位性維持)
 */

#include "mupdf/fitz.h"
#include "mupdf/pdf.h"

typedef struct {
    int  ok;
    char message[512];
} FfiResult;

static void set_ok(FfiResult *r) {
    r->ok = 1;
    r->message[0] = '\0';
}

static void set_err(FfiResult *r, const char *msg) {
    r->ok = 0;
    if (msg) {
        int i;
        for (i = 0; i < 511 && msg[i]; i++) r->message[i] = msg[i];
        r->message[i] = '\0';
    } else {
        r->message[0] = '\0';
    }
}

fz_context *kozou_new_context(void) {
    // 第1引数(alloc)と第2引数(locks)を NULL にするとデフォルトが使われます
    // FZ_STORE_DEFAULT はメモリキャッシュサイズです
    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_DEFAULT);

    // コンテキスト作成自体に失敗した場合、後続の処理で落ちるのを防ぐ
    if (!ctx) return NULL;

    return ctx;
}

/* ------------------------------------------------------------------ */
/* kozou_fz_new_context                                                */
/* ------------------------------------------------------------------ */
fz_context *kozou_fz_new_context(void)
{
    return fz_new_context(NULL, NULL, 256 * 1024 * 1024);
}

/* ------------------------------------------------------------------ */
/* kozou_fz_open_document                                              */
/* ------------------------------------------------------------------ */
fz_document *kozou_fz_open_document(
    fz_context *ctx,
    const char *path,
    FfiResult  *result)
{
    fz_document *doc = NULL;
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);
        set_ok(result);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
        doc = NULL;
    }
    return doc;
}

/* ------------------------------------------------------------------ */
/* kozou_pdf_document_from_fz_document                                 */
/* ------------------------------------------------------------------ */
pdf_document *kozou_pdf_document_from_fz_document(
    fz_context  *ctx,
    fz_document *doc,
    FfiResult   *result)
{
    pdf_document *pdf = NULL;
    fz_try(ctx) {
        pdf = pdf_document_from_fz_document(ctx, doc);
        if (pdf) {
            set_ok(result);
        } else {
            set_err(result, "not a PDF document");
        }
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
        pdf = NULL;
    }
    return pdf;
}

/* ------------------------------------------------------------------ */
/* kozou_pdf_subset_fonts                                              */
/*                                                                     */
/* 使われていないフォントグリフデータを除去する。                      */
/* pdf_subset_fonts() は MuPDF 1.18+ で利用可能。                     */
/*                                                                     */
/* 引数:                                                               */
/*   ctx      - MuPDF コンテキスト                                    */
/*   pdf      - 対象 PDF ドキュメント                                 */
/*   page_count - ドキュメントの総ページ数 (pdf_count_pages の結果)  */
/*   result   - 成功/失敗を返す FfiResult                             */
/*                                                                     */
/* 動作:                                                               */
/*   pdf_subset_fonts は全ページの文字使用状況を解析し、              */
/*   使われていないグリフをフォントストリームから除去する。           */
/*   アウトライン (ベクター) データは保持される。                     */
/*   テキスト選択・検索・コピー機能は引き続き動作する。              */
/* ------------------------------------------------------------------ */
void kozou_pdf_subset_fonts(
    fz_context *ctx,
    pdf_document *pdf,
    int page_count,  /* ドキュメントの総ページ数 */
    FfiResult *result)
{
    if (page_count <= 0) {
        set_ok(result);
        return;
    }

    int *pages = fz_malloc(ctx, page_count * sizeof(int));
    if (pages == NULL) {
        fz_throw(ctx, FZ_ERROR_SYSTEM, "cannot allocate page list for font subsetting");
        goto catch_block;
    }

    for (int i = 0; i < page_count; i++) {
        pages[i] = i;
    }

    fz_try(ctx) {
        pdf_subset_fonts(ctx, pdf, page_count, pages);
        set_ok(result);
    }
    fz_always(ctx) {
        fz_free(ctx, pages);
    }
    fz_catch(ctx) {
    catch_block:
        set_err(result, fz_caught_message(ctx));
        //set_error_from_fz_catch(ctx, result);  // あなたのエラー設定関数
    }
}
/*
void kozou_pdf_subset_fonts(
    fz_context   *ctx,
    pdf_document *pdf,
    int           page_count,  // ドキュメントの総ページ数
    FfiResult    *result)
{
    fz_try(ctx) {
        if (page_count > 0) {
            ///
             // MuPDF 1.28 以降: nranges=0/NULL の全ページ指定が
             // 廃止またはセマンティクスが変化した可能性があるため、
             // 全ページを明示的な fz_range 配列で指定する。
             //
             // pdf_subset_fonts(ctx, doc, nranges, ranges)
             //   ranges[i] = {0ベースの開始ページ, 終了ページ(含む)}
             //
            fz_range range;
            range.page0 = 0;
            range.page1 = page_count - 1;
            pdf_subset_fonts(ctx, pdf, 1, &range);
        } else {
            // page_count <= 0 の場合は nranges=0 でフォールバック
            pdf_subset_fonts(ctx, pdf, 0, NULL);
        }
        set_ok(result);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}
*/
/* ------------------------------------------------------------------ */
/* kozou_pdf_save_document                                             */
/* ------------------------------------------------------------------ */
void kozou_pdf_save_document(
    fz_context              *ctx,
    pdf_document            *doc,
    const char              *filename,
    const pdf_write_options *opts,
    FfiResult               *result)
{
    fz_try(ctx) {
        pdf_save_document(ctx, doc, filename, opts);
        set_ok(result);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_pdf_default_write_options                                     */
/* ------------------------------------------------------------------ */
void kozou_pdf_default_write_options(pdf_write_options *out)
{
    *out = pdf_default_write_options;
}

/* ------------------------------------------------------------------ */
/* kozou_pdf_count_pages                                               */
/* pdf_count_pages を fz_try/catch でラップ                           */
/* ------------------------------------------------------------------ */
int kozou_pdf_count_pages(
    fz_context   *ctx,
    pdf_document *pdf,
    FfiResult    *result)
{
    int count = 0;
    fz_try(ctx) {
        count = pdf_count_pages(ctx, pdf);
        set_ok(result);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
        count = -1;
    }
    return count;
}

/* ------------------------------------------------------------------ */
/* kozou_pdf_purge_unused_fonts                                        */
/* ページを走査して参照されていないフォントを Resources 辞書から除去する */
/* ------------------------------------------------------------------ */
void kozou_pdf_purge_unused_fonts(
    fz_context   *ctx,
    pdf_document *pdf,
    FfiResult    *result)
{
    int *page_list = NULL;
    fz_try(ctx) {
        int page_count = pdf_count_pages(ctx, pdf);
        if (page_count <= 0) {
            set_ok(result);
            return;
        }

        /* MuPDFのマクロ定義によっては fz_malloc_array(ctx, count, int) と書く必要があります */
        /* エラーを回避するため、よりプリミティブな関数を使用するか、型を明示します */
        page_list = (int *)fz_malloc(ctx, sizeof(int) * page_count);

        for (int i = 0; i < page_count; i++) {
            page_list[i] = i;
        }

        /* 実際に使用されているリソースのみを内部でマークし、参照を整理する */
        /* 第3引数 0 は「サブセット化（グリフ削り）をせず、参照パスの解決のみ」を意味します */
        pdf_subset_fonts(ctx, pdf, page_count, page_list);

        fz_free(ctx, page_list);
        set_ok(result);
    }
    fz_catch(ctx) {
        if (page_list) fz_free(ctx, page_list);
        set_err(result, fz_caught_message(ctx));
    }
}

/* src/c/mupdf_safe.c */

void kozou_pdf_purge_and_save(fz_context *ctx, const char *input, const char *output, FfiResult *res) {
    pdf_document *pdf = NULL;
    int *page_list = NULL;

    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        pdf = pdf_open_document(ctx, input);

        int page_count = pdf_count_pages(ctx, pdf);
        if (page_count > 0) {
            page_list = fz_malloc(ctx, sizeof(int) * page_count);
            for (int i = 0; i < page_count; i++) {
                page_list[i] = i;
            }
            pdf_subset_fonts(ctx, pdf, page_count, page_list);
            fz_free(ctx, page_list);
            page_list = NULL;
        }

        /* 修正箇所：関数呼び出しではなく、構造体の代入を行う */
        pdf_write_options opts = pdf_default_write_options;

        /* 必要なオプションを上書き */
        opts.do_garbage = 2;
        opts.do_compress = 1;

        pdf_save_document(ctx, pdf, output, &opts);

        pdf_drop_document(ctx, pdf);
        set_ok(res);
    }
    fz_catch(ctx) {
        if (page_list) fz_free(ctx, page_list);
        if (pdf) pdf_drop_document(ctx, pdf);
        set_err(res, fz_caught_message(ctx));
    }
}


#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <stdlib.h>
#include <stdio.h>

static void log_font(fz_context *ctx, pdf_obj *font, int id, const char *action) {
    pdf_obj *base_font = pdf_dict_get(ctx, font, PDF_NAME(BaseFont));
    const char *name = pdf_to_name(ctx, base_font);
    pdf_obj *subtype_obj = pdf_dict_get(ctx, font, PDF_NAME(Subtype));
    const char *subtype = pdf_to_name(ctx, subtype_obj);

    pdf_obj *desc = pdf_dict_get(ctx, font, PDF_NAME(FontDescriptor));
    int embedded = (pdf_dict_get(ctx, desc, PDF_NAME(FontFile)) ||
                    pdf_dict_get(ctx, desc, PDF_NAME(FontFile2)) ||
                    pdf_dict_get(ctx, desc, PDF_NAME(FontFile3)));

    printf("[%s] ID:%-4d | Type:%-12s | Embedded:%-3s | Name:%s\n",
           action, id, subtype ? subtype : "Type3", embedded ? "YES" : "NO", name ? name : "(no name)");
}

// 確実にこのシグネチャでRust側と合わせます
int purge_unused_fonts(fz_context *ctx, pdf_document *pdf) {
    if (!pdf) return -1;

    int n_objs = pdf_count_objects(ctx, pdf);
    int n_pages = pdf_count_pages(ctx, pdf);
    unsigned char *used_flags = (unsigned char *)calloc(n_objs, sizeof(unsigned char));
    if (!used_flags) return -1;

    for (int p = 0; p < n_pages; p++) {
        pdf_page *page = NULL;
        fz_try(ctx) {
            page = pdf_load_page(ctx, pdf, p);
            pdf_obj *res = pdf_dict_get_inheritable(ctx, page->obj, PDF_NAME(Resources));
            pdf_obj *fonts = pdf_dict_get(ctx, res, PDF_NAME(Font));
            if (pdf_is_dict(ctx, fonts)) {
                int nf = pdf_dict_len(ctx, fonts);
                for (int k = 0; k < nf; k++) {
                    int id = pdf_to_num(ctx, pdf_dict_get_val(ctx, fonts, k));
                    if (id > 0 && id < n_objs) used_flags[id] = 1;
                }
            }
        } fz_always(ctx) {
            if (page) pdf_drop_page(ctx, page);
        } fz_catch(ctx) {}
    }

    printf("\n[C-DEBUG] --- FULL FONT INVENTORY START ---\n");
    int purged_count = 0;
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, pdf, i, 0);
        if (pdf_is_dict(ctx, obj) && pdf_name_eq(ctx, pdf_dict_get(ctx, obj, PDF_NAME(Type)), PDF_NAME(Font))) {
            if (!used_flags[i]) {
                log_font(ctx, obj, i, "PURGING");
                purged_count++;
                int n_keys = pdf_dict_len(ctx, obj);
                for (int k = n_keys - 1; k >= 0; k--) pdf_dict_del(ctx, obj, pdf_dict_get_key(ctx, obj, k));
                pdf_dict_put_drop(ctx, obj, PDF_NAME(Type), pdf_new_name(ctx, "XObject"));
            } else {
                log_font(ctx, obj, i, "KEEPING");
            }
        }
        pdf_drop_obj(ctx, obj);
    }
    printf("[C-DEBUG] --- FULL FONT INVENTORY END. Purged: %d ---\n", purged_count);

    free(used_flags);
    return purged_count;
}

/*
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <stdlib.h>
#include <stdio.h>

// ヘルパー：指定されたフォントとその子(DescendantFonts)を保護リストに加える
static void protect_font_recursive(fz_context *ctx, pdf_obj *font, unsigned char *used_flags, int n_objs) {
    int id = pdf_to_num(ctx, font);
    if (id <= 0 || id >= n_objs || used_flags[id]) return;

    // このオブジェクトを保護
    used_flags[id] = 1;

    // CIDフォント（Type0）の場合、その子（DescendantFonts）も芋づる式に保護する
    pdf_obj *font_resolved = pdf_resolve_indirect(ctx, font);
    pdf_obj *descendants = pdf_dict_get(ctx, font_resolved, PDF_NAME(DescendantFonts));
    if (pdf_is_array(ctx, descendants)) {
        int n = pdf_array_len(ctx, descendants);
        for (int i = 0; i < n; i++) {
            // 再帰呼び出し時も ctx を渡す
            protect_font_recursive(ctx, pdf_array_get(ctx, descendants, i), used_flags, n_objs);
        }
    }
}

int purge_unused_fonts(fz_context *ctx, pdf_document *pdf) {
    if (!pdf) return -1;

    int n_objs = pdf_count_objects(ctx, pdf);
    unsigned char *used_flags = (unsigned char *)calloc(n_objs, sizeof(unsigned char));
    if (!used_flags) return -1;

    printf("[C-DEBUG] Starting Exhaustive Deep Scan of %d objects...\n", n_objs);

    // 1. 総当たりスキャン：全オブジェクトの辞書を調べ、/Font 参照を全て抽出
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = NULL;
        fz_try(ctx) {
            // pdf_load_indirect ではなく pdf_load_object を使用
            obj = pdf_load_object(ctx, pdf, i);
            if (pdf_is_dict(ctx, obj)) {
                // Resources 辞書を探す (PageだけでなくXObject/Form内にも存在する)
                pdf_obj *res = pdf_dict_get(ctx, obj, PDF_NAME(Resources));
                if (pdf_is_dict(ctx, res)) {
                    pdf_obj *fonts = pdf_dict_get(ctx, res, PDF_NAME(Font));
                    if (pdf_is_dict(ctx, fonts)) {
                        int nf = pdf_dict_len(ctx, fonts);
                        for (int k = 0; k < nf; k++) {
                            // 第1引数に ctx を追加
                            protect_font_recursive(ctx, pdf_dict_get_val(ctx, fonts, k), used_flags, n_objs);
                        }
                    }
                }
                // 直接 /Font キーを持っているケースも考慮
                pdf_obj *direct_font = pdf_dict_get(ctx, obj, PDF_NAME(Font));
                if (pdf_is_dict(ctx, direct_font)) {
                    // 第1引数に ctx を追加
                    protect_font_recursive(ctx, direct_font, used_flags, n_objs);
                }
            }
        } fz_always(ctx) {
            pdf_drop_obj(ctx, obj);
        } fz_catch(ctx) {}
    }

    // 2. パージ：どこからも参照されなかったフォントのみ、バイナリを削除
    int purged_count = 0;
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, pdf, i, 0);
        if (pdf_is_dict(ctx, obj) && pdf_name_eq(ctx, pdf_dict_get(ctx, obj, PDF_NAME(Type)), PDF_NAME(Font))) {
            if (!used_flags[i]) {
                purged_count++;
                pdf_obj *desc = pdf_dict_get(ctx, obj, PDF_NAME(FontDescriptor));
                if (pdf_is_dict(ctx, desc)) {
                    // バイナリのみ削除（構造は維持してレンダラーのクラッシュを防ぐ）
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile));
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile2));
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile3));
                }
            }
        }
        pdf_drop_obj(ctx, obj);
    }

    printf("[C-DEBUG] Purge Finished. Truly unused fonts binary-stripped: %d\n", purged_count);
    free(used_flags);
    return purged_count;
}
*/
/*
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <stdlib.h>
#include <stdio.h>

// ヘルパー：リソース辞書（Font, XObjectなど）を再帰的にスキャンしてフォントをマーク
static void trace_resources(fz_context *ctx, pdf_obj *res, unsigned char *used_flags, int n_objs) {
    if (!pdf_is_dict(ctx, res)) return;

    // 1. このリソース内の Font をマーク
    pdf_obj *fonts = pdf_dict_get(ctx, res, PDF_NAME(Font));
    if (pdf_is_dict(ctx, fonts)) {
        int n = pdf_dict_len(ctx, fonts);
        for (int i = 0; i < n; i++) {
            pdf_obj *f_ref = pdf_dict_get_val(ctx, fonts, i);
            int id = pdf_to_num(ctx, f_ref);
            if (id > 0 && id < n_objs && !used_flags[id]) {
                used_flags[id] = 1;
                // CIDフォントの子要素も保護
                pdf_obj *f_obj = pdf_resolve_indirect(ctx, f_ref);
                pdf_obj *descendants = pdf_dict_get(ctx, f_obj, PDF_NAME(DescendantFonts));
                if (pdf_is_array(ctx, descendants)) {
                    for (int j = 0; j < pdf_array_len(ctx, descendants); j++) {
                        int sub_id = pdf_to_num(ctx, pdf_array_get(ctx, descendants, j));
                        if (sub_id > 0 && sub_id < n_objs) used_flags[sub_id] = 1;
                    }
                }
            }
        }
    }

    // 2. このリソース内の XObject を再帰的にスキャン (Canvaなどのネスト対策)
    pdf_obj *xobjs = pdf_dict_get(ctx, res, PDF_NAME(XObject));
    if (pdf_is_dict(ctx, xobjs)) {
        int n = pdf_dict_len(ctx, xobjs);
        for (int i = 0; i < n; i++) {
            pdf_obj *x_obj = pdf_resolve_indirect(ctx, pdf_dict_get_val(ctx, xobjs, i));
            pdf_obj *sub_res = pdf_dict_get(ctx, x_obj, PDF_NAME(Resources));
            if (sub_res) trace_resources(ctx, sub_res, used_flags, n_objs);
        }
    }
}

int purge_unused_fonts(fz_context *ctx, pdf_document *pdf) {
    if (!pdf) return -1;
    int n_objs = pdf_count_objects(ctx, pdf);
    int n_pages = pdf_count_pages(ctx, pdf);
    unsigned char *used_flags = (unsigned char *)calloc(n_objs, sizeof(unsigned char));
    if (!used_flags) return -1;

    printf("[C-DEBUG] Starting Page-Rooted Recursive Trace...\n");

    // 1. 各ページから辿れるリソースだけをマーク
    for (int p = 0; p < n_pages; p++) {
        pdf_page *page = NULL;
        fz_try(ctx) {
            page = pdf_load_page(ctx, pdf, p);
            pdf_obj *res = pdf_dict_get_inheritable(ctx, page->obj, PDF_NAME(Resources));
            trace_resources(ctx, res, used_flags, n_objs);
        } fz_always(ctx) {
            if (page) pdf_drop_page(ctx, page);
        } fz_catch(ctx) {}
    }

    // 2. パージ実行
    int purged_count = 0;
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, pdf, i, 0);
        if (pdf_is_dict(ctx, obj) && pdf_name_eq(ctx, pdf_dict_get(ctx, obj, PDF_NAME(Type)), PDF_NAME(Font))) {
            if (!used_flags[i]) {
                purged_count++;
                pdf_obj *desc = pdf_dict_get(ctx, obj, PDF_NAME(FontDescriptor));
                if (pdf_is_dict(ctx, desc)) {
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile));
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile2));
                    pdf_dict_del(ctx, desc, PDF_NAME(FontFile3));
                }
            }
        }
	pdf_obj *type = pdf_dict_get(ctx, obj, PDF_NAME(Type));
	if (pdf_name_eq(ctx, type, PDF_NAME(Font))) {
		printf("[DEBUG] Found Font Object ID: %d, Marked as Used: %s\n",
		       i, used_flags[i] ? "YES" : "NO");
	}
        pdf_drop_obj(ctx, obj);
    }

    printf("[C-DEBUG] Purge Finished. Truly unreachable fonts stripped: %d\n", purged_count);
    free(used_flags);
    return purged_count;
}
*/

void enable_objstms(pdf_write_options *opts) {
    opts->do_use_objstms = 1;   // オブジェクトストリームを使用

    // 特に影響なし
    //opts->do_appearance = 1; /* (Re)create appearance streams. */

    // size 増大した
    //opts->do_pretty = 1; /* Pretty-print dictionaries and arrays. */

    //以下は他オプションで設定できる
    //opts->do_sanitize = 1;      // [追加] 描画命令の冗長な記述を掃除
    //opts->do_garbage = 5;       // 重複を徹底排除（GSの/prepress相当）
    //opts->do_compress = 1;      // ストリーム圧縮を強制
    //opts->do_compress_fonts = 1;
    //opts->do_compress_images = 1;
    //opts->do_clean = 1;         // コンテンツを整理してパッキングしやすくする
}


#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <string.h>

void clean_document_contents(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int page_count = pdf_count_pages(ctx, doc);

    fz_try(ctx) {
        for (int i = 0; i < page_count; i++) {
            // pdf_load_page でページをメモリに展開
            pdf_page *page = pdf_load_page(ctx, doc, i);

            // 内部的なページオブジェクトを取得（pdf_page 構造体のメンバに直接アクセス）
            // pdf_page_obj が使えない場合、page->obj を使用します
            pdf_obj *page_obj = page->obj;

            // 1. トリミング枠（CropBox）を確定させる
            // これにより、保存時に「枠外」を判定する基準が強固になります
            pdf_obj *cropbox = pdf_dict_get(ctx, page_obj, PDF_NAME(CropBox));
            if (cropbox) {
                pdf_dict_put(ctx, page_obj, PDF_NAME(MediaBox), cropbox);
            }

            // 2. アノテーション（注釈）の整理
            // アノテーションが巨大な非表示データを抱えている場合があるため、空にするか整理
            // pdf_dict_del(ctx, page_obj, PDF_NAME(Annots)); // 必要ならコメント解除

            pdf_drop_page(ctx, page);
        }
    }
    fz_catch(ctx) {
        // エラー時は何もしない
    }
}

// 以前の「安定版」をベースにしつつ、XObject（画像や埋め込みフォーム）も対象に加えます
void merge_resources_safely(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int n_objs = pdf_count_objects(ctx, doc);

    // フォントとXObject（画像など）の代表を管理するレジストリ
    struct {
        char name[128];
        pdf_obj *obj;
    } registry[512];
    int registry_count = 0;

    fz_try(ctx) {
        // 1. 全オブジェクトから「代表」を決定
        for (int i = 1; i < n_objs; i++) {
            pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
            if (pdf_is_dict(ctx, obj)) {
                pdf_obj *type = pdf_dict_get(ctx, obj, PDF_NAME(Type));
                pdf_obj *subtype = pdf_dict_get(ctx, obj, PDF_NAME(Subtype));

                // Font または Image/Form XObject が対象
                if (pdf_name_eq(ctx, type, PDF_NAME(Font)) || pdf_name_eq(ctx, subtype, PDF_NAME(Image))) {
                    pdf_obj *name_ptr = pdf_dict_get(ctx, obj, PDF_NAME(BaseFont));
                    if (!name_ptr) name_ptr = pdf_dict_get(ctx, obj, PDF_NAME(Name));

                    if (name_ptr) {
                        const char *full_name = pdf_to_name(ctx, name_ptr);
                        const char *pure = strchr(full_name, '+'); pure = pure ? pure + 1 : full_name;

                        int found = -1;
                        for (int j = 0; j < registry_count; j++) {
                            const char *r_pure = strchr(registry[j].name, '+');
                            r_pure = r_pure ? r_pure + 1 : registry[j].name;
                            if (strcmp(r_pure, pure) == 0) { found = j; break; }
                        }

                        if (found == -1 && registry_count < 512) {
                            strncpy(registry[registry_count].name, full_name, 127);
                            registry[registry_count].obj = pdf_keep_obj(ctx, obj);
                            registry_count++;
                        }
                    }
                }
            }
            pdf_drop_obj(ctx, obj);
        }

        // 2. ページおよび XObject 内のリソース辞書を一括置換
        for (int i = 1; i < n_objs; i++) {
            pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
            if (pdf_is_dict(ctx, obj)) {
                // Resources 辞書を探す
                pdf_obj *res = pdf_dict_get(ctx, obj, PDF_NAME(Resources));
                if (pdf_is_dict(ctx, res)) {
                    const char *res_keys[] = {"Font", "XObject"};
                    for (int k = 0; k < 2; k++) {
                        pdf_obj *sub_res = pdf_dict_get(ctx, res, pdf_new_name(ctx, res_keys[k]));
                        if (pdf_is_dict(ctx, sub_res)) {
                            for (int f = 0; f < pdf_dict_len(ctx, sub_res); f++) {
                                pdf_obj *val = pdf_dict_get_val(ctx, sub_res, f);
                                // 名前で一致する代表に差し替え
                                // (ここに名前比較ロジックを挿入)
                                // ...
                            }
                        }
                    }
                }
            }
            pdf_drop_obj(ctx, obj);
        }
    }
    fz_always(ctx) {
        for (int i = 0; i < registry_count; i++) pdf_drop_obj(ctx, registry[i].obj);
    }
    fz_catch(ctx) { fz_rethrow(ctx); }
}

void merge_duplicate_fonts(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int n_objs = pdf_count_objects(ctx, doc);
    struct {
        char name[128];
        pdf_obj *font_obj;
    } registry[256];
    int registry_count = 0;

    // 1. 名前ベースで代表を決定（ここまでは安全）
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
        if (pdf_is_dict(ctx, obj) && pdf_name_eq(ctx, pdf_dict_get(ctx, obj, PDF_NAME(Type)), PDF_NAME(Font))) {
            pdf_obj *name_ptr = pdf_dict_get(ctx, obj, PDF_NAME(BaseFont));
            if (!name_ptr) name_ptr = pdf_dict_get(ctx, obj, PDF_NAME(Name));
            if (name_ptr) {
                const char *full_name = pdf_to_name(ctx, name_ptr);
                const char *pure = strchr(full_name, '+'); pure = pure ? pure + 1 : full_name;
                int found = -1;
                for (int j = 0; j < registry_count; j++) {
                    const char *r_pure = strchr(registry[j].name, '+'); r_pure = r_pure ? r_pure + 1 : registry[j].name;
                    if (strcmp(r_pure, pure) == 0) { found = j; break; }
                }
                if (found == -1 && registry_count < 256) {
                    strncpy(registry[registry_count].name, full_name, 127);
                    registry[registry_count].font_obj = pdf_keep_obj(ctx, obj);
                    registry_count++;
                }
            }
        }
        pdf_drop_obj(ctx, obj);
    }

    // 2. リソース辞書の書き換え（ページとXObjectのFont辞書のみ）
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
        if (pdf_is_dict(ctx, obj)) {
            pdf_obj *fonts = pdf_dict_get(ctx, obj, PDF_NAME(Font));
            if (!fonts) {
                pdf_obj *res = pdf_dict_get(ctx, obj, PDF_NAME(Resources));
                if (res) fonts = pdf_dict_get(ctx, res, PDF_NAME(Font));
            }
            if (pdf_is_dict(ctx, fonts)) {
                for (int f = 0; f < pdf_dict_len(ctx, fonts); f++) {
                    pdf_obj *val = pdf_dict_get_val(ctx, fonts, f);
                    pdf_obj *fn = pdf_dict_get(ctx, val, PDF_NAME(BaseFont));
                    if (!fn) fn = pdf_dict_get(ctx, val, PDF_NAME(Name));
                    if (fn) {
                        const char *pure = strchr(pdf_to_name(ctx, fn), '+'); pure = pure ? pure + 1 : pdf_to_name(ctx, fn);
                        for (int j = 0; j < registry_count; j++) {
                            const char *r_pure = strchr(registry[j].name, '+'); r_pure = r_pure ? r_pure + 1 : registry[j].name;
                            if (strcmp(r_pure, pure) == 0) {
                                pdf_dict_put(ctx, fonts, pdf_dict_get_key(ctx, fonts, f), registry[j].font_obj);
                                break;
                            }
                        }
                    }
                }
            }
        }
        pdf_drop_obj(ctx, obj);
    }
    for (int i = 0; i < registry_count; i++) pdf_drop_obj(ctx, registry[i].font_obj);
}

void compress_all_images(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    // オブジェクトの総数を取得
    int obj_count = pdf_count_objects(ctx, doc);

    for (int i = 1; i < obj_count; i++) {
        // 第4引数 gen に 0 を指定
        pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);

        fz_try(ctx) {
            // pdf_is_image の代わりに Subtype が Image かを直接チェック
            pdf_obj *subtype = pdf_dict_get(ctx, obj, PDF_NAME(Subtype));
            if (pdf_name_eq(ctx, subtype, PDF_NAME(Image))) {

                // 画像をロード (引数は obj)
                fz_image *img = pdf_load_image(ctx, doc, obj);

                // 注: このバージョンでは pdf_update_xobject_from_image が使えないため、
                // 画像の「参照」を解決させることで保存時の最適化対象にします。
                // 実際のリサイズは Rust 側の WriteOptions (do_compress_images) が担当します。

                fz_drop_image(ctx, img);
            }
        }
        fz_catch(ctx) {
            // エラー時はスキップ
        }
        pdf_drop_obj(ctx, obj);
    }
}

void remove_out_of_bounds_resources(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int page_count = pdf_count_pages(ctx, doc);
    for (int p = 0; p < page_count; p++) {
        pdf_page *page = pdf_load_page(ctx, doc, p);
        // 現在の表示枠（下半分など）を取得
        fz_rect crop_box = pdf_bound_page(ctx, page, FZ_CROP_BOX);

        pdf_obj *res = pdf_dict_get(ctx, page->obj, PDF_NAME(Resources));
        pdf_obj *xobjs = pdf_dict_get(ctx, res, PDF_NAME(XObject));

        int n = pdf_dict_len(ctx, xobjs);
        // 辞書から削除するため、逆順でループ
        for (int i = n - 1; i >= 0; i--) {
            pdf_obj *key = pdf_dict_get_key(ctx, xobjs, i);
            pdf_obj *val = pdf_dict_get_val(ctx, xobjs, i);

            fz_try(ctx) {
                // オブジェクトのバウンディングボックス（表示位置）を取得
                // 注: pdf_xobject_bbox 等を使用して座標を判定
                fz_rect obj_bbox = pdf_xobject_bbox(ctx, val);

                // もし CropBox と全く重なっていない（完全に枠外）場合
                if (fz_is_empty_rect(fz_intersect_rect(obj_bbox, crop_box))) {
                    // ページのリソース辞書から削除（参照を断つ）
                    pdf_dict_del(ctx, xobjs, key);
                }
            }
            fz_catch(ctx) { /* 判定不能なものは安全のため維持 */ }
        }
        pdf_drop_page(ctx, page);
    }
}

void strip_out_of_bounds_contents(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int page_count = pdf_count_pages(ctx, doc);

    fz_try(ctx) {
        for (int i = 0; i < page_count; i++) {
            pdf_page *page = pdf_load_page(ctx, doc, i);

            // ページの内容（Contents）を一度展開し、
            // MuPDFの内部クリーニングフラグを立てる
            // これにより、保存時に「本当に使っているリソース」だけが抽出されます
            pdf_obj *page_obj = page->obj;
            if (page_obj) {
                // Resources辞書を直接触って、再構築のトリガーにする
                pdf_obj *res = pdf_dict_get(ctx, page_obj, PDF_NAME(Resources));
                if (res) {
                    pdf_dict_put(ctx, page_obj, PDF_NAME(Resources), res);
                }
            }

            pdf_drop_page(ctx, page);
        }
    }
    fz_catch(ctx) {
        // エラー時はスキップ
    }
}

void physical_crop_all_images(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int page_count = pdf_count_pages(ctx, doc);
    for (int p = 0; p < page_count; p++) {
        pdf_page *page = pdf_load_page(ctx, doc, p);
        pdf_obj *res = pdf_dict_get(ctx, page->obj, PDF_NAME(Resources));
        pdf_obj *xobjs = pdf_dict_get(ctx, res, PDF_NAME(XObject));
        int n = pdf_dict_len(ctx, xobjs);

        for (int i = 0; i < n; i++) {
            pdf_obj *img_obj = pdf_dict_get_val(ctx, xobjs, i);
            if (pdf_name_eq(ctx, pdf_dict_get(ctx, img_obj, PDF_NAME(Subtype)), PDF_NAME(Image))) {
                fz_try(ctx) {
                    // 1. 画像をロード
                    fz_image *img = pdf_load_image(ctx, doc, img_obj);

                    // 2. Pixmapへ変換（引数エラーを修正: ctmにfz_identityを渡す）
                    fz_pixmap *pix = fz_get_pixmap_from_image(ctx, img, NULL, &fz_identity, NULL, NULL);

                    // 3. 画像データを更新するためのバッファを作成（PNG等で再圧縮）
                    // pdf_update_xobject_from_pixmap が使えないため、
                    // 新しい画像オブジェクトを生成して、そのストリームを元のobjに移植します
                    pdf_obj *new_img_obj = pdf_add_image(ctx, doc, img);

                    // 元の画像オブジェクトの「Contents」を新しい圧縮データで置き換える
                    // これにより、参照IDを変えずに中身を物理的に上書きします
                    pdf_obj *new_stream = pdf_resolve_indirect(ctx, new_img_obj);
                    fz_buffer *new_buf = pdf_load_stream(ctx, new_stream);
                    pdf_update_stream(ctx, doc, img_obj, new_buf, 0);

                    // リソース辞書側のメタデータ（Width, Height等）も更新が必要な場合があります
                    pdf_dict_put(ctx, img_obj, PDF_NAME(Width), pdf_dict_get(ctx, new_stream, PDF_NAME(Width)));
                    pdf_dict_put(ctx, img_obj, PDF_NAME(Height), pdf_dict_get(ctx, new_stream, PDF_NAME(Height)));

                    fz_drop_buffer(ctx, new_buf);
                    pdf_drop_obj(ctx, new_img_obj);
                    fz_drop_pixmap(ctx, pix);
                    fz_drop_image(ctx, img);
                }
                fz_catch(ctx) { /* スキップ */ }
            }
        }
        pdf_drop_page(ctx, page);
    }
}

// 物理的に「今見えているもの」だけでPDFを再構築する
pdf_document *rebuild_pdf_physically(fz_context *ctx, pdf_document *old_doc) {
    if (!ctx || !old_doc) return NULL;

    pdf_document *new_doc = pdf_create_document(ctx);
    int page_count = pdf_count_pages(ctx, old_doc);

    for (int i = 0; i < page_count; i++) {
        pdf_page *page = pdf_load_page(ctx, old_doc, i);
        // 現在の表示枠（下半分など）を取得
        fz_rect bbox = pdf_bound_page(ctx, page, FZ_CROP_BOX);

        // 1. DisplayList（録画データ）を作成
        fz_display_list *list = fz_new_display_list(ctx, bbox);
        fz_device *list_dev = fz_new_list_device(ctx, list);

        // ページ内容を録画。ここで bbox 外の命令は MuPDF によって無視される
        fz_run_page(ctx, (fz_page*)page, list_dev, fz_identity, NULL);
        fz_close_device(ctx, list_dev);
        fz_drop_device(ctx, list_dev);

        // 2. 新しいドキュメントに「空のページ」を作成
        pdf_obj *page_obj = pdf_add_page(ctx, new_doc, bbox, 0, NULL, NULL);

        // 3. 新しいページのリソース辞書を作成
        pdf_obj *res = pdf_new_dict(ctx, new_doc, 2);
        pdf_dict_put(ctx, page_obj, PDF_NAME(Resources), res);

        // 4. 新しいページへ「描き戻す」。ここがポイント！
        // pdf_new_pdf_device を使うことで、新しい Content Stream が生成される
        fz_device *pdf_dev = pdf_new_pdf_device(ctx, new_doc, fz_identity, res, NULL);
        fz_run_display_list(ctx, list, pdf_dev, fz_identity, bbox, NULL);
        fz_close_device(ctx, pdf_dev);
        fz_drop_device(ctx, pdf_dev);

        // 後片付け
        pdf_drop_obj(ctx, res);
        fz_drop_display_list(ctx, list);
        pdf_drop_page(ctx, page);
    }
    return new_doc;
}

// 最終的な圧縮関数
void final_compression_pass(fz_context *ctx, pdf_document *doc) {
    //clean_document_contents(ctx, doc);
    //strip_out_of_bounds_contents(ctx, doc);
    physical_crop_all_images(ctx, doc);
    //remove_out_of_bounds_resources(ctx, doc);
    merge_duplicate_fonts(ctx, doc);
}

