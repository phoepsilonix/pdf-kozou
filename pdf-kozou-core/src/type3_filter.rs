// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------


// pdf-kozou-core/src/type3_filter.rs
//
// Type3フォントを含むテキストをベクターパスに変換するNativeDeviceラッパー。
//
// 設計: inner (pdf_device) を Option<Device> で直接所有する。
// page.run 完了後に take_inner() で Device を取り出して end_page に渡す。

use std::num::NonZero;
use mupdf::{
    BlendMode, ColorParams, Colorspace, Device, Font, Image, Matrix, NativeDevice,
    Path, Rect, Shade, StrokeState, Text,
};
use mupdf::device::{DefaultColorspaces, DeviceFlag, Metatext, Structure};
use mupdf::Function;

pub struct Type3FilterDevice {
    inner: Option<Device>,
}

impl Type3FilterDevice {
    pub fn new(inner: Device) -> Self {
        Self { inner: Some(inner) }
    }

    /// page.run 完了後に呼び出して inner Device を取り出す
    pub fn take_inner(&mut self) -> Option<Device> {
        self.inner.take()
    }

    fn dev(&self) -> &Device {
        self.inner.as_ref().expect("Type3FilterDevice: inner device already taken")
    }

    fn is_type3_font(font: &Font) -> bool {
        let name = font.name();
        if name.contains("Type3") || name.starts_with("T3-") {
            return true;
        }
        match font.outline_glyph(0) {
            Ok(Some(_)) => false,
            _           => true,
        }
    }

    fn render_type3_as_paths(
        &self,
        text: &Text,
        ctm: &Matrix,
        color_space: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
        stroke_state: Option<&StrokeState>,
    ) {
        let dev = self.dev();
        for span in text.spans() {
            let font = span.font();
            let trm  = span.trm();

            if !Self::is_type3_font(&font) {
                if let Some(ss) = stroke_state {
                    let _ = dev.stroke_text(text, ss, ctm, color_space, color, alpha, cp);
                } else {
                    let _ = dev.fill_text(text, ctm, color_space, color, alpha, cp);
                }
                return;
            }

            for item in span.items() {
                let gid = item.gid();
                if gid < 0 { continue; }

                let mut pos   = Matrix::new_translate(item.x(), item.y());
                let glyph_ctm = pos.concat(trm.clone()).concat(ctm.clone());

                match font.outline_glyph_with_ctm(gid, &glyph_ctm) {
                    Ok(Some(path)) => {
                        if let Some(ss) = stroke_state {
                            let _ = dev.stroke_path(
                                &path, ss, &Matrix::IDENTITY,
                                color_space, color, alpha, cp,
                            );
                        } else {
                            let _ = dev.fill_path(
                                &path, false, &Matrix::IDENTITY,
                                color_space, color, alpha, cp,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

impl NativeDevice for Type3FilterDevice {
    fn fill_path(
        &mut self, path: &Path, even_odd: bool, ctm: Matrix,
        cs: &Colorspace, color: &[f32], alpha: f32, cp: ColorParams,
    ) {
        let _ = self.dev().fill_path(path, even_odd, &ctm, cs, color, alpha, cp);
    }

    fn stroke_path(
        &mut self, path: &Path, ss: &StrokeState, ctm: Matrix,
        cs: &Colorspace, color: &[f32], alpha: f32, cp: ColorParams,
    ) {
        let _ = self.dev().stroke_path(path, ss, &ctm, cs, color, alpha, cp);
    }

    fn clip_path(&mut self, path: &Path, even_odd: bool, ctm: Matrix, _scissor: Rect) {
        let _ = self.dev().clip_path(path, even_odd, &ctm);
    }

    fn clip_stroke_path(&mut self, path: &Path, ss: &StrokeState, ctm: Matrix, _scissor: Rect) {
        let _ = self.dev().clip_stroke_path(path, ss, &ctm);
    }

    fn fill_text(
        &mut self, text: &Text, ctm: Matrix,
        cs: &Colorspace, color: &[f32], alpha: f32, cp: ColorParams,
    ) {
        // デバッグ: Type3処理を一切せず、エラーも無視してスルー
        let _ = self.dev().fill_text(text, &ctm, cs, color, alpha, cp);
    }

    fn stroke_text(
        &mut self, text: &Text, ss: &StrokeState, ctm: Matrix,
        cs: &Colorspace, color: &[f32], alpha: f32, cp: ColorParams,
    ) {
        // デバッグ: Type3処理を一切せず、エラーも無視してスルー
        let _ = self.dev().stroke_text(text, ss, &ctm, cs, color, alpha, cp);
    }

    fn clip_text(&mut self, text: &Text, ctm: Matrix, _scissor: Rect) {
        let _ = self.dev().clip_text(text, &ctm);
    }

    fn clip_stroke_text(&mut self, text: &Text, ss: &StrokeState, ctm: Matrix, _scissor: Rect) {
        let _ = self.dev().clip_stroke_text(text, ss, &ctm);
    }

    fn ignore_text(&mut self, text: &Text, ctm: Matrix) {
        let _ = self.dev().ignore_text(text, &ctm);
    }

    fn fill_shade(&mut self, shade: &Shade, ctm: Matrix, alpha: f32, cp: ColorParams) {
        let _ = self.dev().fill_shade(shade, &ctm, alpha, cp);
    }

    fn fill_image(&mut self, img: &Image, ctm: Matrix, alpha: f32, cp: ColorParams) {
        let _ = self.dev().fill_image(img, &ctm, alpha, cp);
    }

    fn fill_image_mask(
        &mut self, img: &Image, ctm: Matrix,
        cs: &Colorspace, color: &[f32], alpha: f32, cp: ColorParams,
    ) {
        let _ = self.dev().fill_image_mask(img, &ctm, cs, color, alpha, cp);
    }

    fn clip_image_mask(&mut self, img: &Image, ctm: Matrix, _scissor: Rect) {
        let _ = self.dev().clip_image_mask(img, &ctm);
    }

    fn pop_clip(&mut self) {
        let _ = self.dev().pop_clip();
    }

    fn begin_mask(
        &mut self, area: Rect, luminosity: bool,
        cs: &Colorspace, color: &[f32], cp: ColorParams,
    ) {
        let _ = self.dev().begin_mask(area, luminosity, cs, color, cp);
    }

    fn end_mask(&mut self, f: &Function) {
        let _ = self.dev().end_mask(Some(f));
    }

    fn begin_group(
        &mut self, area: Rect, cs: &Colorspace,
        isolated: bool, knockout: bool, blendmode: BlendMode, alpha: f32,
    ) {
        let _ = self.dev().begin_group(area, cs, isolated, knockout, blendmode, alpha);
    }

    fn end_group(&mut self) {
        let _ = self.dev().end_group();
    }

    fn begin_tile(
        &mut self, area: Rect, view: Rect, x_step: f32, y_step: f32,
        ctm: Matrix, id: Option<NonZero<i32>>, doc_id: Option<NonZero<i32>>,
    ) -> Option<NonZero<i32>> {
        self.dev().begin_tile(area, view, x_step, y_step, &ctm, id, doc_id)
            .ok().flatten()
    }

    fn end_tile(&mut self) {
        let _ = self.dev().end_tile();
    }

    fn render_flags(&mut self, _set: DeviceFlag, _clear: DeviceFlag) {}
    fn set_default_colorspaces(&mut self, _dcs: &DefaultColorspaces) {}

    fn begin_layer(&mut self, name: &str) {
        let _ = self.dev().begin_layer(name);
    }

    fn end_layer(&mut self) {
        let _ = self.dev().end_layer();
    }

    fn begin_structure(&mut self, standard: Structure, raw: &str, idx: i32) {
        let _ = self.dev().begin_structure(standard, raw, idx);
    }

    fn end_structure(&mut self) {
        let _ = self.dev().end_structure();
    }

    fn begin_metatext(&mut self, meta: Metatext, text: &str) {
        let _ = self.dev().begin_metatext(meta, text);
    }

    fn end_metatext(&mut self) {
        let _ = self.dev().end_metatext();
    }
}
