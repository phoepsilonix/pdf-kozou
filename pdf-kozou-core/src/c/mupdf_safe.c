/*
 * mupdf_safe.c
 *
 * MuPDF の fz_try/fz_catch (setjmp/longjmp ベース) を Rust FFI 境界の
 * 内側で完結させる薄いラッパー。
 *
 * fz_new_context はヘッダ内のマクロ:
 *   #define fz_new_context(alloc, locks, max_store) \
 *       fz_new_context_imp(alloc, locks, max_store, FZ_VERSION)
 * C 側から呼べばマクロが展開されるため問題なし。
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
/* fz_new_context マクロ (→ fz_new_context_imp + FZ_VERSION) を C 側  */
/* から展開する。Rust からは fz_new_context_imp を直接呼べるが          */
/* FZ_VERSION が bindgen でブロックされているためこのラッパーを使う。  */
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
/* pdf_default_write_options は extern static なので C 経由でコピー   */
/* ------------------------------------------------------------------ */
void kozou_pdf_default_write_options(pdf_write_options *out)
{
    *out = pdf_default_write_options;
}
