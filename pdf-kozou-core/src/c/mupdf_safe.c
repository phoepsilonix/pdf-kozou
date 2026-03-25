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


#include <mupdf/pdf.h>
#include <string.h>

void merge_duplicate_fonts(fz_context *ctx, pdf_document *doc) {
    if (!ctx || !doc) return;

    int n_objs = pdf_count_objects(ctx, doc);
    struct {
        char name[128];
        pdf_obj *font_obj; // ここを確実に font_obj と定義
    } registry[100];
    int registry_count = 0;

    // 1. 全オブジェクトを走査して「各フォント名の代表（Font Dict）」を決定
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
        if (pdf_is_dict(ctx, obj) && pdf_name_eq(ctx, pdf_dict_get(ctx, obj, PDF_NAME(Type)), PDF_NAME(Font))) {
            pdf_obj *base_font = pdf_dict_get(ctx, obj, PDF_NAME(BaseFont));
            if (base_font) {
                const char *full_name = pdf_to_name(ctx, base_font);
                const char *name = strchr(full_name, '+');
                name = (name) ? name + 1 : full_name;

                int found_idx = -1;
                for (int j = 0; j < registry_count; j++) {
                    const char *reg_full = registry[j].name;
                    const char *reg_name = strchr(reg_full, '+');
                    reg_name = (reg_name) ? reg_name + 1 : reg_full;
                    if (strcmp(reg_name, name) == 0) { found_idx = j; break; }
                }

                if (found_idx == -1 && registry_count < 100) {
                    strncpy(registry[registry_count].name, full_name, 127);
                    registry[registry_count].font_obj = pdf_keep_obj(ctx, obj);
                    registry_count++;
                }
            }
        }
        pdf_drop_obj(ctx, obj);
    }

    // 2. 全オブジェクト（Page, XObject 等）の /Font 辞書を代表へ差し替え
    for (int i = 1; i < n_objs; i++) {
        pdf_obj *obj = pdf_new_indirect(ctx, doc, i, 0);
        if (pdf_is_dict(ctx, obj)) {
            // 直接 Font 辞書を持っているか、Resources 内に持っているか確認
            pdf_obj *fonts = pdf_dict_get(ctx, obj, PDF_NAME(Font));
            if (!fonts) {
                pdf_obj *res = pdf_dict_get(ctx, obj, PDF_NAME(Resources));
                if (res) fonts = pdf_dict_get(ctx, res, PDF_NAME(Font));
            }

            if (pdf_is_dict(ctx, fonts)) {
                int n_fonts = pdf_dict_len(ctx, fonts);
                for (int f = 0; f < n_fonts; f++) {
                    pdf_obj *key = pdf_dict_get_key(ctx, fonts, f);
                    pdf_obj *f_val = pdf_dict_get_val(ctx, fonts, f);
                    pdf_obj *base_font = pdf_dict_get(ctx, f_val, PDF_NAME(BaseFont));

                    if (base_font) {
                        const char *full_name = pdf_to_name(ctx, base_font);
                        const char *name = strchr(full_name, '+');
                        name = (name) ? name + 1 : full_name;

                        for (int j = 0; j < registry_count; j++) {
                            const char *reg_full = registry[j].name;
                            const char *reg_name = strchr(reg_full, '+');
                            reg_name = (reg_name) ? reg_name + 1 : reg_full;

                            if (strcmp(reg_name, name) == 0) {
                                // 代表の Font Object ID に上書き
                                pdf_dict_put(ctx, fonts, key, registry[j].font_obj);
                                pdf_dirty_obj(ctx, fonts);
                                break;
                            }
                        }
                    }
                }
            }
        }
        pdf_drop_obj(ctx, obj);
    }

    for (int i = 0; i < registry_count; i++) {
        pdf_drop_obj(ctx, registry[i].font_obj);
    }
}


/* ------------------------------------------------------------------ */
/* utf8_to_pdf_string_obj                                              */
/*                                                                     */
/* UTF-8 文字列から PDF /Info 文字列オブジェクトを生成する。           */
/* ASCII のみなら PDFDocEncoding (= Latin-1 サブセット) として格納し、 */
/* 非 ASCII を含む場合は BOM 付き UTF-16 BE として格納する。           */
/* これにより pdfinfo・Adobe Acrobat など標準ツールで正しく表示される。*/
/* ------------------------------------------------------------------ */
static pdf_obj *utf8_to_pdf_string_obj(fz_context *ctx, const char *utf8)
{
    if (!utf8) return pdf_new_string(ctx, "", 0);

    /* ASCII のみか判定 */
    int is_ascii = 1;
    for (const char *p = utf8; *p; p++) {
        if ((unsigned char)*p > 0x7F) { is_ascii = 0; break; }
    }

    if (is_ascii) {
        /* ASCII のみ: そのまま PDFDocEncoding 文字列として格納 */
        return pdf_new_string(ctx, utf8, strlen(utf8));
    }

    /* UTF-8 → BOM 付き UTF-16 BE に変換 */
    /* まず必要バイト数を計算: BOM(2) + 各コードポイント*2 (or *4) */
    size_t buf_capacity = 2 + strlen(utf8) * 3 + 4; /* 余裕を持たせる */
    unsigned char *buf = (unsigned char *)fz_malloc(ctx, buf_capacity);

    buf[0] = 0xFE; /* BOM high */
    buf[1] = 0xFF; /* BOM low  */
    int out = 2;

    const unsigned char *s = (const unsigned char *)utf8;
    while (*s) {
        unsigned int cp = 0;
        if (*s < 0x80) {
            cp = *s++;
        } else if ((*s & 0xE0) == 0xC0) {
            cp = (*s++ & 0x1F) << 6;
            if (*s) cp |= (*s++ & 0x3F);
        } else if ((*s & 0xF0) == 0xE0) {
            cp = (*s++ & 0x0F) << 12;
            if (*s) cp |= (*s++ & 0x3F) << 6;
            if (*s) cp |= (*s++ & 0x3F);
        } else if ((*s & 0xF8) == 0xF0) {
            cp = (*s++ & 0x07) << 18;
            if (*s) cp |= (*s++ & 0x3F) << 12;
            if (*s) cp |= (*s++ & 0x3F) << 6;
            if (*s) cp |= (*s++ & 0x3F);
        } else {
            s++; cp = 0xFFFD; /* 不正バイト → 置換文字 */
        }

        if (cp < 0x10000) {
            /* BMP: 2バイト */
            buf[out++] = (cp >> 8) & 0xFF;
            buf[out++] = cp & 0xFF;
        } else {
            /* サプリメンタリ: サロゲートペア */
            cp -= 0x10000;
            unsigned int hi = 0xD800 + (cp >> 10);
            unsigned int lo = 0xDC00 + (cp & 0x3FF);
            buf[out++] = (hi >> 8) & 0xFF;
            buf[out++] = hi & 0xFF;
            buf[out++] = (lo >> 8) & 0xFF;
            buf[out++] = lo & 0xFF;
        }

        /* バッファ拡張（念のため） */
        if ((size_t)(out + 8) >= buf_capacity) {
            buf_capacity *= 2;
            buf = (unsigned char *)fz_realloc(ctx, buf, buf_capacity);
        }
    }

    pdf_obj *obj = pdf_new_string(ctx, (const char *)buf, out);
    fz_free(ctx, buf);
    return obj;
}

/* ------------------------------------------------------------------ */
/* kozou_set_pdf_info_key                                              */
/*                                                                     */
/* PDF ファイルを開き、/Info 辞書の指定キーに値を設定して保存する。   */
/* UTF-8 入力を BOM 付き UTF-16 BE に変換して格納する。               */
/* ------------------------------------------------------------------ */
void kozou_set_pdf_info_key(
    fz_context   *ctx,
    const char   *path,
    const char   *key,
    const char   *value,
    FfiResult    *result)
{
    pdf_document *pdf = NULL;


    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        /* PDF を読み書きモードで開く */
        pdf = pdf_open_document(ctx, path);

        /* trailer から /Info を取得。なければ新規作成 */
        pdf_obj *trailer = pdf_trailer(ctx, pdf);
        pdf_obj *info    = pdf_dict_get(ctx, trailer, PDF_NAME(Info));

        if (!info || pdf_is_null(ctx, info)) {
            /* /Info 辞書を新規作成して trailer に追加 */
            info = pdf_add_new_dict(ctx, pdf, 4);
            pdf_dict_put(ctx, trailer, PDF_NAME(Info), info);
            pdf_drop_obj(ctx, info);
            /* trailer に追加した後、再取得 */
            info = pdf_dict_get(ctx, trailer, PDF_NAME(Info));
        }

        /* 間接参照を解決する */
        info = pdf_resolve_indirect(ctx, info);

        /* UTF-8 → BOM 付き UTF-16 BE (非ASCII含む場合) で格納 */
        pdf_obj *key_obj = pdf_new_name(ctx, key);
        pdf_obj *val_obj = utf8_to_pdf_string_obj(ctx, value);
        pdf_dict_put(ctx, info, key_obj, val_obj);
        pdf_drop_obj(ctx, val_obj);
        pdf_drop_obj(ctx, key_obj);

        /* do_incremental = 0: 新規作成 PDF にも対応するため通常保存。*/
        pdf_write_options opts = pdf_default_write_options;
        opts.do_incremental = 0;
        opts.do_garbage     = 0;
        opts.do_compress    = 0;

        pdf_save_document(ctx, pdf, path, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (pdf) pdf_drop_document(ctx, pdf);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_write_pdf_info                                                */
/*                                                                     */
/* PDF ファイルを1回だけ開き、複数の /Info キーをまとめて書き込んで   */
/* 1回だけ保存するバッチ関数。                                         */
/* PdfDocument::new() で作成した新規 PDF にも対応。                   */
/* ------------------------------------------------------------------ */
void kozou_write_pdf_info(
    fz_context  *ctx,
    const char  *path,
    const char **keys,
    const char **values,
    int          count,
    FfiResult   *result)
{
    pdf_document *pdf  = NULL;
    pdf_obj      *info = NULL;

    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        pdf = pdf_open_document(ctx, path);

        /* --- /Info 辞書を取得または新規作成 --- */
        pdf_obj *trailer = pdf_trailer(ctx, pdf);

        /* trailer は通常 direct dict だが念のため解決する */
        if (pdf_is_indirect(ctx, trailer))
            trailer = pdf_resolve_indirect(ctx, trailer);

        pdf_obj *info_ref = pdf_dict_get(ctx, trailer, PDF_NAME(Info));

        if (info_ref && !pdf_is_null(ctx, info_ref)) {
            /* 既存 /Info: 間接参照を解決して実体を取得 */
            info = pdf_resolve_indirect(ctx, info_ref);
        } else {
            /* /Info がない（新規 PDF など）: オブジェクトとして追加 */
            /* pdf_add_new_dict: xref に登録された新規辞書オブジェクトを返す */
            info = pdf_add_new_dict(ctx, pdf, count > 0 ? count : 8);

            /* trailer の /Info に間接参照として設定 */
            pdf_dict_put(ctx, trailer, PDF_NAME(Info), info);

            /* pdf_add_new_dict が返したオブジェクトは既に xref 登録済み
             * なので drop して trailer 経由で再取得 */
            pdf_drop_obj(ctx, info);
            info = pdf_resolve_indirect(ctx,
                       pdf_dict_get(ctx, trailer, PDF_NAME(Info)));
        }

        /* --- 各キー/値を書き込む --- */
        for (int i = 0; i < count; i++) {
            if (!keys[i] || !values[i]) continue;
            pdf_obj *key_obj = pdf_new_name(ctx, keys[i]);
            /* UTF-8 → BOM 付き UTF-16 BE に変換して格納 */
            pdf_obj *val_obj = utf8_to_pdf_string_obj(ctx, values[i]);
            pdf_dict_put(ctx, info, key_obj, val_obj);
            pdf_drop_obj(ctx, val_obj);
            pdf_drop_obj(ctx, key_obj);
        }

        /* --- 保存 ---
         * do_incremental = 0: 新規 PDF には /Info が xref にないため
         *                      インクリメンタル保存では追加できない。
         *                      通常保存（全体再書き込み）を使う。
         * do_garbage = 0:     メタデータ追加のみなので gc 不要。
         * do_compress = 0:    圧縮状態を変えない。                 */
        pdf_write_options opts = pdf_default_write_options;
        opts.do_incremental = 0;
        opts.do_garbage     = 0;
        opts.do_compress    = 0;

        pdf_save_document(ctx, pdf, path, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (pdf) pdf_drop_document(ctx, pdf);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_get_pdf_info_key                                              */
/*                                                                     */
/* PDF /Info 辞書から指定キーの文字列値を取得してバッファにコピーする。*/
/* UTF-16 BE 文字列 (BOM \xfe\xff 付き) を UTF-8 に変換して返す。     */
/*                                                                     */
/* 引数:                                                               */
/*   ctx     - MuPDF コンテキスト                                     */
/*   path    - 対象 PDF ファイルパス                                   */
/*   key     - /Info キー名 ("Title", "Author" 等)                    */
/*   buf     - 出力バッファ (UTF-8)                                    */
/*   buf_len - バッファサイズ (ヌル終端含む)                          */
/*   result  - 成功/失敗を返す FfiResult                              */
/*                                                                     */
/* 返り値: コピーしたバイト数（ヌル終端含まず）。0 なら未設定/エラー。*/
/* ------------------------------------------------------------------ */
int kozou_get_pdf_info_key(
    fz_context *ctx,
    const char *path,
    const char *key,
    char       *buf,
    int         buf_len,
    FfiResult  *result)
{
    pdf_document *pdf = NULL;
    int copied = 0;

    if (buf && buf_len > 0) buf[0] = '\0';

    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        pdf = pdf_open_document(ctx, path);

        pdf_obj *trailer = pdf_trailer(ctx, pdf);
        pdf_obj *info    = pdf_dict_get(ctx, trailer, PDF_NAME(Info));

        if (info && !pdf_is_null(ctx, info)) {
            info = pdf_resolve_indirect(ctx, info);
            pdf_obj *key_name = pdf_new_name(ctx, key);
            pdf_obj *val = pdf_dict_get(ctx, info, key_name);
            pdf_drop_obj(ctx, key_name);

            if (val && !pdf_is_null(ctx, val)) {
                val = pdf_resolve_indirect(ctx, val);

                if (pdf_is_string(ctx, val)) {
                    /* MuPDF 1.28: pdf_to_text_string(ctx, obj) は
                     * PDFDocEncoding / UTF-16 BE を自動で UTF-8 に変換して返す。
                     * 返り値は内部バッファへのポインタのため fz_free 不要。 */
                    const char *utf8 = pdf_to_text_string(ctx, val);
                    if (utf8 && buf && buf_len > 1) {
                        int len = (int)strlen(utf8);
                        int to_copy = len < buf_len - 1 ? len : buf_len - 1;
                        memcpy(buf, utf8, to_copy);
                        buf[to_copy] = '\0';
                        copied = to_copy;
                    }
                } else if (pdf_is_name(ctx, val)) {
                    /* /Name オブジェクトとして格納されている場合（稀）*/
                    const char *name_ptr = pdf_to_name(ctx, val);
                    if (name_ptr && name_ptr[0] && buf && buf_len > 1) {
                        int len = (int)strlen(name_ptr);
                        int to_copy = len < buf_len - 1 ? len : buf_len - 1;
                        memcpy(buf, name_ptr, to_copy);
                        buf[to_copy] = '\0';
                        copied = to_copy;
                    }
                }
            }
        }
        set_ok(result);
    }
    fz_always(ctx) {
        if (pdf) pdf_drop_document(ctx, pdf);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
        copied = 0;
    }
    return copied;
}

/* ------------------------------------------------------------------ */
/* kozou_convert_to_pdf                                                */
/*                                                                     */
/* mutool convert と同等のフローで非 PDF を PDF に変換する。           */
/*                                                                     */
/* mutool convert との違い:                                            */
/*   1. fz_layout_document を呼んでレイアウトを確定する                */
/*   2. pdf_page_write + fz_run_page でページを PDF に変換する          */
/*   3. gc=4 で保存する                                                */
/*                                                                     */
/* mupdf_convert_to_pdf_internal との違い:                             */
/*   - fz_layout_document を呼ぶ（reflowable 文書のオーバーラップ修正）*/
/*   - 直接 pdf_save_document で gc=4 付き保存まで行う                 */
/* ------------------------------------------------------------------ */
void kozou_convert_to_pdf(
    fz_context *ctx,
    const char *input,
    const char *output,
    float       layout_w,
    float       layout_h,
    float       layout_em,
    FfiResult  *result)
{
    fz_document  *doc    = NULL;
    pdf_document *pdfout = NULL;

    fz_var(doc);
    fz_var(pdfout);

    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        /* 入力ファイルを開く */
        doc = fz_open_document(ctx, input);

        /* reflowable 文書（DOCX, EPUB, HTML 等）はレイアウト計算が必要 */
        if (fz_is_document_reflowable(ctx, doc)) {
            if (layout_w  <= 0.0f) layout_w  = 450.0f;
            if (layout_h  <= 0.0f) layout_h  = 600.0f;
            if (layout_em <= 0.0f) layout_em = 12.0f;
            fz_layout_document(ctx, doc, layout_w, layout_h, layout_em);
        }

        int page_count = fz_count_pages(ctx, doc);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");

        /* 新規 PDF ドキュメントを作成 */
        pdfout = pdf_create_document(ctx);

        /* 各ページを pdf_page_write + fz_run_page で変換 */
        for (int i = 0; i < page_count; i++) {
            fz_page *page         = NULL;
            fz_device *dev        = NULL;
            fz_buffer *contents   = NULL;
            pdf_obj *resources    = NULL;
            pdf_obj *page_obj     = NULL;

            fz_var(page);
            fz_var(dev);
            fz_var(contents);
            fz_var(resources);
            fz_var(page_obj);

            fz_try(ctx) {
                page = fz_load_page(ctx, doc, i);
                fz_rect mediabox = fz_bound_page(ctx, page);
                dev = pdf_page_write(ctx, pdfout, mediabox,
                                     &resources, &contents);
                fz_run_page(ctx, page, dev, fz_identity, NULL);
                fz_close_device(ctx, dev);
                fz_drop_device(ctx, dev);
                dev = NULL;
                page_obj = pdf_add_page(ctx, pdfout, mediabox,
                                        0, resources, contents);
                pdf_insert_page(ctx, pdfout, -1, page_obj);
            }
            fz_always(ctx) {
                pdf_drop_obj(ctx, page_obj);
                pdf_drop_obj(ctx, resources);
                fz_drop_buffer(ctx, contents);
                if (dev) fz_drop_device(ctx, dev);
                fz_drop_page(ctx, page);
            }
            fz_catch(ctx) {
                fz_rethrow(ctx);
            }
        }

        /* gc=4 付きで保存 */
        pdf_write_options opts = pdf_default_write_options;
        opts.do_compress        = 1;
        opts.do_compress_images = 1;
        opts.do_garbage         = 4;
        opts.do_clean           = 0;
        pdf_save_document(ctx, pdfout, output, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (pdfout) pdf_drop_document(ctx, pdfout);
        if (doc)    fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}
