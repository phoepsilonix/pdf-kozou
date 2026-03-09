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
    fz_context   *ctx,
    pdf_document *pdf,
    int           nranges_unused,  /* 常に 0 を渡す (全ページ対象) */
    FfiResult    *result)
{
    (void)nranges_unused;
    fz_try(ctx) {
        /*
         * pdf_subset_fonts(ctx, doc, nranges, ranges)
         *   nranges = 0, ranges = NULL → 全ページを対象にサブセット化
         */
        pdf_subset_fonts(ctx, pdf, 0, NULL);
        set_ok(result);
    }
    fz_catch(ctx) {
        set_err(result, fz_caught_message(ctx));
    }
}

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
