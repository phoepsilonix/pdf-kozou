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

#include <limits.h>
#include <math.h>
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


/* ------------------------------------------------------------------ */
/* kozou_sanitize が出力した U+0020 を「無害化済み」として識別する      */
/* ------------------------------------------------------------------ */
static int kozou_is_sanitized_space(int cp)
{
    return (cp == 0x0020); /* kozou_sanitize の置き換え先は U+0020 のみ */
}

/* kozou_control_char_category の前方宣言                               */
/* （定義は detect_control_chars の直前にあるため先に宣言する）         */
static const char *kozou_control_char_category(int cp);

/* フォント名が Helvetica 系かどうか判定する                             */
#define KOZOU_HV "KOZOU_HV"  /* Helvetica Type1 フォントのリソース名 */
/* kozou_sanitize は KOZOU_HV (Helvetica Type1) を使うため、           */
/* Helvetica + U+0020 の組み合わせを sanitized と確定判定できる         */
/* ------------------------------------------------------------------ */
static int kozou_is_helvetica_font(fz_context *ctx, fz_font *font)
{
    if (!font) return 0;
    const char *name = fz_font_name(ctx, font);
    if (!name) return 0;
    return (strstr(name, "Helvetica") != NULL ||
            strstr(name, "KOZOU_HV") != NULL);
}

/* U+0020 以外の空白系文字 — 無害化対象候補として検出する               */
/* ------------------------------------------------------------------ */
static int kozou_is_whitespace_codepoint(int cp)
{
    return (cp == 0x00A0 ||  /* ノーブレークスペース */
            cp == 0x3000 ||  /* 全角スペース */
            cp == 0x2000 || cp == 0x2001 || cp == 0x2002 ||
            cp == 0x2003 || cp == 0x2004 || cp == 0x2005 ||
            cp == 0x2006 || cp == 0x2007 || cp == 0x2008 ||
            cp == 0x2009 || cp == 0x200A || /* 各種幅スペース */
            cp == 0x0009 || cp == 0x000D); /* TAB/CR (LF除外) */
}

/* 注: Rust側 (ffi.rs) からはもう呼ばれていません。mupdf-rs のフォント代替
 * フックが内部で使う共有コンテキストと異なるグループになってしまうため、
 * Rust側は代わりに mupdf::new_context() (共有コンテキストのクローン) を
 * 使うよう変更されました。単独のコンテキストが必要なC側の他の用途のために
 * 関数自体は残しています。 */
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
    float       page_w_pt,   /* >0 のとき出力ページをこのサイズ(pt)に固定し */
    float       page_h_pt,   /* 元コンテンツをアスペクト比保持で中央 fit する */
    int         auto_orient, /* 1: ページごとに画像の縦横比で向きを自動選択 */
    FfiResult  *result)
{
    fz_document  *doc    = NULL;
    pdf_document *pdfout = NULL;

    fz_var(doc);
    fz_var(pdfout);

    fz_try(ctx) {

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

        int fit_to_size = (page_w_pt > 0.0f && page_h_pt > 0.0f);

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
                fz_rect src_box = fz_bound_page(ctx, page);

                if (fit_to_size) {
                    /* 出力ページを指定サイズに固定し、元コンテンツを
                     * アスペクト比保持で中央に fit 配置する。
                     * 画像を A4 等の決まったサイズに収める用途。 */
                    float sw = src_box.x1 - src_box.x0;
                    float sh = src_box.y1 - src_box.y0;
                    if (sw <= 0) sw = 1;
                    if (sh <= 0) sh = 1;

                    /* 向き自動: このページ（画像）の縦横比に合わせて
                     * ページの縦横を選ぶ。横長画像→横ページ、縦長→縦ページ。
                     * 明示指定（auto_orient=0）のときは渡された向きを固定。 */
                    float target_w = page_w_pt;
                    float target_h = page_h_pt;
                    if (auto_orient) {
                        int img_landscape = (sw > sh);
                        int page_landscape = (target_w > target_h);
                        if (img_landscape != page_landscape) {
                            /* ページの縦横を入れ替えて画像の向きに合わせる */
                            float tmp = target_w;
                            target_w = target_h;
                            target_h = tmp;
                        }
                    }

                    fz_rect mediabox = { 0, 0, target_w, target_h };
                    float scale_x = target_w / sw;
                    float scale_y = target_h / sh;
                    float scale = scale_x < scale_y ? scale_x : scale_y;
                    float draw_w = sw * scale;
                    float draw_h = sh * scale;
                    float off_x = (target_w - draw_w) * 0.5f;
                    float off_y = (target_h - draw_h) * 0.5f;
                    /* CTM: 元ページ原点を 0 に寄せ、scale 倍し、中央へ平行移動 */
                    fz_matrix ctm = fz_translate(-src_box.x0, -src_box.y0);
                    ctm = fz_concat(ctm, fz_scale(scale, scale));
                    ctm = fz_concat(ctm, fz_translate(off_x, off_y));

                    dev = pdf_page_write(ctx, pdfout, mediabox,
                                         &resources, &contents);
                    fz_run_page(ctx, page, dev, ctm, NULL);
                    fz_close_device(ctx, dev);
                    fz_drop_device(ctx, dev);
                    dev = NULL;
                    page_obj = pdf_add_page(ctx, pdfout, mediabox,
                                            0, resources, contents);
                    pdf_insert_page(ctx, pdfout, -1, page_obj);
                } else {
                    /* 従来動作: 元ページサイズをそのまま使う */
                    fz_rect mediabox = src_box;
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
/* kozou_rasterize_no_text                                             */
/*                                                                     */
/* kozou_rasterize と同じ手順だが、draw device の作成直後に            */
/* テキスト系コールバック (fill_text/stroke_text/clip_text/            */
/* clip_stroke_text/ignore_text) を NULL にしてから fz_run_page する。 */
/* fz_device のディスパッチ関数 (fz_fill_text 等) はコールバックが     */
/* NULL の場合そのオペレータを単に無視する設計になっている            */
/* (全デバイスが全メソッドを実装するわけではないための標準動作)。     */
/* これにより「テキスト(Type3グリフ含む)を一切描画しない背景画像」    */
/* を作れる。Type3 グリフの描画も内部的には fill_text 経由で           */
/* ディスパッチされるため、通常フォントと同様に除外される。            */
/*                                                                     */
/* 画像PDF化機能 (フォントを残す版) の Stage 1: 背景画像生成のみ。      */
/* ページのコンテンツストリーム側 (非テキスト演算子の除去 + 背景画像   */
/* の合成) は Stage 2 で別途実装する。                                 */
/* ------------------------------------------------------------------ */
void kozou_rasterize_no_text(
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

        doc = fz_open_document(ctx, input);

        if (fz_is_document_reflowable(ctx, doc)) {
            fz_layout_document(ctx, doc, 450.0f, 600.0f, 12.0f);
        }

        int page_count = fz_count_pages(ctx, doc);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");

        if (dpi <= 0.0f) dpi = 150.0f;
        float scale = dpi / 72.0f;

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
            pages_to_render     = (int *)malloc(sizeof(int) * page_count);
            pages_to_render_len = page_count;
            allocated           = 1;
            for (int k = 0; k < page_count; k++)
                pages_to_render[k] = k;
        }

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

                fz_matrix ctm = fz_scale(scale, scale);
                fz_irect bbox = fz_round_rect(fz_transform_rect(bounds, ctm));
                fz_colorspace *rgb = fz_device_rgb(ctx);
                pixmap = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
                fz_clear_pixmap_with_value(ctx, pixmap, 0xff);

                {
                    fz_device *draw_dev = fz_new_draw_device(ctx, ctm, pixmap);
                    /* テキストを一切描画しない: コールバックを NULL にして
                     * fz_run_page からのテキスト系オペレータを無視させる。
                     * Type3 グリフもこの fill_text 経由でしか描画されない
                     * ため、通常フォントと同様に除外される。 */
                    draw_dev->fill_text        = NULL;
                    draw_dev->stroke_text      = NULL;
                    draw_dev->clip_text        = NULL;
                    draw_dev->clip_stroke_text = NULL;
                    draw_dev->ignore_text      = NULL;
                    fz_try(ctx) {
                        fz_run_page(ctx, page, draw_dev, fz_identity, NULL);
                        fz_close_device(ctx, draw_dev);
                    }
                    fz_always(ctx) { fz_drop_device(ctx, draw_dev); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                }

                snprintf(tmp_img, sizeof(tmp_img),
                         "%s" KOZOU_PATH_SEP "kozou_rasterize_notext_%d_%d.%s",
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

                resources = pdf_new_dict(ctx, pdfout, 1);
                xobj_dict = pdf_new_dict(ctx, pdfout, 1);
                {
                    pdf_obj *im0_name = pdf_new_name(ctx, "Im0");
                    pdf_dict_put(ctx, xobj_dict, im0_name, imgref);
                    pdf_drop_obj(ctx, im0_name);
                }
                pdf_dict_put(ctx, resources, PDF_NAME(XObject), xobj_dict);

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
                if (tmp_img[0] != '\0') {
                    remove(tmp_img);
                    tmp_img[0] = '\0';
                }
                pdf_drop_obj(ctx, page_obj);
                pdf_drop_obj(ctx, xobj_dict);
                pdf_drop_obj(ctx, resources);
                fz_drop_buffer(ctx, contents);
                fz_drop_image(ctx, image);
                fz_drop_pixmap(ctx, pixmap);
                fz_drop_page(ctx, page);
            }
            fz_catch(ctx) {
                fz_rethrow(ctx);
            }
        }

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
/* kozou_compose_image_pdf_keep_text 用ヘルパー                        */
/* ------------------------------------------------------------------ */

/* バッファ中の BI ... ID ... EI (インライン画像) を丸ごと除去する。
 * インライン画像の ID~EI 間は任意のバイナリデータであり、'\n' を
 * 含みうるため、行単位ではなくバイト単位で走査する必要がある。
 * EI は前後を空白/デリミタで区切られたトークンとして探す
 * (バイナリデータの中に偶然 "EI" という2バイトが現れても、
 *  前がホワイトスペースであることを要求することで多くの誤検出を防ぐ)。*/
static fz_buffer *kozou_strip_inline_images(fz_context *ctx, fz_buffer *in_buf)
{
    unsigned char *d = NULL;
    size_t n = fz_buffer_storage(ctx, in_buf, &d);
    fz_buffer *out = fz_new_buffer(ctx, n + 16);
    if (!d || n == 0) return out;

    size_t i = 0;
    while (i < n) {
        /* "BI" をトークン境界付きで探す */
        if (d[i] == 'B' && i + 1 < n && d[i+1] == 'I' &&
            (i == 0 || d[i-1] == ' ' || d[i-1] == '\n' || d[i-1] == '\r' || d[i-1] == '\t') &&
            (i + 2 >= n || d[i+2] == ' ' || d[i+2] == '\n' || d[i+2] == '\r' || d[i+2] == '\t')) {
            /* BI から EI までスキップして出力しない */
            size_t j = i + 2;
            size_t ei_pos = n; /* 見つからなければ末尾まで */
            while (j + 1 < n) {
                if (d[j] == 'E' && d[j+1] == 'I' &&
                    (d[j-1] == ' ' || d[j-1] == '\n' || d[j-1] == '\r' || d[j-1] == '\t') &&
                    (j + 2 >= n || d[j+2] == ' ' || d[j+2] == '\n' || d[j+2] == '\r' || d[j+2] == '\t')) {
                    ei_pos = j + 2;
                    break;
                }
                j++;
            }
            i = ei_pos;
            continue;
        }
        fz_append_byte(ctx, out, d[i]);
        i++;
    }
    return out;
}

/* PDF コンテンツストリームの簡易字句解析用トークン。
 * 行区切りに依存せず、1行に複数演算子が書かれていても正しく
 * 演算子単位で処理できるようにするため導入。
 * 括弧文字列 "(...)" はエスケープ考慮のバランス走査で1トークンとして
 * 扱い、内部にある f/Do/sh 等の文字列を誤って演算子と解釈しない。 */
typedef struct { size_t start, end; } kozou_tok;

static size_t kozou_next_token(const char *s, size_t len, size_t pos, kozou_tok *out)
{
    while (pos < len && (s[pos]==' '||s[pos]=='\t'||s[pos]=='\r'||s[pos]=='\n')) pos++;
    if (pos >= len) { out->start = out->end = pos; return pos; }

    char c0 = s[pos];

    if (c0 == '(') {
        size_t start = pos; int depth = 1; pos++;
        while (pos < len && depth > 0) {
            if (s[pos] == '\\' && pos + 1 < len) { pos += 2; continue; }
            if (s[pos] == '(') depth++;
            else if (s[pos] == ')') depth--;
            pos++;
        }
        out->start = start; out->end = pos; return pos;
    }
    if (c0 == '<' && pos + 1 < len && s[pos+1] == '<') {
        size_t start = pos; int depth = 1; pos += 2;
        while (pos < len && depth > 0) {
            if (s[pos]=='<' && pos+1<len && s[pos+1]=='<') { depth++; pos+=2; continue; }
            if (s[pos]=='>' && pos+1<len && s[pos+1]=='>') { depth--; pos+=2; continue; }
            pos++;
        }
        out->start = start; out->end = pos; return pos;
    }
    if (c0 == '<') {
        size_t start = pos; pos++;
        while (pos < len && s[pos] != '>') pos++;
        if (pos < len) pos++;
        out->start = start; out->end = pos; return pos;
    }
    if (c0=='['||c0==']'||c0=='{'||c0=='}'||c0=='>') {
        out->start = pos; out->end = pos + 1; return pos + 1;
    }
    /* 名前("/xxx")・数値・演算子キーワードいずれもこの汎用パスで
     * 正しく1トークンとして切り出せる(先頭が '/' でもそれ以外でも、
     * 次のデリミタまで読み進めるだけでよい)。 */
    size_t start = pos;
    pos++;
    while (pos < len) {
        char c = s[pos];
        if (c==' '||c=='\t'||c=='\r'||c=='\n'||c=='('||c==')'||c=='<'||c=='>'||c=='['||c==']'||c=='{'||c=='}'||c=='/') break;
        pos++;
    }
    out->start = start; out->end = pos; return pos;
}

/* "/Name" トークン(先頭に '/' を含む)が指す XObject の Subtype が
 * /Form かどうかを判定する。Form XObject を指す Do は、その名前の
 * エントリが kozou_build_text_only_form で作った新規テキストのみ
 * Formに既に差し替えられている前提のため、Do 呼び出し自体は
 * 保持してよい。Image XObject や名前解決できない場合は 0 を返す
 * (呼び出し側で Do を除去する = 背景画像側に既に焼き込まれている)。*/
static int kozou_do_name_targets_form(fz_context *ctx, pdf_obj *xobj_dict,
                                       const char *name_tok, size_t name_tok_len)
{
    if (!xobj_dict || name_tok_len < 2 || name_tok[0] != '/') return 0;
    size_t name_len = name_tok_len - 1;
    if (name_len == 0 || name_len > 127) return 0;

    char namebuf[128];
    memcpy(namebuf, name_tok + 1, name_len);
    namebuf[name_len] = '\0';

    pdf_obj *xo = pdf_dict_gets(ctx, xobj_dict, namebuf);
    if (!xo) return 0;
    pdf_obj *resolved = pdf_resolve_indirect(ctx, xo);
    pdf_obj *subtype = resolved ? pdf_dict_get(ctx, resolved, PDF_NAME(Subtype)) : NULL;
    return subtype && pdf_name_eq(ctx, subtype, PDF_NAME(Form));
}

/* 定義は本ファイル後方。src 側の Form XObject (常に確実に読める) から
 * テキストだけを残した新規 Form XObject を dst に作成して返す。
 * ネストした Form XObject も再帰的に同じ方法で新規作成する。 */
static pdf_obj *kozou_build_text_only_form(
    fz_context *ctx, pdf_document *dst, pdf_graft_map *gmap,
    pdf_obj *src_xobj, int depth);

/* BT 外にある「非テキストの描画命令」を演算子単位で除去する
 * (トークン解析ベース。1行に複数演算子が書かれていても、対象の
 *  演算子とその演算子自身のオペランドだけを正確に取り除き、
 *  同じ行にある q/Q や他の演算子は一切変更しない)。
 * 対象 (ページに実際にピクセルを描く演算子のみ、オペランドは0個):
 *   f F f* S s B B* b b*  (パスの塗り/線)
 * 対象 (オペランド1個: 直前の名前トークンも一緒に除去):
 *   sh                    (シェーディング)
 *   Do                    ただし Image XObject を指す場合のみ除去する。
 *     Form XObject を指す場合は演算子・オペランドとも残す。
 * 対象外 (温存する):
 *   パス構築 (m l c v y h re) : 単独では何も描かないため無害。
 *     後続の W n によるクリップに使われている場合があるため、
 *     パスそのものは残し、実際に「塗る/描く」演算子だけを除去する。
 *   W W* n                : クリップの確定は描画を伴わないため無害。
 *   q Q cm gs 色設定系      : テキストの位置・色にも影響するため必須。
 * BT ～ ET の内側は無条件でそのまま温存する。
 *
 * xobj_dict: このコンテンツストリームが参照する Resources/XObject
 * (Do の名前解決に使う)。 */
static fz_buffer *kozou_strip_nontext_paint_ops(fz_context *ctx, fz_buffer *in_buf,
                                                 pdf_obj *xobj_dict)
{
    unsigned char *src_data = NULL;
    size_t src_len = fz_buffer_storage(ctx, in_buf, &src_data);
    fz_buffer *out = fz_new_buffer(ctx, src_len + 16);
    if (!src_data || src_len == 0) return out;
    const char *src = (const char *)src_data;

    size_t cap = 256, ntok = 0;
    kozou_tok *toks = (kozou_tok *)malloc(sizeof(kozou_tok) * cap);

    {
        size_t pos = 0;
        while (pos < src_len) {
            kozou_tok t;
            size_t next = kozou_next_token(src, src_len, pos, &t);
            if (t.start == t.end) break; /* 残りは空白のみ */
            if (ntok == cap) { cap *= 2; toks = (kozou_tok *)realloc(toks, sizeof(kozou_tok) * cap); }
            toks[ntok++] = t;
            pos = next;
        }
    }

    char *drop = (char *)calloc(ntok ? ntok : 1, 1);
    int in_bt = 0;

    for (size_t i = 0; i < ntok; i++) {
        size_t tlen = toks[i].end - toks[i].start;
        const char *tp = src + toks[i].start;

        if (tlen == 2 && tp[0] == 'B' && tp[1] == 'T') { in_bt = 1; continue; }
        if (tlen == 2 && tp[0] == 'E' && tp[1] == 'T') { in_bt = 0; continue; }
        if (in_bt) continue;

        int is_paint0 =
            (tlen == 1 && (tp[0]=='f'||tp[0]=='F'||tp[0]=='S'||tp[0]=='s'||tp[0]=='B'||tp[0]=='b')) ||
            (tlen == 2 && tp[0]=='f' && tp[1]=='*') ||
            (tlen == 2 && tp[0]=='B' && tp[1]=='*') ||
            (tlen == 2 && tp[0]=='b' && tp[1]=='*');
        int is_sh = (tlen == 2 && tp[0]=='s' && tp[1]=='h');
        int is_do = (tlen == 2 && tp[0]=='D' && tp[1]=='o');

        if (is_paint0) {
            drop[i] = 1;
        } else if (is_sh) {
            drop[i] = 1;
            if (i > 0) drop[i-1] = 1; /* シェーディング名オペランド */
        } else if (is_do) {
            int keep_for_form = 0;
            if (i > 0) {
                size_t nlen = toks[i-1].end - toks[i-1].start;
                const char *np = src + toks[i-1].start;
                keep_for_form = kozou_do_name_targets_form(ctx, xobj_dict, np, nlen);
            }
            if (!keep_for_form) {
                drop[i] = 1;
                if (i > 0) drop[i-1] = 1; /* XObject名オペランド */
            }
        }
    }

    /* 連続する drop トークン列をまとめて、その範囲のバイトだけを
     * 出力からスキップする(それ以外は元のバイト列をそのままコピー
     * するので、間の空白・改行やq/Q等は一切変更されない)。 */
    size_t cur = 0, i = 0;
    while (i < ntok) {
        if (!drop[i]) { i++; continue; }
        size_t j = i;
        while (j < ntok && drop[j]) j++;
        size_t del_start = toks[i].start;
        size_t del_end   = toks[j-1].end;
        if (del_start > cur) fz_append_data(ctx, out, src + cur, del_start - cur);
        cur = del_end;
        i = j;
    }
    if (cur < src_len) fz_append_data(ctx, out, src + cur, src_len - cur);

    free(drop);
    free(toks);
    return out;
}

/* デバッグ用: 環境変数 KOZOU_COMPOSE_DEBUG=1 が設定されている場合のみ、
 * 指定バッファの内容を <output>.p<page>.<tag>.txt として書き出す。
 * 実機での位置ずれ/サイズ問題の切り分け用(該当ページの実際の
 * コンテンツストリームを目視確認できるようにする)。通常運用では
 * 環境変数が未設定なので何もしない。 */
static void kozou_debug_dump_buffer(fz_context *ctx, const char *output,
                                     int page_index, const char *tag,
                                     fz_buffer *buf)
{
    if (!buf) return;
    const char *dbg = getenv("KOZOU_COMPOSE_DEBUG");
    if (!dbg || dbg[0] == '\0' || dbg[0] == '0') return;

    char path[1200];
    snprintf(path, sizeof(path), "%s.p%d.%s.txt", output, page_index, tag);

    fz_try(ctx) {
        fz_output *fo = fz_new_output_with_path(ctx, path, 0);
        fz_try(ctx) {
            fz_write_buffer(ctx, fo, buf);
            fz_close_output(ctx, fo);
        }
        fz_always(ctx) { fz_drop_output(ctx, fo); }
        fz_catch(ctx) { fz_rethrow(ctx); }
    }
    fz_catch(ctx) {
        fz_warn(ctx, "kozou_debug_dump_buffer: failed to write %s: %s",
                path, fz_caught_message(ctx));
    }
}

/* ------------------------------------------------------------------ */
/* kozou_compose_image_pdf_keep_text                                   */
/*                                                                     */
/* 画像PDF化(フォント保持版) Stage 2。                                  */
/* 各ページを以下の手順で合成する:                                      */
/*   1. 元ページをテキスト(Type3含む)除外でラスタライズし背景画像化    */
/*      (Stage 1 の kozou_rasterize_no_text と同じ手法:                */
/*       draw device のテキスト系コールバックを NULL にする)。          */
/*   2. pdf_graft_mapped_object で元ページをそのまま新規PDFへ複製      */
/*      (Resources/Font/Type3 CharProcs は完全に無変更のまま持ち込む   */
/*       — フォントの再埋め込みは一切発生しない)。                     */
/*   3. 複製後のページのコンテンツストリームから、非テキストの         */
/*      描画命令(パスの塗り/線, sh, Do, インライン画像)だけを除去し、   */
/*      先頭に背景画像の描画命令を挿入する。BT/ET・Tf/Tj 等のテキスト  */
/*      演算子とq/Q/cm/gs/色設定等の状態管理演算子はそのまま残す。     */
/*   4. ページが参照する Form XObject(Do で描画される部品)のうち       */
/*      テキストを含むものは、グラフト済みの複製を直接書き換えるの     */
/*      ではなく、常に src (無変更・確実に読める) 側から               */
/*      kozou_build_text_only_form で「テキストだけを残した新規        */
/*      Form XObject」を作り、xobj 辞書のエントリをそれに差し替える。  */
/*      (グラフト済みFormを pdf_update_stream で直接書き換える旧方式   */
/*       は、実機検証でこの手のPDF構造に対して信頼できないことが       */
/*       判明したため撤廃した。) 画像を指す Do は除去する               */
/*      (既に背景画像に焼き込まれている)。                             */
/*                                                                     */
/* 既知の制限:                                                         */
/*  - 画像の陰に隠れて見えないテキストがあった場合、そのテキストは      */
/*    (隠していた画像はプライバシー保護のため背景に焼き込まれ消える     */
/*     ため)前面に単独で現れる可能性がある。検出・回避はしていない。   */
/*  - /Rotate が 0 以外のページは今回未対応。安全のため、そのページ    */
/*    だけ kozou_rasterize_no_text 相当(テキストも含めた通常の         */
/*    全面ラスタライズ)にフォールバックする。                          */
/* ------------------------------------------------------------------ */
void kozou_compose_image_pdf_keep_text(
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
    pdf_document  *src   = NULL;
    pdf_document  *dst   = NULL;
    pdf_graft_map *gmap  = NULL;

    fz_var(src);
    fz_var(dst);
    fz_var(gmap);

    fz_try(ctx) {
        src = pdf_open_document(ctx, input);
        dst = pdf_create_document(ctx);

        if (fz_is_document_reflowable(ctx, (fz_document *)src)) {
            fz_layout_document(ctx, (fz_document *)src, 450.0f, 600.0f, 12.0f);
        }

        int page_count = pdf_count_pages(ctx, src);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");

        if (dpi <= 0.0f) dpi = 150.0f;
        float scale = dpi / 72.0f;

        int  *pages_to_do     = NULL;
        int   pages_to_do_len = 0;
        int   allocated       = 0;

        if (page_indices != NULL && page_indices_len > 0) {
            pages_to_do     = (int *)malloc(sizeof(int) * page_indices_len);
            pages_to_do_len = 0;
            allocated       = 1;
            for (int k = 0; k < page_indices_len; k++) {
                int idx = page_indices[k];
                if (idx >= 0 && idx < page_count)
                    pages_to_do[pages_to_do_len++] = idx;
            }
            if (pages_to_do_len == 0)
                fz_throw(ctx, FZ_ERROR_ARGUMENT,
                         "page_indices: no valid pages in range");
        } else {
            pages_to_do     = (int *)malloc(sizeof(int) * page_count);
            pages_to_do_len = page_count;
            allocated       = 1;
            for (int k = 0; k < page_count; k++)
                pages_to_do[k] = k;
        }

        const char *base_tmp = (tmp_dir && tmp_dir[0]) ? tmp_dir : output;
        const char *ext      = use_png ? "png" : "jpg";

        gmap = pdf_new_graft_map(ctx, dst);

        for (int ii = 0; ii < pages_to_do_len; ii++) {
            int i = pages_to_do[ii];

            fz_page   *render_page = NULL;
            fz_pixmap *pixmap      = NULL;
            fz_image  *image       = NULL;
            pdf_obj   *imgref      = NULL;
            pdf_obj   *src_page    = NULL;
            pdf_obj   *dst_page    = NULL;
            pdf_page  *dst_pg      = NULL;
            fz_buffer *orig_buf    = NULL;
            fz_buffer *no_inline   = NULL;
            fz_buffer *stripped    = NULL;
            fz_buffer *final_buf   = NULL;

            char tmp_img[1024];
            tmp_img[0] = '\0';

            fz_var(render_page);
            fz_var(pixmap);
            fz_var(image);
            fz_var(imgref);
            fz_var(src_page);
            fz_var(dst_page);
            fz_var(dst_pg);
            fz_var(orig_buf);
            fz_var(no_inline);
            fz_var(stripped);
            fz_var(final_buf);

            fz_try(ctx) {
                src_page = pdf_lookup_page_obj(ctx, src, i);
                int rotate = pdf_to_int(ctx,
                    pdf_dict_get_inheritable(ctx, src_page, PDF_NAME(Rotate)));

                /* --- 1. ページを丸ごと複製 (フォント/Type3 は無変更) ---
                 * 背景画像のレンダリング(fz_run_page)より必ず先に行う。
                 * 既存の動作実績がある kozou_compress_preserving_type3 は
                 * グラフトの前に src 側で fz_run_page を一切行わない。
                 * 実機で「グラフト後のForm XObjectがstreamとして
                 * 認識されない(pdf_is_stream=偽)」問題が再現し、
                 * 同じPDFで compress_preserving_type3 (レンダリング無し)
                 * は問題なく動作したことから、fz_run_page が src の
                 * ストリーム読み込み状態に何らかの副作用を残し、
                 * その直後のグラフトを壊している可能性が高いと判断し、
                 * 順序を入れ替えた。 */
                dst_page = pdf_graft_mapped_object(ctx, gmap, src_page);
                pdf_insert_page(ctx, dst, -1, dst_page);

                /* --- 2. 背景画像を生成 (テキスト除外) --- */
                render_page = fz_load_page(ctx, (fz_document *)src, i);
                fz_rect bounds = fz_bound_page(ctx, render_page);
                float pw_pt = bounds.x1 - bounds.x0;
                float ph_pt = bounds.y1 - bounds.y0;

                /* 重要: fz_bound_page が返す bounds は (0,0) 起点に
                 * 正規化されている場合があり、ページの実際の /MediaBox
                 * 原点(0以外のことがある — 実機で [0, 7.82998, 595.5,
                 * 850.08] のようなケースが確認された)とは一致しない。
                 * 元ページのコンテンツストリームは実際の /MediaBox の
                 * 座標系に合わせて作られているため、背景画像の配置には
                 * bounds.x0/y0 ではなく実際の /MediaBox 原点を使う
                 * 必要がある(使わないと背景画像だけが数ポイント
                 * ズレて、前面のテキストと噛み合わなくなる)。 */
                float mb_x0 = bounds.x0, mb_y0 = bounds.y0;
                {
                    pdf_obj *mb = pdf_dict_get_inheritable(ctx, src_page, PDF_NAME(MediaBox));
                    if (mb && pdf_is_array(ctx, mb) && pdf_array_len(ctx, mb) == 4) {
                        mb_x0 = pdf_to_real(ctx, pdf_array_get(ctx, mb, 0));
                        mb_y0 = pdf_to_real(ctx, pdf_array_get(ctx, mb, 1));
                    }
                }

                fz_matrix ctm = fz_scale(scale, scale);
                fz_irect bbox = fz_round_rect(fz_transform_rect(bounds, ctm));
                fz_colorspace *rgb = fz_device_rgb(ctx);
                pixmap = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
                fz_clear_pixmap_with_value(ctx, pixmap, 0xff);

                {
                    fz_device *draw_dev = fz_new_draw_device(ctx, ctm, pixmap);
                    draw_dev->fill_text        = NULL;
                    draw_dev->stroke_text      = NULL;
                    draw_dev->clip_text        = NULL;
                    draw_dev->clip_stroke_text = NULL;
                    draw_dev->ignore_text      = NULL;
                    fz_try(ctx) {
                        fz_run_page(ctx, render_page, draw_dev, fz_identity, NULL);
                        fz_close_device(ctx, draw_dev);
                    }
                    fz_always(ctx) { fz_drop_device(ctx, draw_dev); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                }

                snprintf(tmp_img, sizeof(tmp_img),
                         "%s" KOZOU_PATH_SEP "kozou_composeimg_%d_%d.%s",
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

                image  = fz_new_image_from_file(ctx, tmp_img);
                imgref = pdf_add_image(ctx, dst, image);

                if (rotate != 0) {
                    /* Stage 2 未対応: /Rotate!=0 のページは合成せず、
                     * 通常の全面ラスタライズ(テキスト含む)にフォールバック
                     * して安全側に倒す。 */
                    dst_pg = pdf_load_page(ctx, dst, i);
                    pdf_obj *page_obj = dst_pg->obj;

                    fz_pixmap *full_pm = NULL;
                    fz_var(full_pm);
                    fz_try(ctx) {
                        full_pm = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
                        fz_clear_pixmap_with_value(ctx, full_pm, 0xff);
                        fz_device *full_dev = fz_new_draw_device(ctx, ctm, full_pm);
                        fz_try(ctx) {
                            fz_run_page(ctx, render_page, full_dev, fz_identity, NULL);
                            fz_close_device(ctx, full_dev);
                        }
                        fz_always(ctx) { fz_drop_device(ctx, full_dev); }
                        fz_catch(ctx) { fz_rethrow(ctx); }

                        char tmp_img2[1024];
                        snprintf(tmp_img2, sizeof(tmp_img2),
                                 "%s" KOZOU_PATH_SEP "kozou_composeimg_full_%d_%d.%s",
                                 base_tmp, (int)getpid(), i, ext);
                        if (use_png) {
                            fz_output *fout2 = fz_new_output_with_path(ctx, tmp_img2, 0);
                            fz_try(ctx) {
                                fz_write_pixmap_as_png(ctx, fout2, full_pm);
                                fz_close_output(ctx, fout2);
                            }
                            fz_always(ctx) { fz_drop_output(ctx, fout2); }
                            fz_catch(ctx) { fz_rethrow(ctx); }
                        } else {
                            int jq = (quality > 0 && quality <= 100) ? quality : 85;
                            fz_save_pixmap_as_jpeg(ctx, full_pm, tmp_img2, jq);
                        }
                        fz_image *full_img  = fz_new_image_from_file(ctx, tmp_img2);
                        pdf_obj  *full_ref  = pdf_add_image(ctx, dst, full_img);
                        fz_drop_image(ctx, full_img);
                        remove(tmp_img2);

                        pdf_obj *res2 = pdf_new_dict(ctx, dst, 1);
                        pdf_obj *xd2  = pdf_new_dict(ctx, dst, 1);
                        pdf_obj *nm2  = pdf_new_name(ctx, "KzFullImg");
                        pdf_dict_put(ctx, xd2, nm2, full_ref);
                        pdf_drop_obj(ctx, nm2);
                        pdf_dict_put(ctx, res2, PDF_NAME(XObject), xd2);
                        pdf_drop_obj(ctx, xd2);

                        char cs2[256];
                        int cs2_len = snprintf(cs2, sizeof(cs2),
                            "q\n%.4f 0 0 %.4f 0 0 cm\n/KzFullImg Do\nQ\n",
                            pw_pt, ph_pt);
                        fz_buffer *cbuf2 = fz_new_buffer_from_copied_data(
                            ctx, (const unsigned char *)cs2, (size_t)cs2_len);
                        pdf_obj *stm2 = pdf_add_stream(ctx, dst, cbuf2, NULL, 0);
                        fz_drop_buffer(ctx, cbuf2);
                        pdf_dict_put(ctx, page_obj, PDF_NAME(Contents), stm2);
                        pdf_drop_obj(ctx, stm2);
                        pdf_dict_put(ctx, page_obj, PDF_NAME(Resources), res2);
                        pdf_drop_obj(ctx, res2);
                        /* 合成をやめて全面ラスタライズにしたので、この
                         * 画像には回転後の見た目がそのまま焼き込まれて
                         * いる(kozou_rasterize と同じ考え方)。
                         * そのため /Rotate は 0 にリセットし、代わりに
                         * /MediaBox を回転後の pw_pt×ph_pt に合わせて
                         * 更新する(そのままだと元の MediaBox と縦横が
                         * 食い違ってページ表示がずれる)。
                         * /CropBox が別途設定されている場合はここでは
                         * 未対応(既知の制限、/Rotate!=0 のフォールバック
                         * 経路のみに影響)。 */
                        pdf_dict_put_drop(ctx, page_obj, PDF_NAME(Rotate), pdf_new_int(ctx, 0));
                        {
                            pdf_obj *mb = pdf_new_array(ctx, dst, 4);
                            pdf_array_push_drop(ctx, mb, pdf_new_real(ctx, 0));
                            pdf_array_push_drop(ctx, mb, pdf_new_real(ctx, 0));
                            pdf_array_push_drop(ctx, mb, pdf_new_real(ctx, pw_pt));
                            pdf_array_push_drop(ctx, mb, pdf_new_real(ctx, ph_pt));
                            pdf_dict_put_drop(ctx, page_obj, PDF_NAME(MediaBox), mb);
                            pdf_dict_del(ctx, page_obj, PDF_NAME(CropBox));
                        }
                        fz_warn(ctx,
                            "compose_image_pdf_keep_text: page %d has /Rotate=%d, "
                            "falling back to full rasterize (text not preserved for this page)",
                            i, rotate);
                    }
                    fz_always(ctx) {
                        fz_drop_pixmap(ctx, full_pm);
                    }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                } else {
                    /* --- 3. コンテンツストリームを合成 --- */
                    dst_pg = pdf_load_page(ctx, dst, i);
                    pdf_obj *page_obj = dst_pg->obj;

                    pdf_obj *contents = pdf_dict_get(ctx, page_obj, PDF_NAME(Contents));
                    orig_buf = fz_new_buffer(ctx, 65536);
                    if (contents) {
                        if (pdf_is_array(ctx, contents)) {
                            int nc = pdf_array_len(ctx, contents);
                            for (int ci = 0; ci < nc; ci++) {
                                pdf_obj *part = pdf_array_get(ctx, contents, ci);
                                if (!pdf_is_stream(ctx, part)) continue;
                                fz_buffer *b = NULL;
                                fz_var(b);
                                fz_try(ctx) {
                                    b = pdf_load_stream(ctx, part);
                                    fz_append_buffer(ctx, orig_buf, b);
                                    fz_append_byte(ctx, orig_buf, '\n');
                                }
                                fz_always(ctx) { fz_drop_buffer(ctx, b); }
                                fz_catch(ctx) {
                                    fz_warn(ctx, "compose_image_pdf_keep_text: "
                                                 "skipping unreadable content stream: %s",
                                            fz_caught_message(ctx));
                                }
                            }
                        } else if (pdf_is_stream(ctx, contents)) {
                            fz_buffer *b = pdf_load_stream(ctx, contents);
                            fz_append_buffer(ctx, orig_buf, b);
                            fz_drop_buffer(ctx, b);
                        }
                    }

                    /* 背景画像の Resources 登録に先立って、既存の
                     * Resources/XObject を取得しておく(Do の名前解決と
                     * ネストした Form XObject の再帰処理に必要なため)。
                     * Resources 自体がページに直接無い(継承のみ)場合は
                     * 新規に作成してページへ直接持たせる。
                     *
                     * 重要: 継承元の Resources (inherited) はまだ
                     * dst にグラフトされていない可能性があるため、
                     * 値をそのまま pdf_dict_put するのではなく、
                     * 必ず pdf_graft_mapped_object で dst 側に
                     * グラフトしてから使う。以前はここで生の値を
                     * 直接コピーしており、それが「Form XObjectの
                     * オブジェクト番号が常に0、pdf_is_streamも常に
                     * 偽になる」不具合の原因だった可能性が高い
                     * (src文書側の参照がdst所有のdictにそのまま
                     * 紛れ込んでいたため)。 */
                    pdf_obj *res = pdf_dict_get(ctx, page_obj, PDF_NAME(Resources));
                    fz_warn(ctx, "compose_image_pdf_keep_text: page %d "
                                 "direct Resources present = %d", i, res != NULL);
                    if (!res) {
                        pdf_obj *inherited = pdf_dict_get_inheritable(
                            ctx, page_obj, PDF_NAME(Resources));
                        fz_warn(ctx, "compose_image_pdf_keep_text: page %d "
                                     "inherited Resources found = %d", i, inherited != NULL);
                        if (inherited) {
                            res = pdf_graft_mapped_object(ctx, gmap, inherited);
                        } else {
                            res = pdf_new_dict(ctx, dst, 4);
                        }
                        pdf_dict_put(ctx, page_obj, PDF_NAME(Resources), res);
                    }
                    pdf_obj *xobj = pdf_dict_get(ctx, res, PDF_NAME(XObject));
                    if (!xobj) {
                        xobj = pdf_new_dict(ctx, dst, 1);
                        pdf_dict_put(ctx, res, PDF_NAME(XObject), xobj);
                    }

                    /* src 側(グラフトしていない、常に確実に読める)の
                     * Resources/XObject を見て、Form XObject を指す
                     * 名前だけを新規に作った「テキストのみ版」に
                     * 差し替える。既存のグラフト済みオブジェクトを
                     * 書き換える(pdf_update_stream)操作は実機検証で
                     * 信頼できないことが判明したため、代わりに
                     * 常に新規オブジェクトを作成し、xobj 辞書の
                     * 該当エントリを差し替えるだけにする(これは
                     * 既に確実に動いている KzBgImg 追加と同じ操作)。 */
                    pdf_obj *src_res_x  = pdf_dict_get(ctx, src_page, PDF_NAME(Resources));
                    pdf_obj *src_xobj_d = src_res_x ? pdf_dict_get(ctx, src_res_x, PDF_NAME(XObject)) : NULL;
                    if (src_xobj_d) {
                        int nsx = pdf_dict_len(ctx, src_xobj_d);
                        for (int sk = 0; sk < nsx; sk++) {
                            pdf_obj *skey = pdf_dict_get_key(ctx, src_xobj_d, sk);
                            const char *skeystr = pdf_to_name(ctx, skey);
                            if (!skeystr || !skeystr[0]) continue;
                            pdf_obj *child_src = pdf_dict_gets(ctx, src_xobj_d, skeystr);
                            pdf_obj *child_subtype = child_src ? pdf_dict_get(ctx, child_src, PDF_NAME(Subtype)) : NULL;
                            if (!child_subtype || !pdf_name_eq(ctx, child_subtype, PDF_NAME(Form))) continue;

                            pdf_obj *new_form = kozou_build_text_only_form(ctx, dst, gmap, child_src, 0);
                            if (new_form) {
                                pdf_dict_puts(ctx, xobj, skeystr, new_form);
                            } else {
                                /* 作成に失敗した場合は安全側に倒す:
                                 * エントリ自体を削除し、対応する Do は
                                 * 名前解決できず除去されるようにする
                                 * (=既に背景画像に焼き込まれている)。 */
                                pdf_obj *delname = pdf_new_name(ctx, skeystr);
                                pdf_dict_del(ctx, xobj, delname);
                                pdf_drop_obj(ctx, delname);
                                fz_warn(ctx, "compose_image_pdf_keep_text: "
                                             "page %d: failed to build text-only form for /%s, "
                                             "dropping (image-only fallback)", i, skeystr);
                            }
                        }
                    }

                    no_inline = kozou_strip_inline_images(ctx, orig_buf);
                    stripped  = kozou_strip_nontext_paint_ops(ctx, no_inline, xobj);

                    kozou_debug_dump_buffer(ctx, output, i, "orig", orig_buf);
                    kozou_debug_dump_buffer(ctx, output, i, "stripped", stripped);

                    {
                        pdf_obj *bgname = pdf_new_name(ctx, "KzBgImg");
                        pdf_dict_put(ctx, xobj, bgname, imgref);
                        pdf_drop_obj(ctx, bgname);
                    }

                    char cs_prefix[256];
                    int  cs_prefix_len = snprintf(cs_prefix, sizeof(cs_prefix),
                        "q\n%.4f 0 0 %.4f %.4f %.4f cm\n/KzBgImg Do\nQ\n",
                        pw_pt, ph_pt, mb_x0, mb_y0);

                    final_buf = fz_new_buffer(ctx,
                        (size_t)cs_prefix_len + fz_buffer_storage(ctx, stripped, NULL) + 8);
                    fz_append_data(ctx, final_buf, cs_prefix, (size_t)cs_prefix_len);
                    fz_append_buffer(ctx, final_buf, stripped);

                    kozou_debug_dump_buffer(ctx, output, i, "final", final_buf);

                    pdf_obj *new_stm = pdf_add_stream(ctx, dst, final_buf, NULL, 0);
                    pdf_dict_put(ctx, page_obj, PDF_NAME(Contents), new_stm);
                    pdf_drop_obj(ctx, new_stm);
                }
            }
            fz_always(ctx) {
                if (tmp_img[0] != '\0') { remove(tmp_img); tmp_img[0] = '\0'; }
                if (dst_pg) fz_drop_page(ctx, (fz_page *)dst_pg);
                fz_drop_buffer(ctx, final_buf);
                fz_drop_buffer(ctx, stripped);
                fz_drop_buffer(ctx, no_inline);
                fz_drop_buffer(ctx, orig_buf);
                pdf_drop_obj(ctx, dst_page);
                fz_drop_image(ctx, image);
                fz_drop_pixmap(ctx, pixmap);
                fz_drop_page(ctx, render_page);
            }
            fz_catch(ctx) {
                fz_rethrow(ctx);
            }
        }

        pdf_write_options opts = pdf_default_write_options;
        opts.do_compress        = 1;
        opts.do_compress_images = use_png ? 0 : 1;
        /* do_garbage は 2 を上限にする。
         * kozou_compress_preserving_type3 の既存コメントにある通り、
         * 「3以上はフォント統合で Type3 破壊リスク」があるとこの
         * コードベースで既に判明している。ファイルサイズ対策として
         * 一時的に 4 に引き上げていたが、実機でグラフト後の
         * Form XObjectが保存後に壊れる(mupdf自身が「content stream
         * is not a stream」と警告する)問題が再現し、既存の
         * compress_preserving_type3(gcを0-2に制限)では同じPDFで
         * 問題が起きないことから、この do_garbage=4 が原因である
         * 可能性が高いと判断し、安全な範囲に戻した。 */
        opts.do_garbage         = 2;
        opts.do_clean           = 0;
        pdf_save_document(ctx, dst, output, &opts);

        if (allocated) free(pages_to_do);
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

/* src 側の Form XObject (グラフトしていない、常に確実に読める) から、
 * テキストだけを残した新規 Form XObject を dst に新規作成して返す。
 * 既存のグラフト済みオブジェクトを書き換えるのではなく、常に新規に
 * ストリームを作成するアプローチ — 実機検証で「グラフト済みFormを
 * pdf_update_stream で書き換える」操作がこのPDF構造に対して信頼
 * できないことが判明したため。
 *
 * ネストした Form XObject を Do で参照している場合は、対応する src
 * 側の Form XObject を再帰的に同じ方法で新規作成し、この Form 専用の
 * 新しい /Resources/XObject 辞書で元の名前に差し替える。
 * Image XObject への Do は除去する(背景画像に既に焼き込み済み)。
 * 深さ制限で循環参照を防ぐ。失敗した場合は NULL を返す
 * (呼び出し側で、対応する Do を安全側に倒して除去する)。 */
static pdf_obj *kozou_build_text_only_form(
    fz_context *ctx, pdf_document *dst, pdf_graft_map *gmap,
    pdf_obj *src_xobj, int depth)
{
    if (!src_xobj || depth > 12) return NULL;
    if (!pdf_is_stream(ctx, src_xobj)) return NULL;

    pdf_obj *new_form = NULL;
    fz_buffer *orig = NULL, *ni = NULL, *stripped = NULL;
    pdf_obj *new_xobj_dict = NULL;
    fz_var(new_form); fz_var(orig); fz_var(ni); fz_var(stripped); fz_var(new_xobj_dict);

    fz_try(ctx) {
        pdf_obj *src_res      = pdf_dict_get(ctx, src_xobj, PDF_NAME(Resources));
        pdf_obj *src_own_xobj = src_res ? pdf_dict_get(ctx, src_res, PDF_NAME(XObject)) : NULL;

        /* ネストした Form XObject を先に再帰的に新規作成し、
         * 名前→新規Formの対応表を作る(Image はここに含めない
         * = 対応するDoは名前解決できず除去される)。 */
        if (src_own_xobj) {
            int n = pdf_dict_len(ctx, src_own_xobj);
            for (int k = 0; k < n; k++) {
                pdf_obj *key = pdf_dict_get_key(ctx, src_own_xobj, k);
                const char *keystr = pdf_to_name(ctx, key);
                if (!keystr || !keystr[0]) continue;
                pdf_obj *child_src = pdf_dict_gets(ctx, src_own_xobj, keystr);
                pdf_obj *child_subtype = child_src ? pdf_dict_get(ctx, child_src, PDF_NAME(Subtype)) : NULL;
                if (!child_subtype || !pdf_name_eq(ctx, child_subtype, PDF_NAME(Form))) continue;

                pdf_obj *child_new = kozou_build_text_only_form(ctx, dst, gmap, child_src, depth + 1);
                if (child_new) {
                    if (!new_xobj_dict) new_xobj_dict = pdf_new_dict(ctx, dst, 4);
                    pdf_dict_puts(ctx, new_xobj_dict, keystr, child_new);
                }
            }
        }

        orig     = pdf_load_stream(ctx, src_xobj);
        ni       = kozou_strip_inline_images(ctx, orig);
        stripped = kozou_strip_nontext_paint_ops(ctx, ni, new_xobj_dict);

        /* この Form 専用の新しい /Resources を作る:
         * テキスト描画に必要なリソースをグラフトする。
         * Font/ExtGState に加え、Pattern(グラデーション等の塗りに
         * テキストが Pattern を参照するケースがあるため必須。
         * 実機で "cannot find Pattern resource" エラーが発生し
         * 判明した)、Shading、Pattern が使う ColorSpace、マーク付き
         * コンテンツ(BDC等)が参照する Properties も持ち込む。
         * 通常の画像・写真等(/XObject 配下の Image)は一切持ち込まない
         * (焼き込み済みの背景画像との重複や、プライバシー保護対象の
         *  再露出を防ぐ)。 */
        pdf_obj *new_res = pdf_new_dict(ctx, dst, 2);
        if (src_res) {
            pdf_obj *src_font = pdf_dict_get(ctx, src_res, PDF_NAME(Font));
            if (src_font) {
                pdf_dict_put(ctx, new_res, PDF_NAME(Font),
                             pdf_graft_mapped_object(ctx, gmap, src_font));
            }
            pdf_obj *src_gs = pdf_dict_get(ctx, src_res, PDF_NAME(ExtGState));
            if (src_gs) {
                pdf_dict_put(ctx, new_res, PDF_NAME(ExtGState),
                             pdf_graft_mapped_object(ctx, gmap, src_gs));
            }
            pdf_obj *src_pattern = pdf_dict_get(ctx, src_res, PDF_NAME(Pattern));
            if (src_pattern) {
                pdf_dict_put(ctx, new_res, PDF_NAME(Pattern),
                             pdf_graft_mapped_object(ctx, gmap, src_pattern));
            }
            pdf_obj *src_shading = pdf_dict_get(ctx, src_res, PDF_NAME(Shading));
            if (src_shading) {
                pdf_dict_put(ctx, new_res, PDF_NAME(Shading),
                             pdf_graft_mapped_object(ctx, gmap, src_shading));
            }
            pdf_obj *src_cs = pdf_dict_get(ctx, src_res, PDF_NAME(ColorSpace));
            if (src_cs) {
                pdf_dict_put(ctx, new_res, PDF_NAME(ColorSpace),
                             pdf_graft_mapped_object(ctx, gmap, src_cs));
            }
            pdf_obj *src_props = pdf_dict_get(ctx, src_res, PDF_NAME(Properties));
            if (src_props) {
                pdf_dict_put(ctx, new_res, PDF_NAME(Properties),
                             pdf_graft_mapped_object(ctx, gmap, src_props));
            }
        }
        if (new_xobj_dict) {
            pdf_dict_put(ctx, new_res, PDF_NAME(XObject), new_xobj_dict);
        }

        pdf_obj *form_dict = pdf_new_dict(ctx, dst, 6);
        pdf_dict_put(ctx, form_dict, PDF_NAME(Type), PDF_NAME(XObject));
        pdf_dict_put(ctx, form_dict, PDF_NAME(Subtype), PDF_NAME(Form));
        pdf_obj *src_bbox = pdf_dict_get(ctx, src_xobj, PDF_NAME(BBox));
        if (src_bbox) {
            pdf_dict_put(ctx, form_dict, PDF_NAME(BBox),
                         pdf_graft_mapped_object(ctx, gmap, src_bbox));
        }
        pdf_obj *src_matrix = pdf_dict_get(ctx, src_xobj, PDF_NAME(Matrix));
        if (src_matrix) {
            pdf_dict_put(ctx, form_dict, PDF_NAME(Matrix),
                         pdf_graft_mapped_object(ctx, gmap, src_matrix));
        }
        pdf_dict_put(ctx, form_dict, PDF_NAME(Resources), new_res);

        new_form = pdf_add_stream(ctx, dst, stripped, form_dict, 0);
    }
    fz_always(ctx) {
        fz_drop_buffer(ctx, stripped);
        fz_drop_buffer(ctx, ni);
        fz_drop_buffer(ctx, orig);
    }
    fz_catch(ctx) {
        fz_warn(ctx, "kozou_build_text_only_form: failed at depth %d: %s",
                depth, fz_caught_message(ctx));
        new_form = NULL;
    }

    return new_form;
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

/* ── 共通 XObject 追跡コンポーネント ──────────────────────────────────────
 * 全検出デバイスに埋め込んで使用する。
 * stext ベースの検出では fz_run_page でこのデバイスを先に走らせ、
 * 文字座標 → (xobj_xref, internal_x, internal_y) のマップを構築する。
 * buried デバイスでは KozouBuriedDevice 内に直接埋め込む。
 * ─────────────────────────────────────────────────────────────────────── */

/* 1文字分のXObject情報 */
typedef struct {
    float page_x, page_y;    /* ページ座標 (MuPDF デバイス座標, Y下向き) */
    int   xobj_xref;         /* 所属 XObject xref (0=トップレベル) */
    float ix, iy;            /* XObject 内部座標 (Y上向き PDF 座標系) */
    int   ucs;               /* Unicode コードポイント (取り違え防止の識別子) */
    float size;              /* フォントサイズ pt (同上) */
} KozouCharXObj;

#define KOZOU_XOBJ_CHAR_MAX 65536

/* XObject スタックフレーム */
#define KOZOU_XOBJ_MAX_DEPTH 32
typedef struct {
    int       xref;          /* 現在の XObject xref (0=トップレベル) */
    fz_matrix ctm;           /* XObject → デバイス座標への変換行列 */
    fz_matrix inv_ctm;       /* デバイス → XObject 内部座標への逆変換行列 */
} KozouXObjFrame;

typedef struct {
    fz_device      base;
    KozouXObjFrame stack[KOZOU_XOBJ_MAX_DEPTH];
    int            depth;
    KozouCharXObj  chars[KOZOU_XOBJ_CHAR_MAX];
    int            char_count;
} KozouXObjDevice;

/* begin_group: 透明グループ（XObject ではなく単純なグループ）*/
static void kozou_xobj_begin_group(
    fz_context *ctx, fz_device *dev_,
    fz_rect bbox, fz_colorspace *cs, int isolated, int knockout,
    int blendmode, float alpha)
{
    KozouXObjDevice *dev = (KozouXObjDevice *)dev_;
    (void)ctx; (void)bbox; (void)cs; (void)isolated;
    (void)knockout; (void)blendmode; (void)alpha;
    if (dev->depth + 1 >= KOZOU_XOBJ_MAX_DEPTH) return;
    dev->depth++;
    dev->stack[dev->depth] = dev->stack[dev->depth - 1]; /* 親の状態を継承 */
}

static void kozou_xobj_end_group(fz_context *ctx, fz_device *dev_)
{
    KozouXObjDevice *dev = (KozouXObjDevice *)dev_;
    (void)ctx;
    if (dev->depth > 0) dev->depth--;
}

/* fill_text: 文字ごとに (page_x, page_y) と内部座標を記録 */
static void kozou_xobj_fill_text(
    fz_context *ctx, fz_device *dev_,
    const fz_text *text, fz_matrix ctm,
    fz_colorspace *cs, const float *color,
    float alpha, fz_color_params cp)
{
    KozouXObjDevice *dev = (KozouXObjDevice *)dev_;
    (void)cs; (void)color; (void)alpha; (void)cp;
    for (fz_text_span *span = text->head; span; span = span->next) {
        for (int i = 0; i < span->len; i++) {
            if (dev->char_count >= KOZOU_XOBJ_CHAR_MAX) return;
            fz_text_item *item = &span->items[i];
            /* stext と同じ計算: fz_concat(tm_with_item_xy, ctm).e/f
             * = item->x * ctm.a + item->y * ctm.c + ctm.e
             * これが stext の ch->origin と一致するデバイス座標 */
            KozouCharXObj *c = &dev->chars[dev->char_count++];
            c->page_x    = item->x * ctm.a + item->y * ctm.c + ctm.e;
            c->page_y    = item->x * ctm.b + item->y * ctm.d + ctm.f;
            c->xobj_xref = dev->stack[dev->depth].xref;
            /* 取り違え防止用の識別子: Unicode と概算フォントサイズ。
             * 同一座標に複数グリフが重なる場合、座標だけでなく ucs/size でも
             * 区別して正しいグリフのメタデータを引けるようにする。 */
            c->ucs  = item->ucs;
            c->size = sqrtf(span->trm.b * span->trm.b + span->trm.d * span->trm.d);
            /* 内部座標 (Tm+Td): span->trm の逆行列で復元
             * span->trm.a = font_size * Tm.a, span->trm.d = font_size * Tm.d
             * span->trm_inv × (item->x, item->y):
             *   ix = (1/Tfs) * item->x = Tm.tx + Td_x_cum
             *   iy = -((-1/Tfs) * item->y) = Tm.ty + Td_y_cum
             * これが kozou_find_xobj_by_tm のTm+Td座標と一致する */
            {
                fz_matrix strm_inv;
                if (fz_try_invert_matrix(&strm_inv, span->trm)) {
                    /* singular: フォールバック */
                    c->ix = item->x;
                    c->iy = item->y;
                } else {
                    /* 逆行列で正規化した内部座標は font_size で割られた値
                     * (例: Tm.ty=20, font_size=20.31 → iy_norm=0.985)。
                     * PDF ストリームの生 Tm/Td 座標と照合するため
                     * font_size を掛け戻して生の Tm 座標 (Tm.tx+Td_x, Tm.ty+Td_y)
                     * に戻す。font_size はテキスト縦スケール = |span->trm の縦成分|。 */
                    float ix_norm = strm_inv.a * item->x + strm_inv.c * item->y;
                    float iy_norm = -(strm_inv.b * item->x + strm_inv.d * item->y);
                    float font_size = sqrtf(span->trm.b * span->trm.b +
                                            span->trm.d * span->trm.d);
                    if (font_size < 1e-6f) font_size = 1.0f;
                    c->ix = ix_norm * font_size;
                    c->iy = iy_norm * font_size;
                }
            }
        }
    }
}

static KozouXObjDevice *kozou_new_xobj_device(fz_context *ctx)
{
    KozouXObjDevice *dev = fz_new_derived_device(ctx, KozouXObjDevice);
    dev->base.fill_text   = kozou_xobj_fill_text;
    dev->base.begin_group = kozou_xobj_begin_group;
    dev->base.end_group   = kozou_xobj_end_group;
    dev->depth      = 0;
    dev->char_count = 0;
    memset(&dev->stack[0], 0, sizeof(KozouXObjFrame));
    dev->stack[0].xref    = 0;
    dev->stack[0].ctm     = fz_identity;
    dev->stack[0].inv_ctm = fz_identity;
    return dev;
}

/* ページ座標 (px, py) に最も近い KozouCharXObj を検索。
 * 取り違え防止: 同一座標に複数グリフが重なる場合があるため、まず
 * want_ucs と一致する (かつサイズが近い) エントリの中から最近傍を選ぶ。
 * 一致するものが無ければ従来どおり座標最近傍を返す。
 * want_ucs < 0 を渡すと ucs を無視して座標最近傍のみで検索する。 */
static const KozouCharXObj *kozou_xobj_lookup(
    const KozouXObjDevice *dev, float px, float py, float tol,
    int want_ucs, float want_size)
{
    float best_d2 = tol * tol;
    const KozouCharXObj *best = NULL;       /* 座標最近傍 (フォールバック) */
    float best_match_d2 = tol * tol;
    const KozouCharXObj *best_match = NULL;  /* ucs/size 一致の最近傍 */
    for (int i = 0; i < dev->char_count; i++) {
        float dx = dev->chars[i].page_x - px;
        float dy = dev->chars[i].page_y - py;
        float d2 = dx*dx + dy*dy;
        if (d2 < best_d2) { best_d2 = d2; best = &dev->chars[i]; }
        if (want_ucs >= 0 && dev->chars[i].ucs == want_ucs) {
            /* サイズが分かる場合は大きく違うものを除外 (緩い許容: ±25%) */
            int size_ok = (want_size <= 0.0f || dev->chars[i].size <= 0.0f) ||
                (dev->chars[i].size >= want_size * 0.75f &&
                 dev->chars[i].size <= want_size * 1.25f);
            if (size_ok && d2 < best_match_d2) {
                best_match_d2 = d2; best_match = &dev->chars[i];
            }
        }
    }
    return best_match ? best_match : best;
}

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

    KozouXObjDevice *xobj_dev = NULL;
    fz_var(xobj_dev);
    fz_try(ctx) {
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
                /* XObject 追跡スキャン: 文字ごとの xref と内部座標を収集 */
                xobj_dev = kozou_new_xobj_device(ctx);
                fz_run_page(ctx, page, (fz_device *)xobj_dev, fz_identity, NULL);


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

                    /* Unicode コードポイント */
                    int cp = ch->c;

                    /* 制御文字は detect_control_chars で検出するためスキップ */
                    if (kozou_control_char_category(cp) != NULL) continue;

                    /* 無害な空白系文字は reason を whitespace_only にして別扱い */
                    int is_sanitized = kozou_is_sanitized_space(cp) &&
                        kozou_is_helvetica_font(ctx, ch->font);
                    /* sanitized は hits から除外 */
                    if (is_sanitized) continue;
                    int is_ws = kozou_is_whitespace_codepoint(cp);

                    /* Unicode コードポイント → UTF-8 */
                    char utf8[8] = {0};
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
                    if (is_ws)
                        reason = "whitespace_only";  /* 無害化が推奨される空白系文字 */
                    else if (ch_flags == 0)
                        reason = "invisible_mode";   /* Tr=3: 完全不可視 */
                    else if (ch_flags & 64)
                        reason = "clip_only_mode";   /* Tr=7: クリップのみ */
                    else
                        reason = "transparent";      /* ExtGState alpha=0 */

                    /* Type3 フォント判定: fz_font_name が "Type3" で始まる */
                    const char *font_name = fz_font_name(ctx, ch->font);
                    int is_type3 = (font_name &&
                        (strncmp(font_name, "Type3", 5) == 0 ||
                         strncmp(font_name, "type3", 5) == 0));
                    /* XObject 情報ルックアップ */
                    const KozouCharXObj *xobj_info = kozou_xobj_lookup(
                        xobj_dev, o.x, o.y, 2.0f, ch->c, ch->size);

                    fz_write_printf(ctx, out,
                        "{"
                        "\"char\":\"%s\","
                        "\"alpha\":%d,"
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"flags\":%d,"
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"size\":%.3f,"
                        "\"is_type3\":%s,"
                        "\"xobj_xref\":%d,"
                        "\"internal_origin\":[%.3f,%.3f]"
                        "}",
                        escaped, alpha, r, g, b,
                        ch_flags, reason,
                        o.x, o.y,
                        q.ul.x, q.ul.y,
                        q.ur.x, q.ur.y,
                        q.ll.x, q.ll.y,
                        q.lr.x, q.lr.y,
                        ch->size,
                        is_type3 ? "true" : "false",
                        xobj_info ? xobj_info->xobj_xref : 0,
                        xobj_info ? xobj_info->ix : o.x,
                        xobj_info ? xobj_info->iy : o.y
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
        if (xobj_dev) fz_drop_device(ctx, (fz_device *)xobj_dev);
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
/* 知覚色差: sRGB → CIELAB 変換と ΔE 計算                              */
/* グラデーション背景でも一貫した尺度で「肉眼で見える差」を測るため、    */
/* WCAG コントラスト比に加えて知覚均等色差 (ΔE) を用いる。              */
/* 第1レイヤーでは ΔE76 (CIE76, Lab ユークリッド距離) を使用。          */
/* 参考値: ΔE < 1 ほぼ区別不可 / 1-2 訓練された目で識別 /              */
/*         2-10 一見して分かる / 11-49 大きく異なる / 100 反対色       */
/* ------------------------------------------------------------------ */
static void kozou_srgb_to_lab(
    float r, float g, float b,
    float *out_L, float *out_a, float *out_b)
{
    /* sRGB → 線形 RGB */
#define KZ_LIN(c) ((c) <= 0.04045f ? (c)/12.92f : powf(((c)+0.055f)/1.055f, 2.4f))
    float rl = KZ_LIN(r), gl = KZ_LIN(g), bl = KZ_LIN(b);
#undef KZ_LIN
    /* 線形 RGB → XYZ (sRGB / D65) */
    float X = 0.4124564f*rl + 0.3575761f*gl + 0.1804375f*bl;
    float Y = 0.2126729f*rl + 0.7151522f*gl + 0.0721750f*bl;
    float Z = 0.0193339f*rl + 0.1191920f*gl + 0.9503041f*bl;
    /* D65 白色点で正規化 */
    float xr = X / 0.95047f;
    float yr = Y / 1.00000f;
    float zr = Z / 1.08883f;
    /* XYZ → Lab */
#define KZ_F(t) ((t) > 0.008856f ? cbrtf(t) : (7.787f*(t) + 16.0f/116.0f))
    float fx = KZ_F(xr), fy = KZ_F(yr), fz_ = KZ_F(zr);
#undef KZ_F
    *out_L = 116.0f*fy - 16.0f;
    *out_a = 500.0f*(fx - fy);
    *out_b = 200.0f*(fy - fz_);
}

/* CIE76 色差 ΔE (Lab ユークリッド距離) */
static float kozou_delta_e76(
    float r1, float g1, float b1,
    float r2, float g2, float b2)
{
    float L1,a1,b1l, L2,a2,b2l;
    kozou_srgb_to_lab(r1, g1, b1, &L1, &a1, &b1l);
    kozou_srgb_to_lab(r2, g2, b2, &L2, &a2, &b2l);
    float dL = L1 - L2, da = a1 - a2, db = b1l - b2l;
    return sqrtf(dL*dL + da*da + db*db);
}

/* ------------------------------------------------------------------ */
/* 内部: 塗り矩形リスト（描画順に蓄積する）                             */
/* ------------------------------------------------------------------ */
#define KOZOU_MAX_FILLS 4096

typedef struct {
    float x0, y0, x1, y1;  /* pt 座標（PDF座標系: Y上向き）*/
    float r, g, b;
    int   draw_order;       /* 描画順インデックス */
} KozouFillRect;

#define KOZOU_MAX_TEXT_EVENTS 4096
typedef struct {
    float x, y;       /* テキスト原点 */
    int   draw_order; /* 描画順 */
} KozouTextEvent;

typedef struct {
    KozouFillRect  rects[KOZOU_MAX_FILLS];
    int            count;
    int            global_order;
    KozouTextEvent texts[KOZOU_MAX_TEXT_EVENTS];
    int            text_count;
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
    fr->draw_order = dev->fills->global_order++;
}

/* fill_text: テキストの描画順を記録 */
static void kozou_fill_device_fill_text(
    fz_context *ctx, fz_device *dev_,
    const fz_text *text, fz_matrix ctm,
    fz_colorspace *cs, const float *color, float alpha, fz_color_params cp)
{
    KozouFillDevice *dev = (KozouFillDevice *)dev_;
    if (!dev->fills) return;
    for (fz_text_span *span = text->head; span; span = span->next) {
        for (int i = 0; i < span->len; i++) {
            fz_text_item *item = &span->items[i];
            fz_point pt = fz_transform_point(fz_make_point(item->x, item->y), ctm);
            if (dev->fills->text_count < KOZOU_MAX_TEXT_EVENTS) {
                KozouTextEvent *te = &dev->fills->texts[dev->fills->text_count++];
                te->x = pt.x;
                te->y = pt.y;
                te->draw_order = dev->fills->global_order++;
            }
        }
    }
    (void)cs; (void)color; (void)alpha; (void)cp;
}

static fz_device *kozou_new_fill_device(fz_context *ctx, KozouFillList *fills)
{
    KozouFillDevice *dev = fz_new_derived_device(ctx, KozouFillDevice);
    dev->base.fill_path = kozou_fill_device_fill_path;
    dev->base.fill_text = kozou_fill_device_fill_text;
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
    float ox, float oy,
    float page_h)
{
    /* 文字位置を含む塗り矩形の中で最も小さいもの（最も具体的な背景）を選ぶ。
     * 最後に描画された（draw_order最大）を優先しつつ、最小面積を選ぶ。
     * 注: fill_text は通常 Tr=0 では呼ばれないため texts[] は使わない。 */
    int best = -1;
    float best_area = 1e18f;
    int best_order = -1;
    for (int i = 0; i < fills->count; i++) {
        const KozouFillRect *fr = &fills->rects[i];
        if (ox >= fr->x0 && ox <= fr->x1 &&
            oy >= fr->y0 && oy <= fr->y1) {
            float area = (fr->x1 - fr->x0) * (fr->y1 - fr->y0);
            /* 面積が同程度（10%以内）なら描画順が新しいものを優先 */
            /* 面積が大幅に小さければ常に優先（より具体的な背景） */
            int prefer = 0;
            if (best < 0) prefer = 1;
            else if (area < best_area * 0.5f) prefer = 1;   /* 半分以下なら必ず選ぶ */
            else if (area <= best_area * 1.1f &&
                     fr->draw_order > best_order) prefer = 1; /* 同程度なら後のものを選ぶ */
            if (prefer) {
                best_area = area;
                best_order = fr->draw_order;
                best = i;
            }
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
/* contrast_threshold: 1.0〜21.0 (デフォルト: 1.2)                    */
/*   1.0 = 完全に同色のみ（最も厳格）                                  */
/*   1.2 = ほぼ同色（標準: 約5%の輝度差以下）                          */
/*   1.5 = わずかに見えにくい（緩め）                                  */
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
/* リング32点中、低コントラスト点がこの割合以上を占めたら「埋没」と判定する */
#define KOZOU_LC_RATIO_THRESHOLD 0.4f

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
    fz_pixmap     *pixmap = NULL;
    fz_var(doc); fz_var(page); fz_var(stext); fz_var(pixmap);

    if (contrast_threshold <= 0.0f) contrast_threshold = 1.2f;
    if (contrast_threshold > 21.0f) contrast_threshold = 21.0f;

    fz_try(ctx) {
        doc = fz_open_document(ctx, path);

        /* ページをレンダリング（3倍解像度で背景色を精度よくサンプリング）*/
        const float RENDER_SCALE = 3.0f;
        fz_matrix render_ctm = fz_scale(RENDER_SCALE, RENDER_SCALE);
        pixmap = fz_new_pixmap_from_page_number(
            ctx, doc, page_index, render_ctm, fz_device_rgb(ctx), 0);

        /* stext でテキスト取得 */
        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        page = fz_load_page(ctx, doc, page_index);

        /* ページの高さ（Y座標変換用）*/
        fz_rect bounds = fz_bound_page(ctx, page);
        float page_h = bounds.y1 - bounds.y0;
        (void)page_h;

        stext = fz_new_stext_page_from_page(ctx, page, &opts);

        int hit_count = 0;
        fz_write_printf(ctx, out,
            "{\"ok\":true,\"page\":%d,\"hits\":[", page_index);

        /* pixmap のサンプリング関数 */
        /* 文字のquad外側をサンプリングして背景色を取得する */

        for (fz_stext_block *block = stext->first_block;
             block; block = block->next) {
            if (block->type != FZ_STEXT_BLOCK_TEXT) continue;

            for (fz_stext_line *line = block->u.t.first_line;
                 line; line = line->next) {

                for (fz_stext_char *ch = line->first_char;
                     ch; ch = ch->next) {

                    /* alpha=0 の文字は透明テキスト検出で扱う */
                    unsigned int packed = (unsigned int)ch->argb;
                    int alpha = (packed >> 24) & 0xFF;
                    if (alpha == 0) continue;

                    /* 文字色(PDF記録値): 完全透明はスキップ済み */
                    int pdf_tr = (packed >> 16) & 0xFF;
                    int pdf_tg = (packed >>  8) & 0xFF;
                    int pdf_tb =  packed        & 0xFF;

                    /* 文字のquadからbboxを計算 */
                    fz_quad q = ch->quad;
                    float qx0 = q.ul.x < q.ll.x ? q.ul.x : q.ll.x;
                    float qx1 = q.ur.x > q.lr.x ? q.ur.x : q.lr.x;
                    float qy0 = q.ul.y < q.ur.y ? q.ul.y : q.ur.y;
                    float qy1 = q.ll.y > q.lr.y ? q.ll.y : q.lr.y;
                    float char_w = qx1 - qx0;
                    float char_h = qy1 - qy0;
                    float cx = (qx0 + qx1) * 0.5f;
                    float cy = (qy0 + qy1) * 0.5f;

                    if (char_w < 0.5f || char_h < 0.5f) continue;

                    /* ── 多点サンプリング＋割合判定 ─────────────────────────────
                     * 文字内側 3x3=9点 で実際の描画色(fg)を取得。
                     * 文字外周リング 32点 で各背景色を個別取得し、
                     * fg とのコントラストを点ごとに計算。
                     * 低コントラスト点の割合 >= 40% なら検出。
                     * これにより「上半分だけ同化」等の部分的同化を正確に捕捉。 */

                    /* Step 1: 文字グリフ内側 3x3 の最も暗いピクセルを fg とする
                     * 中空グリフ（口、日など）では内側が全て背景色になるため
                     * その場合は PDF 記録色にフォールバックする */
                    float inner = char_h * 0.25f;
                    float best_lum = 1.0e18f;
                    float fg_r = pdf_tr / 255.0f;
                    float fg_g = pdf_tg / 255.0f;
                    float fg_b = pdf_tb / 255.0f;
                    for (int gy = -1; gy <= 1; gy++) {
                        for (int gx = -1; gx <= 1; gx++) {
                            int fpx = (int)((cx + gx * inner) * RENDER_SCALE);
                            int fpy = (int)((cy + gy * inner) * RENDER_SCALE);
                            if (fpx < 0 || fpx >= pixmap->w ||
                                fpy < 0 || fpy >= pixmap->h) continue;
                            unsigned char *fp = pixmap->samples +
                                fpy * pixmap->stride + fpx * pixmap->n;
                            float pr = fp[0]/255.0f, pg = fp[1]/255.0f, pb = fp[2]/255.0f;
                            float lum_val = 0.2126f*pr + 0.7152f*pg + 0.0722f*pb;
                            if (lum_val < best_lum) {
                                best_lum = lum_val;
                                fg_r = pr; fg_g = pg; fg_b = pb;
                            }
                        }
                    }
                    /* 最暗ピクセルが背景色と同一（中空グリフ）の場合は PDF 記録色を使用 */
                    {
                        float pdf_lum = 0.2126f*(pdf_tr/255.0f) +
                                        0.7152f*(pdf_tg/255.0f) +
                                        0.0722f*(pdf_tb/255.0f);
                        float diff = best_lum - pdf_lum;
                        if (diff < 0) diff = -diff;
                        if (diff > 0.1f) {
                            /* ピクセルの最暗値が PDF 記録色と大きく異なる = 中空グリフ */
                            fg_r = pdf_tr / 255.0f;
                            fg_g = pdf_tg / 255.0f;
                            fg_b = pdf_tb / 255.0f;
                        }
                    }
                    (void)pdf_tr; (void)pdf_tg; (void)pdf_tb;

                    /* Step 2: 外周リング 32点 を均等配置でサンプリング
                     * 各点について fg との知覚色差 ΔE と WCAG コントラスト比を計算。
                     * 「割合判定」: 低コントラスト点(cr_i<=閾値)がリング全体の
                     * KOZOU_LC_RATIO_THRESHOLD 以上を占めるなら「埋もれている」と判定。
                     * 「上半分だけ同化」等の部分的同化でも角度に依らず正確に捕捉できる。
                     *
                     * 外周点が fg と全く同じ色の場合（文字色と背景色が完全一致）も、
                     * かつてはスキップして無効サンプル扱いにしていたが、これは
                     * 「背景が本当に文字色と同一」という最も強い埋没シグナルを
                     * 逆に捨ててしまうバグだった。fg==bg はコントラスト比1.0
                     * （最も低い値）として正しくカウントする。 */
                    float ring_rx = char_w * 0.5f + char_h * 0.7f + 3.0f;
                    float ring_ry = char_h * 0.5f + char_h * 0.7f + 3.0f;
                    int   ring_total = 0;      /* pixmap範囲内でサンプリングできた点数 */
                    int   low_count  = 0;      /* 低コントラストと判定された点数 */
                    int   bg_r_sum = 0, bg_g_sum = 0, bg_b_sum = 0;
                    float de_sum = 0.0f;
                    float cr_sum = 0.0f;
                    for (int ri = 0; ri < 32; ri++) {
                        float angle = (float)(2.0 * 3.14159265358979 * ri / 32);
                        int bpx = (int)((cx + ring_rx * cosf(angle)) * RENDER_SCALE);
                        int bpy = (int)((cy + ring_ry * sinf(angle)) * RENDER_SCALE);
                        if (bpx < 0 || bpx >= pixmap->w ||
                            bpy < 0 || bpy >= pixmap->h) continue;
                        unsigned char *bp = pixmap->samples +
                            bpy * pixmap->stride + bpx * pixmap->n;
                        float bg_r_f = bp[0] / 255.0f;
                        float bg_g_f = bp[1] / 255.0f;
                        float bg_b_f = bp[2] / 255.0f;
                        float de_i = kozou_delta_e76(
                            fg_r, fg_g, fg_b, bg_r_f, bg_g_f, bg_b_f);
                        float cr_i = kozou_contrast_ratio(
                            fg_r, fg_g, fg_b, bg_r_f, bg_g_f, bg_b_f);
                        ring_total++;
                        de_sum += de_i;
                        cr_sum += cr_i;
                        bg_r_sum += bp[0]; bg_g_sum += bp[1]; bg_b_sum += bp[2];
                        if (cr_i <= contrast_threshold) low_count++;
                    }
                    if (ring_total == 0) continue;  /* ページ端でサンプリング不能 */
                    int bg_r = bg_r_sum / ring_total;
                    int bg_g = bg_g_sum / ring_total;
                    int bg_b = bg_b_sum / ring_total;

                    /* Step 3: 割合判定で検出
                     * リング32点中、低コントラストな点が
                     * KOZOU_LC_RATIO_THRESHOLD (40%) 以上を占めるかどうかで判定する。
                     * 単一方向の最良値(max)による判定は、
                     *  - 背景色と文字色が完全一致し外周が丸ごと同色になるケース
                     *  - 文字を囲む着色矩形が小さく、サンプリングリングがその外側の
                     *    ページ地色（白）にわずかにはみ出すケース
                     * のいずれでも、ごく一部の点（あるいは0点）だけで
                     * 「見える／見えない」を決めてしまい誤判定を招くため、
                     * リング全体に対する比率で安定して判定する。 */
                    float low_ratio = (float)low_count / (float)ring_total;
                    if (low_ratio < KOZOU_LC_RATIO_THRESHOLD) continue;

                    /* JSON 出力用の代表値（リング平均）*/
                    float cr = cr_sum / ring_total;
                    float max_de = de_sum / ring_total;

                    /* 無害な文字はスキップ */
                    int _lc_san = kozou_is_sanitized_space(ch->c) &&
                        kozou_is_helvetica_font(ctx, ch->font);
                    if (_lc_san) continue;

                    const char *lc_reason =
                        kozou_is_whitespace_codepoint(ch->c) ? "whitespace_only"
                        : "low_contrast";

                    /* JSON出力 */
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

                    const char *lc_font_name = fz_font_name(ctx, ch->font);
                    int lc_is_type3 = (lc_font_name &&
                        (strncmp(lc_font_name, "Type3", 5) == 0 ||
                         strncmp(lc_font_name, "type3", 5) == 0));

                    fz_quad lq = ch->quad;
                    if (hit_count > 0) fz_write_printf(ctx, out, ",");

                    /* xobj_xref は常に 0 (low_contrast は stext から取得) */
                    fz_write_printf(ctx, out,
                        "{\"char\":\"%s\","
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"bg_color_rgb\":[%d,%d,%d],"
                        "\"contrast\":%.3f,"
                        "\"delta_e\":%.3f,"
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"size\":%.3f,"
                        "\"is_type3\":%s,"
                        "\"xobj_xref\":0,"
                        "\"internal_origin\":[%.3f,%.3f]}",
                        escaped,
                        (int)(fg_r * 255), (int)(fg_g * 255), (int)(fg_b * 255),
                        bg_r, bg_g, bg_b,
                        (double)cr,
                        (double)max_de,
                        lc_reason,
                        (double)ch->origin.x, (double)ch->origin.y,
                        (double)lq.ul.x, (double)lq.ul.y,
                        (double)lq.ur.x, (double)lq.ur.y,
                        (double)lq.ll.x, (double)lq.ll.y,
                        (double)lq.lr.x, (double)lq.lr.y,
                        (double)(ch->size > 0 ? ch->size : 12.0f),
                        lc_is_type3 ? "true" : "false",
                        (double)ch->origin.x, (double)ch->origin.y);

                    hit_count++;
                }
            }
        }

        fz_write_printf(ctx, out, "]}");
        result->ok = 1;
    }
    fz_always(ctx) {
        if (pixmap) fz_drop_pixmap(ctx, pixmap);
        if (stext)  fz_drop_stext_page(ctx, stext);
        if (page)   fz_drop_page(ctx, page);
        if (doc)    fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}


void kozou_detect_tiny_text(
    fz_context  *ctx,
    const char  *path,
    int          page_index,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    float        size_threshold,
    fz_output   *out,
    FfiResult   *result)
{
    fz_document   *doc   = NULL;
    fz_page       *page  = NULL;
    fz_stext_page *stext = NULL;

    fz_var(doc);
    fz_var(page);
    fz_var(stext);

    KozouXObjDevice *xobj_dev = NULL;
    fz_var(xobj_dev);
    fz_try(ctx) {
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = (layout_w  > 0) ? layout_w  : 450.0f;
            float h  = (layout_h  > 0) ? layout_h  : 600.0f;
            float em = (layout_em > 0) ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page  = fz_load_page(ctx, doc, page_index);

        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        stext = fz_new_stext_page_from_page(ctx, page, &opts);

                /* XObject 追跡スキャン */
                xobj_dev = kozou_new_xobj_device(ctx);
                fz_run_page(ctx, page, (fz_device *)xobj_dev, fz_identity, NULL);

        if (size_threshold <= 0.0f) size_threshold = 2.0f;

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

                    if (ch->size > size_threshold) continue;

                    /* sanitized は hits から除外 */
                    if (kozou_is_sanitized_space(ch->c) &&
                        kozou_is_helvetica_font(ctx, ch->font)) continue;
                    const char *tiny_reason =
                        kozou_is_whitespace_codepoint(ch->c) ? "whitespace_only"
                        : "tiny_font";

                    /* 文字色 */
                    unsigned int packed = (unsigned int)ch->argb;
                    int r = (packed >> 16) & 0xFF;
                    int g = (packed >>  8) & 0xFF;
                    int b =  packed        & 0xFF;

                    /* JSON エスケープ */
                    int cp = ch->c;
                    char escaped[32] = {0};
                    if      (cp == '"')  { escaped[0]='\\'; escaped[1]='"';  }
                    else if (cp == '\\') { escaped[0]='\\'; escaped[1]='\\'; }
                    else if (cp == '\n') { escaped[0]='\\'; escaped[1]='n';  }
                    else if (cp < 0x20 || cp > 0x7E) {
                        snprintf(escaped, sizeof(escaped), "\\u%04X", cp);
                    } else {
                        escaped[0] = (char)cp;
                    }

                    fz_quad  q = ch->quad;
                    fz_point o = ch->origin;

                    if (hit_count > 0) fz_write_printf(ctx, out, ",");
                    const char *tiny_font_name = fz_font_name(ctx, ch->font);
                    int tiny_is_type3 = (tiny_font_name &&
                        (strncmp(tiny_font_name, "Type3", 5) == 0 ||
                         strncmp(tiny_font_name, "type3", 5) == 0));
                    /* XObject 情報ルックアップ */
                    const KozouCharXObj *xobj_info = kozou_xobj_lookup(
                        xobj_dev, o.x, o.y, 2.0f, ch->c, ch->size);

                    fz_write_printf(ctx, out,
                        "{"
                        "\"char\":\"%s\","
                        "\"size\":%.4f,"
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"is_type3\":%s,"
                        "\"xobj_xref\":%d,"
                        "\"internal_origin\":[%.3f,%.3f]"
                        "}",
                        escaped,
                        ch->size,
                        r, g, b,
                        tiny_reason,
                        o.x, o.y,
                        q.ul.x, q.ul.y,
                        q.ur.x, q.ur.y,
                        q.ll.x, q.ll.y,
                        q.lr.x, q.lr.y,
                        tiny_is_type3 ? "true" : "false",
                        xobj_info ? xobj_info->xobj_xref : 0,
                        xobj_info ? xobj_info->ix : o.x,
                        xobj_info ? xobj_info->iy : o.y
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
        if (xobj_dev) fz_drop_device(ctx, (fz_device *)xobj_dev);
        if (doc)   fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ================================================================== */
/* ⑤ オブジェクト裏に隠されたテキストの検出（改訂版）                  */
/*                                                                     */
/* 設計:                                                               */
/*   Pass 1: fz_run_page で fill_path/fill_image/fill_text を          */
/*           event_index 付きで記録。                                  */
/*           fill_text は PDF座標(Y上向き)→デバイス座標(Y下向き)に変換。*/
/*   Pass 2: fz_stext_page で文字を取得し、                            */
/*           origin が最近傍の fill_text イベントと対応付け。           */
/*           その fill_text の event_index より大きい event_index を    */
/*           持ち、かつ文字 bbox を cover_ratio 以上覆う               */
/*           fill_path/fill_image があれば「隠蔽」と判定。             */
/* ================================================================== */

/* 内部: 塗りパスイベント (fill_path / fill_image) */
typedef struct {
    int   event_index;
    int   xobj_xref;         /* 所属 XObject の xref (0=トップレベル) */
    float x0, y0, x1, y1;   /* デバイス座標 (Y下向き) */

    /* SMask/Mask を持つ画像カバーの精査用 (fill_path 由来では is_image=0)。
     * 画像は矩形(bbox)が重なっていても実際には透明な部分があり得るため、
     * 後段でグリフと重なる領域だけをピクセル単位でサンプリングする
     * (kozou_cover_alpha_ok 参照)。fz_keep_image で参照を保持し、
     * 検出処理の終了時 (kozou_detect_buried_text の fz_always) に
     * fz_drop_image で解放する。 */
    int       is_image;
    fz_image *image;   /* NULL = 通常のパスカバー、またはマスク無し画像 */
    fz_matrix ctm;      /* この画像描画時の CTM (unit square → デバイス座標) */
} KozouCoverRect;

/* 内部: テキスト文字イベント (fill_text) */
typedef struct {
    int   event_index;
    int   xobj_xref;         /* 所属 XObject の xref (0=トップレベル) */
    int   ucs;               /* Unicode (取り違え防止: stext 文字との対応付け) */
    float ix, iy;            /* XObject 内部座標系での origin */
    float ox, oy;            /* デバイス座標 (Y下向き) */
    float x0, y0, x1, y1;   /* グリフ bbox (デバイス座標) */

    /* このテキストが描画された時点で有効だったクリップ矩形のスナップ
     * ショット。Tr=0(通常描画)の可視テキストであっても、その文字位置を
     * 含まない小さなクリップ矩形の内側に押し込めることで見た目上隠す
     * ことができる (覆うオブジェクトが無いため fill_path/fill_image側の
     * カバー判定では検出できない別系統の隠蔽手口)。
     * has_clip=0 の場合はクリップ無し (制限なし)。 */
    int     has_clip;
    fz_rect clip;
} KozouTextEvt;

#define KOZOU_MAX_COVERS 8192
#define KOZOU_MAX_TEXTS  32768

typedef struct {
    KozouCoverRect covers[KOZOU_MAX_COVERS];
    int            cover_count;
    KozouTextEvt   texts[KOZOU_MAX_TEXTS];
    int            text_count;
    int            event_counter;
    float          page_h;   /* ページ高さ (pt) — Y 変換用 */
} KozouBuriedList;



/* ──────────────────────────────────────────────────────────────────
 * パスの実塗り面積を計算する (buried 誤検出防止)
 *
 * fz_bound_path はパスのバウンディングボックスを返すため、罫線・枠・グリッド
 * のように「細い線だが bbox は広い」パスを塗りつぶし矩形と誤認してしまう。
 * (例: カレンダーの罫線10本 → bbox はカレンダー全体 → 内側の可視テキストを
 *  すべて buried と誤判定し、無害化で可視テキストを破壊する)
 *
 * 各サブパスの符号付き面積 (シューレース公式) を積算し、デバイス座標系での
 * 実塗り面積を求める。曲線は終点で近似 (枠/線 vs 面塗りの判別には十分)。
 * 塗り面積 / bbox面積 が小さいパスは「枠・線」とみなし被覆対象から除外する。
 * ───────────────────────────────────────────────────────────────── */
typedef struct {
    fz_matrix ctm;
    fz_point  start;   /* サブパス始点 (デバイス座標) */
    fz_point  cur;     /* 現在点 (デバイス座標) */
    double    area2;   /* 符号付き面積の2倍を積算 */
    int       has_sub; /* サブパス開始済みか */
} KozouAreaWalk;

static void kozou_area_close_sub(KozouAreaWalk *w)
{
    if (w->has_sub)
        w->area2 += (double)w->cur.x * w->start.y - (double)w->start.x * w->cur.y;
}
static void kozou_area_edge(KozouAreaWalk *w, fz_point p)
{
    w->area2 += (double)w->cur.x * p.y - (double)p.x * w->cur.y;
    w->cur = p;
}
static void kozou_area_moveto(fz_context *ctx, void *arg, float x, float y)
{
    (void)ctx; KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_close_sub(w); /* 直前サブパスを暗黙クローズ (fill は暗黙閉路) */
    w->start = w->cur = fz_transform_point(fz_make_point(x, y), w->ctm);
    w->has_sub = 1;
}
static void kozou_area_lineto(fz_context *ctx, void *arg, float x, float y)
{
    (void)ctx; KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_edge(w, fz_transform_point(fz_make_point(x, y), w->ctm));
}
static void kozou_area_curveto(fz_context *ctx, void *arg,
    float x1, float y1, float x2, float y2, float x3, float y3)
{
    (void)ctx; (void)x1; (void)y1; (void)x2; (void)y2;
    KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_edge(w, fz_transform_point(fz_make_point(x3, y3), w->ctm));
}
static void kozou_area_quadto(fz_context *ctx, void *arg,
    float x1, float y1, float x2, float y2)
{
    (void)ctx; (void)x1; (void)y1;
    KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_edge(w, fz_transform_point(fz_make_point(x2, y2), w->ctm));
}
static void kozou_area_curvetov(fz_context *ctx, void *arg,
    float x2, float y2, float x3, float y3)
{
    (void)ctx; (void)x2; (void)y2;
    KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_edge(w, fz_transform_point(fz_make_point(x3, y3), w->ctm));
}
static void kozou_area_curvetoy(fz_context *ctx, void *arg,
    float x1, float y1, float x3, float y3)
{
    (void)ctx; (void)x1; (void)y1;
    KozouAreaWalk *w = (KozouAreaWalk *)arg;
    kozou_area_edge(w, fz_transform_point(fz_make_point(x3, y3), w->ctm));
}
static void kozou_area_closepath(fz_context *ctx, void *arg)
{
    (void)ctx; KozouAreaWalk *w = (KozouAreaWalk *)arg;
    w->cur = w->start; /* 始点に戻る (面積寄与は close_sub でまとめて計上) */
}

/* パスの「実塗り面積 / bbox面積」比を返す (0.0〜約1.0)。
 * bbox が退化している場合は 0。曲線終点近似のため面塗りは過小評価され得るが、
 * 枠・線 (比≈0) と面塗り (比が大) の判別には十分。 */
static float kozou_path_fill_ratio(
    fz_context *ctx, const fz_path *path, fz_matrix ctm, fz_rect bbox)
{
    float bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
    float barea = bw * bh;
    if (barea <= 0.0f) return 0.0f;
    fz_path_walker walker = {
        kozou_area_moveto, kozou_area_lineto, kozou_area_curveto,
        kozou_area_closepath, kozou_area_quadto,
        kozou_area_curvetov, kozou_area_curvetoy
    };
    KozouAreaWalk w;
    memset(&w, 0, sizeof(w));
    w.ctm = ctm;
    fz_walk_path(ctx, path, &walker, &w);
    kozou_area_close_sub(&w); /* 最終サブパスを暗黙クローズ */
    double filled = fabs(w.area2) * 0.5;
    return (float)(filled / (double)barea);
}

/* 細い線・枠とみなす実塗り面積比の下限。
 * これ未満のパスは「面塗りで覆っている」のではなく罫線/枠なので被覆対象外。
 * 罫線グリッドは比≈0、面塗り矩形は≈1、円/角丸も終点近似で 0.5 前後を確保。 */
#define KOZOU_BURIED_MIN_FILL_RATIO 0.20f

/* クリップ矩形の深さ上限。実務上のPDFでこれを超える深さの入れ子クリップは
 * ほぼ無いが、超過した場合は "現状維持" のまま対応する pop を待つ
 * (clip_over_depth で push/pop の対応を崩さない)。 */
#define KOZOU_MAX_CLIP_DEPTH 256

/* ---- デバイス ---- */
typedef struct {
    fz_device      base;
    KozouBuriedList *list;
    KozouXObjFrame  xobj_stack[KOZOU_XOBJ_MAX_DEPTH];
    int             xobj_depth; /* 現在のスタック深さ (0=トップレベル) */

    /* アクティブなクリップ矩形のスタック (bbox近似)。
     * fill_path/fill_image が実際に見える範囲を正しく評価するため、
     * clip_path 等で押し込まれた scissor (MuPDFが既に親クリップと
     * 交差計算済みの矩形) をそのまま積む。 */
    fz_rect         clip_stack[KOZOU_MAX_CLIP_DEPTH];
    int             clip_depth;      /* 実際にスタックされている深さ */
    int             clip_over_depth; /* 上限超過分の push 回数 (対応する pop で相殺) */
} KozouBuriedDevice;

/* 現在有効なクリップ矩形との交差を返す。clip_depth==0 (クリップ無し) の
 * 場合は bbox をそのまま返す。fz_infinite_rect 等の特別な番兵値の解釈に
 *依存したくないため、素朴な軸並行矩形の交差計算を自前で行う。 */
static fz_rect kozou_buried_clip_intersect(const KozouBuriedDevice *dev, fz_rect bbox)
{
    if (dev->clip_depth <= 0) return bbox;
    fz_rect c = dev->clip_stack[dev->clip_depth - 1];
    fz_rect r;
    r.x0 = bbox.x0 > c.x0 ? bbox.x0 : c.x0;
    r.y0 = bbox.y0 > c.y0 ? bbox.y0 : c.y0;
    r.x1 = bbox.x1 < c.x1 ? bbox.x1 : c.x1;
    r.y1 = bbox.y1 < c.y1 ? bbox.y1 : c.y1;
    return r;
}

static int kozou_buried_rect_is_empty(fz_rect r)
{
    return r.x0 >= r.x1 || r.y0 >= r.y1;
}

static void kozou_buried_push_clip(KozouBuriedDevice *dev, fz_rect scissor)
{
    if (dev->clip_depth < KOZOU_MAX_CLIP_DEPTH) {
        dev->clip_stack[dev->clip_depth] = kozou_buried_clip_intersect(dev, scissor);
        dev->clip_depth++;
    } else {
        dev->clip_over_depth++;
    }
}

static void kozou_buried_pop_clip(fz_context *ctx, fz_device *dev_)
{
    (void)ctx;
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (dev->clip_over_depth > 0) dev->clip_over_depth--;
    else if (dev->clip_depth > 0) dev->clip_depth--;
}

/* clip_path/clip_stroke_path/clip_image_mask は「これから描画される内容が
 * この矩形(scissor)でクリップされる」ことをデバイスに通知するコールバック。
 * scissor はMuPDF側で既に親クリップと交差計算済みのデバイス空間bboxなので、
 * そのままスタックに積むだけでよい (パス形状そのものの精密なクリップ形状
 * までは追わず、外接矩形近似で扱う。fill_path/fill_image のカバー判定自体
 * が既にbbox近似のため一貫している)。
 *
 * clip_text/clip_stroke_text は意図的に実装しない: Tr=7 (クリップのみ・
 * 不可視) の文字はこれらのコールバックが未設定 (NULL) の場合に限って
 * MuPDF が fill_text 経由でも通知してくれる (invisible_mode/clip_only 検出
 * が fill_text 側に依存している既存の挙動、下のコメント参照)。ここで
 * clip_text を実装してしまうと Tr=7 の文字が fill_text に来なくなり、
 * 別機能である不可視テキスト検出を壊してしまうため、テキスト系クリップは
 * 対象外のままにする (今回の誤検出はパスのクリップ (re → W* → n) が原因であり
 * テキストクリップ由来ではないため、この範囲で実害はない)。 */
static void kozou_buried_clip_path(
    fz_context *ctx, fz_device *dev_, const fz_path *path,
    int even_odd, fz_matrix ctm, fz_rect scissor)
{
    (void)ctx; (void)path; (void)even_odd; (void)ctm;
    kozou_buried_push_clip((KozouBuriedDevice *)dev_, scissor);
}
static void kozou_buried_clip_stroke_path(
    fz_context *ctx, fz_device *dev_, const fz_path *path,
    const fz_stroke_state *stroke, fz_matrix ctm, fz_rect scissor)
{
    (void)ctx; (void)path; (void)stroke; (void)ctm;
    kozou_buried_push_clip((KozouBuriedDevice *)dev_, scissor);
}
static void kozou_buried_clip_image_mask(
    fz_context *ctx, fz_device *dev_, fz_image *image,
    fz_matrix ctm, fz_rect scissor)
{
    (void)ctx; (void)image; (void)ctm;
    kozou_buried_push_clip((KozouBuriedDevice *)dev_, scissor);
}

static void kozou_buried_fill_path(
    fz_context *ctx, fz_device *dev_,
    const fz_path *path, int even_odd, fz_matrix ctm,
    fz_colorspace *cs, const float *color, float alpha,
    fz_color_params cp)
{
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (!dev->list || dev->list->cover_count >= KOZOU_MAX_COVERS) return;
    if (alpha < 0.5f) return;

    fz_rect bbox = fz_bound_path(ctx, path, NULL, ctm);
    if (bbox.x0 >= bbox.x1 || bbox.y0 >= bbox.y1) return;

    /* 罫線・枠・グリッドの誤検出防止 (buried 取り違えの主因):
     * パスの実塗り面積が bbox に対して小さい場合、それは「面で覆う塗り」では
     * なく細い線なので被覆対象にしない。これを怠ると、カレンダー罫線等の
     * 広い bbox を持つ線パスが内側の可視テキストを buried と誤判定し、
     * 無害化で可視テキストを破壊してしまう。
     * (fill_ratio はクリップ前の本来のパス面積比で判定する) */
    float fill_ratio = kozou_path_fill_ratio(ctx, path, ctm, bbox);
    if (fill_ratio < KOZOU_BURIED_MIN_FILL_RATIO) return;

    /* アクティブなクリップ矩形と交差させる。クリップの外側は実際には
     * 描画されない (見えない) ので、その部分をカバーとして扱ってしまうと
     * クリップの外にあるテキストまで誤って埋没扱いしてしまう。 */
    fz_rect clipped_bbox = kozou_buried_clip_intersect(dev, bbox);
    if (kozou_buried_rect_is_empty(clipped_bbox)) return;

    KozouCoverRect *cr = &dev->list->covers[dev->list->cover_count++];
    cr->event_index = dev->list->event_counter++;
    cr->xobj_xref   = dev->xobj_stack[dev->xobj_depth].xref;
    cr->x0 = clipped_bbox.x0; cr->y0 = clipped_bbox.y0;
    cr->x1 = clipped_bbox.x1; cr->y1 = clipped_bbox.y1;
}

static void kozou_buried_fill_image(
    fz_context *ctx, fz_device *dev_,
    fz_image *image, fz_matrix ctm, float alpha,
    fz_color_params cp)
{
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (!dev->list || dev->list->cover_count >= KOZOU_MAX_COVERS) return;
    if (alpha < 0.5f) return;

    fz_rect bbox = fz_transform_rect(fz_unit_rect, ctm);
    if (bbox.x0 > bbox.x1) { float t = bbox.x0; bbox.x0 = bbox.x1; bbox.x1 = t; }
    if (bbox.y0 > bbox.y1) { float t = bbox.y0; bbox.y0 = bbox.y1; bbox.y1 = t; }

    /* アクティブなクリップ矩形と交差させる。クリップの外側は実際には
     * 描画されない (見えない) ので、その部分をカバーとして扱ってしまうと
     * クリップの外にあるテキストまで誤って埋没扱いしてしまう。
     * (画像の bbox は元々巨大でも、クリップで小さな帯状にしか見えていない
     * ケースが実際にある。ベース画像とSMaskのunit square対応付けに使う
     * cr->ctm は元の ctm のまま保持する = クリップ後の bbox とは独立) */
    fz_rect clipped_bbox = kozou_buried_clip_intersect(dev, bbox);
    if (kozou_buried_rect_is_empty(clipped_bbox)) return;

    KozouCoverRect *cr = &dev->list->covers[dev->list->cover_count++];
    cr->event_index = dev->list->event_counter++;
    cr->xobj_xref   = dev->xobj_stack[dev->xobj_depth].xref;
    cr->x0 = clipped_bbox.x0; cr->y0 = clipped_bbox.y0;
    cr->x1 = clipped_bbox.x1; cr->y1 = clipped_bbox.y1;

    /* SMask/Mask (PDFの /SMask, /Mask) を持つ画像だけ参照を保持する。
     * マスク無し画像は矩形全体が一様に不透明とみなしてよく、ピクセル
     * サンプリングの負荷をかける必要が無いため is_image=0 のままにする。 */
    if (image && image->mask) {
        cr->is_image = 1;
        cr->image    = fz_keep_image(ctx, image);
        cr->ctm      = ctm; /* unit square→デバイスの対応付けは元のctmを使う */
    }
}

static void kozou_buried_fill_text(
    fz_context *ctx, fz_device *dev_,
    const fz_text *text, fz_matrix ctm,
    fz_colorspace *cs, const float *color,
    float alpha, fz_color_params cp)
{
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (!dev->list) return;
    float ph = dev->list->page_h;

    for (fz_text_span *span = text->head; span; span = span->next) {
        for (int i = 0; i < span->len; i++) {
            if (dev->list->text_count >= KOZOU_MAX_TEXTS) return;
            fz_text_item *item = &span->items[i];

            /* item->x, item->y は PDF 座標 (Y 上向き、変換前) */
            /* CTM を適用してデバイス座標に変換 */
            fz_point pt = fz_transform_point(fz_make_point(item->x, item->y), ctm);
            /* デバイス座標は Y 下向き: y_dev = page_h - y_pdf_transformed
             * ただし ctm に Y 反転が含まれている場合はそのまま使う。
             * MuPDF の draw_device は page_h を反映した CTM を受け取るので
             * fz_transform_point の結果がすでに Y 下向きデバイス座標になっている */
            float ox = pt.x;
            float oy = pt.y;

            /* グリフのデバイス空間 bbox */
            fz_rect gr = fz_bound_glyph(ctx, span->font, item->gid, ctm);
            /* bound_glyph は CTM 込みのデバイス座標を返す
             * ただしグリフのローカル座標 (0,0) 基準なので item->x,y を加算 */
            fz_rect glyph_bbox;
            glyph_bbox.x0 = gr.x0 + ox;
            glyph_bbox.x1 = gr.x1 + ox;
            glyph_bbox.y0 = gr.y0 + oy;
            glyph_bbox.y1 = gr.y1 + oy;

            /* 正規化 */
            if (glyph_bbox.x0 > glyph_bbox.x1) {
                float t = glyph_bbox.x0; glyph_bbox.x0 = glyph_bbox.x1; glyph_bbox.x1 = t;
            }
            if (glyph_bbox.y0 > glyph_bbox.y1) {
                float t = glyph_bbox.y0; glyph_bbox.y0 = glyph_bbox.y1; glyph_bbox.y1 = t;
            }

            KozouTextEvt *te = &dev->list->texts[dev->list->text_count++];
            te->event_index = dev->list->event_counter++;
            te->ucs = item->ucs;  /* 取り違え防止用の文字識別子 */
            /* XObject 情報を記録 */
            te->xobj_xref = dev->xobj_stack[dev->xobj_depth].xref;
            {
                /* デバイス座標 → XObject 内部座標に逆変換 */
                /* internal_origin: item->x, item->y = テキストスペース座標
                 * (Tm の tx/ty を含む完全な平行移動成分)
                 * kozou_rewrite_stream_for_xobj の tm[4]/tm[5] と同じ座標系 */
                te->ix = item->x;
                te->iy = item->y;
            }
            te->ox = ox;
            te->oy = oy;
            te->x0 = glyph_bbox.x0; te->y0 = glyph_bbox.y0;
            te->x1 = glyph_bbox.x1; te->y1 = glyph_bbox.y1;

            /* 描画時点のクリップ矩形をスナップショットしておく
             * (クリップで実質的に見えなくされているテキストを、後段の
             * kozou_char_is_clipped_out で検出するため)。 */
            if (dev->clip_depth > 0) {
                te->has_clip = 1;
                te->clip = dev->clip_stack[dev->clip_depth - 1];
            } else {
                te->has_clip = 0;
            }
        }
    }
}

/* XObject 入場: スタックに push */
static void kozou_buried_begin_group(
    fz_context *ctx, fz_device *dev_,
    fz_rect bbox, fz_colorspace *cs, int isolated, int knockout,
    int blendmode, float alpha)
{
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (dev->xobj_depth + 1 >= KOZOU_XOBJ_MAX_DEPTH) return;
    /* 深さを増やすが xref は変わらない（通常の透明グループ）*/
    dev->xobj_depth++;
    dev->xobj_stack[dev->xobj_depth] = dev->xobj_stack[dev->xobj_depth - 1];
}

/* XObject 退場: スタックから pop */
static void kozou_buried_end_group(
    fz_context *ctx, fz_device *dev_)
{
    KozouBuriedDevice *dev = (KozouBuriedDevice *)dev_;
    if (dev->xobj_depth > 0) dev->xobj_depth--;
}

/* Form XObject 入場: xref を記録してスタックに push */
static void kozou_buried_begin_tile(
    fz_context *ctx, fz_device *dev_,
    fz_rect area, fz_rect view, float xstep, float ystep,
    fz_matrix ctm, int id)
{
    /* タイルパターンは xref 追跡対象外 */
    (void)ctx; (void)dev_; (void)area; (void)view;
    (void)xstep; (void)ystep; (void)ctm; (void)id;
}

static fz_device *kozou_new_buried_device(fz_context *ctx, KozouBuriedList *list)
{
    KozouBuriedDevice *dev = fz_new_derived_device(ctx, KozouBuriedDevice);
    dev->base.fill_path    = kozou_buried_fill_path;
    dev->base.fill_image   = kozou_buried_fill_image;
    dev->base.fill_text    = kozou_buried_fill_text;
    dev->base.begin_group  = kozou_buried_begin_group;
    dev->base.end_group    = kozou_buried_end_group;
    /* クリップ矩形の追跡: fill_path/fill_image が実際に見える範囲だけを
     * カバーとして登録するために必要 (詳細は各コールバックのコメント参照)。
     * clip_text/clip_stroke_text はあえて未設定 (下記コメント参照)。 */
    dev->base.clip_path         = kozou_buried_clip_path;
    dev->base.clip_stroke_path  = kozou_buried_clip_stroke_path;
    dev->base.clip_image_mask   = kozou_buried_clip_image_mask;
    dev->base.pop_clip          = kozou_buried_pop_clip;
    /* clip_text (Tr=7) はシグネチャがバージョンにより異なるため省略。
     * Tr=7 の文字は fill_text コールバックでも記録されるため問題なし。 */
    dev->list      = list;
    dev->xobj_depth = 0;
    dev->xobj_stack[0].xref    = 0; /* トップレベル */
    dev->xobj_stack[0].ctm     = fz_identity;
    dev->xobj_stack[0].inv_ctm = fz_identity;
    dev->clip_depth      = 0;
    dev->clip_over_depth = 0;
    return (fz_device *)dev;
}

/* ──────────────────────────────────────────────────────────────────
 * SMask/Mask 付き画像カバーについて、グリフと重なる領域だけを
 * ピクセル単位でサンプリングし、平均アルファがしきい値以上かを判定する
 * (buried 誤検出防止・画像版)。
 *
 * kozou_path_fill_ratio が「bboxは広いが実際の塗りは細い罫線/枠」を
 * 除外するのと同じ狙いで、こちらは「bboxは広いが SMask によって
 * ほとんど透明な装飾画像」を除外する。
 *
 * デコードや変換に失敗した場合は安全側 (=覆っているとみなす、戻り値1)
 * に倒す。判定できないケースで可視テキストを誤って隠しテキスト扱い
 * から除外してしまう方が、誤検出のまま残るより実害が小さいため。
 * ───────────────────────────────────────────────────────────────── */
static int kozou_cover_alpha_ok(
    fz_context            *ctx,
    const KozouCoverRect  *cr,
    const fz_rect         *stext_bbox,
    float                  alpha_threshold)
{
    if (!cr->is_image || !cr->image || !cr->image->mask) return 1; /* 通常カバー: 従来通り */

    /* SMask/Mask (PDFの /SMask, /Mask) は、それ自体が独立した fz_image
     * (image->mask) として保持される。ベース画像 (cr->image) を
     * fz_get_pixmap_from_image でデコードしても、必ずしもマスクが
     * 自動合成されたアルファ付きピクスマップが返るとは限らないため
     * (実装依存)、マスク画像そのものを直接デコードしてグレー値=不透明度
     * をサンプリングする方が確実。マスク画像は常にベース画像と同じ
     * unit square [0,1]x[0,1] 上にマッピングされる(解像度は別で良い)ため、
     * unit square 座標の計算はベース画像と共通でよい。 */
    fz_image *mask = cr->image->mask;

    int ok = 1; /* デコード失敗時のフォールバック = 覆っているとみなす */

    fz_try(ctx) {
        fz_matrix inv = fz_invert_matrix(cr->ctm);

        /* stext_bbox (デバイス座標) の4隅を画像の unit square 座標系
         * (0..1 x 0..1) に逆変換する。CTM が回転/せん断を含む場合に
         * 備えて4隅すべてを変換してから軸並行な外接矩形を取る。 */
        fz_point p0 = fz_transform_point(fz_make_point(stext_bbox->x0, stext_bbox->y0), inv);
        fz_point p1 = fz_transform_point(fz_make_point(stext_bbox->x1, stext_bbox->y0), inv);
        fz_point p2 = fz_transform_point(fz_make_point(stext_bbox->x0, stext_bbox->y1), inv);
        fz_point p3 = fz_transform_point(fz_make_point(stext_bbox->x1, stext_bbox->y1), inv);

        float ux0 = fz_min(fz_min(p0.x, p1.x), fz_min(p2.x, p3.x));
        float ux1 = fz_max(fz_max(p0.x, p1.x), fz_max(p2.x, p3.x));
        float uy0 = fz_min(fz_min(p0.y, p1.y), fz_min(p2.y, p3.y));
        float uy1 = fz_max(fz_max(p0.y, p1.y), fz_max(p2.y, p3.y));

        /* unit square にクランプ (グリフがカバーのbboxからはみ出ている
         * 部分は判定対象外。呼び出し元で bbox 重なりを確認済みなので
         * 通常はクランプ後も非退化のはず) */
        ux0 = fz_clamp(ux0, 0.0f, 1.0f); ux1 = fz_clamp(ux1, 0.0f, 1.0f);
        uy0 = fz_clamp(uy0, 0.0f, 1.0f); uy1 = fz_clamp(uy1, 0.0f, 1.0f);

        if (ux1 <= ux0 || uy1 <= uy0) {
            ok = 1; /* 変換不能・退化 → 安全側 */
        } else if (mask->w <= 0 || mask->h <= 0) {
            ok = 1;
        } else {
            fz_irect subarea;
            subarea.x0 = (int)floorf(ux0 * (float)mask->w);
            subarea.y0 = (int)floorf(uy0 * (float)mask->h);
            subarea.x1 = (int)ceilf (ux1 * (float)mask->w);
            subarea.y1 = (int)ceilf (uy1 * (float)mask->h);
            if (subarea.x1 <= subarea.x0) subarea.x1 = subarea.x0 + 1;
            if (subarea.y1 <= subarea.y0) subarea.y1 = subarea.y0 + 1;
            if (subarea.x1 > mask->w) subarea.x1 = mask->w;
            if (subarea.y1 > mask->h) subarea.y1 = mask->h;

            /* ネイティブ解像度でデコードさせるため、unit square → 実ピクセル
             * サイズへのスケール行列を渡す (低解像度への間引きを避ける)。 */
            fz_matrix decode_ctm = fz_scale((float)mask->w, (float)mask->h);
            int dw = 0, dh = 0;
            fz_pixmap *pm = fz_get_pixmap_from_image(
                ctx, mask, &subarea, &decode_ctm, &dw, &dh);

            if (pm) {
                fz_try(ctx) {
                    if (pm->n > 0 && pm->w > 0 && pm->h > 0) {
                        long sum = 0;
                        long count = 0;
                        int n = pm->n;
                        unsigned char *base = pm->samples;
                        /* SMask/Mask はDeviceGray(1成分)が基本で、画素値
                         * そのものが不透明度(0=透明,255=不透明)を表す。
                         * 先頭成分を用いる(pm->alphaのようなアルファ合成
                         * 済みの値に依存しない)。 */
                        for (int y = 0; y < pm->h; y++) {
                            unsigned char *row = base + (size_t)y * pm->stride;
                            for (int x = 0; x < pm->w; x++) {
                                sum += row[x * n];
                                count++;
                            }
                        }
                        if (count > 0) {
                            float avg_alpha = (float)sum / (float)count / 255.0f;
                            ok = (avg_alpha >= alpha_threshold);
                        }
                    }
                }
                fz_always(ctx) { fz_drop_pixmap(ctx, pm); }
                fz_catch(ctx) { ok = 1; }
            }
        }
    }
    fz_catch(ctx) {
        ok = 1; /* サンプリング中の例外は安全側 (=覆っているとみなす) */
    }

    return ok;
}

/* ---- 埋没判定 ---- */
static int kozou_char_is_buried(
    fz_context             *ctx,
    const KozouBuriedList *list,
    const KozouTextEvt    *te,
    const fz_rect         *stext_bbox,  /* stextのより正確なbbox */
    float                  cover_ratio,
    float                  image_alpha_threshold)
{
    float tw = stext_bbox->x1 - stext_bbox->x0;
    float th = stext_bbox->y1 - stext_bbox->y0;
    if (tw <= 0.5f || th <= 0.5f) return 0;
    float text_area = tw * th;

    for (int i = 0; i < list->cover_count; i++) {
        const KozouCoverRect *cr = &list->covers[i];
        if (cr->event_index <= te->event_index) continue;

        float ix0 = stext_bbox->x0 > cr->x0 ? stext_bbox->x0 : cr->x0;
        float iy0 = stext_bbox->y0 > cr->y0 ? stext_bbox->y0 : cr->y0;
        float ix1 = stext_bbox->x1 < cr->x1 ? stext_bbox->x1 : cr->x1;
        float iy1 = stext_bbox->y1 < cr->y1 ? stext_bbox->y1 : cr->y1;

        if (ix1 <= ix0 || iy1 <= iy0) continue;
        float overlap = (ix1 - ix0) * (iy1 - iy0);
        if (overlap / text_area < cover_ratio) continue;

        /* bbox上は覆われているが、SMask付き画像の場合は実ピクセルを
         * サンプリングして実質的に不透明かどうかを再確認する。 */
        if (!kozou_cover_alpha_ok(ctx, cr, stext_bbox, image_alpha_threshold))
            continue;

        return 1;
    }
    return 0;
}

/* ---- クリップによる隠蔽の判定 ----
 * 覆うオブジェクトが無くても、テキスト自身が描画時点のクリップ矩形の
 * 大部分の外側にあれば実質的に不可視。buried (覆い) とは別の隠蔽経路
 * なので、呼び出し側で理由 ("clipped") を区別できるよう関数を分ける。 */
static int kozou_char_is_clipped_out(
    const KozouTextEvt *te,
    const fz_rect      *stext_bbox,
    float                cover_ratio)
{
    if (!te->has_clip) return 0;

    float tw = stext_bbox->x1 - stext_bbox->x0;
    float th = stext_bbox->y1 - stext_bbox->y0;
    if (tw <= 0.5f || th <= 0.5f) return 0;
    float text_area = tw * th;

    float ix0 = stext_bbox->x0 > te->clip.x0 ? stext_bbox->x0 : te->clip.x0;
    float iy0 = stext_bbox->y0 > te->clip.y0 ? stext_bbox->y0 : te->clip.y0;
    float ix1 = stext_bbox->x1 < te->clip.x1 ? stext_bbox->x1 : te->clip.x1;
    float iy1 = stext_bbox->y1 < te->clip.y1 ? stext_bbox->y1 : te->clip.y1;

    float visible_area = 0.0f;
    if (ix1 > ix0 && iy1 > iy0)
        visible_area = (ix1 - ix0) * (iy1 - iy0);

    float hidden_ratio = 1.0f - (visible_area / text_area);
    return hidden_ratio >= cover_ratio;
}

/* ---- 公開関数 ---- */
/* ════════════════════════════════════════════════════════════════════
 * CropBox 外 XObject 収集
 *
 * ページ上の全 Form/Image XObject の名前・xref・BBox・配置 CTM を収集して
 * JSON で返す。Rust 側で CropBox と交差判定を行い、不要な Do 命令を lopdf で削除する。
 *
 * 出力 JSON:
 * {
 *   "ok": true,
 *   "page_h": <float>,          // ページ高さ pt (MuPDF Y下向き座標系)
 *   "cropbox": [x0,y0,x1,y1],  // CropBox (MuPDF デバイス座標)
 *   "xobjs": [
 *     {
 *       "name": "X0",
 *       "xref": 10,
 *       "bbox": [x0,y0,x1,y1]  // XObject BBox をページ CTM で変換した結果
 *                               // (MuPDF デバイス座標, Y下向き)
 *     }, ...
 *   ]
 * }
 *
 * BBox の取得方法:
 *   Form XObject の /BBox を /Matrix と CTM で変換してページ座標に変換する。
 *   Image XObject は配置 CTM から bbox を推定する。
 * ════════════════════════════════════════════════════════════════════ */

/* XObject のページ座標上 bbox を計算するヘルパー */
static fz_rect kozou_xobj_page_bbox(
    fz_context *ctx,
    pdf_document *pdf,
    pdf_obj *xobj,          /* 解決済み XObject オブジェクト */
    fz_matrix page_ctm)     /* ページ → デバイス座標の CTM */
{
    /* XObject の /Matrix を取得 (なければ identity) */
    pdf_obj *mat_arr = pdf_dict_get(ctx, xobj, PDF_NAME(Matrix));
    fz_matrix xobj_matrix = fz_identity;
    if (mat_arr && pdf_array_len(ctx, mat_arr) >= 6) {
        xobj_matrix.a = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 0));
        xobj_matrix.b = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 1));
        xobj_matrix.c = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 2));
        xobj_matrix.d = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 3));
        xobj_matrix.e = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 4));
        xobj_matrix.f = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 5));
    }

    /* /BBox を取得 */
    pdf_obj *bbox_arr = pdf_dict_get(ctx, xobj, PDF_NAME(BBox));
    if (!bbox_arr || pdf_array_len(ctx, bbox_arr) < 4)
        return fz_infinite_rect;

    fz_rect bbox;
    bbox.x0 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 0));
    bbox.y0 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 1));
    bbox.x1 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 2));
    bbox.y1 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 3));

    /* BBox を Matrix → page_ctm で変換 */
    fz_matrix combined = fz_concat(xobj_matrix, page_ctm);
    return fz_transform_rect(bbox, combined);
}

/* ════════════════════════════════════════════════════════════════════
 * XObject bbox 再帰収集（crop_cleanup Phase 1 用）
 *
 * ページ上に配置された全 Form XObject（ネスト含む）の
 * ページ座標系（MuPDF デバイス座標, Y下向き）での bbox を JSON で返す。
 *
 * 出力 JSON:
 * {
 *   "ok": true,
 *   "page_h": <float>,
 *   "cropbox": [x0, y0, x1, y1],   // MuPDF デバイス座標
 *   "entries": [
 *     {
 *       "container_xref": <int>,   // この Do 命令を含む XObject の xref
 *                                  //  (0 = ページのコンテンツストリーム)
 *       "xobj_name": "<string>",   // /Name の名前部分
 *       "xobj_xref": <int>,        // 参照先 XObject の xref
 *       "bbox": [x0, y0, x1, y1]  // ページ座標系での bbox
 *     }, ...
 *   ]
 * }
 * ════════════════════════════════════════════════════════════════════ */

/* 再帰収集の内部状態 */
typedef struct {
    fz_context   *ctx;
    pdf_document *pdf;
    fz_output    *out;
    int           first;      /* JSON カンマ制御 */
    float         page_h;
} KozouXObjCollectCtx;

/* 1つの XObject 辞書を走査して全 Form XObject の bbox を出力する（再帰） */
static void kozou_collect_xobj_recursive(
    KozouXObjCollectCtx *cx,
    pdf_obj             *res_dict,    /* 現在のリソース辞書 */
    fz_matrix            ctm,         /* 現在の変換行列（XObject内部→デバイス座標） */
    int                  container_xref, /* この Do を含む XObject の xref */
    int                  depth)
{
    if (depth > 8) return; /* 無限再帰防止 */
    fz_context *ctx = cx->ctx;

    pdf_obj *xobj_dict = pdf_dict_get(ctx, res_dict, PDF_NAME(XObject));
    if (!xobj_dict) return;

    int n = pdf_dict_len(ctx, xobj_dict);
    for (int i = 0; i < n; i++) {
        pdf_obj *key = pdf_dict_get_key(ctx, xobj_dict, i);
        pdf_obj *val = pdf_dict_get_val(ctx, xobj_dict, i);

        int xref = pdf_is_indirect(ctx, val) ? pdf_to_num(ctx, val) : 0;
        if (xref == 0) continue;

        pdf_obj *xobj = pdf_resolve_indirect(ctx, val);
        if (!xobj) continue;

        pdf_obj *subtype = pdf_dict_get(ctx, xobj, PDF_NAME(Subtype));
        if (!pdf_name_eq(ctx, subtype, PDF_NAME(Form))) continue;

        const char *name = pdf_to_name(ctx, key);
        if (!name || !*name) continue;

        /* /BBox を取得 */
        pdf_obj *bbox_arr = pdf_dict_get(ctx, xobj, PDF_NAME(BBox));
        if (!bbox_arr || pdf_array_len(ctx, bbox_arr) < 4) continue;

        fz_rect bbox;
        bbox.x0 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 0));
        bbox.y0 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 1));
        bbox.x1 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 2));
        bbox.y1 = pdf_to_real(ctx, pdf_array_get(ctx, bbox_arr, 3));

        /* /Matrix を取得（なければ identity）*/
        pdf_obj *mat_arr = pdf_dict_get(ctx, xobj, PDF_NAME(Matrix));
        fz_matrix xobj_matrix = fz_identity;
        if (mat_arr && pdf_array_len(ctx, mat_arr) >= 6) {
            xobj_matrix.a = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 0));
            xobj_matrix.b = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 1));
            xobj_matrix.c = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 2));
            xobj_matrix.d = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 3));
            xobj_matrix.e = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 4));
            xobj_matrix.f = pdf_to_real(ctx, pdf_array_get(ctx, mat_arr, 5));
        }

        /* BBox を ctm × matrix でページ座標に変換 */
        fz_matrix combined = fz_concat(xobj_matrix, ctm);
        fz_rect pg_bbox = fz_transform_rect(bbox, combined);

        /* 出力 */
        if (!cx->first) fz_write_printf(ctx, cx->out, ",");
        cx->first = 0;

        fz_write_printf(ctx, cx->out,
            "{\"container_xref\":%d,"
            "\"xobj_name\":\"%s\","
            "\"xobj_xref\":%d,"
            "\"bbox\":[%.3f,%.3f,%.3f,%.3f]}",
            container_xref,
            name,
            xref,
            pg_bbox.x0, pg_bbox.y0,
            pg_bbox.x1, pg_bbox.y1);

        /* 子 XObject のリソースを再帰処理 */
        pdf_obj *child_res = pdf_dict_get(ctx, xobj, PDF_NAME(Resources));
        if (child_res) {
            kozou_collect_xobj_recursive(
                cx, child_res, combined, xref, depth + 1);
        }
    }
}

void kozou_collect_xobj_bboxes(
    fz_context   *ctx,
    const char   *path,
    int           page_index,
    float         layout_w,
    float         layout_h,
    float         layout_em,
    fz_output    *out,
    FfiResult    *result)
{
    pdf_document *pdf  = NULL;
    fz_page      *page = NULL;
    fz_var(pdf);
    fz_var(page);

    fz_try(ctx) {
        pdf = (pdf_document *)fz_open_document(ctx, path);
        if (!pdf)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "not a PDF");

        if (fz_is_document_reflowable(ctx, (fz_document *)pdf)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, (fz_document *)pdf, w, h, em);
        }

        int total = pdf_count_pages(ctx, pdf);
        if (page_index < 0 || page_index >= total)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "page out of range");

        page = fz_load_page(ctx, (fz_document *)pdf, page_index);
        pdf_page *ppage = (pdf_page *)page;

        fz_rect page_mediabox = pdf_bound_page(ctx, ppage, FZ_MEDIA_BOX);
        fz_rect page_cropbox  = pdf_bound_page(ctx, ppage, FZ_CROP_BOX);
        float page_h = page_mediabox.y1 - page_mediabox.y0;

        /* ページ → デバイス座標の CTM */
        fz_matrix page_ctm = fz_identity;
        pdf_page_transform(ctx, ppage, &page_mediabox, &page_ctm);

        /* ページのリソース */
        pdf_obj *resources = pdf_page_resources(ctx, ppage);

        KozouXObjCollectCtx cx = {
            .ctx    = ctx,
            .pdf    = pdf,
            .out    = out,
            .first  = 1,
            .page_h = page_h,
        };

        fz_write_printf(ctx, out,
            "{\"ok\":true,\"page_h\":%.3f,"
            "\"cropbox\":[%.3f,%.3f,%.3f,%.3f],"
            "\"entries\":[",
            page_h,
            page_cropbox.x0, page_cropbox.y0,
            page_cropbox.x1, page_cropbox.y1);

        /* ページリソースから再帰収集（container_xref=0 はページレベル）*/
        if (resources)
            kozou_collect_xobj_recursive(&cx, resources, page_ctm, 0, 0);

        fz_write_printf(ctx, out, "]}");
        set_ok(result);
    }
    fz_always(ctx) {
        if (page) fz_drop_page(ctx, page);
        if (pdf)  fz_drop_document(ctx, (fz_document *)pdf);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}


void kozou_detect_buried_text(
    fz_context  *ctx,
    const char  *path,
    int          page_index,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    float        cover_ratio,
    float        image_alpha_threshold,
    fz_output   *out,
    FfiResult   *result)
{
    fz_document    *doc      = NULL;
    fz_page        *page     = NULL;
    fz_stext_page  *stext    = NULL;
    fz_device      *orderdev = NULL;
    KozouBuriedList *list    = NULL;
    KozouXObjDevice *xobj_dev = NULL;

    fz_var(doc); fz_var(page); fz_var(stext);
    fz_var(orderdev); fz_var(list); fz_var(xobj_dev);

    fz_try(ctx) {
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page = fz_load_page(ctx, doc, page_index);
        fz_rect page_bounds = fz_bound_page(ctx, page);
        float page_h = page_bounds.y1 - page_bounds.y0;

        list = (KozouBuriedList *)fz_malloc(ctx, sizeof(KozouBuriedList));
        memset(list, 0, sizeof(KozouBuriedList));
        list->page_h = page_h;

        /* Pass 1: 描画順を記録
         * CropBox外にはみ出した装飾 (デザインツール書き出しでよくある
         * 塗り足し/オーバーフロー) を、覆いとして誤登録しないよう、
         * ページの実際の可視領域 (CropBox) を初期クリップとして積んでおく。
         * これが無いと、Form XObject 自身のBBoxクリップは追えても、
         * 「ページそのものの外側にはみ出した部分」は素通りしてしまう
         * (今回の X48 のケースと全く同じ構造の問題がページレベルでも
         * 起こり得る)。 */
        orderdev = kozou_new_buried_device(ctx, list);
        kozou_buried_push_clip((KozouBuriedDevice *)orderdev, page_bounds);
        fz_run_page(ctx, page, orderdev, fz_identity, NULL);
        fz_close_device(ctx, orderdev);
        fz_drop_device(ctx, orderdev);
        orderdev = NULL;

        /* Pass 1b: XObject 追跡スキャン（内部座標取得用）*/
        /* item->x/y は既にデバイス座標なので fz_identity で実行 */
        xobj_dev = kozou_new_xobj_device(ctx);
        fz_run_page(ctx, page, (fz_device *)xobj_dev, fz_identity, NULL);
        /* xobj_dev は Pass 2 で使用するため Drop しない */

        /* Pass 2: stext で文字を取得し照合 */
        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        stext = fz_new_stext_page_from_page(ctx, page, &opts);

        if (cover_ratio <= 0.0f || cover_ratio > 1.0f) cover_ratio = 0.8f;
        /* SMask付き画像カバーの平均アルファがこの値未満なら「実質透明」と
         * みなし覆いから除外する。デフォルト0.5 = カバー領域の半分以上が
         * 不透明でなければ隠蔽と判定しない。 */
        if (image_alpha_threshold <= 0.0f || image_alpha_threshold > 1.0f)
            image_alpha_threshold = 0.5f;

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

                    fz_point o = ch->origin;

                    /* 最近傍の fill_text イベントを探す。
                     * 取り違え防止: 同一座標に複数グリフが重なる場合があるため、
                     * まず同じ Unicode のイベントの中から最近傍を選び、無ければ
                     * 座標最近傍にフォールバックする。 */
                    KozouTextEvt *matched = NULL;
                    float best = 4.0f * 4.0f; /* 4pt 以内 (座標最近傍フォールバック) */
                    KozouTextEvt *matched_ucs = NULL;
                    float best_ucs = 4.0f * 4.0f; /* 同 ucs の最近傍 */
                    for (int k = 0; k < list->text_count; k++) {
                        KozouTextEvt *te = &list->texts[k];
                        float dx = te->ox - o.x;
                        float dy = te->oy - o.y;
                        float d2 = dx*dx + dy*dy;
                        if (d2 < best) { best = d2; matched = te; }
                        if (te->ucs == ch->c && d2 < best_ucs) {
                            best_ucs = d2; matched_ucs = te;
                        }
                    }
                    if (matched_ucs) matched = matched_ucs;
                    if (!matched) continue;

                    /* stext の quad から正確な bbox を計算 */
                    fz_quad q = ch->quad;
                    fz_rect stext_bbox;
                    stext_bbox.x0 = q.ul.x < q.ll.x ? q.ul.x : q.ll.x;
                    stext_bbox.y0 = q.ul.y < q.ur.y ? q.ul.y : q.ur.y;
                    stext_bbox.x1 = q.ur.x > q.lr.x ? q.ur.x : q.lr.x;
                    stext_bbox.y1 = q.ll.y > q.lr.y ? q.ll.y : q.lr.y;

                    int buried_is_clipped = 0;
                    if (!kozou_char_is_buried(ctx, list, matched, &stext_bbox,
                            cover_ratio, image_alpha_threshold)) {
                        if (!kozou_char_is_clipped_out(matched, &stext_bbox, cover_ratio))
                            continue;
                        buried_is_clipped = 1;
                    }

                    int cp = ch->c;
                    /* sanitized は hits から除外 */
                    if (kozou_is_sanitized_space(cp) &&
                        kozou_is_helvetica_font(ctx, ch->font)) continue;

                    const char *buried_reason =
                        kozou_is_whitespace_codepoint(cp) ? "whitespace_only"
                        : buried_is_clipped ? "clipped"
                        : "buried";

                    /* JSON エスケープ */
                    char escaped[32] = {0};
                    if      (cp == '"')  { escaped[0]='\\'; escaped[1]='"';  }
                    else if (cp == '\\') { escaped[0]='\\'; escaped[1]='\\'; }
                    else if (cp == '\n') { escaped[0]='\\'; escaped[1]='n';  }
                    else if (cp < 0x20 || cp > 0x7E) {
                        snprintf(escaped, sizeof(escaped), "\\u%04X", cp);
                    } else { escaped[0] = (char)cp; }

                    unsigned int packed = (unsigned int)ch->argb;
                    int r = (packed>>16)&0xFF, g = (packed>>8)&0xFF, b = packed&0xFF;

                    if (hit_count > 0) fz_write_printf(ctx, out, ",");
                    const char *buried_font_name = fz_font_name(ctx, ch->font);
                    int buried_is_type3 = (buried_font_name &&
                        (strncmp(buried_font_name, "Type3", 5) == 0 ||
                         strncmp(buried_font_name, "type3", 5) == 0));
                    /* XObject 情報を取得（xobj_dev スキャン結果から）*/
                    const KozouCharXObj *xobj_info = xobj_dev
                        ? kozou_xobj_lookup(xobj_dev, o.x, o.y, 5.0f, ch->c, ch->size)
                        : NULL;
                    int b_xref = xobj_info ? xobj_info->xobj_xref : 0;
                    float b_ix = xobj_info ? xobj_info->ix : o.x;
                    float b_iy = xobj_info ? xobj_info->iy : o.y;
                    fz_write_printf(ctx, out,
                        "{\"char\":\"%s\","
                        "\"color_rgb\":[%d,%d,%d],"
                        "\"size\":%.3f,"
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"xobj_xref\":%d,"
                        "\"internal_origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"is_type3\":%s}",
                        escaped, r, g, b, ch->size, buried_reason, o.x, o.y,
                        b_xref, b_ix, b_iy,
                        q.ul.x,q.ul.y,q.ur.x,q.ur.y,q.ll.x,q.ll.y,q.lr.x,q.lr.y,
                        buried_is_type3 ? "true" : "false");
                    hit_count++;
                }
            }
        }

        fz_write_printf(ctx, out, "]}");
        set_ok(result);
    }
    fz_always(ctx) {
        if (list) {
            /* kozou_buried_fill_image で fz_keep_image した参照を解放する */
            for (int _ci = 0; _ci < list->cover_count; _ci++) {
                if (list->covers[_ci].image)
                    fz_drop_image(ctx, list->covers[_ci].image);
            }
            fz_free(ctx, list);
        }
        if (stext)    fz_drop_stext_page(ctx, stext);
        if (orderdev) { fz_close_device(ctx, orderdev);
                        fz_drop_device(ctx, orderdev); }
        if (page)     fz_drop_page(ctx, page);
        if (doc)      fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) { set_err(result, fz_caught_message(ctx)); }
}

/* ================================================================== */

/* ================================================================== */
/* ⑤ オブジェクト裏に隠されたテキストの検出                            */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* 内部: 描画イベントリスト                                             */
/* テキスト文字と塗りパスの両方を描画順（event_index）付きで記録する。  */


/* ================================================================== */
/* 隠しテキスト置き換え機能 (試験的)                                    */
/*                                                                     */
/* ⚠ 警告: この機能は試験的実装です。                                   */
/*   - 全ての隠しテキスト手法を網羅できる保証はありません               */
/*   - 本機能の使用による損害について開発者は責任を負いません            */
/*                                                                     */
/* 方針:                                                               */
/*   隠しテキスト → U+0020 (半角スペース) に置き換え                    */
/*   フォントを Helvetica (内蔵 Type1) に統一                           */
/*   Tr=0 (通常描画) に設定                                             */
/*   元のグリフ幅との差分を TJ カーニングで補正                          */
/*                                                                     */
/*   Helvetica U+0020 の幅 = 278/1000em (PDF仕様上の固定値)            */
/*   これにより他アプリの隠しテキスト検出でフラグが立たなくなる          */
/* ================================================================== */

/* Helvetica U+0020 の標準幅 (1/1000em) */
#define KOZOU_HELVETICA_SPACE_WIDTH 278.0f

/* 置き換え対象の座標集合 */
/* ------------------------------------------------------------------ */
/* quad幅マップ: fz_stext_char の origin → 実描画幅 (1/1000em)        */
/* RTL・縦書き・合字すべてに対応できる唯一確実な幅取得方式             */
/* ------------------------------------------------------------------ */
#define KOZOU_QUAD_MAP_MAX 131072

typedef struct {
    float ox, oy;       /* origin (デバイス座標 Y下向き) */
    float width_1000;   /* 実描画幅 1/1000em (常に正値)  */
    float size;         /* フォントサイズ pt              */
    int   ucs;          /* Unicode コードポイント (取り違え防止の識別子) */
} KozouQuadEntry;

typedef struct {
    KozouQuadEntry entries[KOZOU_QUAD_MAP_MAX];
    int            count;
} KozouQuadMap;

/* quad から実描画幅を計算する (1/1000em、常に正値) */
static float kozou_quad_width_1000(const fz_quad *q, float size)
{
    if (size <= 0.0f) return 0.0f;
    /* 横方向幅: ul→ur の距離 */
    float dx = q->ur.x - q->ul.x;
    float dy = q->ur.y - q->ul.y;
    float horiz = sqrtf(dx*dx + dy*dy);
    /* 縦方向幅: ul→ll の距離 */
    float vx = q->ll.x - q->ul.x;
    float vy = q->ll.y - q->ul.y;
    float vert = sqrtf(vx*vx + vy*vy);
    /* 大きいほうを文字進行方向の幅とみなす */
    float w = horiz > vert ? horiz : vert;
    return (w / size) * 1000.0f;
}

/* quad マップから origin に最も近いエントリの幅を返す */
static float kozou_quad_map_lookup(
    const KozouQuadMap *qmap,
    float ox, float oy, float tol2)
{
    float best_dist = tol2;
    float best_w    = -1.0f;
    for (int i = 0; i < qmap->count; i++) {
        float dx = qmap->entries[i].ox - ox;
        float dy = qmap->entries[i].oy - oy;
        float d2 = dx*dx + dy*dy;
        if (d2 < best_dist) {
            best_dist = d2;
            best_w    = qmap->entries[i].width_1000;
        }
    }
    return best_w; /* -1.0f = 見つからない */
}

/* quad マップから origin に最も近いエントリの (ucs,size) を返す。
 * 無害化時の「文字そのものの照合」(取り違え防止) に使う。
 * stext が生成した実描画グリフの Unicode とサイズを、書き換え対象 Tj の
 * デバイス座標位置で引くことで、座標が近いだけの別グリフを除外できる。
 * 見つかった場合 1 を返し *out_ucs / *out_size を埋める。無ければ 0。 */
static int kozou_quad_map_lookup_glyph(
    const KozouQuadMap *qmap,
    float ox, float oy, float tol2,
    int *out_ucs, float *out_size)
{
    float best_dist = tol2;
    int   found     = 0;
    int   best_ucs  = -1;
    float best_size = 0.0f;
    for (int i = 0; i < qmap->count; i++) {
        float dx = qmap->entries[i].ox - ox;
        float dy = qmap->entries[i].oy - oy;
        float d2 = dx*dx + dy*dy;
        if (d2 < best_dist) {
            best_dist = d2;
            best_ucs  = qmap->entries[i].ucs;
            best_size = qmap->entries[i].size;
            found     = 1;
        }
    }
    if (found) { if (out_ucs) *out_ucs = best_ucs; if (out_size) *out_size = best_size; }
    return found;
}

/* 検出時に記録した文字 identity (codepoint+size) と、書き換え対象 Tj の位置で
 * stext から得た実描画グリフ (g_ucs,g_size) が一致するか判定する。
 *
 * 安全バイアス (ユーザー指定): 「無関係な文字を絶対に消さない」。
 *   - target.codepoint < 0 (identity 不明) → 後方互換: identity では弾かない
 *   - その位置に stext グリフが見つからない (have_glyph==0) → identity では弾かない
 *     (ターゲット自体 stext 由来なので、マップ未収集=取りこぼしであり別グリフ誤判定ではない)
 *   - identity が分かる場合のみ、codepoint 不一致 → 別グリフとして除外 (消さない)
 *     size も分かる場合は ±25% を超える差を別グリフとみなす
 * 戻り値: 1=identity 一致(または判定不能で従来通り許可), 0=別グリフ(除外) */
static int kozou_identity_ok(
    int target_cp, float target_size,
    int have_glyph, int g_ucs, float g_size)
{
    if (target_cp < 0) return 1;       /* identity 不明: 従来動作 */
    if (!have_glyph)   return 1;        /* 位置にグリフ無し: マップ取りこぼし → 許可 */
    if (g_ucs != target_cp) return 0;   /* 文字が違う → 別グリフ (消さない) */
    if (target_size > 0.0f && g_size > 0.0f) {
        if (g_size < target_size * 0.75f || g_size > target_size * 1.25f)
            return 0;                   /* サイズが大きく違う → 別グリフ */
    }
    return 1;
}

#define KOZOU_SANITIZE_MAX 65536

typedef struct {
    float x, y;          /* ページ座標系 (既存: ページ書き換えに使用) */
    int   xobj_xref;     /* 所属 XObject xref (0=トップレベル, 現状常に0) */
    float ix, iy;        /* XObject 内部座標系 (Tm座標) */
    float ox, oy;        /* デバイス座標 (MuPDF Y下向き, XObject特定に使用) */
    int   in_xobj;       /* 1=XObject内で処理済み、ページ書き換えをスキップ */
    int   is_buried;     /* 1=buried検出 → XObject書き換えが必要 */
    int   page_index;    /* 0-indexed page (-1=全ページ共通) */
    /* 描画モードによる取り違え防止:
     *  1 = 不可視描画 (Tr=3/7) として検出された (invisible_mode/clip_only)
     *  0 = 可視描画 (Tr が塗り/線あり) として検出された (transparent/low_contrast/tiny/buried 等)
     * -1 = 不明 → 座標のみで照合 (後方互換: 従来動作)
     * 同一座標に可視と不可視のグリフが重なる場合に、検出されたモードと
     * 一致する show 演算子だけを無害化し、別グリフを巻き込まないために使う。 */
    int   render_invisible;
    /* 文字 identity (取り違え防止の本命):
     *  codepoint = 検出されたグリフの Unicode (-1=不明→従来動作)
     *  size      = 検出されたグリフのサイズ pt (stext 空間, 0=不明)
     * 書き換え時、対象 Tj の位置で stext から得た実描画グリフと照合し、
     * 座標が近いだけの別グリフ (隣接文字・重なり) を巻き込まない。 */
    int   codepoint;
    float size;
} KozouSanitizeOrigin;

/* show 演算子の現在の描画モード Tr が「不可視(塗り/線なし)」かを返す。
 * Tr=3 (描画なし) と Tr=7 (クリップのみ) が不可視。 */
static int kozou_tr_is_invisible(int tr_mode)
{
    return (tr_mode == 3 || tr_mode == 7) ? 1 : 0;
}

/* ページ座標でのマッチング (xobj_xref==0 の場合)。
 * cur_invisible = この show 演算子の現在 Tr の不可視クラス (0/1)。
 * ターゲットの render_invisible が -1 (不明) なら座標のみで照合する。 */
static int kozou_sanitize_is_target(
    const KozouSanitizeOrigin *t, int n, float x, float y, float tol2,
    int cur_invisible,
    int have_glyph, int g_ucs, float g_size)
{
    for (int i = 0; i < n; i++) {
        if (t[i].in_xobj) continue; /* XObject内で処理するのでスキップ */
        if (t[i].xobj_xref != 0) continue; /* XObject内ターゲットは階層側で処理 (取り違え防止) */
        if (t[i].render_invisible >= 0 &&
            t[i].render_invisible != cur_invisible) continue; /* モード不一致は別グリフ */
        float dx = t[i].x - x, dy = t[i].y - y;
        if (dx*dx + dy*dy > tol2) continue;
        /* 文字 identity の照合 (取り違え防止の本命)。
         * 座標が近いだけの隣接/重なりグリフを巻き込まない。 */
        if (!kozou_identity_ok(t[i].codepoint, t[i].size,
                               have_glyph, g_ucs, g_size)) continue;
        return 1;
    }
    return 0;
}

/* XObject 内部座標 (Tm tx/ty) でのマッチング */
static int kozou_sanitize_is_target_ix(
    const KozouSanitizeOrigin *t, int n, float ix, float iy, float tol2)
{
    for (int i = 0; i < n; i++) {
        float dx = t[i].ix - ix, dy = t[i].iy - iy;
        if (dx*dx + dy*dy <= tol2) return 1;
    }
    return 0;
}

/* XObject 内部座標でのマッチング */
static int kozou_sanitize_is_xobj_target(
    const KozouSanitizeOrigin *t, int n, int xref, float ix, float iy, float tol2)
{
    for (int i = 0; i < n; i++) {
        if (t[i].xobj_xref != xref) continue;
        float dx = t[i].ix - ix, dy = t[i].iy - iy;
        if (dx*dx + dy*dy <= tol2) return 1;
    }
    return 0;
}

/* /Widths 配列から文字コードの幅を取得 (1/1000em) */
/* ------------------------------------------------------------------ */
/* kozou_get_char_width_1000                                           */
/*                                                                     */
/* フォントリソースから文字コードのグリフ幅を取得する (1/1000em 単位)。 */
/*                                                                     */
/* Type1 / TrueType: /FirstChar + /Widths 配列から取得                 */
/* Type0 (CIDFont) : /W 配列から取得 (2種類のフォーマットに対応)        */
/*   形式A: [cid [w0 w1 ...]]  ← cid から連続する文字の個別幅          */
/*   形式B: [c1 c2 w]          ← c1〜c2 の全文字が幅 w                 */
/* ------------------------------------------------------------------ */
static float kozou_get_char_width_1000(
    fz_context *ctx, pdf_document *pdf,
    pdf_obj *font_res, int char_code)
{
    if (!font_res) return 600.0f;
    pdf_obj *font = pdf_resolve_indirect(ctx, font_res);
    if (!font) return 600.0f;

    /* ── Type1 / TrueType: /Widths 配列 ── */
    pdf_obj *widths    = pdf_dict_get(ctx, font, PDF_NAME(Widths));
    pdf_obj *first_obj = pdf_dict_get(ctx, font, PDF_NAME(FirstChar));
    if (widths && first_obj) {
        int fc  = pdf_to_int(ctx, first_obj);
        int idx = char_code - fc;
        int n   = pdf_array_len(ctx, widths);
        if (idx >= 0 && idx < n) {
            float w = pdf_to_real(ctx, pdf_array_get(ctx, widths, idx));
            if (w > 0.0f) return w;
        }
    }

    /* ── Type0 (CIDFont): /DescendantFonts → /W 配列 ── */
    pdf_obj *desc = pdf_dict_get(ctx, font, PDF_NAME(DescendantFonts));
    if (desc && pdf_is_array(ctx, desc) && pdf_array_len(ctx, desc) > 0) {
        pdf_obj *cid_font = pdf_resolve_indirect(ctx,
                                pdf_array_get(ctx, desc, 0));
        if (cid_font) {
            /* /DW: デフォルト幅 */
            float dw = 1000.0f;
            pdf_obj *dw_obj = pdf_dict_get(ctx, cid_font, PDF_NAME(DW));
            if (dw_obj) dw = pdf_to_real(ctx, dw_obj);

            /* /W: [cid1 [w...] | cid1 cid2 w ...] */
            pdf_obj *w_arr = pdf_dict_get(ctx, cid_font, PDF_NAME(W));
            if (w_arr && pdf_is_array(ctx, w_arr)) {
                int wlen = pdf_array_len(ctx, w_arr);
                int i = 0;
                while (i < wlen) {
                    pdf_obj *e0 = pdf_array_get(ctx, w_arr, i);
                    if (i + 1 >= wlen) break;
                    pdf_obj *e1 = pdf_array_get(ctx, w_arr, i + 1);

                    if (pdf_is_array(ctx, e1)) {
                        /* 形式A: cid [w0 w1 w2 ...] */
                        int cid_start = pdf_to_int(ctx, e0);
                        int wn = pdf_array_len(ctx, e1);
                        int offset = char_code - cid_start;
                        if (offset >= 0 && offset < wn) {
                            float w = pdf_to_real(ctx,
                                pdf_array_get(ctx, e1, offset));
                            return w > 0.0f ? w : dw;
                        }
                        i += 2;
                    } else {
                        /* 形式B: cid_from cid_to w */
                        if (i + 2 >= wlen) break;
                        int cid_from = pdf_to_int(ctx, e0);
                        int cid_to   = pdf_to_int(ctx,
                            pdf_array_get(ctx, w_arr, i + 1));
                        float w = pdf_to_real(ctx,
                            pdf_array_get(ctx, w_arr, i + 2));
                        if (char_code >= cid_from && char_code <= cid_to)
                            return w > 0.0f ? w : dw;
                        i += 3;
                    }
                }
            }
            return dw;
        }
    }

    /* /DW フォールバック (Type0以外でWidthsがない場合) */
    pdf_obj *dw = pdf_dict_get(ctx, font, PDF_NAME(DW));
    if (dw) return pdf_to_real(ctx, dw);

    return 600.0f;
}

/* ------------------------------------------------------------------ */
/* kozou_is_multibyte_font                                             */
/*                                                                     */
/* フォントがマルチバイト文字列(2バイト/文字)を使用するか判定する。    */
/* Type0 (CIDFont) かどうかを /Subtype で確認する。                    */
/* ------------------------------------------------------------------ */
static int kozou_is_multibyte_font(fz_context *ctx, pdf_obj *font_res)
{
    if (!font_res) return 0;
    pdf_obj *font = pdf_resolve_indirect(ctx, font_res);
    if (!font) return 0;
    pdf_obj *subtype = pdf_dict_get(ctx, font, PDF_NAME(Subtype));
    if (!subtype) return 0;
    const char *st = pdf_to_name(ctx, subtype);
    /* Type0 = CIDFont (2バイト/文字が一般的) */
    return (st && strcmp(st, "Type0") == 0);
}

/* Helvetica フォントリソースをページに追加して名前を返す */
static pdf_obj *kozou_ensure_helvetica(
    fz_context *ctx, pdf_document *pdf, pdf_obj *page_obj)
{
    pdf_obj *res = pdf_dict_get_inheritable(ctx, page_obj, PDF_NAME(Resources));
    if (!res) {
        res = pdf_new_dict(ctx, pdf, 4);
        pdf_dict_put_drop(ctx, page_obj, PDF_NAME(Resources), res);
    }
    /* Font辞書 */
    pdf_obj *font_dict = pdf_dict_get(ctx, res, PDF_NAME(Font));
    if (!font_dict) {
        font_dict = pdf_new_dict(ctx, pdf, 4);
        pdf_dict_put_drop(ctx, res, PDF_NAME(Font), font_dict);
    }
    /* KOZOU_HV: Helvetica Type1 内蔵フォント */
    if (!pdf_dict_gets(ctx, font_dict, "KOZOU_HV")) {
        pdf_obj *fobj = pdf_new_dict(ctx, pdf, 6);
        pdf_dict_put_name(ctx, fobj, PDF_NAME(Type),     "Font");
        pdf_dict_put_name(ctx, fobj, PDF_NAME(Subtype),  "Type1");
        pdf_dict_put_name(ctx, fobj, PDF_NAME(BaseFont), "Helvetica");
        pdf_dict_put_name(ctx, fobj, PDF_NAME(Encoding), "WinAnsiEncoding");
        pdf_obj *ind = pdf_add_object_drop(ctx, pdf, fobj);
        pdf_dict_put_drop(ctx, font_dict, pdf_new_name(ctx, "KOZOU_HV"), ind);
    }
    /* KOZOU_NORMAL: fill/stroke alpha=1.0 に正規化する ExtGState
     * 置き換え文字の前に適用して ca=0 等の透明状態を解除する            */
    pdf_obj *ext_dict = pdf_dict_get(ctx, res, PDF_NAME(ExtGState));
    if (!ext_dict) {
        ext_dict = pdf_new_dict(ctx, pdf, 4);
        pdf_dict_put_drop(ctx, res, PDF_NAME(ExtGState), ext_dict);
    }
    if (!pdf_dict_gets(ctx, ext_dict, "KOZOU_NORMAL")) {
        pdf_obj *gs = pdf_new_dict(ctx, pdf, 4);
        pdf_dict_put_name(ctx, gs, PDF_NAME(Type), "ExtGState");
        pdf_dict_put_real(ctx, gs, PDF_NAME(ca), 1.0f); /* fill alpha  */
        pdf_dict_put_real(ctx, gs, PDF_NAME(CA), 1.0f); /* stroke alpha */
        pdf_obj *gs_ind = pdf_add_object_drop(ctx, pdf, gs);
        pdf_dict_put_drop(ctx, ext_dict,
            pdf_new_name(ctx, "KOZOU_NORMAL"), gs_ind);
    }
    return pdf_dict_gets(ctx, font_dict, "KOZOU_HV");
}

/* ────────────────────────────────────────────────────────────────────
 * kozou_find_xobj_for_point
 *
 * ページ座標(ox, oy)を含む最小の Form XObject の xref を返す。
 * 再帰的に子 XObject を走査し、(ox,oy) を含む最小bbox の XObject を選ぶ。
 * 見つからなければ 0 を返す（ページトップレベル）。
 * ──────────────────────────────────────────────────────────────────── */
/* ──────────────────────────────────────────────────────────────────
 * kozou_find_xobj_by_tm
 *
 * buried テキストの内部座標 (ix, iy) を使って対象 XObject を特定する。
 * 各 XObject のストリームをスキャンし、Tm 命令の tx/ty が ix/iy に近い
 * ものを持つ XObject の xref を返す。
 * これにより CTM チェーンの計算を完全に回避できる。
 * ──────────────────────────────────────────────────────────────────── */
/* ──────────────────────────────────────────────────────────────────
 * 指定 xref の XObject がページ上に配置される CTM を求める。
 * ページの content streams をスキャンし、q/Q/cm を追跡しながら
 * /Name Do を見つけ、その XObject の xref が目的のものなら
 * その時点の CTM を返す。ネスト XObject にも再帰対応する。
 * 見つかれば 1 を返し out_ctm に格納、見つからなければ 0。
 * ─────────────────────────────────────────────────────────────────── */
static int kozou_xobj_place_ctm_scan(
    fz_context *ctx, pdf_document *pdf,
    const char *src, size_t len,
    pdf_obj *resources,
    int target_xref, fz_matrix base, fz_matrix *out_ctm, int depth)
{
    if (depth > 8) return 0;
    pdf_obj *xdict = resources ?
        pdf_dict_get(ctx, resources, PDF_NAME(XObject)) : NULL;

    fz_matrix ctm_stack[64];
    int sp = 0;
    ctm_stack[0] = base;

    size_t pos = 0;
    while (pos < len) {
        size_t ls = pos;
        while (pos < len && src[pos] != '\n') pos++;
        size_t le = pos;
        if (pos < len) pos++;
        size_t ts = ls;
        while (ts < le && (src[ts]==' '||src[ts]=='\t')) ts++;
        size_t tl = le - ts;
        if (tl < 1) continue;

        if (tl == 1 && src[ts]=='q') {
            if (sp < 63) { ctm_stack[sp+1]=ctm_stack[sp]; sp++; }
        } else if (tl == 1 && src[ts]=='Q') {
            if (sp > 0) sp--;
        } else if (tl >= 2 && src[le-2]=='c' && src[le-1]=='m') {
            char cmline[160] = {0};
            size_t cl = tl < 159 ? tl : 159;
            memcpy(cmline, src+ts, cl);
            float a,b,c,d,e,f;
            if (sscanf(cmline,"%f %f %f %f %f %f cm",&a,&b,&c,&d,&e,&f)==6) {
                fz_matrix m = {a,b,c,d,e,f};
                ctm_stack[sp] = fz_concat(m, ctm_stack[sp]);
            }
        } else if (tl >= 3 && src[le-2]=='D' && src[le-1]=='o' &&
                   src[ts]=='/') {
            /* /Name Do : 名前を抽出 */
            char name[64] = {0};
            int ni = 0;
            size_t p2 = ts + 1;
            while (p2 < le && src[p2] != ' ' && src[p2] != '\t' &&
                   src[p2] != '\r' && ni < 63) {
                name[ni++] = src[p2++];
            }
            if (xdict) {
                pdf_obj *val = pdf_dict_gets(ctx, xdict, name);
                int xr = pdf_is_indirect(ctx, val) ? pdf_to_num(ctx, val) : 0;
                if (xr == target_xref) {
                    /* 対象 XObject 自身の /Matrix を適用してから返す。
                     * /Name Do の描画では CTM' = Matrix × CTM となり、XObject 内部
                     * 座標（cm/Tm が住む空間）→デバイスの写像には対象 XObject の
                     * /Matrix を含める必要がある。再帰側（子 XObject）の xm 適用と対称。
                     * Matrix が無い/identity の場合は従来どおり ctm_stack[sp] と同じ。 */
                    fz_matrix tmx = fz_identity;
                    pdf_obj *tobj = pdf_resolve_indirect(ctx, val);
                    pdf_obj *tmo = tobj ? pdf_dict_get(ctx, tobj, PDF_NAME(Matrix)) : NULL;
                    if (pdf_is_array(ctx, tmo) && pdf_array_len(ctx, tmo) == 6) {
                        tmx.a = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 0));
                        tmx.b = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 1));
                        tmx.c = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 2));
                        tmx.d = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 3));
                        tmx.e = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 4));
                        tmx.f = pdf_to_real(ctx, pdf_array_get(ctx, tmo, 5));
                    }
                    *out_ctm = fz_concat(tmx, ctm_stack[sp]);
                    return 1;
                }
                /* ネスト Form XObject なら再帰探索 */
                if (xr != 0) {
                    pdf_obj *xobj = pdf_resolve_indirect(ctx, val);
                    pdf_obj *st = xobj ? pdf_dict_get(ctx, xobj, PDF_NAME(Subtype)) : NULL;
                    if (st && pdf_name_eq(ctx, st, PDF_NAME(Form))) {
                        fz_buffer *cbuf = NULL;
                        int hit = 0;
                        fz_var(cbuf); fz_var(hit);
                        fz_try(ctx) {
                            pdf_obj *ind = pdf_new_indirect(ctx, pdf, xr, 0);
                            cbuf = pdf_load_stream(ctx, ind);
                            pdf_drop_obj(ctx, ind);
                            /* XObject 自身の Matrix を base に適用 */
                            fz_matrix xm = fz_identity;
                            pdf_obj *mo = pdf_dict_get(ctx, xobj, PDF_NAME(Matrix));
                            if (pdf_is_array(ctx, mo) && pdf_array_len(ctx, mo) == 6) {
                                xm.a = pdf_to_real(ctx, pdf_array_get(ctx, mo, 0));
                                xm.b = pdf_to_real(ctx, pdf_array_get(ctx, mo, 1));
                                xm.c = pdf_to_real(ctx, pdf_array_get(ctx, mo, 2));
                                xm.d = pdf_to_real(ctx, pdf_array_get(ctx, mo, 3));
                                xm.e = pdf_to_real(ctx, pdf_array_get(ctx, mo, 4));
                                xm.f = pdf_to_real(ctx, pdf_array_get(ctx, mo, 5));
                            }
                            fz_matrix child_base = fz_concat(xm, ctm_stack[sp]);
                            pdf_obj *xres = pdf_dict_get(ctx, xobj, PDF_NAME(Resources));
                            if (!xres) xres = resources;
                            unsigned char *cd = NULL;
                            size_t clen = fz_buffer_storage(ctx, cbuf, &cd);
                            if (cd && kozou_xobj_place_ctm_scan(ctx, pdf,
                                    (const char*)cd, clen, xres,
                                    target_xref, child_base, out_ctm, depth+1)) {
                                hit = 1;
                            }
                        } fz_always(ctx) {
                            if (cbuf) fz_drop_buffer(ctx, cbuf);
                        } fz_catch(ctx) { hit = 0; }
                        if (hit) return 1;
                    }
                }
            }
        }
    }
    return 0;
}

/* ページ全体の content streams を結合してスキャンし、
 * target_xref の XObject 配置 CTM を求める。 */
static int kozou_get_xobj_place_ctm(
    fz_context *ctx, pdf_document *pdf, pdf_page *ppage,
    int target_xref, fz_matrix *out_ctm)
{
    if (!ppage) return 0;   /* NULL ページ防御 (NULL デリファレンス回避) */
    pdf_obj *res = pdf_page_resources(ctx, ppage);
    fz_buffer *cbuf = NULL;
    int hit = 0;
    fz_var(cbuf); fz_var(hit);
    fz_try(ctx) {
        pdf_obj *contents = pdf_page_contents(ctx, ppage);
        cbuf = fz_new_buffer(ctx, 1024);
        if (pdf_is_array(ctx, contents)) {
            /* Contents が配列: 各ストリームを連結 */
            int cn = pdf_array_len(ctx, contents);
            for (int ci = 0; ci < cn; ci++) {
                pdf_obj *part = pdf_array_get(ctx, contents, ci);
                fz_buffer *pb = pdf_load_stream(ctx, part);
                if (pb) {
                    unsigned char *pd = NULL;
                    size_t pl = fz_buffer_storage(ctx, pb, &pd);
                    if (pd && pl) {
                        fz_append_data(ctx, cbuf, pd, pl);
                        fz_append_byte(ctx, cbuf, '\n');
                    }
                    fz_drop_buffer(ctx, pb);
                }
            }
        } else if (contents) {
            fz_buffer *pb = pdf_load_stream(ctx, contents);
            if (pb) {
                unsigned char *pd = NULL;
                size_t pl = fz_buffer_storage(ctx, pb, &pd);
                if (pd && pl) fz_append_data(ctx, cbuf, pd, pl);
                fz_drop_buffer(ctx, pb);
            }
        }
        unsigned char *cd = NULL;
        size_t clen = fz_buffer_storage(ctx, cbuf, &cd);
        /* ページの PDF native 座標 → MuPDF デバイス座標 (top-left, Y下向き)
         * への変換を base にする。検出側 (kozou_xobj_fill_text) の page_x/y は
         * fz_run_page が渡すデバイス CTM 基準なので、これと座標系を揃える。 */
        fz_rect mbox;
        fz_matrix page_ctm = fz_identity;
        pdf_page_transform(ctx, ppage, &mbox, &page_ctm);
        if (cd && kozou_xobj_place_ctm_scan(ctx, pdf, (const char*)cd, clen,
                res, target_xref, page_ctm, out_ctm, 0)) {
            hit = 1;
        }
    } fz_always(ctx) {
        if (cbuf) fz_drop_buffer(ctx, cbuf);
    } fz_catch(ctx) { hit = 0; }
    return hit;
}

/* ix/iyに一致するTj/TJを持つXObjectのxrefを再帰的に収集する内部実装。
 * 第一引数 xdict は対象の XObject リソース辞書。depth で無限再帰を防ぐ。 */
static void kozou_find_all_xobjs_by_tm_dict(
    fz_context   *ctx,
    pdf_document *pdf,
    pdf_obj      *xdict,
    float         ix,
    float         iy,
    float         tol2,
    int          *out_xrefs,
    int          *n_out,
    int           max_out,
    int           depth)
{
    if (!xdict || depth > 8) return;
    int n = pdf_dict_len(ctx, xdict);

    for (int i = 0; i < n; i++) {
        pdf_obj *val = pdf_dict_get_val(ctx, xdict, i);
        int xref = pdf_is_indirect(ctx, val) ? pdf_to_num(ctx, val) : 0;
        if (xref == 0) continue;

        /* 既に登録済みならスキップ（無限再帰 + 二重登録防止） */
        int dup = 0;
        for (int k = 0; k < *n_out; k++) {
            if (out_xrefs[k] == xref) { dup = 1; break; }
        }

        pdf_obj *xobj = pdf_resolve_indirect(ctx, val);
        if (!xobj) continue;
        pdf_obj *subtype = pdf_dict_get(ctx, xobj, PDF_NAME(Subtype));
        if (!pdf_name_eq(ctx, subtype, PDF_NAME(Form))) continue;

        fz_buffer *buf = NULL;
        int found = 0;
        fz_try(ctx) {
            pdf_obj *xobj_ind = pdf_new_indirect(ctx, pdf, xref, 0);
            buf = pdf_load_stream(ctx, xobj_ind);
            pdf_drop_obj(ctx, xobj_ind);
            if (!buf) fz_throw(ctx, FZ_ERROR_GENERIC, "no stream");

            unsigned char *d = NULL;
            size_t len = fz_buffer_storage(ctx, buf, &d);
            const char *src = (const char *)d;

            int in_bt = 0;
            float tm_tx = 0, tm_ty = 0;
            float td_x = 0, td_y = 0;

            size_t pos = 0;
            while (pos < len && !found) {
                size_t ls = pos;
                while (pos < len && src[pos] != '\n') pos++;
                size_t le = pos;
                if (pos < len) pos++;

                size_t ts = ls;
                while (ts < le && (src[ts]==' '||src[ts]=='\t')) ts++;
                size_t trimlen = le - ts;
                if (trimlen < 2) continue;

                if (!in_bt) {
                    if (trimlen == 2 && src[ts]=='B' && src[ts+1]=='T') {
                        in_bt = 1;
                        tm_tx = tm_ty = td_x = td_y = 0;
                    }
                } else {
                    if (trimlen == 2 && src[ts]=='E' && src[ts+1]=='T') {
                        in_bt = 0;
                    } else if (trimlen >= 2 && src[le-2]=='T' && src[le-1]=='m') {
                        char lb[128]={0};
                        size_t cp = (le-ts)<127?(le-ts):127;
                        memcpy(lb, src+ts, cp);
                        float a,b,c,dv,tx,ty;
                        if (sscanf(lb,"%f %f %f %f %f %f Tm",&a,&b,&c,&dv,&tx,&ty)==6) {
                            tm_tx = tx; tm_ty = ty;
                            td_x = 0; td_y = 0;
                        }
                    } else if (trimlen >= 2 && src[le-2]=='T' && src[le-1]=='d') {
                        char lb[64]={0};
                        size_t cp = (le-ts)<63?(le-ts):63;
                        memcpy(lb, src+ts, cp);
                        float tx, ty;
                        if (sscanf(lb,"%f %f Td",&tx,&ty)==2) {
                            td_x += tx; td_y += ty;
                        }
                    } else if (trimlen >= 2 && (src[le-2]=='T' && src[le-1]=='j'
                                              || src[le-2]=='T' && src[le-1]=='J')) {
                        float cur_x = tm_tx + td_x;
                        float cur_y = tm_ty + td_y;
                        float dx = cur_x - ix, dy = cur_y - iy;
                        if (dx*dx + dy*dy <= tol2) {
                            found = 1;
                        }
                    }
                }
            }
        } fz_always(ctx) {
            if (buf) { fz_drop_buffer(ctx, buf); buf = NULL; }
        } fz_catch(ctx) {}

        if (found && !dup && *n_out < max_out) {
            out_xrefs[(*n_out)++] = xref;
        }

        /* このXObject自身の Resources を再帰的にスキャン（ネスト XObject 対応）*/
        if (!dup) {
            pdf_obj *child_res = pdf_dict_get(ctx, xobj, PDF_NAME(Resources));
            if (child_res) {
                pdf_obj *child_xdict = pdf_dict_get(ctx, child_res, PDF_NAME(XObject));
                if (child_xdict)
                    kozou_find_all_xobjs_by_tm_dict(ctx, pdf, child_xdict,
                                                    ix, iy, tol2,
                                                    out_xrefs, n_out, max_out, depth+1);
            }
        }
    }
}

/* ix/iy に一致する全XObjectのxrefをout_xrefsに追記する。
 * ページの直接 XObject だけでなく、ネストした子 XObject も再帰的に検索する。 */
static void kozou_find_all_xobjs_by_tm(
    fz_context   *ctx,
    pdf_document *pdf,
    pdf_page     *ppage,
    float         ix,
    float         iy,
    float         tol,
    int          *out_xrefs,
    int          *n_out,
    int           max_out)
{
    if (!ppage || !out_xrefs || !n_out) return;
    pdf_obj *res = pdf_page_resources(ctx, ppage);
    if (!res) return;
    pdf_obj *xdict = pdf_dict_get(ctx, res, PDF_NAME(XObject));
    if (!xdict) return;

    float tol2 = tol * tol;
    kozou_find_all_xobjs_by_tm_dict(ctx, pdf, xdict, ix, iy, tol2,
                                    out_xrefs, n_out, max_out, 0);
}

static int kozou_find_xobj_by_tm(
    fz_context   *ctx,
    pdf_document *pdf,
    pdf_page     *ppage,
    float         ix,
    float         iy,
    float         tol)
{
    int xrefs[1];
    int n = 0;
    kozou_find_all_xobjs_by_tm(ctx, pdf, ppage, ix, iy, tol, xrefs, &n, 1);
    return n > 0 ? xrefs[0] : 0;
}


static int kozou_find_xobj_for_point(
    fz_context   *ctx,
    pdf_page     *ppage,
    float         ox,
    float         oy)
{
    /* ox/oy でのフォールバック: 使用されなくなった */
    (void)ox; (void)oy;
    return 0;
}


/* XObject ストリームの全 BT〜ET ブロックをスペースで置き換える（シンプル版）
 * buried テキストの無害化に使用。座標マッチング不要で確実に動作する。 */
static void kozou_blank_all_bt_blocks_hv(
    fz_context *ctx, fz_buffer *in_buf, fz_buffer *out_buf, pdf_obj *hv_ref,
    const KozouSanitizeOrigin *targets, int n_targets, float tol);

static void kozou_blank_all_bt_blocks(
    fz_context   *ctx,
    fz_buffer    *in_buf,
    fz_buffer    *out_buf)
{
    kozou_blank_all_bt_blocks_hv(ctx, in_buf, out_buf, NULL, NULL, 0, 0.0f);
}

/* バッファ中の Tj / TJ 演算子の出現数を数える。
 * 無害化の書き換えは「Tj をブランク化する(( ) Tj に置換)」だけで、
 * 正常時は Tj 演算子の総数が減ることはない（ブランク化しても Tj は残る）。
 * よって書き換え後に Tj 総数が減っていれば、それは内容の欠落＝
 * 書き換えの誤り（ラッパー XObject の誤特定等）を意味する。 */
static long kozou_count_tj_ops(fz_context *ctx, fz_buffer *buf)
{
    unsigned char *d = NULL;
    size_t n = fz_buffer_storage(ctx, buf, &d);
    long cnt = 0;
    if (!d) return 0;
    for (size_t i = 0; i + 1 < n; i++) {
        if (d[i] == 'T' && (d[i+1] == 'j' || d[i+1] == 'J')) cnt++;
    }
    return cnt;
}

/* XObject 配置 CTM を受け取り、各 Tj のデバイス座標を計算して
 * ターゲットの ox/oy (ページデバイス座標) と照合する版。
 * 内部 Tm 座標 (ix/iy) だけでは、XObject 内で同一 Tm を持つ複数の
 * テキストブロックが異なる cm で別の場所に配置されている場合に
 * 区別できない。デバイス座標で照合することで一意に特定する。 */
static void kozou_blank_all_bt_blocks_hv_ctm(
    fz_context                *ctx,
    pdf_document              *pdf,        /* フォント幅取得用 (NULL可) */
    pdf_obj                   *font_dict,  /* XObject の Resources/Font (NULL可) */
    fz_buffer                 *in_buf,
    fz_buffer                 *out_buf,
    pdf_obj                   *hv_ref,
    const KozouSanitizeOrigin *targets,
    int                        n_targets,
    float                      tol,
    fz_matrix                  place_ctm,  /* XObject → ページデバイス座標 */
    const KozouQuadMap        *qmap)       /* ページ stext マップ (identity 照合用, NULL可) */
{
    unsigned char *src_data = NULL;
    size_t src_len = fz_buffer_storage(ctx, in_buf, &src_data);
    if (!src_data || src_len == 0) return;

    const char *src = (const char *)src_data;
    size_t pos = 0;
    int in_bt = 0;
    int blank_entire_bt = (n_targets == 0);
    float tol2 = tol * tol;
    /* Tm を完全な行列として保持する。Tm は [a b c d e f] で回転・反転・
     * スケールを含みうる（例: [1 0 0 -1 tx ty] の Y 反転）。
     * 平行移動成分(tx,ty)だけを使うと、回転・反転を持つ XObject 内テキストの
     * 位置計算を誤る。Td はテキスト空間での移動なので Tm に対して合成する。 */
    fz_matrix cur_tm = fz_identity;  /* 直近の Tm 行列 */
    fz_matrix cur_td = fz_identity;  /* Tm 以降の Td 累積（テキスト空間） */
    char cur_font_name[64] = {0};
    float cur_font_size = 12.0f;
    char cur_font_line[128] = {0};
    int   cur_tr = 0;   /* 直近のテキスト描画モード Tr (取り違え防止) */

    /* BT 外の cm スタック (グラフィックス状態の CTM)。
     * q/Q でスタックし、cm で現在の CTM を更新する。
     * これは XObject 座標系内での CTM。最終デバイス座標は place_ctm を掛ける。 */
    fz_matrix ctm_stack[64];
    int ctm_sp = 0;
    ctm_stack[0] = fz_identity;

    while (pos < src_len) {
        size_t line_start = pos;
        while (pos < src_len && src[pos] != '\n') pos++;
        size_t line_len = pos - line_start;
        if (pos < src_len) pos++;

        size_t ts = line_start;
        while (ts < line_start + line_len && (src[ts] == ' ' || src[ts] == '\t')) ts++;
        size_t te = line_start + line_len;
        size_t trimmed_len = te - ts;

        if (!in_bt) {
            /* q / Q / cm を追跡 (BT 外のグラフィックス状態) */
            if (trimmed_len == 1 && src[ts] == 'q') {
                if (ctm_sp < 63) { ctm_stack[ctm_sp+1] = ctm_stack[ctm_sp]; ctm_sp++; }
            } else if (trimmed_len == 1 && src[ts] == 'Q') {
                if (ctm_sp > 0) ctm_sp--;
            } else if (trimmed_len >= 2 && src[te-2] == 'c' && src[te-1] == 'm') {
                char cmline[128] = {0};
                size_t cl = (te - ts) < 127 ? (te - ts) : 127;
                memcpy(cmline, src + ts, cl);
                float a,b,c,d,e,f;
                if (sscanf(cmline,"%f %f %f %f %f %f cm",&a,&b,&c,&d,&e,&f) == 6) {
                    fz_matrix m = { a,b,c,d,e,f };
                    ctm_stack[ctm_sp] = fz_concat(m, ctm_stack[ctm_sp]);
                }
            } else if (trimmed_len == 2 && src[ts] == 'B' && src[ts+1] == 'T') {
                in_bt = 1;
                cur_tm = fz_identity;
                cur_td = fz_identity;
            }
            fz_append_data(ctx, out_buf, src + line_start, line_len);
            fz_append_byte(ctx, out_buf, '\n');
        } else {
            if (trimmed_len == 2 && src[ts] == 'E' && src[ts+1] == 'T') {
                in_bt = 0;
                fz_append_data(ctx, out_buf, src + line_start, line_len);
                fz_append_byte(ctx, out_buf, '\n');
            } else if (trimmed_len >= 2 &&
                       ((src[te-2] == 'T' && src[te-1] == 'j') ||
                        (src[te-2] == 'T' && src[te-1] == 'J'))) {
                /* Tj/TJ 描画位置を完全な行列連鎖でデバイス座標に変換する。
                 * テキスト原点 (0,0) を次の順で変換:
                 *   text-origin → Td → Tm → cm → place_ctm → device
                 * 行列は fz_concat(A,B)=「A を先に適用」。
                 * 連鎖 = Td · Tm · cm · place_ctm。 */
                fz_matrix txt = fz_concat(cur_td, cur_tm);
                fz_matrix m1  = fz_concat(txt, ctm_stack[ctm_sp]);
                fz_matrix full = fz_concat(m1, place_ctm);
                /* テキスト空間原点 (0,0) のデバイス座標 = 平行移動成分 */
                float dev_x = full.e;
                float dev_y = full.f;
                int do_blank = blank_entire_bt;
                if (!do_blank && n_targets > 0) {
                    int cur_invisible = kozou_tr_is_invisible(cur_tr);
                    /* この Tj が実際に描くグリフの identity を stext マップから取得。
                     * 座標が近いだけの隣接/重なりグリフの巻き込みを防ぐ本命の照合。 */
                    int   g_ucs = -1; float g_size = 0.0f; int have_g = 0;
                    if (qmap)
                        have_g = kozou_quad_map_lookup_glyph(
                            qmap, dev_x, dev_y, 4.0f, &g_ucs, &g_size);
                    for (int _ti = 0; _ti < n_targets; _ti++) {
                        if (targets[_ti].render_invisible >= 0 &&
                            targets[_ti].render_invisible != cur_invisible)
                            continue;
                        float dx = targets[_ti].ox - dev_x;
                        float dy = targets[_ti].oy - dev_y;
                        if (dx*dx + dy*dy > tol2) continue;
                        if (!kozou_identity_ok(targets[_ti].codepoint, targets[_ti].size,
                                               have_g, g_ucs, g_size)) continue;
                        do_blank = 1; break;
                    }
                    /* Tm 原点がターゲット外でも、文字単位で前進して再照合。
                     * 先頭文字が検出されない場合 (部分被覆の buried 等) に対応。 */
                    if (!do_blank && pdf && font_dict) {
                        /* Tj/TJ 行から文字列を抜き出す */
                        const char *line_p = (const char *)src + ts;
                        const char *str_start = NULL;
                        for (size_t _ci = 0; _ci < trimmed_len; _ci++) {
                            if (line_p[_ci] == '(') { str_start = line_p + _ci; break; }
                        }
                        if (str_start) {
                            pdf_obj *fobj_c = pdf_dict_gets(ctx, font_dict, cur_font_name);
                            int is_mb_c = kozou_is_multibyte_font(ctx, fobj_c);
                            float adv_c = 0.0f;
                            const char *p_c = str_start + 1;
                            while (*p_c && *p_c != ')' && !do_blank) {
                                int cc_c;
                                if (*p_c == '\\') {
                                    p_c++;
                                    if (*p_c >= '0' && *p_c <= '7') {
                                        cc_c = (*p_c++ - '0');
                                        if (*p_c >= '0' && *p_c <= '7') cc_c = cc_c*8 + (*p_c++ - '0');
                                        if (*p_c >= '0' && *p_c <= '7') cc_c = cc_c*8 + (*p_c++ - '0');
                                    } else { cc_c = (unsigned char)*p_c++; }
                                } else { cc_c = (unsigned char)*p_c++; }
                                if (is_mb_c && *p_c && *p_c != ')') {
                                    int lo_c;
                                    if (*p_c == '\\') {
                                        p_c++;
                                        if (*p_c >= '0' && *p_c <= '7') {
                                            lo_c = (*p_c++ - '0');
                                            if (*p_c >= '0' && *p_c <= '7') lo_c = lo_c*8 + (*p_c++ - '0');
                                            if (*p_c >= '0' && *p_c <= '7') lo_c = lo_c*8 + (*p_c++ - '0');
                                        } else { lo_c = (unsigned char)*p_c++; }
                                    } else { lo_c = (unsigned char)*p_c++; }
                                    cc_c = (cc_c << 8) | lo_c;
                                }
                                float cw_c = kozou_get_char_width_1000(ctx, pdf, fobj_c, cc_c);
                                float adv_pts_c = adv_c * cur_font_size / 1000.0f;
                                /* 文字の device 座標: テキスト空間 (adv,0) を full 行列で変換 */
                                fz_matrix txt_c = fz_concat(cur_td, cur_tm);
                                fz_matrix m1_c  = fz_concat(txt_c, ctm_stack[ctm_sp]);
                                fz_matrix full_c = fz_concat(m1_c, place_ctm);
                                fz_point adv_dev = fz_transform_point(
                                    fz_make_point(adv_pts_c, 0.0f), full_c);
                                float ch_dev_x = adv_dev.x;
                                float ch_dev_y = adv_dev.y;
                                int g_c_ucs = -1; float g_c_size = 0.0f; int have_g_c = 0;
                                if (qmap)
                                    have_g_c = kozou_quad_map_lookup_glyph(
                                        qmap, ch_dev_x, ch_dev_y, 4.0f, &g_c_ucs, &g_c_size);
                                for (int _ti2 = 0; _ti2 < n_targets && !do_blank; _ti2++) {
                                    if (targets[_ti2].render_invisible >= 0 &&
                                        targets[_ti2].render_invisible != cur_invisible)
                                        continue;
                                    float dx2 = targets[_ti2].ox - ch_dev_x;
                                    float dy2 = targets[_ti2].oy - ch_dev_y;
                                    if (dx2*dx2 + dy2*dy2 > tol2) continue;
                                    if (!kozou_identity_ok(targets[_ti2].codepoint,
                                            targets[_ti2].size, have_g_c, g_c_ucs, g_c_size))
                                        continue;
                                    do_blank = 1;
                                }
                                adv_c += cw_c;
                            }
                        }
                    }
                }
                if (!do_blank) {
                    fz_append_data(ctx, out_buf, src + line_start, line_len);
                    fz_append_byte(ctx, out_buf, '\n');
                } else if (hv_ref) {
                    fz_append_printf(ctx, out_buf,
                        "/%s %g Tf\n( ) Tj\n%s\n",
                        KOZOU_HV, cur_font_size,
                        cur_font_name[0] ? cur_font_line : "");
                } else {
                    fz_append_string(ctx, out_buf, "( ) Tj\n");
                }
            } else {
                if (trimmed_len >= 2 && src[te-2] == 'T' && src[te-1] == 'm') {
                    char tmline[128] = {0};
                    size_t cplen2 = (te - ts) < 127 ? (te - ts) : 127;
                    memcpy(tmline, src + ts, cplen2);
                    float ta,tb2,tc,td2,tx,ty;
                    if (sscanf(tmline,"%f %f %f %f %f %f Tm",
                               &ta,&tb2,&tc,&td2,&tx,&ty) == 6) {
                        cur_tm.a = ta; cur_tm.b = tb2;
                        cur_tm.c = tc; cur_tm.d = td2;
                        cur_tm.e = tx; cur_tm.f = ty;
                        cur_td = fz_identity;  /* Tm で Td 累積をリセット */
                    }
                }
                else if (trimmed_len >= 2 && src[te-2] == 'T' &&
                         (src[te-1] == 'd' || src[te-1] == 'D')) {
                    char tdline[128] = {0};
                    size_t cplen3 = (te - ts) < 127 ? (te - ts) : 127;
                    memcpy(tdline, src + ts, cplen3);
                    float dxv, dyv;
                    if (sscanf(tdline,"%f %f T%*c", &dxv,&dyv) == 2) {
                        /* Td はテキスト空間での平行移動。現在の Td に合成。 */
                        fz_matrix tdm = fz_translate(dxv, dyv);
                        cur_td = fz_concat(tdm, cur_td);
                    }
                }
                if (trimmed_len >= 2 && src[te-2] == 'T' && src[te-1] == 'f') {
                    char tf_name[64] = {0};
                    float tf_size = 12.0f;
                    char linebuf[128] = {0};
                    size_t cplen = (te - ts) < 127 ? (te - ts) : 127;
                    memcpy(linebuf, src + ts, cplen);
                    if (sscanf(linebuf, "/%63s %f Tf", tf_name, &tf_size) == 2) {
                        snprintf(cur_font_name, sizeof(cur_font_name), "%s", tf_name);
                        cur_font_size = tf_size;
                        snprintf(cur_font_line, sizeof(cur_font_line),
                                 "/%s %g Tf", tf_name, tf_size);
                    }
                }
                if (trimmed_len >= 2 && src[te-2] == 'T' && src[te-1] == 'r') {
                    char trline[64] = {0};
                    size_t cplen4 = (te - ts) < 63 ? (te - ts) : 63;
                    memcpy(trline, src + ts, cplen4);
                    int trv;
                    if (sscanf(trline, "%d Tr", &trv) == 1) cur_tr = trv;
                }
                fz_append_data(ctx, out_buf, src + line_start, line_len);
                fz_append_byte(ctx, out_buf, '\n');
            }
        }
    }
}

/* 旧 API 互換: 内部座標 (ix/iy) でマッチングする版。
 * n_targets==0 で全 BT blank する用途 (kozou_blank_all_bt_blocks) のみ残す。 */
static void kozou_blank_all_bt_blocks_hv(
    fz_context                *ctx,
    fz_buffer                 *in_buf,
    fz_buffer                 *out_buf,
    pdf_obj                   *hv_ref,
    const KozouSanitizeOrigin *targets,
    int                        n_targets,
    float                      tol)
{
    /* place_ctm を identity にすると ox/oy 照合が XObject 座標系のままになり
     * 整合しないため、この旧 API は n_targets==0 (全 blank) 専用とする。 */
    (void)targets; (void)tol;
    unsigned char *src_data = NULL;
    size_t src_len = fz_buffer_storage(ctx, in_buf, &src_data);
    if (!src_data || src_len == 0) return;
    const char *src = (const char *)src_data;
    size_t pos = 0;
    int in_bt = 0;
    int blank_entire_bt = (n_targets == 0);
    char cur_font_name[64] = {0};
    float cur_font_size = 12.0f;
    char cur_font_line[128] = {0};

    while (pos < src_len) {
        size_t line_start = pos;
        while (pos < src_len && src[pos] != '\n') pos++;
        size_t line_len = pos - line_start;
        if (pos < src_len) pos++;
        size_t ts = line_start;
        while (ts < line_start + line_len && (src[ts] == ' ' || src[ts] == '\t')) ts++;
        size_t te = line_start + line_len;
        size_t trimmed_len = te - ts;

        if (!in_bt) {
            if (trimmed_len == 2 && src[ts] == 'B' && src[ts+1] == 'T') in_bt = 1;
            fz_append_data(ctx, out_buf, src + line_start, line_len);
            fz_append_byte(ctx, out_buf, '\n');
        } else {
            if (trimmed_len == 2 && src[ts] == 'E' && src[ts+1] == 'T') {
                in_bt = 0;
                fz_append_data(ctx, out_buf, src + line_start, line_len);
                fz_append_byte(ctx, out_buf, '\n');
            } else if (trimmed_len >= 2 &&
                       ((src[te-2] == 'T' && src[te-1] == 'j') ||
                        (src[te-2] == 'T' && src[te-1] == 'J'))) {
                if (!blank_entire_bt) {
                    fz_append_data(ctx, out_buf, src + line_start, line_len);
                    fz_append_byte(ctx, out_buf, '\n');
                } else if (hv_ref) {
                    fz_append_printf(ctx, out_buf,
                        "/%s %g Tf\n( ) Tj\n%s\n",
                        KOZOU_HV, cur_font_size,
                        cur_font_name[0] ? cur_font_line : "");
                } else {
                    fz_append_string(ctx, out_buf, "( ) Tj\n");
                }
            } else {
                if (trimmed_len >= 2 && src[te-2] == 'T' && src[te-1] == 'f') {
                    char tf_name[64] = {0};
                    float tf_size = 12.0f;
                    char linebuf[128] = {0};
                    size_t cplen = (te - ts) < 127 ? (te - ts) : 127;
                    memcpy(linebuf, src + ts, cplen);
                    if (sscanf(linebuf, "/%63s %f Tf", tf_name, &tf_size) == 2) {
                        snprintf(cur_font_name, sizeof(cur_font_name), "%s", tf_name);
                        cur_font_size = tf_size;
                        snprintf(cur_font_line, sizeof(cur_font_line),
                                 "/%s %g Tf", tf_name, tf_size);
                    }
                }
                fz_append_data(ctx, out_buf, src + line_start, line_len);
                fz_append_byte(ctx, out_buf, '\n');
            }
        }
    }
}

/* ──────────────────────────────────────────────────────────────────
 * XObject ストリームの隠しテキスト書き換え
 * 内部座標（ix, iy）でターゲットをマッチングする。
 * ページ版の kozou_sanitize_hidden_text 内のループと同じロジックだが
 * 単一ストリームに対してのみ動作する。
 * ─────────────────────────────────────────────────────────────────── */
static void kozou_rewrite_stream_for_xobj(
    fz_context            *ctx,
    pdf_document          *pdf,
    fz_buffer             *in_buf,
    fz_buffer             *out_buf,
    pdf_obj               *font_dict,
    pdf_obj               *hv_ref,
    const KozouSanitizeOrigin *targets,
    int                    n_targets,
    float                  tol2,
    fz_matrix              xobj_to_device) /* XObject内部→デバイス座標 */
{
    unsigned char *src_data = NULL;
    size_t src_len = fz_buffer_storage(ctx, in_buf, &src_data);
    const char *src = (const char *)src_data;
    size_t pos = 0;

    /* 字句解析用バッファ */
    char kw[64];
    int  kw_len = 0;
    char num_stk[16][64];
    int  num_top = 0;
    float args[16];

    int   in_text  = 0;
    int   tr_mode  = 0;
    float tm[6]    = {1,0,0,1,0,0};
    float lm[6]    = {1,0,0,1,0,0};
    float font_size = 12.0f;
    int   n_ch     = 0;
    float diff     = 0.0f;
    int   hit      = 0;
    int   stk_top  = 0;
    /* xobj_to_device: cm 命令を積算して XObject内部→デバイス座標への変換を追跡 */
    /* 呼び出し元から渡された初期値（通常 fz_identity）から始まる */

    /* 現在のテキスト位置（内部座標）を計算するためのマクロ */
    /* tm: [a b c d e f] で Tm/Td/T* 等から更新される */
    /* テキスト位置: (tm[4], tm[5]) がベースライン origin */
#define XOBJ_CUR_X (tm[4])
#define XOBJ_CUR_Y (tm[5])

    while (pos < src_len) {
        /* 空白・改行をスキップ */
        while (pos < src_len && (src[pos]==' '||src[pos]=='\t'||src[pos]=='\r'||src[pos]=='\n'))
            pos++;
        if (pos >= src_len) break;

        char c = src[pos];

        if (c == '%') {
            /* コメント行 */
            while (pos < src_len && src[pos] != '\n') pos++;
            continue;
        }

        if (c == '<' && pos+1 < src_len && src[pos+1] == '<') {
            /* 辞書 << ... >> はそのまま出力 */
            int depth = 0;
            size_t start = pos;
            while (pos < src_len) {
                if (src[pos]=='<' && pos+1<src_len && src[pos+1]=='<') { depth++; pos+=2; }
                else if (src[pos]=='>' && pos+1<src_len && src[pos+1]=='>') {
                    depth--; pos+=2;
                    if (depth == 0) break;
                } else pos++;
            }
            fz_append_data(ctx, out_buf, src+start, pos-start);
            fz_append_byte(ctx, out_buf, '\n');
            num_top = 0;
            continue;
        }

        if (c == '(' ) {
            /* リテラル文字列 */
            size_t start = pos++;
            int depth = 1;
            while (pos < src_len && depth > 0) {
                if (src[pos]=='\\') pos += 2;
                else if (src[pos]=='(') { depth++; pos++; }
                else if (src[pos]==')') { depth--; pos++; }
                else pos++;
            }
            if (num_top < 16) {
                size_t slen = pos - start;
                if (slen < 64) { memcpy(num_stk[num_top], src+start, slen); num_stk[num_top][slen]=0; }
                num_top++;
            }
            continue;
        }

        if (c == '<') {
            /* 16進文字列 */
            size_t start = pos++;
            while (pos < src_len && src[pos] != '>') pos++;
            if (pos < src_len) pos++;
            if (num_top < 16) {
                size_t slen = pos - start;
                if (slen < 64) { memcpy(num_stk[num_top], src+start, slen); num_stk[num_top][slen]=0; }
                num_top++;
            }
            continue;
        }

        if (c == '[') {
            /* 配列 [...] */
            size_t start = pos++;
            int depth = 1;
            while (pos < src_len && depth > 0) {
                if (src[pos]=='[') depth++;
                else if (src[pos]==']') depth--;
                pos++;
            }
            if (num_top < 16) {
                size_t slen = pos - start;
                if (slen < 64) { memcpy(num_stk[num_top], src+start, slen); num_stk[num_top][slen]=0; }
                num_top++;
            }
            continue;
        }

        /* 数値またはキーワードを読む */
        if (c == '-' || c == '+' || c == '.' || (c >= '0' && c <= '9')) {
            size_t start = pos;
            while (pos < src_len && (src[pos]!='\n'&&src[pos]!='\r'&&src[pos]!=' '&&src[pos]!='\t'))
                pos++;
            size_t slen = pos - start;
            if (num_top < 16 && slen < 64) {
                memcpy(num_stk[num_top], src+start, slen);
                num_stk[num_top][slen] = 0;
                num_top++;
            }
            continue;
        }

        if (c == '/') {
            /* 名前 */
            size_t start = pos++;
            while (pos < src_len && src[pos]!=' '&&src[pos]!='\n'&&src[pos]!='\r'&&src[pos]!='\t')
                pos++;
            size_t slen = pos - start;
            if (num_top < 16 && slen < 64) {
                memcpy(num_stk[num_top], src+start, slen);
                num_stk[num_top][slen] = 0;
                num_top++;
            }
            continue;
        }

        /* キーワードを読む */
        kw_len = 0;
        size_t kw_start = pos;
        while (pos < src_len && src[pos]!=' '&&src[pos]!='\n'&&src[pos]!='\r'&&src[pos]!='\t'
               && src[pos]!='<'&&src[pos]!='('&&src[pos]!='['&&src[pos]!='/')
            pos++;
        kw_len = (int)(pos - kw_start);
        if (kw_len <= 0 || kw_len >= 64) { pos++; num_top = 0; continue; }
        memcpy(kw, src+kw_start, kw_len);
        kw[kw_len] = 0;

        /* 引数を float に変換 */
        int na = num_top < 16 ? num_top : 16;
        for (int i = 0; i < na; i++)
            args[i] = (float)atof(num_stk[i]);

        if (!strcmp(kw, "BT")) {
            in_text = 1; tr_mode = 0; n_ch = 0; diff = 0; hit = 0; stk_top = 0;
            memset(tm, 0, sizeof(tm)); tm[0]=tm[3]=1;
            memset(lm, 0, sizeof(lm)); lm[0]=lm[3]=1;
            fz_append_string(ctx, out_buf, "BT\n");
            num_top = 0;
            continue;
        }
        if (!strcmp(kw, "ET")) {
            in_text = 0;
            fz_append_string(ctx, out_buf, "ET\n");
            num_top = 0;
            continue;
        }

        if (!in_text) {
            /* BT 外はそのまま出力 */
            fz_append_data(ctx, out_buf, src+kw_start - (kw_start > 0 && src[kw_start-1]!=' ' ? 0 : 0), pos-kw_start);
            for (int i = 0; i < num_top; i++) {
                fz_append_string(ctx, out_buf, num_stk[i]);
                fz_append_byte(ctx, out_buf, ' ');
            }
            fz_append_string(ctx, out_buf, kw);
            fz_append_byte(ctx, out_buf, '\n');
            num_top = 0;
            continue;
        }

        /* BT 内の演算子処理 */
        if (!strcmp(kw, "Tm") && na >= 6) {
            for (int i=0;i<6;i++) tm[i]=args[i];
            memcpy(lm, tm, sizeof(tm));
            /* Tm をそのまま出力 */
            for (int i=0;i<6;i++) fz_append_printf(ctx, out_buf, "%.6g ", (double)tm[i]);
            fz_append_string(ctx, out_buf, "Tm\n");
            num_top = 0;
            continue;
        }
        if (!strcmp(kw, "Td") && na >= 2) {
            tm[4] = lm[4] + args[0]*lm[0] + args[1]*lm[2];
            tm[5] = lm[5] + args[0]*lm[1] + args[1]*lm[3];
            memcpy(lm, tm, sizeof(tm));
            fz_append_printf(ctx, out_buf, "%.6g %.6g Td\n", (double)args[0], (double)args[1]);
            num_top = 0;
            continue;
        }
        if (!strcmp(kw, "TD") && na >= 2) {
            tm[4] = lm[4] + args[0]*lm[0] + args[1]*lm[2];
            tm[5] = lm[5] + args[0]*lm[1] + args[1]*lm[3];
            memcpy(lm, tm, sizeof(tm));
            fz_append_printf(ctx, out_buf, "%.6g %.6g TD\n", (double)args[0], (double)args[1]);
            num_top = 0;
            continue;
        }
        if ((!strcmp(kw, "T*")||!strcmp(kw,"T"))) {
            fz_append_string(ctx, out_buf, "T*\n");
            num_top = 0;
            continue;
        }
        if (!strcmp(kw, "Tf") && na >= 2) {
            font_size = args[1];
            /* Tf をそのまま出力 */
            for (int i=0;i<num_top;i++) {
                fz_append_string(ctx, out_buf, num_stk[i]);
                fz_append_byte(ctx, out_buf, ' ');
            }
            fz_append_string(ctx, out_buf, "Tf\n");
            num_top = 0;
            continue;
        }
        if (!strcmp(kw, "Tr") && na >= 1) {
            tr_mode = (int)args[0];
            fz_append_printf(ctx, out_buf, "%d Tr\n", tr_mode);
            num_top = 0;
            continue;
        }

        /* Tj / TJ の処理: テキストスペース座標 (tm[4], tm[5]) でターゲットと照合
         * internal_origin は item->x, item->y (テキストスペース座標) で記録済み
         * xref チェックなしで ix, iy のみで照合（xobj_xref は常に 0 のため）*/
        if (!strcmp(kw, "Tj") || !strcmp(kw, "TJ")) {
            /* xref に依存しない ix/iy 照合 */
            int is_target = 0;
            for (int _ti = 0; _ti < n_targets; _ti++) {
                float _dx = targets[_ti].ix - XOBJ_CUR_X;
                float _dy = targets[_ti].iy - XOBJ_CUR_Y;
                if (_dx*_dx + _dy*_dy <= tol2) { is_target = 1; break; }
            }

            if (is_target && hv_ref) {
                /* Helvetica で空白に置き換え */
                fz_append_printf(ctx, out_buf,
                    "/%s %s Tf\n0 Tr\n(%s) Tj\n",
                    KOZOU_HV,
                    num_stk[num_top > 1 ? 1 : 0], /* font size */
                    " ");
            } else {
                /* そのまま出力 */
                for (int i=0;i<num_top;i++) {
                    fz_append_string(ctx, out_buf, num_stk[i]);
                    fz_append_byte(ctx, out_buf, ' ');
                }
                fz_append_string(ctx, out_buf, kw);
                fz_append_byte(ctx, out_buf, '\n');
            }
            num_top = 0;
            continue;
        }

        /* cm: 座標変換行列を積算して xobj_to_device を更新 */
        if (!strcmp(kw, "cm") && na >= 6) {
            fz_matrix m;
            m.a = args[0]; m.b = args[1];
            m.c = args[2]; m.d = args[3];
            m.e = args[4]; m.f = args[5];
            xobj_to_device = fz_concat(m, xobj_to_device);
            /* cm はそのまま出力 */
            for (int i=0;i<num_top;i++) {
                fz_append_string(ctx, out_buf, num_stk[i]);
                fz_append_byte(ctx, out_buf, ' ');
            }
            fz_append_string(ctx, out_buf, "cm\n");
            num_top = 0;
            continue;
        }

        /* その他の演算子: そのまま出力 */
        for (int i=0;i<num_top;i++) {
            fz_append_string(ctx, out_buf, num_stk[i]);
            fz_append_byte(ctx, out_buf, ' ');
        }
        fz_append_string(ctx, out_buf, kw);
        fz_append_byte(ctx, out_buf, '\n');
        num_top = 0;
    }

#undef XOBJ_CUR_X
#undef XOBJ_CUR_Y

    /* 未使用変数の警告抑制 */
    (void)stk_top; (void)n_ch; (void)diff; (void)hit; (void)font_size;
    (void)hv_ref; (void)font_dict; (void)pdf;
}

void kozou_sanitize_hidden_text(
    fz_context  *ctx,
    const char  *input_path,
    const char  *output_path,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    const float *target_origins,
    int          n_origins,
    float        tolerance,
    const int   *target_render_class, /* 並列配列: 各ターゲットの描画モード
                                        * (1=不可視, 0=可視, -1=不明)。
                                        * NULL 可 (全て -1 とみなし従来動作)。
                                        * 既存の 9 要素パック配列のストライドは
                                        * 変更しないため互換性を壊さない。 */
    FfiResult   *result)
{
    pdf_document *pdf = NULL;
    fz_var(pdf);

    fz_try(ctx) {
        pdf = (pdf_document *)fz_open_document(ctx, input_path);
        if (!pdf)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "not a PDF");

        if (fz_is_document_reflowable(ctx, (fz_document *)pdf)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, (fz_document *)pdf, w, h, em);
        }

        if (n_origins <= 0 || !target_origins)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "no target origins");

        int n = n_origins < KOZOU_SANITIZE_MAX ? n_origins : KOZOU_SANITIZE_MAX;
        KozouSanitizeOrigin *targets =
            (KozouSanitizeOrigin *)fz_calloc(ctx, n, sizeof(KozouSanitizeOrigin));
        /* target_origins: [x,y,xobj_xref,ix,iy,ox,oy,is_buried,page_index,
         *                   codepoint,size] 11要素 (旧9要素から拡張)。
         * codepoint は f32 で渡されるが整数値 (Unicode, -1=不明)。 */
        for (int i = 0; i < n; i++) {
            targets[i].x          = target_origins[i*11];
            targets[i].y          = target_origins[i*11+1];
            targets[i].xobj_xref  = (int)target_origins[i*11+2];
            targets[i].ix         = target_origins[i*11+3];
            targets[i].iy         = target_origins[i*11+4];
            targets[i].ox         = target_origins[i*11+5];
            targets[i].oy         = target_origins[i*11+6];
            targets[i].is_buried  = (int)target_origins[i*11+7];
            targets[i].page_index = (int)target_origins[i*11+8];
            /* 文字 identity (取り違え防止の本命)。codepoint<0 で従来動作。 */
            targets[i].codepoint  = (int)target_origins[i*11+9];
            targets[i].size       = target_origins[i*11+10];
            /* 描画モード (取り違え防止)。並列配列が無ければ -1 (不明=従来動作)。 */
            targets[i].render_invisible =
                target_render_class ? target_render_class[i] : -1;
        }
        float tol2 = tolerance > 0 ? tolerance*tolerance : 1.0f;

        int page_count  = pdf_count_pages(ctx, pdf);
        int width_warn  = 0;

        /* ページごとターゲット配列はヒープ確保（スタックオーバーフロー防止）。
         * KOZOU_SANITIZE_MAX 個の構造体はスタックには大きすぎる。 */
        KozouSanitizeOrigin *pi_targets =
            (KozouSanitizeOrigin *)fz_malloc(ctx,
                sizeof(KozouSanitizeOrigin) * KOZOU_SANITIZE_MAX);
        for (int pi = 0; pi < page_count; pi++) {
            pdf_page *page = NULL;
            fz_var(page);
            /* このページ向けターゲットのみのフィルタ済み配列 */
            int pi_n = 0;
            for (int _fi = 0; _fi < n && pi_n < KOZOU_SANITIZE_MAX; _fi++) {
                if (targets[_fi].page_index >= 0 && targets[_fi].page_index != pi)
                    continue;
                pi_targets[pi_n++] = targets[_fi];
            }
            fz_try(ctx) {
                page = pdf_load_page(ctx, pdf, pi);
                /* 検出側の origin は fz_new_stext_page_from_page が生成する
                 * MuPDF デバイス座標 (左上原点・Y下向き・回転/CropBox 原点を含む)。
                 * 無害化側も stext と同一の page_ctm を使ってテキスト原点を
                 * デバイス座標へ変換し、両者を厳密に一致させる。
                 * 旧実装の `dev_y = page_h - tm[5]` は CropBox 原点 (x0,y0) や
                 * ページ回転を無視するため、原点が 0 でない PDF で検出座標と
                 * ずれ、検出済みでも無害化できない/別位置を誤って無害化する
                 * 不具合の原因になっていた。 */
                fz_rect page_mbox;
                fz_matrix page_ctm = fz_identity;
                pdf_page_transform(ctx, page, &page_mbox, &page_ctm);

                pdf_obj *page_obj  = page->obj;
                pdf_obj *res       = pdf_dict_get_inheritable(ctx, page_obj, PDF_NAME(Resources));
                pdf_obj *font_dict = res ? pdf_dict_get(ctx, res, PDF_NAME(Font)) : NULL;

                /* Helvetica フォントをリソースに登録 */
                kozou_ensure_helvetica(ctx, pdf, page_obj);

                /* Pass 0: fz_stext_page から origin → quad幅 マップを構築
 * RTL・縦書き・合字すべてに対応できる実描画幅をMuPDFから直接取得 */
                KozouQuadMap *qmap = (KozouQuadMap *)fz_malloc(ctx,
                    sizeof(KozouQuadMap));
                memset(qmap, 0, sizeof(KozouQuadMap));
                fz_var(qmap);

                fz_stext_page  *stext_pg = NULL;
                fz_var(stext_pg);
                fz_try(ctx) {
                    fz_stext_options sopts = {
                        FZ_STEXT_PRESERVE_WHITESPACE | FZ_STEXT_ACCURATE_BBOXES, 0 };
                    stext_pg = fz_new_stext_page_from_page(
                        ctx, (fz_page *)page, &sopts);
                    for (fz_stext_block *blk = stext_pg->first_block;
                         blk; blk = blk->next) {
                        if (blk->type != FZ_STEXT_BLOCK_TEXT) continue;
                        for (fz_stext_line *ln = blk->u.t.first_line;
                             ln; ln = ln->next) {
                            for (fz_stext_char *ch = ln->first_char;
                                 ch; ch = ch->next) {
                                if (qmap->count >= KOZOU_QUAD_MAP_MAX) break;
                                KozouQuadEntry *e =
                                    &qmap->entries[qmap->count++];
                                e->ox   = ch->origin.x;
                                e->oy   = ch->origin.y;
                                e->size = ch->size;
                                e->ucs  = ch->c;
                                e->width_1000 = kozou_quad_width_1000(
                                    &ch->quad, ch->size);
                            }
                        }
                    }
                }
                fz_always(ctx) {
                    if (stext_pg) {
                        fz_drop_stext_page(ctx, stext_pg);
                        stext_pg = NULL;
                    }
                }
                fz_catch(ctx) {
                    /* quad収集失敗は致命的でないのでwarningで続行 */
                    fz_warn(ctx, "sanitize: quad map build failed page %d", pi);
                }


                /* コンテンツストリームを展開 */
                pdf_obj *contents = pdf_dict_get(ctx, page_obj, PDF_NAME(Contents));
                if (!contents) { pdf_drop_page(ctx, page); page = NULL; continue; }

                fz_buffer *orig_buf = fz_new_buffer(ctx, 65536);
                fz_var(orig_buf);
                fz_try(ctx) {
                    if (pdf_is_array(ctx, contents)) {
                        int nc = pdf_array_len(ctx, contents);
                        for (int ci = 0; ci < nc; ci++) {
                            fz_buffer *b = pdf_load_stream(ctx, pdf_array_get(ctx, contents, ci));
                            fz_append_buffer(ctx, orig_buf, b);
                            fz_append_byte(ctx, orig_buf, '\n');
                            fz_drop_buffer(ctx, b);
                        }
                    } else {
                        fz_buffer *b = pdf_load_stream(ctx, contents);
                        fz_append_buffer(ctx, orig_buf, b);
                        fz_drop_buffer(ctx, b);
                    }
                }
                fz_catch(ctx) { fz_drop_buffer(ctx, orig_buf); fz_rethrow(ctx); }

                fz_stream *stm   = fz_open_buffer(ctx, orig_buf);
                fz_buffer *new_buf = fz_new_buffer(ctx,
                    fz_buffer_storage(ctx, orig_buf, NULL) + 8192);
                int modified       = 0;
                int page_warn      = 0;

                /* テキスト状態 */
                float tm[6] = {1,0,0,1,0,0};
                float lm[6] = {1,0,0,1,0,0};
                float font_size = 12.0f;
                float leading   = 0.0f;
                int   tr_mode   = 0;
                int   in_text   = 0;
                char  cur_font[64] = "";

                /* グラフィックス状態 CTM スタック (q/Q/cm)。
                 * テキスト原点のデバイス座標 = page_ctm( gs_ctm( (tm.e, tm.f) ) )。
                 * cm でページ内に配置されたテキストも検出側 (stext) と同じ
                 * デバイス座標で照合できるよう、XObject 経路
                 * (kozou_blank_all_bt_blocks_hv_ctm) と同一ロジックで追跡する。 */
                fz_matrix gs_stack[32];
                int gs_sp = 0;
                gs_stack[0] = fz_identity;

#define SSTK 16  /* スタック消費削減のため縮小 (旧64) */
                typedef struct { char s[128]; float v; int is_num; int is_str; } SOp;
                SOp  stk[SSTK];
                int  stk_top = 0;

                pdf_lexbuf lxb;
                pdf_lexbuf_init(ctx, &lxb, PDF_LEXBUF_SMALL);

                fz_try(ctx) {
                while (1) {
                    pdf_token tok = pdf_lex(ctx, stm, &lxb);
                    if (tok == PDF_TOK_EOF) break;

                    SOp op = {{0}, 0, 0, 0};
                    switch (tok) {
                    case PDF_TOK_INT:
                        op.v = (float)lxb.i;
                        snprintf(op.s, sizeof(op.s), "%d", lxb.i);
                        op.is_num = 1; break;
                    case PDF_TOK_REAL:
                        op.v = lxb.f;
                        snprintf(op.s, sizeof(op.s), "%.6g", lxb.f);
                        op.is_num = 1; break;
                    case PDF_TOK_STRING: {
                        unsigned char *d = (unsigned char *)lxb.scratch;
                        size_t len = lxb.len;
                        int j = 0; op.s[j++] = '(';
                        for (size_t k = 0; k < len && j < (int)sizeof(op.s)-4; k++) {
                            unsigned char c = d[k];
                            if      (c=='(')  { op.s[j++]='\\'; op.s[j++]='('; }
                            else if (c==')')  { op.s[j++]='\\'; op.s[j++]=')'; }
                            else if (c=='\\') { op.s[j++]='\\'; op.s[j++]='\\'; }
                            else              { op.s[j++]=(char)c; }
                        }
                        op.s[j++]=')'; op.s[j]='\0';
                        op.is_str = 1;
                        op.v = len > 0 ? (float)(unsigned char)lxb.scratch[0] : 0;
                        break;
                    }
                    case PDF_TOK_NAME:
                        snprintf(op.s, sizeof(op.s), "/%s", lxb.scratch); break;
                    case PDF_TOK_OPEN_ARRAY:  strcpy(op.s, "["); break;
                    case PDF_TOK_CLOSE_ARRAY: strcpy(op.s, "]"); break;
                    case PDF_TOK_KEYWORD:
                        strncpy(op.s, lxb.scratch, sizeof(op.s)-1); break;
                    default: break;
                    }

                    if (tok != PDF_TOK_KEYWORD) {
                        if (op.s[0] && stk_top < SSTK) stk[stk_top++] = op;
                        if (op.s[0]) fz_append_printf(ctx, new_buf, "%s ", op.s);
                        continue;
                    }

                    const char *kw = op.s;

                    /* BT / ET */
                    if (!strcmp(kw,"BT")) {
                        in_text=1;
                        /* Tm/Lm のみリセット。Tr はテキスト状態(グラフィックス状態)
                         * として BT/ET をまたいで持続するためここでは触らない。 */
                        memset(tm,0,sizeof(tm)); tm[0]=tm[3]=1;
                        memset(lm,0,sizeof(lm)); lm[0]=lm[3]=1;
                        fz_append_string(ctx, new_buf, "BT\n");
                        stk_top=0; continue;
                    }
                    if (!strcmp(kw,"ET")) {
                        in_text=0;
                        /* Tr を確実に 0 に戻す */
                        if (tr_mode!=0) fz_append_string(ctx, new_buf, "0 Tr\n");
                        tr_mode=0;
                        fz_append_string(ctx, new_buf, "ET\n");
                        stk_top=0; continue;
                    }

                    if (!in_text) {
                        /* グラフィックス状態 CTM の追跡 (BT 外でのみ更新可能) */
                        if (!strcmp(kw,"q")) {
                            if (gs_sp < 31) { gs_stack[gs_sp+1] = gs_stack[gs_sp]; gs_sp++; }
                        } else if (!strcmp(kw,"Q")) {
                            if (gs_sp > 0) gs_sp--;
                        } else if (!strcmp(kw,"cm") && stk_top >= 6) {
                            fz_matrix cm = {
                                stk[stk_top-6].v, stk[stk_top-5].v, stk[stk_top-4].v,
                                stk[stk_top-3].v, stk[stk_top-2].v, stk[stk_top-1].v };
                            gs_stack[gs_sp] = fz_concat(cm, gs_stack[gs_sp]);
                        } else if (!strcmp(kw,"Tr") && stk_top >= 1) {
                            /* Tr はグラフィックス状態で BT/ET をまたいで持続する。
                             * BT 外で設定されるケースも追跡し、取り違え防止の
                             * 描画モード判定 (kozou_tr_is_invisible) を正確に保つ。 */
                            tr_mode = (int)stk[stk_top-1].v;
                        }
                        fz_append_printf(ctx, new_buf, "%s\n", kw);
                        stk_top=0; continue;
                    }

                    /* テキスト行列 */
                    if (!strcmp(kw,"Tm")&&stk_top>=6) {
                        for(int k=0;k<6;k++) tm[k]=stk[stk_top-6+k].v;
                        memcpy(lm,tm,sizeof(tm));
                        fz_append_printf(ctx,new_buf,"%s\n",kw); stk_top=0; continue;
                    }
                    if (!strcmp(kw,"Td")&&stk_top>=2) {
                        float tx=stk[stk_top-2].v,ty=stk[stk_top-1].v;
                        lm[4]+=tx*lm[0]+ty*lm[2]; lm[5]+=tx*lm[1]+ty*lm[3];
                        memcpy(tm,lm,sizeof(lm));
                        fz_append_printf(ctx,new_buf,"%s\n",kw); stk_top=0; continue;
                    }
                    if (!strcmp(kw,"TD")&&stk_top>=2) {
                        float tx=stk[stk_top-2].v,ty=stk[stk_top-1].v;
                        leading=-ty;
                        lm[4]+=tx*lm[0]+ty*lm[2]; lm[5]+=tx*lm[1]+ty*lm[3];
                        memcpy(tm,lm,sizeof(lm));
                        fz_append_printf(ctx,new_buf,"%s\n",kw); stk_top=0; continue;
                    }
                    if (!strcmp(kw,"T*")) {
                        lm[4]+=leading*lm[2]; lm[5]+=leading*lm[3];
                        memcpy(tm,lm,sizeof(lm));
                        fz_append_string(ctx,new_buf,"T*\n"); stk_top=0; continue;
                    }
                    if (!strcmp(kw,"Tf")&&stk_top>=2) {
                        font_size=stk[stk_top-1].v;
                        const char *fn=stk[stk_top-2].s;
                        if(fn[0]=='/') fn++;
                        strncpy(cur_font,fn,sizeof(cur_font)-1);
                        fz_append_printf(ctx,new_buf,"%s\n",kw); stk_top=0; continue;
                    }
                    if (!strcmp(kw,"Tr")&&stk_top>=1) {
                        tr_mode=(int)stk[stk_top-1].v;
                        fz_append_printf(ctx,new_buf,"%s\n",kw); stk_top=0; continue;
                    }

                    /* ── Tj: 単一文字列 ── */
                    if (!strcmp(kw,"Tj")&&stk_top>=1&&stk[stk_top-1].is_str) {
                        /* テキスト原点 (tm.e, tm.f) → グラフィックス CTM → page_ctm
                         * の順で適用し、stext の origin と同じデバイス座標を得る。 */
                        fz_point dp = fz_transform_point(fz_make_point(tm[4], tm[5]), gs_stack[gs_sp]);
                        dp = fz_transform_point(dp, page_ctm);
                        float dev_x = dp.x, dev_y = dp.y;
                        /* この Tj が実際に描くグリフの identity を stext から取得
                         * 隣接グリフを誤検出しないよう placement tolerance と同じ半径を使う */
                        int   g_ucs = -1; float g_size = 0.0f;
                        int   have_g = kozou_quad_map_lookup_glyph(
                            qmap, dev_x, dev_y, tol2, &g_ucs, &g_size);
                        int origin_is_target = kozou_sanitize_is_target(
                            pi_targets,pi_n,dev_x,dev_y,tol2,
                            kozou_tr_is_invisible(tr_mode),have_g,g_ucs,g_size);

                        /* Step 1: 文字単位でスキャンしながら、各文字ごとに個別に
                         * 「対象(埋没/低コントラスト)かどうか」を判定して記録する。
                         * かつては Tj 文字列内に1文字でも対象があれば文字列全体を
                         * 空白化していたが、これだと被覆矩形の外側/境界付近にある
                         * 対象外の隣接文字まで巻き添えで消えてしまう不具合があった
                         * (例: 部分幅の矩形の右側にはみ出した文字、被覆率境界付近の文字)。
                         * このため文字単位で判定し、対象と非対象を連続ランに分けて
                         * 個別に出力する。SOp.s は char[128] なのでデコード後の文字数は
                         * 常に128未満に収まる。 */
#define KOZOU_TJ_MAX_CH 128
                        const char *ch_start[KOZOU_TJ_MAX_CH];
                        const char *ch_end[KOZOU_TJ_MAX_CH];
                        int         ch_blank[KOZOU_TJ_MAX_CH];
                        float       ch_w[KOZOU_TJ_MAX_CH];
                        int         n_ch = 0;
                        int         any_blank = 0;

                        pdf_obj *fobj2 = font_dict ?
                            pdf_dict_gets(ctx,font_dict,cur_font) : NULL;
                        int is_mb2 = kozou_is_multibyte_font(ctx, fobj2);
                        float adv = 0.0f;
                        const char *p2 = stk[stk_top-1].s + 1;
                        while (*p2 && *p2 != ')' && n_ch < KOZOU_TJ_MAX_CH) {
                            const char *cstart = p2;
                            int cc2;
                            if (*p2 == '\\') {
                                p2++;
                                if (*p2 >= '0' && *p2 <= '7') {
                                    cc2 = (*p2++ - '0');
                                    if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                    if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                } else { cc2 = (unsigned char)*p2++; }
                            } else { cc2 = (unsigned char)*p2++; }
                            if (is_mb2 && *p2 && *p2 != ')') {
                                int lo2;
                                if (*p2 == '\\') {
                                    p2++;
                                    if (*p2 >= '0' && *p2 <= '7') {
                                        lo2 = (*p2++ - '0');
                                        if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                        if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                    } else { lo2 = (unsigned char)*p2++; }
                                } else { lo2 = (unsigned char)*p2++; }
                                cc2 = (cc2 << 8) | lo2;
                            }
                            float cw = kozou_get_char_width_1000(ctx, pdf, fobj2, cc2);
                            float adv_pts = adv * font_size / 1000.0f;
                            float cx = tm[4] + adv_pts * tm[0];
                            float cy = tm[5] + adv_pts * tm[1];
                            fz_point cp = fz_transform_point(fz_make_point(cx, cy), gs_stack[gs_sp]);
                            cp = fz_transform_point(cp, page_ctm);
                            int g2_ucs = -1; float g2_size = 0.0f;
                            int have_g2 = kozou_quad_map_lookup_glyph(qmap, cp.x, cp.y, tol2, &g2_ucs, &g2_size);
                            /* 先頭文字は Tj 原点そのものの判定も orgin_is_target として尊重する
                             * (原点座標と先頭文字位置が完全一致しないケースの取りこぼし防止) */
                            int this_blank = (n_ch == 0 && origin_is_target) ||
                                kozou_sanitize_is_target(pi_targets,pi_n,cp.x,cp.y,tol2,
                                    kozou_tr_is_invisible(tr_mode),have_g2,g2_ucs,g2_size);
                            ch_start[n_ch] = cstart;
                            ch_end[n_ch]   = p2;
                            ch_blank[n_ch] = this_blank;
                            ch_w[n_ch]     = cw;
                            if (this_blank) any_blank = 1;
                            n_ch++;
                            adv += cw;
                        }

                        if (!any_blank) {
                            fz_append_printf(ctx,new_buf,"%s\n",kw);
                        } else {
                            /* Step 2: 対象/非対象それぞれの連続ランごとにまとめて出力する。
                             * 非対象ランは元のバイト列をそのまま書き戻す(再エスケープ不要で安全)。
                             * 対象ランは Helvetica の空白 + 幅差分TJ補正で置換する
                             * (従来の全文字列一括置換と同じ手法をラン単位に適用)。 */
                            float quad_w = kozou_quad_map_lookup(
                                qmap, dev_x, dev_y, tol2 * 4.0f);
                            int i = 0;
                            while (i < n_ch) {
                                int j = i;
                                int blank_run = ch_blank[i];
                                while (j < n_ch && ch_blank[j] == blank_run) j++;
                                if (!blank_run) {
                                    fz_append_byte(ctx,new_buf,'(');
                                    fz_append_data(ctx,new_buf, ch_start[i],
                                        (size_t)(ch_end[j-1] - ch_start[i]));
                                    fz_append_string(ctx,new_buf,") Tj\n");
                                } else {
                                    int   run_n = j - i;
                                    float orig_w = 0.0f;
                                    for (int k=i;k<j;k++) orig_w += ch_w[k];
                                    /* quad幅(実描画幅)が取得できる場合、文字列全体の幅に対する
                                     * このランの advance 比率で按分して近似する */
                                    float eff_orig = orig_w;
                                    if (quad_w > 0.0f && adv > 0.0f)
                                        eff_orig = quad_w * (orig_w / adv);
                                    float sp_total = KOZOU_HELVETICA_SPACE_WIDTH * run_n;
                                    float diff = eff_orig - sp_total;
                                    if (diff>200.0f||diff<-200.0f) page_warn=1;
                                    fz_append_printf(ctx,new_buf,
                                        "/KOZOU_NORMAL gs\n/KOZOU_HV %.4f Tf\n0 Tr\n",
                                        font_size);
                                    if (diff>0.5f||diff<-0.5f) {
                                        fz_append_string(ctx,new_buf,"[(");
                                        for(int k=0;k<run_n;k++) fz_append_byte(ctx,new_buf,0x20);
                                        fz_append_printf(ctx,new_buf,") %.2f] TJ\n",-diff);
                                    } else {
                                        fz_append_string(ctx,new_buf,"(");
                                        for(int k=0;k<run_n;k++) fz_append_byte(ctx,new_buf,0x20);
                                        fz_append_string(ctx,new_buf,") Tj\n");
                                    }
                                    fz_append_printf(ctx,new_buf,
                                        "/%s %.4f Tf\n%d Tr\n",
                                        cur_font, font_size, tr_mode);
                                }
                                i = j;
                            }
                            modified=1;
                        }
#undef KOZOU_TJ_MAX_CH
                        stk_top=0; continue;
                    }

                    /* ── TJ: 配列形式 ── */
                    if (!strcmp(kw,"TJ")) {
                        fz_point dp = fz_transform_point(fz_make_point(tm[4], tm[5]), gs_stack[gs_sp]);
                        dp = fz_transform_point(dp, page_ctm);
                        float dev_x = dp.x, dev_y = dp.y;
                        /* この TJ の先頭グリフ identity を stext から取得
                         * 隣接グリフを誤検出しないよう placement tolerance と同じ半径を使う */
                        int   g_ucs = -1; float g_size = 0.0f;
                        int   have_g = kozou_quad_map_lookup_glyph(
                            qmap, dev_x, dev_y, tol2, &g_ucs, &g_size);
                        int origin_is_target = kozou_sanitize_is_target(
                            pi_targets,pi_n,dev_x,dev_y,tol2,
                            kozou_tr_is_invisible(tr_mode),have_g,g_ucs,g_size);
                        pdf_obj *fobj_tj = font_dict ?
                            pdf_dict_gets(ctx,font_dict,cur_font) : NULL;
                        int is_mb_tj = kozou_is_multibyte_font(ctx, fobj_tj);
                        int arr_s = -1;
                        for (int k = 0; k < stk_top; k++)
                            if (!strcmp(stk[k].s,"[")) { arr_s = k+1; break; }

                        /* Pass 1: 配列全体を走査し、対象文字が1つでもあるかを判定する
                         * (この段階では位置だけ把握し、まだ何も出力しない)。 */
                        int   any_blank = 0;
                        float tj_adv = 0.0f;
                        int   first_char_seen = 0;
                        for (int k = arr_s >= 0 ? arr_s : 0; k < stk_top; k++) {
                            if (stk[k].is_str) {
                                const char *p2 = stk[k].s + 1;
                                while (*p2 && *p2 != ')') {
                                    int cc2;
                                    if (*p2 == '\\') {
                                        p2++;
                                        if (*p2 >= '0' && *p2 <= '7') {
                                            cc2 = (*p2++ - '0');
                                            if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                            if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                        } else { cc2 = (unsigned char)*p2++; }
                                    } else { cc2 = (unsigned char)*p2++; }
                                    if (is_mb_tj && *p2 && *p2 != ')') {
                                        int lo2;
                                        if (*p2 == '\\') {
                                            p2++;
                                            if (*p2 >= '0' && *p2 <= '7') {
                                                lo2 = (*p2++ - '0');
                                                if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                                if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                            } else { lo2 = (unsigned char)*p2++; }
                                        } else { lo2 = (unsigned char)*p2++; }
                                        cc2 = (cc2 << 8) | lo2;
                                    }
                                    float cw2 = kozou_get_char_width_1000(ctx, pdf, fobj_tj, cc2);
                                    float adv_pts2 = tj_adv * font_size / 1000.0f;
                                    float cx2 = tm[4] + adv_pts2 * tm[0];
                                    float cy2 = tm[5] + adv_pts2 * tm[1];
                                    fz_point cp2 = fz_transform_point(fz_make_point(cx2, cy2), gs_stack[gs_sp]);
                                    cp2 = fz_transform_point(cp2, page_ctm);
                                    int g3_ucs = -1; float g3_size = 0.0f;
                                    int have_g3 = kozou_quad_map_lookup_glyph(qmap, cp2.x, cp2.y, tol2, &g3_ucs, &g3_size);
                                    int this_blank = (!first_char_seen && origin_is_target) ||
                                        kozou_sanitize_is_target(pi_targets,pi_n,cp2.x,cp2.y,tol2,
                                            kozou_tr_is_invisible(tr_mode),have_g3,g3_ucs,g3_size);
                                    first_char_seen = 1;
                                    if (this_blank) any_blank = 1;
                                    tj_adv += cw2;
                                }
                            } else if (strcmp(stk[k].s,"[") && strcmp(stk[k].s,"]")) {
                                /* TJ カーニング値は 1/1000 em 単位 (負=前進、正=後退) */
                                tj_adv -= (float)atof(stk[k].s);
                            }
                        }

                        if (!any_blank) {
                            fz_append_printf(ctx,new_buf,"%s\n",kw);
                        } else {
                            /* Pass 2: 対象/非対象を文字単位・連続ランで判定しながら出力する。
                             * 配列全体を一括で Helvetica に置換していた旧実装だと、対象外の
                             * 隣接文字(被覆矩形の外側にはみ出した部分など)まで巻き添えで
                             * 消えてしまうため、ランごとに Tj/TJ とフォント切替を分けて出す。
                             * カーニング数値はテキストを描かない [num] TJ として素通しする。 */
                            float tj_quad_w = kozou_quad_map_lookup(
                                qmap, dev_x, dev_y, tol2 * 4.0f);
                            float tj_adv2 = 0.0f;
                            int   first_char_seen2 = 0;
#define KOZOU_TJ_ELEM_MAX 128
                            for (int k = arr_s >= 0 ? arr_s : 0; k < stk_top; k++) {
                                if (stk[k].is_str) {
                                    const char *ch_start[KOZOU_TJ_ELEM_MAX];
                                    const char *ch_end[KOZOU_TJ_ELEM_MAX];
                                    int         ch_blank[KOZOU_TJ_ELEM_MAX];
                                    float       ch_w[KOZOU_TJ_ELEM_MAX];
                                    int         n_ch = 0;
                                    float       elem_w = 0.0f;
                                    const char *p2 = stk[k].s + 1;
                                    while (*p2 && *p2 != ')' && n_ch < KOZOU_TJ_ELEM_MAX) {
                                        const char *cstart = p2;
                                        int cc2;
                                        if (*p2 == '\\') {
                                            p2++;
                                            if (*p2 >= '0' && *p2 <= '7') {
                                                cc2 = (*p2++ - '0');
                                                if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                                if (*p2 >= '0' && *p2 <= '7') cc2 = cc2*8 + (*p2++ - '0');
                                            } else { cc2 = (unsigned char)*p2++; }
                                        } else { cc2 = (unsigned char)*p2++; }
                                        if (is_mb_tj && *p2 && *p2 != ')') {
                                            int lo2;
                                            if (*p2 == '\\') {
                                                p2++;
                                                if (*p2 >= '0' && *p2 <= '7') {
                                                    lo2 = (*p2++ - '0');
                                                    if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                                    if (*p2 >= '0' && *p2 <= '7') lo2 = lo2*8 + (*p2++ - '0');
                                                } else { lo2 = (unsigned char)*p2++; }
                                            } else { lo2 = (unsigned char)*p2++; }
                                            cc2 = (cc2 << 8) | lo2;
                                        }
                                        float cw2 = kozou_get_char_width_1000(ctx, pdf, fobj_tj, cc2);
                                        float adv_pts2 = tj_adv2 * font_size / 1000.0f;
                                        float cx2 = tm[4] + adv_pts2 * tm[0];
                                        float cy2 = tm[5] + adv_pts2 * tm[1];
                                        fz_point cp2 = fz_transform_point(fz_make_point(cx2, cy2), gs_stack[gs_sp]);
                                        cp2 = fz_transform_point(cp2, page_ctm);
                                        int g3_ucs = -1; float g3_size = 0.0f;
                                        int have_g3 = kozou_quad_map_lookup_glyph(qmap, cp2.x, cp2.y, tol2, &g3_ucs, &g3_size);
                                        int this_blank = (!first_char_seen2 && origin_is_target) ||
                                            kozou_sanitize_is_target(pi_targets,pi_n,cp2.x,cp2.y,tol2,
                                                kozou_tr_is_invisible(tr_mode),have_g3,g3_ucs,g3_size);
                                        first_char_seen2 = 1;
                                        ch_start[n_ch]=cstart; ch_end[n_ch]=p2;
                                        ch_blank[n_ch]=this_blank; ch_w[n_ch]=cw2;
                                        n_ch++;
                                        elem_w += cw2;
                                        tj_adv2 += cw2;
                                    }
                                    /* この文字列要素の実描画幅: quadマップの値があれば優先 */
                                    float eff_elem_w = (tj_quad_w > 0.0f) ? tj_quad_w : elem_w;
                                    int i = 0;
                                    while (i < n_ch) {
                                        int j = i;
                                        int blank_run = ch_blank[i];
                                        while (j < n_ch && ch_blank[j] == blank_run) j++;
                                        if (!blank_run) {
                                            fz_append_byte(ctx,new_buf,'(');
                                            fz_append_data(ctx,new_buf, ch_start[i],
                                                (size_t)(ch_end[j-1]-ch_start[i]));
                                            fz_append_string(ctx,new_buf,") Tj\n");
                                        } else {
                                            int   run_n = j - i;
                                            float run_w = 0.0f;
                                            for (int m=i;m<j;m++) run_w += ch_w[m];
                                            float eff_run = (elem_w > 0.0f)
                                                ? eff_elem_w * (run_w / elem_w) : eff_elem_w;
                                            float sp_total = KOZOU_HELVETICA_SPACE_WIDTH * run_n;
                                            float diff = eff_run - sp_total;
                                            if (diff>200.0f||diff<-200.0f) page_warn=1;
                                            fz_append_printf(ctx,new_buf,
                                                "/KOZOU_NORMAL gs\n/KOZOU_HV %.4f Tf\n0 Tr\n",
                                                font_size);
                                            if (diff>0.5f||diff<-0.5f) {
                                                fz_append_string(ctx,new_buf,"[(");
                                                for(int m=0;m<run_n;m++) fz_append_byte(ctx,new_buf,0x20);
                                                fz_append_printf(ctx,new_buf,") %.2f] TJ\n",-diff);
                                            } else {
                                                fz_append_string(ctx,new_buf,"(");
                                                for(int m=0;m<run_n;m++) fz_append_byte(ctx,new_buf,0x20);
                                                fz_append_string(ctx,new_buf,") Tj\n");
                                            }
                                            fz_append_printf(ctx,new_buf,
                                                "/%s %.4f Tf\n%d Tr\n",
                                                cur_font, font_size, tr_mode);
                                        }
                                        i = j;
                                    }
                                } else if (strcmp(stk[k].s,"[") && strcmp(stk[k].s,"]")) {
                                    /* カーニング値: テキストを描かない位置調整のみの TJ として素通し */
                                    fz_append_printf(ctx,new_buf,"[%s] TJ\n",stk[k].s);
                                    tj_adv2 -= (float)atof(stk[k].s);
                                }
                            }
#undef KOZOU_TJ_ELEM_MAX
                            modified=1;
                        }
                        stk_top=0; continue;
                    }

                    fz_append_printf(ctx,new_buf,"%s\n",kw);
                    stk_top=0;
                }
                } /* fz_try */
                fz_always(ctx) { pdf_lexbuf_fin(ctx, &lxb); }
                fz_catch(ctx) {
                    fz_drop_stream(ctx, stm);
                    fz_drop_buffer(ctx, orig_buf);
                    fz_drop_buffer(ctx, new_buf);
                    fz_rethrow(ctx);
                }

                fz_drop_stream(ctx, stm);
                fz_drop_buffer(ctx, orig_buf);

                if (modified) {
                    pdf_obj *new_stm = pdf_add_stream(ctx, pdf, new_buf, NULL, 0);
                    pdf_dict_put_drop(ctx, page_obj, PDF_NAME(Contents), new_stm);
                }
                fz_drop_buffer(ctx, new_buf);
                if (page_warn) width_warn=1;
                if (qmap) { fz_free(ctx, qmap); qmap = NULL; }
            }
            fz_always(ctx) {
                if (page) { pdf_drop_page(ctx, page); page=NULL; }
            }
            fz_catch(ctx) {
                fz_warn(ctx, "sanitize: skip page %d: %s", pi, fz_caught_message(ctx));
            }
        }
        fz_free(ctx, pi_targets);

        /* 注意: targets はこの後の XObject 処理ループ（下記）でも
         * 参照・更新される（targets[i].in_xobj = 1 など）。
         * ここで解放すると use-after-free となり、buried テキストを含む
         * PDF の無害化時に SEGV を引き起こす。解放は XObject ループ完了後に行う。 */

        if (width_warn)
            strncpy(result->message,
                "WARNING: large glyph width difference detected (>200/1000em). "
                "Layout may shift slightly for wide characters (e.g. CJK).",
                sizeof(result->message)-1);

        /* XObject 内ターゲットの処理（各ページごと）:
         * ページ pi をロードし、そのページの XObject を特定して書き換える。
         * 同じ XObject が複数ページで参照される場合の二重書き換えを防ぐ。 */
        /* XObject 処理用の配列はすべてヒープ確保（スタックオーバーフロー防止）。
         * KOZOU_SANITIZE_MAX 個の配列をスタックに置くと数MB消費し、
         * ページループ内での確保でスタックを使い果たして segfault する。 */
        int *done_xrefs = (int *)fz_malloc(ctx, sizeof(int) * KOZOU_SANITIZE_MAX);
        int *xobj_xrefs = (int *)fz_malloc(ctx, sizeof(int) * KOZOU_SANITIZE_MAX);
        KozouSanitizeOrigin *page_targets = (KozouSanitizeOrigin *)fz_malloc(ctx,
            sizeof(KozouSanitizeOrigin) * KOZOU_SANITIZE_MAX);
        int n_done = 0;
        for (int pi = 0; pi < page_count; pi++)
{
            /* 現在処理中のページをロードして XObject を特定 */
            pdf_page *xobj_search_page = NULL;
            fz_try(ctx) {
                xobj_search_page = pdf_load_page(ctx, pdf, pi);
            } fz_catch(ctx) { xobj_search_page = NULL; }

            /* このページの stext マップ (デバイス座標→グリフ identity) を構築。
             * XObject 内 Tj の無害化時に「文字そのもの」を照合して取り違えを防ぐ。
             * stext はページ全体 (XObject 内部含む) をデバイス座標で展開するため、
             * XObject 内グリフのデバイス座標でもこのマップで identity を引ける。 */
            KozouQuadMap *xqmap = NULL;
            if (xobj_search_page) {
                fz_stext_page *xstext = NULL;
                fz_var(xstext); fz_var(xqmap);
                fz_try(ctx) {
                    xqmap = (KozouQuadMap *)fz_malloc(ctx, sizeof(KozouQuadMap));
                    memset(xqmap, 0, sizeof(KozouQuadMap));
                    fz_stext_options sopts = {
                        FZ_STEXT_PRESERVE_WHITESPACE | FZ_STEXT_ACCURATE_BBOXES, 0 };
                    xstext = fz_new_stext_page_from_page(
                        ctx, (fz_page *)xobj_search_page, &sopts);
                    for (fz_stext_block *blk = xstext->first_block; blk; blk = blk->next) {
                        if (blk->type != FZ_STEXT_BLOCK_TEXT) continue;
                        for (fz_stext_line *ln = blk->u.t.first_line; ln; ln = ln->next)
                            for (fz_stext_char *ch = ln->first_char; ch; ch = ch->next) {
                                if (xqmap->count >= KOZOU_QUAD_MAP_MAX) break;
                                KozouQuadEntry *e = &xqmap->entries[xqmap->count++];
                                e->ox = ch->origin.x; e->oy = ch->origin.y;
                                e->size = ch->size;   e->ucs = ch->c;
                                e->width_1000 = kozou_quad_width_1000(&ch->quad, ch->size);
                            }
                    }
                } fz_always(ctx) {
                    if (xstext) fz_drop_stext_page(ctx, xstext);
                } fz_catch(ctx) {
                    if (xqmap) { fz_free(ctx, xqmap); xqmap = NULL; }
                }
            }

            /* buried XObject 特定: このページ pi のターゲットを使用
             * xobj_search_page は pi ページをロード済み */
            int n_xrefs = 0;
            if (xobj_search_page) {
            for (int i = 0; i < n; i++) {
                if (targets[i].page_index >= 0 && targets[i].page_index != pi) continue;
                if (!targets[i].is_buried) continue; /* buried のみ XObject 処理 */
                float ix = targets[i].ix; /* Tm の tx (internal_origin x) */
                float iy = targets[i].iy; /* Tm の ty (internal_origin y) */
                if (ix == 0.0f && iy == 0.0f) continue;
                /* Tm 座標に一致する全XObjectを収集（複数コピーがある場合も漏れなく処理）*/
                int tmp_xr[64]; int n_tmp = 0;
                kozou_find_all_xobjs_by_tm(ctx, pdf, xobj_search_page,
                                           ix, iy, 2.0f, tmp_xr, &n_tmp, 64);
                if (n_tmp > 0) {
                    targets[i].in_xobj = 1;
                    for (int k = 0; k < n_tmp; k++) {
                        int dup = 0;
                        for (int j = 0; j < n_xrefs; j++) {
                            if (xobj_xrefs[j] == tmp_xr[k]) { dup = 1; break; }
                        }
                        if (!dup && n_xrefs < KOZOU_SANITIZE_MAX)
                            xobj_xrefs[n_xrefs++] = tmp_xr[k];
                    }
                }
            }
            } /* if xobj_search_page */
            /* 注意: xobj_search_page はこの後の各 XObject 処理で
             * kozou_get_xobj_place_ctm() に渡されるため、ここでは解放しない。
             * 早期に解放 (+NULL 代入) すると NULL ページが渡され、
             * pdf_page_resources() で NULL デリファレンス → SEGV になる。
             * 解放は XObject 処理ループ完了後（このページ反復の末尾）で行う。 */

            /* 各 XObject を処理 */
            for (int xi = 0; xi < n_xrefs; xi++) {
                int xref = xobj_xrefs[xi];
                /* 既に書き換え済みの XObject はスキップ（二重処理防止） */
                int already_done = 0;
                for (int _d = 0; _d < n_done; _d++) {
                    if (done_xrefs[_d] == xref) { already_done = 1; break; }
                }
                if (already_done) continue;
                if (n_done < KOZOU_SANITIZE_MAX) done_xrefs[n_done++] = xref;
                pdf_obj *xobj_obj = pdf_new_indirect(ctx, pdf, xref, 0);
                if (!xobj_obj) continue;

                fz_buffer *xobj_buf = NULL;
                fz_var(xobj_buf);
                fz_try(ctx) {
                    /* XObject のストリームを読み込む */
                    xobj_buf = pdf_load_stream(ctx, xobj_obj);
                    if (!xobj_buf) fz_throw(ctx, FZ_ERROR_ARGUMENT, "xobj stream null");

                    /* XObject の Resources からフォントを取得 */
                    pdf_obj *xobj_res = pdf_dict_get(ctx, xobj_obj, PDF_NAME(Resources));
                    pdf_obj *xobj_fonts = xobj_res ? pdf_dict_get(ctx, xobj_res, PDF_NAME(Font)) : NULL;

                    /* Helvetica フォントを XObject リソースに登録 */
                    if (!xobj_fonts) {
                        if (!xobj_res) {
                            xobj_res = pdf_new_dict(ctx, pdf, 1);
                            pdf_dict_put(ctx, xobj_obj, PDF_NAME(Resources), xobj_res);
                            pdf_drop_obj(ctx, xobj_res);
                            xobj_res = pdf_dict_get(ctx, xobj_obj, PDF_NAME(Resources));
                        }
                        xobj_fonts = pdf_new_dict(ctx, pdf, 1);
                        pdf_dict_put(ctx, xobj_res, PDF_NAME(Font), xobj_fonts);
                        pdf_drop_obj(ctx, xobj_fonts);
                        xobj_fonts = pdf_dict_get(ctx, xobj_res, PDF_NAME(Font));
                    }

                    /* KOZOU_HV フォントを登録（未登録の場合）*/
                    pdf_obj *hv_ref = pdf_dict_gets(ctx, xobj_fonts, KOZOU_HV);
                    if (!hv_ref) {
                        /* ページのフォントリソースから KOZOU_HV を探してコピー */
                        int np = pdf_count_pages(ctx, pdf);
                        for (int pi = 0; pi < np && !hv_ref; pi++) {
                            pdf_obj *pg  = pdf_lookup_page_obj(ctx, pdf, pi);
                            pdf_obj *pr  = pdf_dict_get_inheritable(ctx, pg, PDF_NAME(Resources));
                            pdf_obj *pf  = pr ? pdf_dict_get(ctx, pr, PDF_NAME(Font)) : NULL;
                            pdf_obj *phv = pf ? pdf_dict_gets(ctx, pf, KOZOU_HV) : NULL;
                            if (phv) {
                                pdf_dict_puts(ctx, xobj_fonts, KOZOU_HV, phv);
                                hv_ref = pdf_dict_gets(ctx, xobj_fonts, KOZOU_HV);
                            }
                        }
                    }

                    /* XObject ストリームに対してページと同じ書き換えを実行。
                     * ターゲットはデバイス座標 (ox,oy) で記録されているため、
                     * kozou_blank_all_bt_blocks_hv_ctm 内で XObject 配置 CTM と
                     * cm を積算してデバイス座標に変換し照合する。 */
                    fz_buffer *new_xobj_buf = fz_new_buffer(ctx, fz_buffer_storage(ctx, xobj_buf, NULL));

                    /* buried テキスト: kozou_blank_all_bt_blocks_hv で
                     * Tm 座標マッチングと Helvetica 幅補正を行う */
                    kozou_ensure_helvetica(ctx, pdf, xobj_obj);
                    pdf_obj *xobj_res2 = pdf_dict_get(ctx, xobj_obj, PDF_NAME(Resources));
                    pdf_obj *xobj_fonts2 = xobj_res2 ?
                        pdf_dict_get(ctx, xobj_res2, PDF_NAME(Font)) : NULL;
                    pdf_obj *hv_ref2 = xobj_fonts2 ?
                        pdf_dict_gets(ctx, xobj_fonts2, KOZOU_HV) : NULL;
                    /* このページ pi 向けターゲットのみで XObject を書き換え */
                    {
                        int n_page = 0;
                        for (int _pi = 0; _pi < n && n_page < KOZOU_SANITIZE_MAX; _pi++) {
                            if (targets[_pi].page_index >= 0 && targets[_pi].page_index != pi) continue;
                            if (!targets[_pi].is_buried) continue; /* buried のみ */
                            page_targets[n_page++] = targets[_pi];
                        }
                        /* n_page==0 のときは呼ばない（全BT blank を防ぐ）*/
                        if (n_page > 0) {
                            /* この XObject の「ローカル → ページデバイス座標」配置
                             * CTM を取得し、各 Tj をデバイス座標に変換して ox/oy と
                             * 照合する。XObject 内で同一 Tm を持つ複数ブロックが
                             * 異なる cm で別の場所に配置されていても、cm を追跡する
                             * ことで一意に区別できる。 */
                            fz_matrix place_ctm;
                            int got = kozou_get_xobj_place_ctm(ctx, pdf,
                                xobj_search_page, xref, &place_ctm);
                            if (got) {
                                kozou_blank_all_bt_blocks_hv_ctm(ctx, pdf, xobj_fonts2,
                                    xobj_buf, new_xobj_buf, hv_ref2,
                                    page_targets, n_page, 4.0f, place_ctm, xqmap);
                            } else {
                                /* 配置 CTM 不明: 安全側で元ストリームをコピー */
                                unsigned char *sd = NULL;
                                size_t sl = fz_buffer_storage(ctx, xobj_buf, &sd);
                                if (sd && sl) fz_append_data(ctx, new_xobj_buf, sd, sl);
                            }
                        } else {
                            /* ターゲットなし: 元のストリームをそのままコピー */
                            unsigned char *sd = NULL;
                            size_t sl = fz_buffer_storage(ctx, xobj_buf, &sd);
                            if (sd && sl) fz_append_data(ctx, new_xobj_buf, sd, sl);
                        }
                    }
                    /* 安全ガード（取り違え・破壊の防止）:
                     * 書き換え後に Tj 総数が元より減っていたら、それは可視テキストを
                     * 含む内容の欠落を意味する（ページ全体を内包するラッパー XObject を
                     * 誤って書き換え対象にした場合などに発生）。
                     * その書き換えは破棄し、元ストリームをそのまま使う。
                     * → 隠しテキストが残る方向（false negative）の安全側に倒し、
                     *   ページの可視テキストを絶対に壊さない。 */
                    {
                        long tj_in  = kozou_count_tj_ops(ctx, xobj_buf);
                        long tj_out = kozou_count_tj_ops(ctx, new_xobj_buf);
                        if (tj_out < tj_in) {
                            fprintf(stderr,
                                "[sanitize] xobj xref=%d: rewrite dropped content "
                                "(Tj %ld -> %ld); keeping ORIGINAL stream to avoid "
                                "destroying visible text\n", xref, tj_in, tj_out);
                            fz_drop_buffer(ctx, new_xobj_buf);
                            new_xobj_buf = fz_new_buffer(ctx, 0);
                            unsigned char *sd = NULL;
                            size_t sl = fz_buffer_storage(ctx, xobj_buf, &sd);
                            if (sd && sl) fz_append_data(ctx, new_xobj_buf, sd, sl);
                        }
                    }
                    pdf_update_stream(ctx, pdf, xobj_obj, new_xobj_buf, 0);
                    fz_drop_buffer(ctx, new_xobj_buf);
                }
                fz_always(ctx) {
                    if (xobj_buf) fz_drop_buffer(ctx, xobj_buf);
                    pdf_drop_obj(ctx, xobj_obj);
                }
                fz_catch(ctx) {
                    /* XObject の書き換え失敗は警告のみ（致命的エラーにしない） */
                    fprintf(stderr, "[sanitize] xobj xref=%d write failed: %s\n",
                            xref, fz_caught_message(ctx));
                }
            }
            /* このページの XObject 処理が完了したのでページを解放する。 */
            if (xqmap) { fz_free(ctx, xqmap); xqmap = NULL; }
            if (xobj_search_page) { pdf_drop_page(ctx, xobj_search_page); xobj_search_page = NULL; }
        }
        fz_free(ctx, done_xrefs);
        fz_free(ctx, xobj_xrefs);
        fz_free(ctx, page_targets);

        /* targets は XObject 処理ループまで参照されるため、ここで解放する */
        fz_free(ctx, targets);

        pdf_write_options opts = pdf_default_write_options;
        opts.do_compress        = 1;
        opts.do_compress_images = 1;
        opts.do_garbage         = 2;
        pdf_save_document(ctx, pdf, output_path, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (pdf) fz_drop_document(ctx, (fz_document *)pdf);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}


/* ================================================================== */
/* 特殊制御文字検出                                                     */
/*                                                                     */
/* AIへの悪意ある注入や隠蔽に使われる可能性のある特殊制御文字を検出。   */
/*                                                                     */
/* 検出対象:                                                            */
/*   U+200B〜200F  ゼロ幅文字 (ZWSP/ZWNJ/ZWJ/LRM/RLM)                */
/*   U+202A〜202E  双方向制御文字 (LRE/RLE/PDF/LRO/RLO)               */
/*   U+2028/2029   行/段落区切り (LS/PS)                               */
/*   U+FEFF        ゼロ幅ノーブレークスペース (BOM/ZWNBSP)             */
/*   U+E0000〜E007F Unicode タグ文字 (不可視埋め込みタグ)              */
/*                                                                     */
/* 除外 (正常用途が多い):                                               */
/*   U+000A (LF), U+000D (CR), U+0009 (TAB)                           */
/*                                                                     */
/* 出力 JSON:                                                           */
/* { "ok": true, "page": N, "hits": [{                                 */
/*   "char": "U+200B",  ← コードポイント表記                           */
/*   "codepoint": 8203, ← 十進数                                       */
/*   "category": "zero_width",  ← 分類                                 */
/*   "reason": "control_char",                                          */
/*   "origin": [x, y],                                                 */
/*   "quad": [...],                                                     */
/*   "size": 12.0                                                       */
/* }] }                                                                 */
/* ================================================================== */

static const char *kozou_control_char_category(int cp)
{
    if (cp >= 0x200B && cp <= 0x200F) return "zero_width";
    if (cp >= 0x202A && cp <= 0x202E) return "bidi_control";
    if (cp == 0x2028 || cp == 0x2029) return "line_separator";
    if (cp == 0xFEFF)                  return "bom_zwnbsp";
    if (cp >= 0xE0000 && cp <= 0xE007F) return "tag_char";
    return NULL; /* 対象外 */
}

void kozou_detect_control_chars(
    fz_context  *ctx,
    const char  *path,
    int          page_index,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    fz_output   *out,
    FfiResult   *result)
{
    fz_document   *doc   = NULL;
    fz_page       *page  = NULL;
    fz_stext_page *stext = NULL;

    fz_var(doc);
    fz_var(page);
    fz_var(stext);

    fz_try(ctx) {
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        page  = fz_load_page(ctx, doc, page_index);
        fz_stext_options opts = { FZ_STEXT_PRESERVE_WHITESPACE |
                                  FZ_STEXT_ACCURATE_BBOXES, 0 };
        stext = fz_new_stext_page_from_page(ctx, page, &opts);

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

                    int cp = ch->c;
                    const char *cat = kozou_control_char_category(cp);
                    if (!cat) continue;

                    /* 無害化済みかチェック（Helveticaフォント + U+0020）
                     * ただし制御文字(U+200B等)はU+0020に置き換えられるため
                     * kozou_control_char_category(0x0020)==NULL で先にスキップされ
                     * ここには到達しない。念のためフォントチェックも追加する。 */
                    if (kozou_is_sanitized_space(cp) &&
                        kozou_is_helvetica_font(ctx, ch->font)) continue;
                    const char *reason = "control_char";

                    fz_quad  q = ch->quad;
                    fz_point o = ch->origin;

                    if (hit_count > 0) fz_write_printf(ctx, out, ",");
                    fz_write_printf(ctx, out,
                        "{"
                        "\"char\":\"U+%04X\","
                        "\"codepoint\":%d,"
                        "\"category\":\"%s\","
                        "\"reason\":\"%s\","
                        "\"origin\":[%.3f,%.3f],"
                        "\"quad\":[%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f],"
                        "\"size\":%.3f"
                        "}",
                        cp, cp, cat, reason,
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
/* N-up / 製本 面付けレンダリング                                       */
/*                                                                     */
/* 複数ページを1つのpixmapに直接レンダリングして1枚の画像として出力。  */
/* JPEG/PNG圧縮は最後の1回のみ行うため画質劣化が最小。               */
/*                                                                     */
/* 設計:                                                               */
/*   cols×rows のグリッドを作成し、各セルに1ページをレンダリング。     */
/*   各ページはセルにアスペクト比を維持してフィット（余白は白）。      */
/*   ページ番号配列 page_nums で配置を指定（0=空白セル、1始まり）。   */
/*                                                                     */
/* 出力バッファは呼び出し側が管理する（FfiBufferResult経由）。        */
/* ================================================================== */

/* ──────────────────────────────────────────────────────────────────
 * 1シート分の面付けpixmapを合成して返す（呼び出し側が drop する）。
 * doc は呼び出し側が開いて渡す。page_nums は cols*rows 個。
 * セルサイズは渡された page_nums の有効ページ最大寸法から決める。
 * out_cell_w_pt / out_cell_h_pt にセルの pt サイズ（PDF配置用）を返す。
 * ─────────────────────────────────────────────────────────────────── */
static fz_pixmap *kozou_compose_sheet_pixmap(
    fz_context  *ctx,
    fz_document *doc,
    int          page_count,
    const int   *page_nums,
    int          n_pages,
    int          cols,
    int          rows,
    float        dpi,
    int          gap_px,
    float       *out_cell_w_pt,
    float       *out_cell_h_pt)
{
    /* セルサイズ決定: 有効ページの最大幅・高さ */
    float max_w_pt = 595.0f, max_h_pt = 842.0f;
    int valid_count = 0;
    for (int i = 0; i < n_pages; i++) {
        int pno = page_nums[i] - 1;
        if (pno < 0 || pno >= page_count) continue;
        fz_page *pg = fz_load_page(ctx, doc, pno);
        fz_rect b = fz_bound_page(ctx, pg);
        float pw = b.x1 - b.x0;
        float ph = b.y1 - b.y0;
        if (valid_count == 0) { max_w_pt = pw; max_h_pt = ph; }
        else {
            if (pw > max_w_pt) max_w_pt = pw;
            if (ph > max_h_pt) max_h_pt = ph;
        }
        fz_drop_page(ctx, pg);
        valid_count++;
    }

    float scale  = dpi / 72.0f;
    int   cell_w = (int)(max_w_pt * scale + 0.5f);
    int   cell_h = (int)(max_h_pt * scale + 0.5f);
    int   g      = gap_px > 0 ? gap_px : 0;
    int   total_w = cols * cell_w + (cols + 1) * g;
    int   total_h = rows * cell_h + (rows + 1) * g;

    if (out_cell_w_pt) *out_cell_w_pt = max_w_pt;
    if (out_cell_h_pt) *out_cell_h_pt = max_h_pt;

    size_t total_bytes = (size_t)total_w * (size_t)total_h * 3;
    if (total_bytes > (size_t)1024 * 1024 * 1024) {
        fz_throw(ctx, FZ_ERROR_GENERIC,
            "imposition: output too large (%dx%d @ 3ch = %zuMB > 1024MB).",
            total_w, total_h, total_bytes / (1024*1024));
    }

    fz_colorspace *rgb = fz_device_rgb(ctx);
    fz_irect full_bbox = { 0, 0, total_w, total_h };
    fz_pixmap *pixmap = fz_new_pixmap_with_bbox(ctx, rgb, full_bbox, NULL, 0);
    fz_clear_pixmap_with_value(ctx, pixmap, 0xff);

    for (int i = 0; i < n_pages; i++) {
        int col = i % cols;
        int row = i / cols;
        int cell_x = g + col * (cell_w + g);
        int cell_y = g + row * (cell_h + g);
        int pno = page_nums[i] - 1;
        if (pno < 0 || pno >= page_count) continue; /* 空白セル=白のまま */

        fz_page *pg = NULL;
        fz_var(pg);
        fz_try(ctx) {
            pg = fz_load_page(ctx, doc, pno);
            fz_rect pb = fz_bound_page(ctx, pg);
            float pw_pt = pb.x1 - pb.x0;
            float ph_pt = pb.y1 - pb.y0;
            float sx = (float)cell_w / pw_pt;
            float sy = (float)cell_h / ph_pt;
            float fit_scale = (sx < sy) ? sx : sy;
            int render_w = (int)(pw_pt * fit_scale + 0.5f);
            int render_h = (int)(ph_pt * fit_scale + 0.5f);
            if (render_w > cell_w) render_w = cell_w;
            if (render_h > cell_h) render_h = cell_h;
            int off_x = cell_x + (cell_w - render_w) / 2;
            int off_y = cell_y + (cell_h - render_h) / 2;

            fz_matrix ctm = fz_scale(fit_scale, fit_scale);
            ctm = fz_pre_translate(ctm, -pb.x0, -pb.y0);

            fz_irect render_bbox = { 0, 0, render_w, render_h };
            fz_pixmap *cell_pix = fz_new_pixmap_with_bbox(ctx, rgb, render_bbox, NULL, 0);
            fz_clear_pixmap_with_value(ctx, cell_pix, 0xff);

            fz_device *draw_dev = fz_new_draw_device(ctx, ctm, cell_pix);
            fz_try(ctx) {
                fz_run_page(ctx, pg, draw_dev, fz_identity, NULL);
                fz_close_device(ctx, draw_dev);
            }
            fz_always(ctx) { fz_drop_device(ctx, draw_dev); }
            fz_catch(ctx) { fz_drop_pixmap(ctx, cell_pix); fz_rethrow(ctx); }

            {
                int src_stride = fz_pixmap_stride(ctx, cell_pix);
                int dst_stride = fz_pixmap_stride(ctx, pixmap);
                int comp       = fz_pixmap_components(ctx, pixmap);
                int copy_h = render_h, copy_w = render_w;
                if (off_y + copy_h > total_h) copy_h = total_h - off_y;
                if (off_x + copy_w > total_w) copy_w = total_w - off_x;
                if (copy_w > 0 && copy_h > 0) {
                    unsigned char *src = fz_pixmap_samples(ctx, cell_pix);
                    unsigned char *dst = fz_pixmap_samples(ctx, pixmap)
                        + off_y * dst_stride + off_x * comp;
                    for (int r = 0; r < copy_h; r++) {
                        memcpy(dst + r * dst_stride, src + r * src_stride,
                               (size_t)copy_w * comp);
                    }
                }
                fz_drop_pixmap(ctx, cell_pix);
            }
        }
        fz_always(ctx) { if (pg) { fz_drop_page(ctx, pg); pg = NULL; } }
        fz_catch(ctx) {
            fz_warn(ctx, "imposition: skip page %d: %s", pno+1, fz_caught_message(ctx));
        }
    }
    return pixmap;
}

/* ──────────────────────────────────────────────────────────────────
 * 面付け画像PDFを出力する。
 * 各シート（cols*rows ページ）を1枚のpixmapに合成し、
 * それを1つのPDFページ（cols*rows 合計サイズ、例: A3）として埋め込む。
 * sheet_pages: 全シートのページ番号を連結（1始まり、0=空白）。
 *   長さ = n_sheets * cells_per_sheet, cells_per_sheet = cols*rows。
 * ─────────────────────────────────────────────────────────────────── */
/* ──────────────────────────────────────────────────────────────────
 * 面付け解除（split / de-imposition）
 * 入力PDFのあるページを cols×rows のセルに均等分割し、指定セル (row,col)
 * だけをレンダリングした pixmap を返す（呼び出し側が drop する）。
 * 分割は均等。セルのページ内矩形を CTM で原点に移動してレンダリングする。
 * out_cell_w_pt / out_cell_h_pt にセルの pt サイズを返す。
 * ─────────────────────────────────────────────────────────────────── */
static fz_pixmap *kozou_render_cell(
    fz_context  *ctx,
    fz_document *doc,
    int          page_no_0based,
    int          cols,
    int          rows,
    int          cell_row,
    int          cell_col,
    float        dpi,
    float       *out_cell_w_pt,
    float       *out_cell_h_pt)
{
    fz_page *pg = fz_load_page(ctx, doc, page_no_0based);
    fz_pixmap *pix = NULL;
    fz_var(pix);
    fz_try(ctx) {
        fz_rect b = fz_bound_page(ctx, pg);
        float pw = b.x1 - b.x0;
        float ph = b.y1 - b.y0;
        /* 均等分割したセルのページ内矩形（PDF座標, 原点b.x0/b.y0基準） */
        float cw = pw / (float)cols;
        float ch = ph / (float)rows;
        /* セル矩形: 左上が (col, row)。PDF座標は左下原点なので
         * MuPDF のページ境界 b を使い、左→右=col, 上→下=row で配置する。
         * fz_bound_page は左上原点的に x0<x1, y0<y1。
         * 列は左から: x0 + col*cw。行は上から: y0 + row*ch。 */
        float cell_x0 = b.x0 + cell_col * cw;
        float cell_y0 = b.y0 + cell_row * ch;

        if (out_cell_w_pt) *out_cell_w_pt = cw;
        if (out_cell_h_pt) *out_cell_h_pt = ch;

        float scale = dpi / 72.0f;
        int px_w = (int)(cw * scale + 0.5f);
        int px_h = (int)(ch * scale + 0.5f);
        if (px_w < 1) px_w = 1;
        if (px_h < 1) px_h = 1;

        /* セル左上を出力原点に移動する CTM:
         * まずスケール、その後セル左上が (0,0) に来るよう平行移動。 */
        fz_matrix ctm = fz_scale(scale, scale);
        ctm = fz_pre_translate(ctm, -cell_x0, -cell_y0);

        fz_colorspace *rgb = fz_device_rgb(ctx);
        fz_irect bbox = { 0, 0, px_w, px_h };
        pix = fz_new_pixmap_with_bbox(ctx, rgb, bbox, NULL, 0);
        fz_clear_pixmap_with_value(ctx, pix, 0xff);

        fz_device *dev = fz_new_draw_device(ctx, ctm, pix);
        fz_try(ctx) {
            fz_run_page(ctx, pg, dev, fz_identity, NULL);
            fz_close_device(ctx, dev);
        }
        fz_always(ctx) { fz_drop_device(ctx, dev); }
        fz_catch(ctx) { fz_rethrow(ctx); }
    }
    fz_always(ctx) { fz_drop_page(ctx, pg); }
    fz_catch(ctx) {
        if (pix) { fz_drop_pixmap(ctx, pix); pix = NULL; }
        fz_rethrow(ctx);
    }
    return pix;
}

/* ──────────────────────────────────────────────────────────────────
 * 面付け解除して画像PDFを出力する。
 * cells: 出力順に並んだセル指定の配列。各セルは3要素 (page, row, col):
 *   - page: 入力PDFのページ番号（1始まり）
 *   - row : セルの行（0始まり）
 *   - col : セルの列（0始まり）
 * n_cells: 出力ページ数（= cells 配列の3要素組の個数）。
 * cols/rows: 分割数。
 * 各セルを1つのPDFページ（A4相当）として埋め込む。
 * ─────────────────────────────────────────────────────────────────── */
void kozou_split_imposition_pdf(
    fz_context  *ctx,
    const char  *input,
    const char  *output,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    const int   *cells,      /* n_cells*3 個: (page,row,col) を連結 */
    int          n_cells,
    int          cols,
    int          rows,
    float        dpi,
    int          quality,
    int          use_png,
    const char  *tmp_dir,
    FfiResult   *result)
{
    fz_document  *doc    = NULL;
    pdf_document *pdfout = NULL;
    fz_var(doc);
    fz_var(pdfout);

    fz_try(ctx) {
        doc = fz_open_document(ctx, input);
        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }
        int page_count = fz_count_pages(ctx, doc);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");
        if (dpi <= 0.0f) dpi = 150.0f;

        const char *base_tmp = (tmp_dir && tmp_dir[0]) ? tmp_dir : output;
        const char *ext      = use_png ? "png" : "jpg";

        pdfout = pdf_create_document(ctx);

        for (int k = 0; k < n_cells; k++) {
            int page = cells[k*3 + 0] - 1; /* 0始まり */
            int row  = cells[k*3 + 1];
            int col  = cells[k*3 + 2];

            /* page=0 (元の値が0=空白セル) の場合は白紙ページを挿入する。
             * page=-1 になるのでその条件で空白処理へ分岐する。 */
            if (page < 0) {
                /* 空白ページサイズ: 最初の有効ページ(page=0実体)のセルサイズを流用。
                 * 見つからなければデフォルト A4 相当(595×842pt)を使う。 */
                float blank_w = 595.0f, blank_h = 842.0f;
                /* 最初の有効セルを探してセルサイズを取得 */
                for (int j = 0; j < n_cells; j++) {
                    int pg2 = cells[j*3 + 0] - 1;
                    if (pg2 >= 0 && pg2 < page_count) {
                        float cw2 = 0, ch2 = 0;
                        fz_pixmap *pix2 = kozou_render_cell(ctx, doc, pg2,
                            cols, rows, cells[j*3+1], cells[j*3+2],
                            dpi, &cw2, &ch2);
                        fz_drop_pixmap(ctx, pix2);
                        if (cw2 > 0 && ch2 > 0) { blank_w = cw2; blank_h = ch2; }
                        break;
                    }
                }
                pdf_obj *bp_resources = pdf_new_dict(ctx, pdfout, 1);
                fz_buffer *bp_contents = fz_new_buffer(ctx, 4);
                fz_append_string(ctx, bp_contents, " ");
                fz_rect bp_box = { 0, 0, blank_w, blank_h };
                pdf_obj *bp_obj = pdf_add_page(ctx, pdfout, bp_box, 0,
                    bp_resources, bp_contents);
                pdf_insert_page(ctx, pdfout, -1, bp_obj);
                pdf_drop_obj(ctx, bp_obj);
                pdf_drop_obj(ctx, bp_resources);
                fz_drop_buffer(ctx, bp_contents);
                continue;
            } else if (page >= page_count) continue;

            fz_pixmap *pix      = NULL;
            fz_image  *image    = NULL;
            pdf_obj   *imgref   = NULL;
            fz_buffer *contents = NULL;
            pdf_obj   *resources= NULL;
            pdf_obj   *xobj_dict= NULL;
            pdf_obj   *page_obj = NULL;
            char tmp_img[1024]; tmp_img[0] = '\0';

            fz_var(pix); fz_var(image); fz_var(imgref);
            fz_var(contents); fz_var(resources); fz_var(xobj_dict); fz_var(page_obj);

            fz_try(ctx) {
                float cw_pt = 0, ch_pt = 0;
                pix = kozou_render_cell(ctx, doc, page, cols, rows,
                    row, col, dpi, &cw_pt, &ch_pt);

                snprintf(tmp_img, sizeof(tmp_img),
                         "%s" KOZOU_PATH_SEP "kozou_split_%d_%d.%s",
                         base_tmp, (int)getpid(), k, ext);

                if (use_png) {
                    fz_output *fout = fz_new_output_with_path(ctx, tmp_img, 0);
                    fz_try(ctx) {
                        fz_write_pixmap_as_png(ctx, fout, pix);
                        fz_close_output(ctx, fout);
                    }
                    fz_always(ctx) { fz_drop_output(ctx, fout); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                } else {
                    int jq = (quality > 0 && quality <= 100) ? quality : 85;
                    fz_save_pixmap_as_jpeg(ctx, pix, tmp_img, jq);
                }

                image  = fz_new_image_from_file(ctx, tmp_img);
                imgref = pdf_add_image(ctx, pdfout, image);

                resources = pdf_new_dict(ctx, pdfout, 1);
                xobj_dict = pdf_new_dict(ctx, pdfout, 1);
                {
                    pdf_obj *im0 = pdf_new_name(ctx, "Im0");
                    pdf_dict_put(ctx, xobj_dict, im0, imgref);
                    pdf_drop_obj(ctx, im0);
                }
                pdf_dict_put(ctx, resources, PDF_NAME(XObject), xobj_dict);

                char cs_buf[256];
                int cs_len = snprintf(cs_buf, sizeof(cs_buf),
                    "q\n%.4f 0 0 %.4f 0 0 cm\n/Im0 Do\nQ\n", cw_pt, ch_pt);
                contents = fz_new_buffer_from_copied_data(ctx,
                    (const unsigned char *)cs_buf, (size_t)cs_len);

                fz_rect mediabox = { 0, 0, cw_pt, ch_pt };
                page_obj = pdf_add_page(ctx, pdfout, mediabox, 0, resources, contents);
                pdf_insert_page(ctx, pdfout, -1, page_obj);
            }
            fz_always(ctx) {
                if (tmp_img[0]) remove(tmp_img);
                if (page_obj)  pdf_drop_obj(ctx, page_obj);
                if (xobj_dict) pdf_drop_obj(ctx, xobj_dict);
                if (resources) pdf_drop_obj(ctx, resources);
                if (contents)  fz_drop_buffer(ctx, contents);
                if (imgref)    pdf_drop_obj(ctx, imgref);
                if (image)     fz_drop_image(ctx, image);
                if (pix)       fz_drop_pixmap(ctx, pix);
            }
            fz_catch(ctx) { fz_rethrow(ctx); }
        }

        pdf_save_document(ctx, pdfout, output, NULL);
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

/* ──────────────────────────────────────────────────────────────────
 * ベクター保持の面付け結合（n-up / 見開き製本 / ページサイズ変更）
 *
 * グラフト方式(PyMuPDF の show_pdf_page と同方式)。各元ページの
 * コンテンツストリームをバイトそのままコピーし、/Resources(フォント・画像)を
 * ディープコピー(graft)して Form XObject 化し、出力ページに cm + Do で配置する。
 * → 画像も含めて再エンコードなしの無劣化で「ページ内容を丸ごとコピー」する。
 *
 * 各出力シートは target_w×target_h(pt)。cols×rows のセルに分割し、
 * sheet_pages(出力順, 1始まりページ番号, 0=空白)で指定の元ページを
 * 各セルへアスペクト比保持・中央寄せで配置する。
 *   sheet_pages 長さ = n_sheets * (cols*rows)、セル順は左上→右(行優先)→次行。
 *
 * 例) A4×4 → A3見開き2-up: cols=2,rows=1, target=A3横, n_sheets=2(表/裏)
 *
 * ※ 現状は /Rotate 0 のページ向け。/Rotate 90・270 等は警告を出すのみで
 *   向き補正は未対応(次段階)。
 * ─────────────────────────────────────────────────────────────────── */

/* 元ページの /Contents(stream または stream の配列) を1つのバッファに連結する。 */
static fz_buffer *kozou_compose_read_contents(fz_context *ctx, pdf_obj *pageref)
{
    pdf_obj   *contents = pdf_dict_get(ctx, pageref, PDF_NAME(Contents));
    fz_buffer *out      = fz_new_buffer(ctx, 1024);
    fz_try(ctx) {
        if (pdf_is_array(ctx, contents)) {
            int n = pdf_array_len(ctx, contents);
            for (int i = 0; i < n; i++) {
                fz_buffer *b = pdf_load_stream(ctx, pdf_array_get(ctx, contents, i));
                fz_try(ctx) {
                    fz_append_buffer(ctx, out, b);
                    fz_append_byte(ctx, out, '\n'); /* ストリーム境界の安全separator */
                }
                fz_always(ctx) { fz_drop_buffer(ctx, b); }
                fz_catch(ctx) { fz_rethrow(ctx); }
            }
        } else if (contents) {
            fz_buffer *b = pdf_load_stream(ctx, contents);
            fz_try(ctx) { fz_append_buffer(ctx, out, b); }
            fz_always(ctx) { fz_drop_buffer(ctx, b); }
            fz_catch(ctx) { fz_rethrow(ctx); }
        }
    }
    fz_catch(ctx) {
        fz_drop_buffer(ctx, out);
        fz_rethrow(ctx);
    }
    return out;
}

/* 元ページ(pno)を出力PDF(dst)内の Form XObject に変換して返す(呼び出し側が drop)。
 * /Resources は graft でディープコピー、/Contents はバイトコピー。
 * 返す XObject の /BBox は元ページの CropBox(無ければ MediaBox)。 */
static pdf_obj *kozou_compose_page_to_xobject(
    fz_context *ctx, pdf_document *src, pdf_document *dst,
    pdf_graft_map *gmap, int pno)
{
    pdf_obj *pageref = pdf_lookup_page_obj(ctx, src, pno); /* borrowed */

    pdf_obj *boxobj = pdf_dict_get_inheritable(ctx, pageref, PDF_NAME(CropBox));
    if (!pdf_is_array(ctx, boxobj))
        boxobj = pdf_dict_get_inheritable(ctx, pageref, PDF_NAME(MediaBox));
    fz_rect bbox;
    if (pdf_is_array(ctx, boxobj)) {
        bbox = pdf_to_rect(ctx, boxobj);
    } else {
        bbox.x0 = 0; bbox.y0 = 0; bbox.x1 = 595; bbox.y1 = 842;
    }
    if (bbox.x1 < bbox.x0) { float t = bbox.x0; bbox.x0 = bbox.x1; bbox.x1 = t; }
    if (bbox.y1 < bbox.y0) { float t = bbox.y0; bbox.y0 = bbox.y1; bbox.y1 = t; }

    int rot = pdf_to_int(ctx, pdf_dict_get_inheritable(ctx, pageref, PDF_NAME(Rotate)));
    /* /Rotate の向き補正は配置側 cm で行う（kozou_compose_imposition_pdf の配置ループ参照）。
     * ここでは未回転の XObject を作る（BBox=元ボックス, Matrix=identity）。
     * 直交以外（90 の倍数でない）の /Rotate は配置側で無視する。 */
    if (rot % 90 != 0)
        fz_warn(ctx, "compose: page %d has non-orthogonal /Rotate %d (will be ignored)",
                pno + 1, rot);

    pdf_obj    *res      = pdf_dict_get_inheritable(ctx, pageref, PDF_NAME(Resources)); /* borrowed */
    pdf_obj    *res2     = NULL;
    fz_buffer  *contents = NULL;
    pdf_obj    *xobj     = NULL;
    fz_var(res2); fz_var(contents); fz_var(xobj);
    fz_try(ctx) {
        res2     = res ? pdf_graft_mapped_object(ctx, gmap, res)
                       : pdf_new_dict(ctx, dst, 1);
        contents = kozou_compose_read_contents(ctx, pageref);
        /* Matrix は identity。配置側の cm で拡縮・移動する。 */
        xobj     = pdf_new_xobject(ctx, dst, bbox, fz_identity, res2, contents);
        fprintf(stderr,
            "[compose] page %d -> xobject: contents=%zu bytes bbox=[%g %g %g %g] rotate=%d\n",
            pno + 1, fz_buffer_storage(ctx, contents, NULL),
            bbox.x0, bbox.y0, bbox.x1, bbox.y1, rot);
    }
    fz_always(ctx) {
        fz_drop_buffer(ctx, contents);
        pdf_drop_obj(ctx, res2);
    }
    fz_catch(ctx) { fz_rethrow(ctx); }
    return xobj;
}

void kozou_compose_imposition_pdf(
    fz_context  *ctx,
    const char  *input,
    const char  *output,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    float        target_w,
    float        target_h,
    int          cols,
    int          rows,
    const int   *sheet_pages,   /* n_sheets*(cols*rows) 個 */
    int          n_sheets,
    float        gutter,        /* セル間の隙間(pt) */
    float        margin,        /* シート外周の余白(pt) */
    int          auto_orient,   /* 1: セルごとに収まりの良い向きへ +90° 回転を許可 */
    FfiResult   *result)
{
    (void)layout_w; (void)layout_h; (void)layout_em; /* PDF入力前提(上流で変換済み) */

    pdf_document  *src   = NULL;
    pdf_document  *dst   = NULL;
    pdf_graft_map *gmap  = NULL;
    pdf_obj      **xcache = NULL;
    int            page_count = 0;
    fz_var(src); fz_var(dst); fz_var(gmap); fz_var(xcache); fz_var(page_count);

    fz_try(ctx) {
        src = pdf_open_document(ctx, input);
        page_count = pdf_count_pages(ctx, src);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");
        if (cols < 1) cols = 1;
        if (rows < 1) rows = 1;
        if (target_w <= 1.0f || target_h <= 1.0f)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "invalid target page size");
        if (gutter < 0) gutter = 0;
        if (margin < 0) margin = 0;

        int per = cols * rows;
        /* availW/availH/cellW/cellH/mediabox はシートごとに決める。
         * auto_orient かつ 1ページ面付け(per==1)のとき、シートの向きをページの
         * 表示向き(/Rotate 適用後)に合わせるため（下のシートループ内で算出）。 */

        dst   = pdf_create_document(ctx);
        gmap  = pdf_new_graft_map(ctx, dst);
        xcache = fz_calloc(ctx, (size_t)page_count, sizeof(pdf_obj *));

        for (int s = 0; s < n_sheets; s++) {
            fz_buffer *cbuf      = NULL;
            pdf_obj   *sheet_res = NULL;
            pdf_obj   *xdict     = NULL;
            pdf_obj   *page_obj  = NULL;
            fz_var(cbuf); fz_var(sheet_res); fz_var(xdict); fz_var(page_obj);

            fz_try(ctx) {
                cbuf      = fz_new_buffer(ctx, 256);
                sheet_res = pdf_new_dict(ctx, dst, 1);
                xdict     = pdf_new_dict(ctx, dst, per);
                /* xdict の所有権は sheet_res に移す。以後 xdict ポインタは
                 * sheet_res が生かしているので名前追加に使い続けられる。 */
                pdf_dict_put_drop(ctx, sheet_res, PDF_NAME(XObject), xdict);

                /* このシートの出力サイズ(tw×th)を決める。
                 * auto_orient かつ 1ページ面付け(per==1)のときは、シートの向きを
                 * そのページの「表示上の向き」(/Rotate 適用後)に合わせる。
                 * → 縦ページは縦シート、横ページは横シートに置かれ、ページ自体は
                 *   回さない(= /Rotate 維持)。回転維持とページ向きを両立する。
                 * 非 auto（向き固定）や n-up(per>1) では target をそのまま使う。 */
                float tw = target_w, th = target_h;
                if (auto_orient && per == 1) {
                    int pno0 = sheet_pages[s * per] - 1;
                    if (pno0 >= 0 && pno0 < page_count) {
                        pdf_obj *pr  = pdf_lookup_page_obj(ctx, src, pno0); /* borrowed */
                        fz_rect  pcb = pdf_to_rect(ctx, pdf_dict_get_inheritable(ctx, pr, PDF_NAME(CropBox)));
                        if (pcb.x1 <= pcb.x0 || pcb.y1 <= pcb.y0)
                            pcb = pdf_to_rect(ctx, pdf_dict_get_inheritable(ctx, pr, PDF_NAME(MediaBox)));
                        int prot = pdf_to_int(ctx, pdf_dict_get_inheritable(ctx, pr, PDF_NAME(Rotate)));
                        prot = ((prot % 360) + 360) % 360;
                        float pw = pcb.x1 - pcb.x0, ph = pcb.y1 - pcb.y0;
                        int page_landscape = (prot == 90 || prot == 270) ? (ph > pw) : (pw > ph);
                        float big   = (tw > th) ? tw : th;
                        float small = (tw > th) ? th : tw;
                        if (page_landscape) { tw = big;   th = small; }
                        else                { tw = small; th = big;   }
                    }
                }
                float availW = tw - 2.0f * margin - (cols - 1) * gutter;
                float availH = th - 2.0f * margin - (rows - 1) * gutter;
                if (availW <= 1.0f || availH <= 1.0f)
                    fz_throw(ctx, FZ_ERROR_ARGUMENT, "margins/gutter too large for target size");
                float cellW = availW / (float)cols;
                float cellH = availH / (float)rows;
                fz_rect mediabox = { 0, 0, tw, th };

                int placed = 0;
                for (int c = 0; c < per; c++) {
                    int pno = sheet_pages[s * per + c] - 1; /* 0始まり, -1=空白 */
                    if (pno < 0 || pno >= page_count) continue;

                    if (!xcache[pno])
                        xcache[pno] = kozou_compose_page_to_xobject(ctx, src, dst, gmap, pno);
                    pdf_obj *xobj = xcache[pno];

                    fz_rect bb = pdf_to_rect(ctx, pdf_dict_get(ctx, xobj, PDF_NAME(BBox)));
                    float bw = bb.x1 - bb.x0;
                    float bh = bb.y1 - bb.y0;
                    if (bw <= 0 || bh <= 0) continue;

                    /* 元ページの /Rotate を表示向きとして cm に織り込む。
                     * ページ自体は回転させず /Rotate を維持する（向きの最適化は
                     * シートサイズ側で対応済み = auto_orient の per==1 分岐）。 */
                    int rot;
                    {
                        pdf_obj *pr = pdf_lookup_page_obj(ctx, src, pno); /* borrowed */
                        rot = pdf_to_int(ctx, pdf_dict_get_inheritable(ctx, pr, PDF_NAME(Rotate)));
                        rot = ((rot % 360) + 360) % 360;
                        if (rot % 90 != 0) rot = 0; /* 直交以外は無視 */
                    }
                    /* 表示上(回転後)の寸法。90/270 は縦横入れ替え。 */
                    float vw = (rot == 90 || rot == 270) ? bh : bw;
                    float vh = (rot == 90 || rot == 270) ? bw : bh;

                    int   col = c % cols;
                    int   row = c / cols;
                    float cellX    = margin + col * (cellW + gutter);
                    /* PDF は左下原点・Y上向き。row 0 を上端に配置する。 */
                    float cellTopY = th - margin - row * (cellH + gutter);
                    float cellBotY = cellTopY - cellH;

                    float sx = cellW / vw, sy = cellH / vh;
                    float scale = (sx < sy) ? sx : sy;
                    float pw = vw * scale, ph = vh * scale;
                    float offX = cellX    + (cellW - pw) * 0.5f;
                    float offY = cellBotY + (cellH - ph) * 0.5f;

                    /* 未回転ボックス(原点シフト後 0..bw, 0..bh)を、原点(0,0)起点・
                     * 寸法 vw×vh の回転後ボックスへ写す行列。/Rotate は時計回り。
                     *   90 : (x,y)->(y,-x)  + translate(0 , bw)
                     *   180: (x,y)->(-x,-y) + translate(bw, bh)
                     *   270: (x,y)->(-y, x) + translate(bh, 0)  */
                    fz_matrix rotm;
                    switch (rot) {
                        case 90:  rotm = fz_make_matrix(0.f, -1.f, 1.f, 0.f, 0.f, bw); break;
                        case 180: rotm = fz_make_matrix(-1.f, 0.f, 0.f, -1.f, bw, bh); break;
                        case 270: rotm = fz_make_matrix(0.f, 1.f, -1.f, 0.f, bh, 0.f); break;
                        default:  rotm = fz_identity; break;
                    }
                    /* cm = T(offX,offY) ∘ S(scale) ∘ rotm ∘ T(-bb.x0,-bb.y0)
                     * fz_concat(A,B) は「A を先に適用、次に B」。 */
                    fz_matrix m = fz_translate(-bb.x0, -bb.y0);
                    m = fz_concat(m, rotm);
                    m = fz_concat(m, fz_scale(scale, scale));
                    m = fz_concat(m, fz_translate(offX, offY));

                    char nm[24];
                    snprintf(nm, sizeof nm, "X%d", placed);
                    pdf_dict_puts(ctx, xdict, nm, xobj); /* xobj の参照を保持 */

                    fz_append_printf(ctx, cbuf,
                        "q %g %g %g %g %g %g cm /%s Do Q\n",
                        m.a, m.b, m.c, m.d, m.e, m.f, nm);
                    placed++;
                }

                page_obj = pdf_add_page(ctx, dst, mediabox, 0, sheet_res, cbuf);
                pdf_insert_page(ctx, dst, -1, page_obj);
                fprintf(stderr, "[compose] sheet %d/%d: placed %d cells, content=%zu bytes\n",
                        s + 1, n_sheets, placed, fz_buffer_storage(ctx, cbuf, NULL));
            }
            fz_always(ctx) {
                if (page_obj)  pdf_drop_obj(ctx, page_obj);
                if (sheet_res) pdf_drop_obj(ctx, sheet_res);
                if (cbuf)      fz_drop_buffer(ctx, cbuf);
            }
            fz_catch(ctx) { fz_rethrow(ctx); }
        }

        pdf_write_options opts = pdf_default_write_options;
        opts.do_garbage  = 2; /* 共有(graft)オブジェクトを重複排除 */
        opts.do_compress = 1;
        pdf_save_document(ctx, dst, output, &opts);

        set_ok(result);
    }
    fz_always(ctx) {
        if (xcache) {
            for (int i = 0; i < page_count; i++)
                if (xcache[i]) pdf_drop_obj(ctx, xcache[i]);
            fz_free(ctx, xcache);
        }
        if (gmap) pdf_drop_graft_map(ctx, gmap);
        if (dst)  pdf_drop_document(ctx, dst);
        if (src)  pdf_drop_document(ctx, src);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

/* ──────────────────────────────────────────────────────────────────
 * 面付け解除して1セルを画像(base64用バッファ)に出力する。
 * 個別画像ファイル出力用。1回の呼び出しで1セルをレンダリングし、
 * JPEG/PNG を fz_output に書き出す。SVG は別途 fz_new_svg_device を使う。
 * ─────────────────────────────────────────────────────────────────── */
void kozou_split_cell_render(
    fz_context  *ctx,
    const char  *input,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    int          page,       /* 1始まり */
    int          cols,
    int          rows,
    int          cell_row,
    int          cell_col,
    float        dpi,
    int          format,     /* 0=JPEG, 1=PNG, 2=SVG */
    int          quality,
    fz_output   *out,
    FfiResult   *result)
{
    fz_document *doc = NULL;
    fz_pixmap   *pix = NULL;
    fz_var(doc);
    fz_var(pix);

    fz_try(ctx) {
        doc = fz_open_document(ctx, input);
        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }
        int page_count = fz_count_pages(ctx, doc);
        int pno = page - 1;
        if (pno < 0 || pno >= page_count)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "page out of range");
        if (dpi <= 0.0f) dpi = 150.0f;

        if (format == 2) {
            /* SVG: セル領域をクリップした SVG デバイスでレンダリング */
            fz_page *pg = fz_load_page(ctx, doc, pno);
            fz_var(pg);
            fz_try(ctx) {
                fz_rect b = fz_bound_page(ctx, pg);
                float cw = (b.x1 - b.x0) / (float)cols;
                float ch = (b.y1 - b.y0) / (float)rows;
                float cell_x0 = b.x0 + cell_col * cw;
                float cell_y0 = b.y0 + cell_row * ch;
                fz_matrix ctm = fz_translate(-cell_x0, -cell_y0);
                fz_device *dev = fz_new_svg_device(ctx, out, cw, ch, 0, 1);
                fz_try(ctx) {
                    fz_run_page(ctx, pg, dev, ctm, NULL);
                    fz_close_device(ctx, dev);
                }
                fz_always(ctx) { fz_drop_device(ctx, dev); }
                fz_catch(ctx) { fz_rethrow(ctx); }
            }
            fz_always(ctx) { fz_drop_page(ctx, pg); }
            fz_catch(ctx) { fz_rethrow(ctx); }
        } else {
            float cw_pt = 0, ch_pt = 0;
            pix = kozou_render_cell(ctx, doc, pno, cols, rows,
                cell_row, cell_col, dpi, &cw_pt, &ch_pt);
            if (format == 1) {
                fz_write_pixmap_as_png(ctx, out, pix);
            } else {
                int jq = (quality > 0 && quality <= 100) ? quality : 85;
                fz_write_pixmap_as_jpeg(ctx, out, pix, jq, 0);
            }
        }
        set_ok(result);
    }
    fz_always(ctx) {
        if (pix) fz_drop_pixmap(ctx, pix);
        if (doc) fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

void kozou_rasterize_imposition(
    fz_context  *ctx,
    const char  *input,
    const char  *output,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    const int   *sheet_pages,
    int          n_sheets,
    int          cells_per_sheet,
    int          cols,
    int          rows,
    float        dpi,
    int          quality,
    int          use_png,
    int          gap_px,
    const char  *tmp_dir,
    FfiResult   *result)
{
    fz_document  *doc    = NULL;
    pdf_document *pdfout = NULL;
    fz_var(doc);
    fz_var(pdfout);

    fz_try(ctx) {
        doc = fz_open_document(ctx, input);
        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }
        int page_count = fz_count_pages(ctx, doc);
        if (page_count <= 0)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "document has no pages");
        if (dpi <= 0.0f) dpi = 150.0f;

        const char *base_tmp = (tmp_dir && tmp_dir[0]) ? tmp_dir : output;
        const char *ext      = use_png ? "png" : "jpg";

        pdfout = pdf_create_document(ctx);

        for (int s = 0; s < n_sheets; s++) {
            const int *page_nums = sheet_pages + (size_t)s * cells_per_sheet;
            fz_pixmap *pixmap    = NULL;
            fz_image  *image     = NULL;
            pdf_obj   *imgref    = NULL;
            fz_buffer *contents  = NULL;
            pdf_obj   *resources = NULL;
            pdf_obj   *xobj_dict = NULL;
            pdf_obj   *page_obj  = NULL;
            char tmp_img[1024]; tmp_img[0] = '\0';

            fz_var(pixmap); fz_var(image); fz_var(imgref);
            fz_var(contents); fz_var(resources); fz_var(xobj_dict); fz_var(page_obj);

            fz_try(ctx) {
                /* シートのセル pt サイズ（合成は最大ページ寸法基準） */
                float cell_w_pt = 595.0f, cell_h_pt = 842.0f;
                pixmap = kozou_compose_sheet_pixmap(ctx, doc, page_count,
                    page_nums, cells_per_sheet, cols, rows, dpi, gap_px,
                    &cell_w_pt, &cell_h_pt);

                /* PDFページの MediaBox は (cols*cell_w_pt, rows*cell_h_pt)。
                 * gap は pt 換算で加える（gap_px を pt に戻す）。 */
                float g_pt = (gap_px > 0) ? (gap_px * 72.0f / dpi) : 0.0f;
                float page_w_pt = cols * cell_w_pt + (cols + 1) * g_pt;
                float page_h_pt = rows * cell_h_pt + (rows + 1) * g_pt;

                snprintf(tmp_img, sizeof(tmp_img),
                         "%s" KOZOU_PATH_SEP "kozou_imp_%d_%d.%s",
                         base_tmp, (int)getpid(), s, ext);

                if (use_png) {
                    fz_output *fout = fz_new_output_with_path(ctx, tmp_img, 0);
                    fz_try(ctx) {
                        fz_write_pixmap_as_png(ctx, fout, pixmap);
                        fz_close_output(ctx, fout);
                    }
                    fz_always(ctx) { fz_drop_output(ctx, fout); }
                    fz_catch(ctx) { fz_rethrow(ctx); }
                } else {
                    int jq = (quality > 0 && quality <= 100) ? quality : 85;
                    fz_save_pixmap_as_jpeg(ctx, pixmap, tmp_img, jq);
                }

                image  = fz_new_image_from_file(ctx, tmp_img);
                imgref = pdf_add_image(ctx, pdfout, image);

                resources = pdf_new_dict(ctx, pdfout, 1);
                xobj_dict = pdf_new_dict(ctx, pdfout, 1);
                {
                    pdf_obj *im0 = pdf_new_name(ctx, "Im0");
                    pdf_dict_put(ctx, xobj_dict, im0, imgref);
                    pdf_drop_obj(ctx, im0);
                }
                pdf_dict_put(ctx, resources, PDF_NAME(XObject), xobj_dict);

                char cs_buf[256];
                int cs_len = snprintf(cs_buf, sizeof(cs_buf),
                    "q\n%.4f 0 0 %.4f 0 0 cm\n/Im0 Do\nQ\n",
                    page_w_pt, page_h_pt);
                contents = fz_new_buffer_from_copied_data(ctx,
                    (const unsigned char *)cs_buf, (size_t)cs_len);

                fz_rect mediabox = { 0, 0, page_w_pt, page_h_pt };
                page_obj = pdf_add_page(ctx, pdfout, mediabox, 0, resources, contents);
                pdf_insert_page(ctx, pdfout, -1, page_obj);
            }
            fz_always(ctx) {
                if (tmp_img[0]) remove(tmp_img);
                if (page_obj)  pdf_drop_obj(ctx, page_obj);
                if (xobj_dict) pdf_drop_obj(ctx, xobj_dict);
                if (resources) pdf_drop_obj(ctx, resources);
                if (contents)  fz_drop_buffer(ctx, contents);
                if (imgref)    pdf_drop_obj(ctx, imgref);
                if (image)     fz_drop_image(ctx, image);
                if (pixmap)    fz_drop_pixmap(ctx, pixmap);
            }
            fz_catch(ctx) { fz_rethrow(ctx); }
        }

        pdf_save_document(ctx, pdfout, output, NULL);
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

void kozou_render_imposition(
    fz_context  *ctx,
    const char  *path,
    float        layout_w,
    float        layout_h,
    float        layout_em,
    const int   *page_nums,  /* cols*rows 個の配置ページ番号(1始まり、0=空白) */
    int          n_pages,    /* page_nums の要素数 = cols * rows              */
    int          cols,       /* 列数                                           */
    int          rows,       /* 行数                                           */
    float        dpi,        /* 出力DPI（1セル分の解像度基準）                */
    int          format,     /* 0=JPEG, 1=PNG                                  */
    int          quality,    /* JPEG品質 1-100                                 */
    int          gap_px,     /* セル間ギャップ px（出力解像度基準）            */
    fz_output   *out,
    FfiResult   *result)
{
    fz_document *doc     = NULL;
    fz_pixmap   *pixmap  = NULL;
    fz_device   *dev     = NULL;
    fz_output   *fout    = NULL;

    fz_var(doc);
    fz_var(pixmap);
    fz_var(dev);
    fz_var(fout);

    fz_try(ctx) {
        doc = fz_open_document(ctx, path);

        if (fz_is_document_reflowable(ctx, doc)) {
            float w  = layout_w  > 0 ? layout_w  : 450.0f;
            float h  = layout_h  > 0 ? layout_h  : 600.0f;
            float em = layout_em > 0 ? layout_em : 12.0f;
            fz_layout_document(ctx, doc, w, h, em);
        }

        int page_count = fz_count_pages(ctx, doc);

        /* ── Step 1: 全有効ページのサイズを収集してセルサイズを決定 ── */
        /*                                                               */
        /* 改善点:                                                       */
        /* ① 全ページの最大幅・最大高さをセルサイズとして使用           */
        /*   → 混在サイズのPDFでも余白なくレンダリングできる            */
        /* ② pixelサイズを「全体→分割」ではなく「ページ→乗算」で計算  */
        /*   → 2-up時: total_w = 2 × cell_w（丸め誤差が2ページで累積  */
        /*     しない）                                                   */
        /* ③ A4縦×2 → A3横の場合: cell_w×2 = A3横幅（誤差0.2mm以下） */

        float max_w_pt = 595.0f, max_h_pt = 842.0f; /* A4デフォルト */
        int valid_count = 0;
        for (int i = 0; i < n_pages; i++) {
            int pno = page_nums[i] - 1; /* 0始まり */
            if (pno < 0 || pno >= page_count) continue;
            fz_page *pg = fz_load_page(ctx, doc, pno);
            fz_rect b = fz_bound_page(ctx, pg);
            float pw = b.x1 - b.x0;
            float ph = b.y1 - b.y0;
            if (valid_count == 0) {
                /* 最初の有効ページを基準に設定 */
                max_w_pt = pw;
                max_h_pt = ph;
            } else {
                /* 全ページで最大の幅・高さを採用 */
                if (pw > max_w_pt) max_w_pt = pw;
                if (ph > max_h_pt) max_h_pt = ph;
            }
            fz_drop_page(ctx, pg);
            valid_count++;
        }

        /* セルサイズ (px): DPIスケール後のページサイズ                  */
        /* 丸め方式: (int)(x + 0.5) → 四捨五入                          */
        /* 2-up時の全体幅: total_w = 2 × cell_w                        */
        /* ページ単位で四捨五入するため誤差はページ当たり最大0.5px      */
        /* A4(595pt) @ 300dpi: 595×300/72=2479.17 → 2479px             */
        /* 2-up: 2479×2=4958px = 419.8mm（A3横420mmとの差: 0.2mm）     */
        float scale  = dpi / 72.0f;
        int   cell_w = (int)(max_w_pt * scale + 0.5f);
        int   cell_h = (int)(max_h_pt * scale + 0.5f);
        int   g      = gap_px > 0 ? gap_px : 0;

        /* 出力画像全体のサイズ */
        int total_w = cols * cell_w + (cols + 1) * g;
        int total_h = rows * cell_h + (rows + 1) * g;

        /* ── Step 2: サイズ上限チェック後に出力pixmapを作成 ── */
        /* 最大4GB未満（実用上は1GB以下が安全） */
        size_t total_bytes = (size_t)total_w * (size_t)total_h * 3; /* RGB */
        if (total_bytes > (size_t)1024 * 1024 * 1024) {
            fz_throw(ctx, FZ_ERROR_GENERIC,
                "imposition: output too large (%dx%d @ 3ch = %zuMB > 1024MB). "
                "Reduce DPI or use fewer pages per sheet.",
                total_w, total_h, total_bytes / (1024*1024));
        }
        fz_colorspace *rgb = fz_device_rgb(ctx);
        fz_irect full_bbox = { 0, 0, total_w, total_h };
        pixmap = fz_new_pixmap_with_bbox(ctx, rgb, full_bbox, NULL, 0);
        fz_clear_pixmap_with_value(ctx, pixmap, 0xff); /* 白背景 */

        /* ── Step 3: 各ページをセルに直接レンダリング ── */
        for (int i = 0; i < n_pages; i++) {
            int col = i % cols;
            int row = i / cols;

            /* セルの左上座標 */
            int cell_x = g + col * (cell_w + g);
            int cell_y = g + row * (cell_h + g);

            int pno = page_nums[i] - 1; /* 0始まり */
            if (pno < 0 || pno >= page_count) {
                /* 空白セル: 薄いグレーで塗る */
                /* 空白ページ: pixmap は fz_clear_pixmap_with_value で白初期化済み */
                /* 追加描画不要 — 白紙のまま */
                continue;
            }

            fz_page *pg = NULL;
            fz_var(pg);
            fz_try(ctx) {
                pg = fz_load_page(ctx, doc, pno);
                fz_rect pb = fz_bound_page(ctx, pg);
                float pw_pt = pb.x1 - pb.x0;
                float ph_pt = pb.y1 - pb.y0;

                /* アスペクト比を維持してセルにフィットするスケールを計算 */
                /* セルと同サイズのページは完全にセルを埋める（余白ゼロ） */
                float sx = (float)cell_w / pw_pt;
                float sy = (float)cell_h / ph_pt;
                float fit_scale = (sx < sy) ? sx : sy;

                /* render_w/h: セルと同サイズページなら cell_w/h と一致 */
                int render_w = (int)(pw_pt * fit_scale + 0.5f);
                int render_h = (int)(ph_pt * fit_scale + 0.5f);
                /* クランプ（丸め誤差でセルを1pxはみ出すのを防ぐ）       */
                if (render_w > cell_w) render_w = cell_w;
                if (render_h > cell_h) render_h = cell_h;

                /* セル内でセンタリングするオフセット */
                int off_x = cell_x + (cell_w - render_w) / 2;
                int off_y = cell_y + (cell_h - render_h) / 2;

                /* ページをセル内座標に変換する CTM */
                fz_matrix ctm = fz_scale(fit_scale, fit_scale);
                ctm = fz_pre_translate(ctm, -pb.x0, -pb.y0);

                /* セル内のサブpixmapにレンダリング */
                fz_irect cell_bbox = {
                    off_x, off_y,
                    off_x + render_w,
                    off_y + render_h
                };
                /* クランプ */
                if (cell_bbox.x1 > total_w) cell_bbox.x1 = total_w;
                if (cell_bbox.y1 > total_h) cell_bbox.y1 = total_h;

                /* ページを個別pixmapにレンダリング */
                fz_irect render_bbox = { 0, 0, render_w, render_h };
                fz_pixmap *cell_pix = fz_new_pixmap_with_bbox(ctx, rgb, render_bbox, NULL, 0);
                fz_clear_pixmap_with_value(ctx, cell_pix, 0xff);

                fz_device *draw_dev = fz_new_draw_device(ctx, ctm, cell_pix);
                fz_try(ctx) {
                    fz_run_page(ctx, pg, draw_dev, fz_identity, NULL);
                    fz_close_device(ctx, draw_dev);
                }
                fz_always(ctx) {
                    fz_drop_device(ctx, draw_dev);
                }
                fz_catch(ctx) {
                    fz_drop_pixmap(ctx, cell_pix);
                    fz_rethrow(ctx);
                }

                /* レンダリング済みpixmapのサンプルデータを合成先に行単位でコピー */
                {
                    int src_stride  = fz_pixmap_stride(ctx, cell_pix);
                    int dst_stride  = fz_pixmap_stride(ctx, pixmap);
                    int comp        = fz_pixmap_components(ctx, pixmap);
                    int copy_h      = render_h;
                    int copy_w      = render_w;
                    /* クランプ */
                    if (off_y + copy_h > total_h) copy_h = total_h - off_y;
                    if (off_x + copy_w > total_w) copy_w = total_w - off_x;
                    if (copy_w > 0 && copy_h > 0) {
                        unsigned char *src = fz_pixmap_samples(ctx, cell_pix);
                        unsigned char *dst = fz_pixmap_samples(ctx, pixmap)
                            + off_y * dst_stride + off_x * comp;
                        for (int r = 0; r < copy_h; r++) {
                            memcpy(dst + r * dst_stride,
                                   src + r * src_stride,
                                   (size_t)copy_w * comp);
                        }
                    }
                    fz_drop_pixmap(ctx, cell_pix);
                }
            }
            fz_always(ctx) { if (pg) { fz_drop_page(ctx, pg); pg = NULL; } }
            fz_catch(ctx) {
                fz_warn(ctx, "imposition: skip page %d: %s", pno+1, fz_caught_message(ctx));
            }
        }

        /* ── Step 4: 合成済みpixmapを1回だけ圧縮して出力 ── */
        if (format == 1) {
            fz_write_pixmap_as_png(ctx, out, pixmap);
        } else {
            int q = (quality > 0 && quality <= 100) ? quality : 85;
            fz_write_pixmap_as_jpeg(ctx, out, pixmap, q, 0);
        }

        set_ok(result);
    }
    fz_always(ctx) {
        if (pixmap) fz_drop_pixmap(ctx, pixmap);
        if (doc)    fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}
