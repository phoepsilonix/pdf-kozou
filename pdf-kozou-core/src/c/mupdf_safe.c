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

/* プラットフォーム共通インクルード */
#ifdef _WIN32
#  include <process.h>      /* _getpid */
#  define getpid() ((int)_getpid())
#  define KOZOU_PATH_SEP "\\"
#else
#  include <unistd.h>       /* getpid */
#  define KOZOU_PATH_SEP "/"
#endif

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

/* ------------------------------------------------------------------ */
/* kozou_rasterize                                                     */
/*                                                                     */
/* 各ページを DPI 指定でラスタライズして画像ページの PDF を生成する。   */
/* Type3 フォントを含む PDF でも動作する。                             */
/*                                                                     */
/* 方式:                                                               */
/*   1. fz_new_draw_device でページを pixmap にレンダリング             */
/*   2. pixmap を tmp_dir 内の一時ファイル (JPEG/PNG) に保存           */
/*   3. fz_new_image_from_file で fz_image を作成                     */
/*   4. pdf_add_image で PDF の xref に XObject として登録             */
/*   5. コンテンツストリームに cm + Do オペレータを手動で書く          */
/*   6. pdf_add_page + pdf_insert_page でページを追加                 */
/*   7. fz_always ブロックで一時ファイルを必ず削除                    */
/*                                                                     */
/* use_png      : 0=JPEG, 1=PNG                                       */
/* tmp_dir      : 一時ファイルを置くディレクトリ (pdf-kozou temp dir)  */
/*                NULL の場合は output と同じディレクトリを使う        */
/* page_indices : 0ベースのページ番号配列。NULL の場合は全ページ対象。 */
/* page_indices_len: page_indices の要素数。                           */
/* ------------------------------------------------------------------ */
void kozou_rasterize(
    fz_context  *ctx,
    const char  *input,
    const char  *output,
    float        dpi,
    int          quality,
    int          use_png,
    const char  *tmp_dir,
    const int   *page_indices,
    int          page_indices_len,
    FfiResult   *result)
{
    fz_document  *doc    = NULL;
    pdf_document *pdfout = NULL;

    fz_var(doc);
    fz_var(pdfout);

    fz_try(ctx) {
        fz_register_document_handlers(ctx);

        doc = fz_open_document(ctx, input);

        if (fz_is_document_reflowable(ctx, doc)) {
            fz_layout_document(ctx, doc, 450.0f, 600.0f, 12.0f);
        }

        int page_count = fz_count_pages(ctx, doc);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");

        if (dpi <= 0.0f) dpi = 150.0f;
        float scale = dpi / 72.0f;

        /* ページリストを構築: page_indices が NULL なら全ページ */
        int  *pages_to_render     = NULL;
        int   pages_to_render_len = 0;
        int   allocated           = 0;

        if (page_indices != NULL && page_indices_len > 0) {
            pages_to_render     = (int *)malloc(sizeof(int) * page_indices_len);
            pages_to_render_len = 0;
            allocated           = 1;
            for (int k = 0; k < page_indices_len; k++) {
                int idx = page_indices[k];
                if (idx >= 0 && idx < page_count) {
                    pages_to_render[pages_to_render_len++] = idx;
                }
            }
            if (pages_to_render_len == 0)
                fz_throw(ctx, FZ_ERROR_ARGUMENT,
                         "page_indices: no valid pages in range");
        } else {
            /* 全ページ: 0..page_count-1 */
            pages_to_render     = (int *)malloc(sizeof(int) * page_count);
            pages_to_render_len = page_count;
            allocated           = 1;
            for (int k = 0; k < page_count; k++)
                pages_to_render[k] = k;
        }

        /* 一時ファイルのベースディレクトリ:
         * tmp_dir が指定されていればそちら、なければ output の親ディレクトリ。
         * tmp_dir は pdf-kozou 専用 temp フォルダ (<system_temp>/pdf-kozou/) を
         * Rust 側から渡す。これにより一時ファイルが出力先に残らず、
         * アプリ終了時のクリーンアップでも確実に削除される。               */
        const char *base_tmp = (tmp_dir && tmp_dir[0]) ? tmp_dir : output;
        const char *ext      = use_png ? "png" : "jpg";

        pdfout = pdf_create_document(ctx);

        for (int ii = 0; ii < pages_to_render_len; ii++) {
            int i = pages_to_render[ii];
            fz_page    *page      = NULL;
            fz_pixmap  *pixmap    = NULL;
            fz_image   *image     = NULL;
            pdf_obj    *imgref    = NULL;
            fz_buffer  *contents  = NULL;
            pdf_obj    *resources = NULL;
            pdf_obj    *xobj_dict = NULL;
            pdf_obj    *page_obj  = NULL;

            /* 一時ファイルパスを fz_try の外側で宣言しておき、
             * fz_always ブロックで確実に remove できるようにする。
             * tmp_img[0] == '\0' ならファイルは未作成。                    */
            char tmp_img[1024];
            tmp_img[0] = '\0';

            fz_var(page);
            fz_var(pixmap);
            fz_var(image);
            fz_var(imgref);
            fz_var(contents);
            fz_var(resources);
            fz_var(xobj_dict);
            fz_var(page_obj);

            fz_try(ctx) {
                page = fz_load_page(ctx, doc, i);
                fz_rect bounds = fz_bound_page(ctx, page);

                float pw_pt = bounds.x1 - bounds.x0;
                float ph_pt = bounds.y1 - bounds.y0;

                /* draw device で pixmap にレンダリング */
                fz_matrix ctm = fz_scale(scale, scale);
                fz_irect bbox = fz_round_rect(fz_transform_rect(bounds, ctm));
                fz_colorspace *rgb = fz_device_rgb(ctx);
                pixmap = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
                fz_clear_pixmap_with_value(ctx, pixmap, 0xff);

                {
                    fz_device *draw_dev = fz_new_draw_device(ctx, ctm, pixmap);
                    fz_try(ctx) {
                        fz_run_page(ctx, page, draw_dev, fz_identity, NULL);
                        fz_close_device(ctx, draw_dev);
                    }
                    fz_always(ctx) { fz_drop_device(ctx, draw_dev); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                }

                /* pixmap → 一時ファイル (JPEG or PNG) → fz_image
                 *
                 * JPEG: fz_save_pixmap_as_jpeg で圧縮保存（サイズ削減）
                 * PNG : fz_write_pixmap_as_png で可逆保存（品質無劣化）
                 *
                 * 一時ファイルパスは tmp_dir (pdf-kozou専用tempフォルダ) 内に
                 * 置くことで出力先ディレクトリを汚染しない。
                 * fz_always ブロックで必ず remove する。                    */
                snprintf(tmp_img, sizeof(tmp_img),
                         "%s" KOZOU_PATH_SEP "kozou_rasterize_%d_%d.%s",
                         base_tmp, (int)getpid(), i, ext);

                if (use_png) {
                    fz_output *fout = fz_new_output_with_path(ctx, tmp_img, 0);
                    fz_try(ctx) {
                        fz_write_pixmap_as_png(ctx, fout, pixmap);
                        fz_close_output(ctx, fout);
                    }
                    fz_always(ctx) { fz_drop_output(ctx, fout); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                } else {
                    int jpeg_quality = (quality > 0 && quality <= 100) ? quality : 85;
                    fz_save_pixmap_as_jpeg(ctx, pixmap, tmp_img, jpeg_quality);
                }

                image   = fz_new_image_from_file(ctx, tmp_img);
                imgref  = pdf_add_image(ctx, pdfout, image);

                /* Resources 辞書: /XObject << /Im0 <imgref> >> */
                resources = pdf_new_dict(ctx, pdfout, 1);
                xobj_dict = pdf_new_dict(ctx, pdfout, 1);
                {
                    pdf_obj *im0_name = pdf_new_name(ctx, "Im0");
                    pdf_dict_put(ctx, xobj_dict, im0_name, imgref);
                    pdf_drop_obj(ctx, im0_name);
                }
                pdf_dict_put(ctx, resources, PDF_NAME(XObject), xobj_dict);

                /* コンテンツストリーム:
                 *   q
                 *   pw 0 0 ph 0 0 cm   ← MediaBox サイズに拡大
                 *   /Im0 Do             ← 画像を描画
                 *   Q
                 */
                char cs_buf[256];
                int cs_len = snprintf(cs_buf, sizeof(cs_buf),
                    "q\n%.4f 0 0 %.4f 0 0 cm\n/Im0 Do\nQ\n",
                    pw_pt, ph_pt);
                contents = fz_new_buffer_from_copied_data(ctx,
                    (const unsigned char *)cs_buf, (size_t)cs_len);

                fz_rect mediabox = { 0, 0, pw_pt, ph_pt };
                page_obj = pdf_add_page(ctx, pdfout, mediabox, 0, resources, contents);
                pdf_insert_page(ctx, pdfout, -1, page_obj);
            }
            fz_always(ctx) {
                /* 一時ファイルを必ず削除（エラー時も含む） */
                if (tmp_img[0] != '\0') {
                    remove(tmp_img);
                    tmp_img[0] = '\0';
                }
                pdf_drop_obj(ctx, page_obj);
                pdf_drop_obj(ctx, xobj_dict);
                pdf_drop_obj(ctx, resources);
                fz_drop_buffer(ctx, contents);
                /* imgref は pdf_add_image が返す間接参照: pdfout の xref が管理する */
                /* → ここでは drop しない（二重 free を防ぐ）                      */
                fz_drop_image(ctx, image);
                fz_drop_pixmap(ctx, pixmap);
                fz_drop_page(ctx, page);
            }
            fz_catch(ctx) {
                fz_rethrow(ctx);
            }
        }

        /* PNG埋め込み時は do_compress_images を無効にして無劣化を維持 */
        pdf_write_options opts = pdf_default_write_options;
        opts.do_compress        = 1;
        opts.do_compress_images = use_png ? 0 : 1;
        opts.do_garbage         = 0;
        opts.do_clean           = 0;
        pdf_save_document(ctx, pdfout, output, &opts);

        if (allocated) free(pages_to_render);
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

/* ------------------------------------------------------------------ */
/* kozou_compress_preserving_type3                                     */
/*                                                                     */
/* Type3 フォントを含む PDF を圧縮する。                               */
/* pdf_graft_mapped_object でページと全参照オブジェクト（Type3 の      */
/* CharProcs を含む）を新規 PDF に移植し、gc=2 で保存する。            */
/*                                                                     */
/* clip_to_cropbox=1 の場合、各ページのコンテンツストリームの前後に    */
/* CropBox クリッピングパスを挿入する。                                */
/* これにより CropBox 外の描画が視覚的に除去される。                   */
/* ------------------------------------------------------------------ */
void kozou_compress_preserving_type3(
    fz_context  *ctx,
    const char  *input,
    const char  *output,
    int          gc,
    int          compress,
    int          compress_images,
    int          clip_to_cropbox,  /* 1=CropBox クリッピングを適用 */
    FfiResult   *result)
{
    pdf_document *src   = NULL;
    pdf_document *dst   = NULL;
    pdf_graft_map *gmap = NULL;

    fz_var(src);
    fz_var(dst);
    fz_var(gmap);

    fz_try(ctx) {
        if (gc < 0) gc = 0;
        if (gc > 2) gc = 2;

        src = pdf_open_document(ctx, input);
        dst = pdf_create_document(ctx);

        int page_count = pdf_count_pages(ctx, src);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");

        gmap = pdf_new_graft_map(ctx, dst);

        for (int i = 0; i < page_count; i++) {
            pdf_obj *src_page = NULL;
            pdf_obj *dst_page = NULL;

            fz_var(src_page);
            fz_var(dst_page);

            fz_try(ctx) {
                src_page = pdf_lookup_page_obj(ctx, src, i);
                dst_page = pdf_graft_mapped_object(ctx, gmap, src_page);
                pdf_insert_page(ctx, dst, -1, dst_page);

                /* CropBox クリッピングを適用する場合:
                 * dst に挿入済みのページオブジェクトを開いてコンテンツを修正する */
                if (clip_to_cropbox) {
                    pdf_page *dst_pg = NULL;
                    fz_var(dst_pg);
                    fz_try(ctx) {
                        dst_pg = pdf_load_page(ctx, dst, i);

                        /* CropBox を取得（なければ MediaBox） */
                        fz_rect cropbox = pdf_bound_page(ctx, dst_pg, FZ_CROP_BOX);
                        fz_rect mediabox = pdf_bound_page(ctx, dst_pg, FZ_MEDIA_BOX);

                        /* CropBox が MediaBox と同一なら追加不要（クリップ効果なし） */
                        int need_clip =
                            cropbox.x0 != mediabox.x0 || cropbox.y0 != mediabox.y0 ||
                            cropbox.x1 != mediabox.x1 || cropbox.y1 != mediabox.y1;

                        /* または MediaBox 外の領域がある可能性があれば常にクリップ */
                        /* ここでは常に適用する（コスト低い） */
                        need_clip = 1;

                        /* クリッピングラッパーを構築:
                         * q
                         * x0 y0 x1-x0 y1-y0 re   ← CropBox の矩形パス
                         * W n                      ← クリップして塗らない
                         * <元のコンテンツ>
                         * Q
                         */
                        char clip_prefix[256];
                        int prefix_len = snprintf(clip_prefix, sizeof(clip_prefix),
                            "q\n%.4f %.4f %.4f %.4f re\nW n\n",
                            cropbox.x0, cropbox.y0,
                            cropbox.x1 - cropbox.x0,
                            cropbox.y1 - cropbox.y0);

                        const char *clip_suffix = "Q\n";

                        /* 既存のコンテンツバッファを取得 */
                        pdf_obj *page_obj = dst_pg->obj;
                        pdf_obj *contents = pdf_dict_get(ctx, page_obj, PDF_NAME(Contents));

                        if (contents && need_clip) {
                            fz_buffer *prefix_buf = fz_new_buffer_from_copied_data(
                                ctx,
                                (const unsigned char *)clip_prefix,
                                (size_t)prefix_len);
                            fz_buffer *suffix_buf = fz_new_buffer_from_copied_data(
                                ctx,
                                (const unsigned char *)clip_suffix,
                                strlen(clip_suffix));

                            fz_try(ctx) {
                                /* Contents が配列の場合はラッピングストリームを前後に追加 */
                                /* 配列でも単一ストリームでも動作するよう配列に統一する   */
                                pdf_obj *new_contents = pdf_new_array(ctx, dst, 3);

                                fz_try(ctx) {
                                    /* プレフィックスストリームを追加 */
                                    pdf_obj *prefix_stream = pdf_add_stream(
                                        ctx, dst, prefix_buf, NULL, 0);
                                    pdf_array_push_drop(ctx, new_contents, prefix_stream);

                                    /* 元のコンテンツを追加 */
                                    if (pdf_is_array(ctx, contents)) {
                                        int n = pdf_array_len(ctx, contents);
                                        for (int j = 0; j < n; j++) {
                                            pdf_obj *item = pdf_array_get(ctx, contents, j);
                                            pdf_array_push(ctx, new_contents, item);
                                        }
                                    } else {
                                        pdf_array_push(ctx, new_contents, contents);
                                    }

                                    /* サフィックスストリームを追加 */
                                    pdf_obj *suffix_stream = pdf_add_stream(
                                        ctx, dst, suffix_buf, NULL, 0);
                                    pdf_array_push_drop(ctx, new_contents, suffix_stream);

                                    pdf_dict_put(ctx, page_obj, PDF_NAME(Contents), new_contents);
                                }
                                fz_always(ctx) {
                                    pdf_drop_obj(ctx, new_contents);
                                }
                                fz_catch(ctx) {
                                    fz_rethrow(ctx);
                                }
                            }
                            fz_always(ctx) {
                                fz_drop_buffer(ctx, prefix_buf);
                                fz_drop_buffer(ctx, suffix_buf);
                            }
                            fz_catch(ctx) {
                                fz_rethrow(ctx);
                            }
                        }
                    }
                    fz_always(ctx) {
                        if (dst_pg) fz_drop_page(ctx, (fz_page *)dst_pg);
                    }
                    fz_catch(ctx) {
                        /* クリッピング失敗は致命的ではない — 続行 */
                        fz_warn(ctx, "clip_to_cropbox failed for page %d: %s",
                                i, fz_caught_message(ctx));
                    }
                }
            }
            fz_always(ctx) {
                pdf_drop_obj(ctx, dst_page);
            }
            fz_catch(ctx) {
                fz_rethrow(ctx);
            }
        }

        pdf_write_options opts = pdf_default_write_options;
        opts.do_garbage         = gc;
        opts.do_compress        = compress;
        opts.do_compress_images = compress_images;
        opts.do_clean           = 0;
        opts.do_sanitize        = 0;

        pdf_save_document(ctx, dst, output, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (gmap) pdf_drop_graft_map(ctx, gmap);
        if (dst)  pdf_drop_document(ctx, dst);
        if (src)  pdf_drop_document(ctx, src);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_get_doc_info                                                  */
/*                                                                     */
/* ドキュメントの基本情報を取得する（Rust バインディングを使わない）。 */
/* fz_open_document → fz_layout_document（reflowable のみ）           */
/* → ページ数・各ページの bounds を取得する。                         */
/*                                                                     */
/* page_rects: 呼び出し側が確保した fz_rect の配列                   */
/*             (max_pages 個分のスペースが必要)                        */
/* out_page_count: 実際のページ数を返す                               */
/* ------------------------------------------------------------------ */
void kozou_get_doc_info(
    fz_context *ctx,
    const char *path,
    float       layout_w,
    float       layout_h,
    float       layout_em,
    float      *page_rects,    /* out: [x0,y0,x1,y1] × max_pages */
    int        *out_page_count,
    int         max_pages,
    FfiResult  *result)
{
    fz_document *doc = NULL;
    fz_var(doc);

    *out_page_count = 0;

    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);

        int is_reflowable = fz_is_document_reflowable(ctx, doc);

        if (is_reflowable) {
            float w  = (layout_w  > 0) ? layout_w  : 450.0f;
            float h  = (layout_h  > 0) ? layout_h  : 600.0f;
            float em = (layout_em > 0) ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        int page_count = fz_count_pages(ctx, doc);
        *out_page_count = page_count;

        /* page_count だけ取得して bounds はスキップ */
        /* bounds が必要な場合は別 FFI で取得する    */
        int limit = (page_count < max_pages) ? page_count : max_pages;
        for (int i = 0; i < limit; i++) {
            fz_page *page = NULL;
            fz_var(page);
            fz_try(ctx) {
                page = fz_load_page(ctx, doc, i);
                fz_rect r = fz_bound_page(ctx, page);
                page_rects[i * 4 + 0] = r.x0;
                page_rects[i * 4 + 1] = r.y0;
                page_rects[i * 4 + 2] = r.x1;
                page_rects[i * 4 + 3] = r.y1;
            }
            fz_always(ctx) {
                if (page) fz_drop_page(ctx, page);
            }
            fz_catch(ctx) {
                page_rects[i * 4 + 0] = 0.0f;
                page_rects[i * 4 + 1] = 0.0f;
                page_rects[i * 4 + 2] = 595.0f;
                page_rects[i * 4 + 3] = 842.0f;
            }
        }

        set_ok(result);
    }
    fz_always(ctx) {
        if (doc) fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_render_page                                                   */
/*                                                                     */
/* 指定ページを DPI でレンダリングして JPEG または PNG バイト列を返す。 */
/* mupdf-rs の Document::open（グローバルコンテキスト）を使わないため  */
/* Windows での font_kit フリーズが発生しない。                        */
/*                                                                     */
/* out_buf: 呼び出し側で確保・解放不要。fz_buffer* を返す。           */
/*          使用後に kozou_drop_buffer で解放すること。               */
/* format: 0=JPEG, 1=PNG                                              */
/* ------------------------------------------------------------------ */
fz_buffer *kozou_render_page(
    fz_context *ctx,
    const char *path,
    int         page_index,
    float       dpi,
    float       layout_w,
    float       layout_h,
    float       layout_em,
    int         format,      /* 0=JPEG, 1=PNG */
    int         quality,     /* JPEG quality 0-100 */
    int        *out_width,
    int        *out_height,
    float      *out_page_w_pt,
    float      *out_page_h_pt,
    FfiResult  *result)
{
    fz_document *doc    = NULL;
    fz_page     *page   = NULL;
    fz_pixmap   *pixmap = NULL;
    fz_buffer   *buf    = NULL;
    fz_output   *out    = NULL;

    fz_var(doc);
    fz_var(page);
    fz_var(pixmap);
    fz_var(buf);
    fz_var(out);

    *out_width     = 0;
    *out_height    = 0;
    *out_page_w_pt = 0.0f;
    *out_page_h_pt = 0.0f;

    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = (layout_w  > 0) ? layout_w  : 450.0f;
            float h  = (layout_h  > 0) ? layout_h  : 600.0f;
            float em = (layout_em > 0) ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page = fz_load_page(ctx, doc, page_index);
        fz_rect bounds = fz_bound_page(ctx, page);

        *out_page_w_pt = bounds.x1 - bounds.x0;
        *out_page_h_pt = bounds.y1 - bounds.y0;

        float scale = (dpi > 0) ? dpi / 72.0f : 2.0f;
        fz_matrix ctm = fz_scale(scale, scale);
        fz_irect bbox = fz_round_rect(fz_transform_rect(bounds, ctm));

        fz_colorspace *rgb = fz_device_rgb(ctx);
        pixmap = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
        fz_clear_pixmap_with_value(ctx, pixmap, 0xff);

        fz_device *draw_dev = fz_new_draw_device(ctx, ctm, pixmap);
        fz_try(ctx) {
            fz_run_page(ctx, page, draw_dev, fz_identity, NULL);
            fz_close_device(ctx, draw_dev);
        }
        fz_always(ctx) { fz_drop_device(ctx, draw_dev); }
        fz_catch(ctx)  { fz_rethrow(ctx); }

        *out_width  = fz_pixmap_width(ctx, pixmap);
        *out_height = fz_pixmap_height(ctx, pixmap);

        /* バッファに書き出す */
        size_t est_size = (size_t)(*out_width) * (*out_height) * 3;
        buf = fz_new_buffer(ctx, est_size > 4096 ? est_size : 4096);
        out = fz_new_output_with_buffer(ctx, buf);

        if (format == 1) {
            /* PNG */
            fz_write_pixmap_as_png(ctx, out, pixmap);
        } else {
            /* JPEG */
            int q = (quality > 0 && quality <= 100) ? quality : 85;
            fz_write_pixmap_as_jpeg(ctx, out, pixmap, q, 0);
        }
        fz_close_output(ctx, out);
        fz_drop_output(ctx, out);
        out = NULL;

        set_ok(result);
    }
    fz_always(ctx) {
        if (out)    fz_drop_output(ctx, out);
        if (pixmap) fz_drop_pixmap(ctx, pixmap);
        if (page)   fz_drop_page(ctx, page);
        if (doc)    fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        if (buf) { fz_drop_buffer(ctx, buf); buf = NULL; }
        set_err(result, fz_caught_message(ctx));
    }
    return buf;
}

void kozou_drop_buffer(fz_context *ctx, fz_buffer *buf)
{
    if (buf) fz_drop_buffer(ctx, buf);
}

/* fz_buffer の内容を取得するヘルパー */
size_t kozou_buffer_get_data(fz_context *ctx, fz_buffer *buf,
                              const unsigned char **data_out)
{
    if (!buf || !data_out) return 0;
    unsigned char *data = NULL;
    size_t len = fz_buffer_storage(ctx, buf, &data);
    *data_out = data;
    return len;
}

/* ================================================================== */
/* 隠しテキスト検出                                                     */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* kozou_detect_transparent_text                                       */
/*                                                                     */
/* ページ内の透明テキスト（alpha=0）を検出して JSON で返す。           */
/*                                                                     */
/* fz_stext_char.argb は上位8bit が alpha、残り24bit が RGB。          */
/* fz_stext_char.flags: FZ_STEXT_FILLED=16, FZ_STEXT_STROKED=32        */
/*   flags=0 → Tr=3/7 invisible, flags=16 → 通常描画                  */
/* alpha == 0 → 完全透明（不可視）。                                   */
/* alpha > 0 かつ alpha < threshold → 半透明（ほぼ不可視）。           */
/*                                                                     */
/* 出力 JSON 形式（fz_output *out に書き込む）:                        */
/* {                                                                   */
/*   "ok": true,                                                       */
/*   "page": <page_index>,                                             */
/*   "hits": [                                                         */
/*     {                                                               */
/*       "char": "<Unicode文字>",                                      */
/*       "alpha": <0-255>,       // 0=完全透明                        */
/*       "color_rgb": [R, G, B], // 0-255                             */
/*       "origin": [x, y],       // pt 単位                           */
/*       "quad": [ul.x,ul.y, ur.x,ur.y, ll.x,ll.y, lr.x,lr.y],       */
/*       "size": <float>         // フォントサイズ pt                  */
/*     }, ...                                                          */
/*   ]                                                                 */
/* }                                                                   */
/*                                                                     */
/* alpha_threshold: この値以下（0-255）を透明とみなす。                */
/*   0 = 完全透明のみ検出                                              */
/*  25 = alpha < 10% も検出                                            */
/* ------------------------------------------------------------------ */
void kozou_detect_transparent_text(
    fz_context  *ctx,
    const char  *path,
    int          page_index,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    int          alpha_threshold, /* 0-255: この値以下を検出 */
    fz_output   *out,
    FfiResult   *result)
{
    fz_document       *doc       = NULL;
    fz_page           *page      = NULL;
    fz_stext_page     *stext     = NULL;

    fz_var(doc);
    fz_var(page);
    fz_var(stext);

    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = (layout_w  > 0) ? layout_w  : 450.0f;
            float h  = (layout_h  > 0) ? layout_h  : 600.0f;
            float em = (layout_em > 0) ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page = fz_load_page(ctx, doc, page_index);

        /* PRESERVE_WHITESPACE | ACCURATE_BBOXES */
        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        stext = fz_new_stext_page_from_page(ctx, page, &opts);

        /* alpha_threshold を 0-255 にクランプ */
        if (alpha_threshold < 0)   alpha_threshold = 0;
        if (alpha_threshold > 255) alpha_threshold = 255;

        int hit_count = 0;

        fz_write_printf(ctx, out, "{\"ok\":true,\"page\":%d,\"hits\":[", page_index);

        for (fz_stext_block *block = stext->first_block;
             block; block = block->next) {
            if (block->type != FZ_STEXT_BLOCK_TEXT) continue;

            for (fz_stext_line *line = block->u.t.first_line;
                 line; line = line->next) {

                for (fz_stext_char *ch = line->first_char;
                     ch; ch = ch->next) {

                    /* argb: ARGB packed int (0xAARRGGBB) - MuPDF 1.26以降はargbにリネーム */
                    unsigned int packed = (unsigned int)ch->argb;
                    int alpha = (packed >> 24) & 0xFF;
                    int r     = (packed >> 16) & 0xFF;
                    int g     = (packed >>  8) & 0xFF;
                    int b     =  packed        & 0xFF;

                    if (alpha > alpha_threshold) continue;

                    /* Unicode コードポイント → UTF-8 */
                    char utf8[8] = {0};
                    int cp = ch->c;
                    if (cp < 0x80) {
                        utf8[0] = (char)cp;
                    } else if (cp < 0x800) {
                        utf8[0] = (char)(0xC0 | (cp >> 6));
                        utf8[1] = (char)(0x80 | (cp & 0x3F));
                    } else if (cp < 0x10000) {
                        utf8[0] = (char)(0xE0 | (cp >> 12));
                        utf8[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
                        utf8[2] = (char)(0x80 | (cp & 0x3F));
                    } else {
                        utf8[0] = (char)(0xF0 | (cp >> 18));
                        utf8[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
                        utf8[2] = (char)(0x80 | ((cp >>  6) & 0x3F));
                        utf8[3] = (char)(0x80 | (cp & 0x3F));
                    }

                    /* JSON エスケープが必要な文字を処理 */
                    char escaped[32] = {0};
                    if (cp == '"')       { escaped[0]='\\'; escaped[1]='"';  }
                    else if (cp == '\\') { escaped[0]='\\'; escaped[1]='\\'; }
                    else if (cp == '\n') { escaped[0]='\\'; escaped[1]='n';  }
                    else if (cp == '\r') { escaped[0]='\\'; escaped[1]='r';  }
                    else if (cp == '\t') { escaped[0]='\\'; escaped[1]='t';  }
                    else if (cp < 0x20) {
                        /* 制御文字は \uXXXX */
                        snprintf(escaped, sizeof(escaped), "\\u%04X", cp);
                    } else {
                        int i;
                        for (i = 0; utf8[i]; i++) escaped[i] = utf8[i];
                    }

                    fz_quad q  = ch->quad;
                    fz_point o = ch->origin;

                    if (hit_count > 0) fz_write_printf(ctx, out, ",");

                    /* reason の判定:
                     * FZ_STEXT_FILLED  = 16 (0x10)
                     * FZ_STEXT_STROKED = 32 (0x20)
                     * FZ_STEXT_CLIP    = 64 (0x40)
                     *
                     * flags == 0         → Tr=3: 完全不可視（描画なし）
                     * flags & 64 != 0    → Tr=7: クリップパスのみ（塗りなし）
                     * それ以外 alpha==0  → ExtGState ca=0 による透明           */
                    int ch_flags = ch->flags;
                    const char *reason;
                    if (ch_flags == 0)
                        reason = "invisible_mode";   /* Tr=3: 完全不可視 */
                    else if (ch_flags & 64)
                        reason = "clip_only_mode";   /* Tr=7: クリップのみ */
                    else
                        reason = "transparent";      /* ExtGState alpha=0 */

                    fz_write_printf(ctx, out,
                        "{"
                        "\"char\":\"%s\","
                        "\"alpha\":%d,"
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"flags\":%d,"
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"size\":%.3f"
                        "}",
                        escaped, alpha, r, g, b,
                        ch_flags, reason,
                        o.x, o.y,
                        q.ul.x, q.ul.y,
                        q.ur.x, q.ur.y,
                        q.ll.x, q.ll.y,
                        q.lr.x, q.lr.y,
                        ch->size
                    );

                    hit_count++;
                }
            }
        }

        fz_write_printf(ctx, out, "]}");
        set_ok(result);
    }
    fz_always(ctx) {
        if (stext) fz_drop_stext_page(ctx, stext);
        if (page)  fz_drop_page(ctx, page);
        if (doc)   fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ================================================================== */
/* ③ 見えにくい色検出: 文字色と背景色のコントラスト比が低い文字を検出   */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* 内部: コントラスト比計算 (WCAG 2.1 相対輝度)                        */
/* 戻り値: 1.0(同色) 〜 21.0(白黒)                                    */
/* ------------------------------------------------------------------ */
static float kozou_relative_luminance(float r, float g, float b)
{
    /* sRGB → 線形化 */
#define LINEARIZE(c) ((c) <= 0.04045f ? (c)/12.92f : powf(((c)+0.055f)/1.055f, 2.4f))
    float rl = LINEARIZE(r);
    float gl = LINEARIZE(g);
    float bl = LINEARIZE(b);
#undef LINEARIZE
    return 0.2126f * rl + 0.7152f * gl + 0.0722f * bl;
}

static float kozou_contrast_ratio(
    float r1, float g1, float b1,
    float r2, float g2, float b2)
{
    float l1 = kozou_relative_luminance(r1, g1, b1);
    float l2 = kozou_relative_luminance(r2, g2, b2);
    float bright = (l1 > l2) ? l1 : l2;
    float dark   = (l1 < l2) ? l1 : l2;
    return (bright + 0.05f) / (dark + 0.05f);
}

/* ------------------------------------------------------------------ */
/* 内部: 塗り矩形リスト（描画順に蓄積する）                             */
/* ------------------------------------------------------------------ */
#define KOZOU_MAX_FILLS 4096

typedef struct {
    float x0, y0, x1, y1;  /* pt 座標（PDF座標系: Y上向き）*/
    float r, g, b;
} KozouFillRect;

typedef struct {
    KozouFillRect rects[KOZOU_MAX_FILLS];
    int           count;
} KozouFillList;

/* ------------------------------------------------------------------ */
/* 内部: カスタム fz_device — fill_path コールバックで塗り矩形を記録    */
/* ------------------------------------------------------------------ */
typedef struct {
    fz_device  base;    /* 必ず先頭に置く */
    KozouFillList *fills;
    fz_context *ctx;
} KozouFillDevice;

static void kozou_fill_device_fill_path(
    fz_context   *ctx,
    fz_device    *dev_,
    const fz_path *path,
    int           even_odd,
    fz_matrix     ctm,
    fz_colorspace *colorspace,
    const float  *color,
    float         alpha,
    fz_color_params cp)
{
    KozouFillDevice *dev = (KozouFillDevice *)dev_;
    if (!dev->fills || dev->fills->count >= KOZOU_MAX_FILLS) return;
    if (alpha < 0.01f) return; /* ほぼ透明な塗りは無視 */

    /* カラースペースを RGB に変換 */
    float rgb[3] = {0.0f, 0.0f, 0.0f};
    if (colorspace) {
        fz_try(ctx) {
            fz_colorspace *cs_rgb = fz_device_rgb(ctx);
            fz_convert_color(ctx, colorspace, color, cs_rgb, rgb, NULL, cp);
        }
        fz_catch(ctx) {
            /* 変換失敗時はそのまま使う */
            if (fz_colorspace_n(ctx, colorspace) >= 3) {
                rgb[0] = color[0];
                rgb[1] = color[1];
                rgb[2] = color[2];
            }
        }
    }

    /* パスのバウンディングボックスを取得 */
    fz_rect bbox = fz_bound_path(ctx, path, NULL, ctm);
    if (bbox.x0 >= bbox.x1 || bbox.y0 >= bbox.y1) return;

    KozouFillRect *fr = &dev->fills->rects[dev->fills->count++];
    fr->x0 = bbox.x0;
    fr->y0 = bbox.y0;
    fr->x1 = bbox.x1;
    fr->y1 = bbox.y1;
    fr->r  = rgb[0];
    fr->g  = rgb[1];
    fr->b  = rgb[2];
}

static fz_device *kozou_new_fill_device(fz_context *ctx, KozouFillList *fills)
{
    KozouFillDevice *dev = fz_new_derived_device(ctx, KozouFillDevice);
    dev->base.fill_path = kozou_fill_device_fill_path;
    dev->fills = fills;
    dev->ctx   = ctx;
    return (fz_device *)dev;
}

/* ------------------------------------------------------------------ */
/* 内部: 文字位置に最も近い（直前に描画された）塗り矩形の色を返す       */
/* 文字の原点(ox, oy)を包含する矩形のうち、リスト上で最後のものを選ぶ。 */
/* 見つからない場合は -1 を返す。                                       */
/* ------------------------------------------------------------------ */
static int kozou_find_background(
    const KozouFillList *fills,
    float ox, float oy,     /* PDF 座標系 (Y上向き) の文字原点 */
    float page_h)           /* ページ高さ (pt) */
{
    /* PyMuPDF/MuPDF のデバイス座標は Y 下向き
     * fill_path コールバックも CTM 適用後の Y 下向き座標になっている
     * 文字の stext 座標も同じ Y 下向き
     * → 変換不要で直接比較できる                                      */
    int best = -1;
    for (int i = 0; i < fills->count; i++) {
        const KozouFillRect *fr = &fills->rects[i];
        /* 文字原点が矩形内に収まるか */
        if (ox >= fr->x0 && ox <= fr->x1 &&
            oy >= fr->y0 && oy <= fr->y1) {
            best = i; /* 最後に描画されたものを優先 */
        }
    }
    return best;
}

/* ------------------------------------------------------------------ */
/* kozou_detect_low_contrast_text                                      */
/*                                                                     */
/* 文字色と背景色のコントラスト比が contrast_threshold 以下の文字を    */
/* 検出して JSON で返す。                                              */
/*                                                                     */
/* contrast_threshold: 1.0〜21.0 (デフォルト推奨: 1.5)               */
/*   1.0 = 完全に同色のみ                                              */
/*   1.5 = ほぼ同色（約3%の輝度差以下）                                */
/*   3.0 = かなり見えにくい（WCAGの最低基準4.5:1の半分以下）            */
/*                                                                     */
/* 出力 JSON:                                                          */
/* {                                                                   */
/*   "ok": true, "page": N,                                           */
/*   "hits": [{                                                        */
/*     "char": "X",                                                    */
/*     "color_rgb": [R,G,B],       // 文字色 0-255                    */
/*     "bg_color_rgb": [R,G,B],    // 背景色 0-255                    */
/*     "contrast": 1.23,           // コントラスト比                   */
/*     "origin": [x,y],            // pt                              */
/*     "quad": [...],                                                  */
/*     "size": 12.0                                                    */
/*   }]                                                               */
/* }                                                                   */
/* ------------------------------------------------------------------ */
void kozou_detect_low_contrast_text(
    fz_context  *ctx,
    const char  *path,
    int          page_index,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    float        contrast_threshold,
    fz_output   *out,
    FfiResult   *result)
{
    fz_document   *doc    = NULL;
    fz_page       *page   = NULL;
    fz_stext_page *stext  = NULL;
    fz_device     *filldev = NULL;
    KozouFillList *fills  = NULL;

    fz_var(doc);
    fz_var(page);
    fz_var(stext);
    fz_var(filldev);
    fz_var(fills);

    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = (layout_w  > 0) ? layout_w  : 450.0f;
            float h  = (layout_h  > 0) ? layout_h  : 600.0f;
            float em = (layout_em > 0) ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page = fz_load_page(ctx, doc, page_index);
        fz_rect page_bounds = fz_bound_page(ctx, page);
        float page_h = page_bounds.y1 - page_bounds.y0;

        /* Step 1: fill_path コールバックで塗り矩形を順番に収集 */
        fills = (KozouFillList *)fz_malloc(ctx, sizeof(KozouFillList));
        memset(fills, 0, sizeof(KozouFillList));

        filldev = kozou_new_fill_device(ctx, fills);
        fz_run_page(ctx, page, filldev, fz_identity, NULL);
        fz_close_device(ctx, filldev);
        fz_drop_device(ctx, filldev);
        filldev = NULL;

        /* Step 2: stext で文字を取得して背景色と比較 */
        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        stext = fz_new_stext_page_from_page(ctx, page, &opts);

        if (contrast_threshold <= 0.0f) contrast_threshold = 1.5f;
        if (contrast_threshold > 21.0f) contrast_threshold = 21.0f;

        int hit_count = 0;
        fz_write_printf(ctx, out,
            "{\"ok\":true,\"page\":%d,\"hits\":[", page_index);

        for (fz_stext_block *block = stext->first_block;
             block; block = block->next) {
            if (block->type != FZ_STEXT_BLOCK_TEXT) continue;

            for (fz_stext_line *line = block->u.t.first_line;
                 line; line = line->next) {

                for (fz_stext_char *ch = line->first_char;
                     ch; ch = ch->next) {

                    /* alpha=0 の文字は透明テキスト検出で扱う → スキップ */
                    unsigned int packed = (unsigned int)ch->argb;
                    int alpha = (packed >> 24) & 0xFF;
                    if (alpha == 0) continue;

                    /* 文字色 (0.0-1.0) */
                    float tr = ((packed >> 16) & 0xFF) / 255.0f;
                    float tg = ((packed >>  8) & 0xFF) / 255.0f;
                    float tb = ( packed        & 0xFF) / 255.0f;

                    /* 文字の原点 */
                    fz_point o = ch->origin;

                    /* 背景色を検索 */
                    int bi = kozou_find_background(fills, o.x, o.y, page_h);
                    if (bi < 0) continue; /* 背景なし → スキップ */

                    const KozouFillRect *fr = &fills->rects[bi];
                    float cr = kozou_contrast_ratio(tr, tg, tb,
                                                    fr->r, fr->g, fr->b);

                    if (cr > contrast_threshold) continue;

                    /* JSON エスケープ */
                    int cp = ch->c;
                    char escaped[32] = {0};
                    if (cp == '"')       { escaped[0]='\\'; escaped[1]='"';  }
                    else if (cp == '\\') { escaped[0]='\\'; escaped[1]='\\'; }
                    else if (cp == '\n') { escaped[0]='\\'; escaped[1]='n';  }
                    else if (cp < 0x20 || cp > 0x7E) {
                        snprintf(escaped, sizeof(escaped), "\\u%04X", cp);
                    } else {
                        escaped[0] = (char)cp;
                    }

                    fz_quad q = ch->quad;
                    if (hit_count > 0) fz_write_printf(ctx, out, ",");

                    fz_write_printf(ctx, out,
                        "{"
                        "\"char\":\"%s\","
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"bg_color_rgb\":[%d,%d,%d],"
                        "\"contrast\":%.3f,"
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"size\":%.3f"
                        "}",
                        escaped,
                        (int)(tr*255+0.5f),
                        (int)(tg*255+0.5f),
                        (int)(tb*255+0.5f),
                        (int)(fr->r*255+0.5f),
                        (int)(fr->g*255+0.5f),
                        (int)(fr->b*255+0.5f),
                        cr,
                        o.x, o.y,
                        q.ul.x, q.ul.y,
                        q.ur.x, q.ur.y,
                        q.ll.x, q.ll.y,
                        q.lr.x, q.lr.y,
                        ch->size
                    );
                    hit_count++;
                }
            }
        }

        fz_write_printf(ctx, out, "]}");
        set_ok(result);
    }
    fz_always(ctx) {
        if (fills)   fz_free(ctx, fills);
        if (stext)   fz_drop_stext_page(ctx, stext);
        if (filldev) { fz_close_device(ctx, filldev); fz_drop_device(ctx, filldev); }
        if (page)    fz_drop_page(ctx, page);
        if (doc)     fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}
