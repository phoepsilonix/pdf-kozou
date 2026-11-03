// Copyright (C) 2026 Masato TOYOSHIMA <phoepsilonix at gmail dot com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// -------------------------------------------------------------------------

// pdf-kozou-core/src/sanitize_ops.rs
// 内容ストリームの演算子列から、描画結果を変えない無駄を取り除く (MuPDF の sanitize 相当の、
// 意味が変わらないと言えるものだけの lopdf 実装)。
//
// MuPDF の sanitize は、描画状態 (CTM・色・クリップなど) を追跡して、描画に必要になるまで
// 状態変更を遅らせる。完全に同じことは行わず、次の 4 つだけを行う。いずれも、あとに続く描画
// (線・塗り・文字・画像・クリップ) から見た描画状態が変わらないことが、演算子の並びだけから
// 言える場合に限る。
//
//   1. 単位行列の cm (`1 0 0 1 0 0 cm`) を取り除く。
//   2. 状態を設定するだけの演算子が連続している区間 (間に描画・q/Q・cm・BT/ET などが無い) で、
//      あとの同種の設定に上書きされるものを取り除く。
//        w J j M d ri i Tc Tw Tz TL Tf Tr Ts は、同じ演算子が後にあれば前のものは無駄。
//        塗り色 (g rg k cs sc scn)・線色 (G RG K CS SC SCN) は、g/rg/k/cs (色空間ごと決め直す)
//        が後にあれば、それより前の塗り色の設定すべてが無駄。sc/scn (色の値だけ設定する) が
//        後にあれば、それより前の sc/scn が無駄 (cs は色空間を決めるので残す)。
//   3. 対応する q のある Q の直前にある、状態を設定する演算子 (2 の演算子・cm・gs) を取り除く。
//      Q が状態を元に戻すので、その直前の変更は誰にも見られない。対応する q の無い Q (ストリーム
//      の途中で状態を戻す先が無いもの) の前は、何もしない。
//   4. 何も挟まない `q Q`、`BT ET` を取り除く。
//
// 取り除いたことで新しく無駄が見つかることがあるので、変わらなくなるまで繰り返す。
//
// 触らないもの: gs (複数のパラメータを部分的に設定する)、クリップ (W/W* と n)、マーク付きコンテンツ
// (BDC/EMC は構造・アクセシビリティ情報を持つ)、テキスト位置 (Td Tm T* ...)。インライン画像で区切られる
// 前後は、別々に扱う (呼び出し側が区切って渡す)。

use lopdf::Object;
use lopdf::content::Operation;
use std::collections::HashSet;

/// 状態を設定するだけで、あとの同種の設定に完全に上書きされうる演算子
fn is_pure_state(op: &str) -> bool {
    matches!(
        op,
        "w" | "J"
            | "j"
            | "M"
            | "d"
            | "ri"
            | "i"
            | "Tc"
            | "Tw"
            | "Tz"
            | "TL"
            | "Tf"
            | "Tr"
            | "Ts"
            | "g"
            | "G"
            | "rg"
            | "RG"
            | "k"
            | "K"
            | "cs"
            | "CS"
            | "sc"
            | "SC"
            | "scn"
            | "SCN"
    )
}

/// 対応する q のある Q の直前で、取り除いてよい演算子
fn is_dead_before_q(op: &str) -> bool {
    is_pure_state(op) || op == "cm" || op == "gs"
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

fn is_identity_cm(op: &Operation) -> bool {
    op.operator == "cm"
        && op.operands.len() == 6
        && op
            .operands
            .iter()
            .zip([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
            .all(|(o, want)| num(o) == Some(want))
}

/// 状態設定だけが続く区間のうち、あとの設定に上書きされる演算子を false にした印を返す
fn live_in_run(run: &[Operation]) -> Vec<bool> {
    let mut keep = vec![true; run.len()];
    let mut seen: HashSet<&str> = HashSet::new();
    // 塗り色・線色: full = 色空間ごと決め直す演算子が後にある / val = 色の値を決める演算子が後にある
    let (mut fill_full, mut fill_val) = (false, false);
    let (mut stroke_full, mut stroke_val) = (false, false);
    for i in (0..run.len()).rev() {
        let op = run[i].operator.as_str();
        match op {
            "g" | "rg" | "k" | "cs" => {
                if fill_full {
                    keep[i] = false;
                }
                fill_full = true;
                fill_val = true;
            }
            "sc" | "scn" => {
                if fill_val {
                    keep[i] = false;
                }
                fill_val = true;
            }
            "G" | "RG" | "K" | "CS" => {
                if stroke_full {
                    keep[i] = false;
                }
                stroke_full = true;
                stroke_val = true;
            }
            "SC" | "SCN" => {
                if stroke_val {
                    keep[i] = false;
                }
                stroke_val = true;
            }
            _ => {
                // w J j M d ri i Tc Tw Tz TL Tf Tr Ts: 同じ演算子が後にあれば前のものは無駄
                if !seen.insert(op) {
                    keep[i] = false;
                }
            }
        }
    }
    keep
}

/// 1 回分の整理。何も変わらなければ入力と同じ長さを返す。
fn pass(ops: Vec<Operation>) -> Vec<Operation> {
    // 2: 状態設定だけが続く区間ごとに、上書きされるものを外す
    let mut deduped: Vec<Operation> = Vec::with_capacity(ops.len());
    let mut run: Vec<Operation> = Vec::new();
    let flush = |run: &mut Vec<Operation>, out: &mut Vec<Operation>| {
        let keep = live_in_run(run);
        out.extend(run.drain(..).zip(keep).filter(|(_, k)| *k).map(|(o, _)| o));
    };
    for op in ops {
        if is_pure_state(&op.operator) {
            run.push(op);
        } else {
            flush(&mut run, &mut deduped);
            deduped.push(op);
        }
    }
    flush(&mut run, &mut deduped);

    // 1, 3, 4: 先頭から順に積み、Q のところで直前を整理する
    let mut out: Vec<Operation> = Vec::with_capacity(deduped.len());
    let mut depth = 0usize; // このストリームの中で開いている q の数
    for op in deduped {
        match op.operator.as_str() {
            "cm" if is_identity_cm(&op) => {}
            "q" => {
                depth += 1;
                out.push(op);
            }
            "Q" if depth > 0 => {
                depth -= 1;
                // 3: 対応する q の後ろにある状態設定は、Q で元に戻るので不要
                while out.last().is_some_and(|l| is_dead_before_q(&l.operator)) {
                    out.pop();
                }
                // 4: q Q が空なら、組ごと取り除く
                if out.last().is_some_and(|l| l.operator == "q") {
                    out.pop();
                } else {
                    out.push(op);
                }
            }
            "ET" if out.last().is_some_and(|l| l.operator == "BT") => {
                out.pop();
            }
            _ => out.push(op),
        }
    }
    out
}

/// 演算子列を整理する。取り除いた演算子の数を返す。
pub(crate) fn sanitize_operations(ops: Vec<Operation>) -> (Vec<Operation>, usize) {
    let before = ops.len();
    let mut cur = ops;
    loop {
        let n = cur.len();
        cur = pass(cur);
        if cur.len() == n {
            break;
        }
    }
    let removed = before - cur.len();
    (cur, removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn op(name: &str, operands: Vec<Object>) -> Operation {
        Operation::new(name, operands)
    }

    fn n(v: i64) -> Object {
        Object::Integer(v)
    }

    fn nm(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }

    /// "q 1 w Q" のような記法で作る (operand は整数か /名前)
    fn parse(s: &str) -> Vec<Operation> {
        let mut ops = Vec::new();
        let mut operands = Vec::new();
        for t in s.split_whitespace() {
            if let Ok(v) = t.parse::<i64>() {
                operands.push(n(v));
            } else if let Some(name) = t.strip_prefix('/') {
                operands.push(nm(name));
            } else {
                ops.push(op(t, std::mem::take(&mut operands)));
            }
        }
        ops
    }

    fn show(ops: &[Operation]) -> String {
        ops.iter()
            .map(|o| {
                let args: Vec<String> = o
                    .operands
                    .iter()
                    .map(|a| match a {
                        Object::Integer(i) => i.to_string(),
                        Object::Name(n) => format!("/{}", String::from_utf8_lossy(n)),
                        other => format!("{other:?}"),
                    })
                    .collect();
                if args.is_empty() {
                    o.operator.clone()
                } else {
                    format!("{} {}", args.join(" "), o.operator)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn san(s: &str) -> String {
        show(&sanitize_operations(parse(s)).0)
    }

    #[test]
    fn identity_cm_is_removed_only_when_exact() {
        assert_eq!(san("1 0 0 1 0 0 cm 0 0 5 5 re f"), "0 0 5 5 re f");
        assert_eq!(
            san("1 0 0 1 1 0 cm 0 0 5 5 re f"),
            "1 0 0 1 1 0 cm 0 0 5 5 re f"
        );
        // Real の 1.0 / 0.0 も単位行列
        let ops = vec![op(
            "cm",
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0].map(Object::Real).to_vec(),
        )];
        assert!(sanitize_operations(ops).0.is_empty());
    }

    #[test]
    fn overwritten_state_settings_are_dropped() {
        assert_eq!(san("1 w 2 w 0 0 5 5 re S"), "2 w 0 0 5 5 re S");
        // 間に別種の状態設定があっても、同種の後の設定が勝つ
        assert_eq!(san("1 w 1 J 2 w 0 0 5 5 re S"), "1 J 2 w 0 0 5 5 re S");
        // 描画を挟めば別の区間 (前の設定は描画に使われる)
        assert_eq!(
            san("1 w 0 0 5 5 re S 2 w 0 0 5 5 re S"),
            "1 w 0 0 5 5 re S 2 w 0 0 5 5 re S"
        );
        // フォント: 後の Tf が勝つ
        assert_eq!(san("/F1 10 Tf /F2 12 Tf BT Tj ET"), "/F2 12 Tf BT Tj ET");
    }

    #[test]
    fn colour_rules_keep_what_later_ops_depend_on() {
        // g/rg/k は色空間ごと決め直すので、前の塗り色の設定はすべて無駄
        assert_eq!(san("/Cs1 cs 1 sc 0 g 0 0 5 5 re f"), "0 g 0 0 5 5 re f");
        assert_eq!(san("1 g 1 0 0 rg 0 0 5 5 re f"), "1 0 0 rg 0 0 5 5 re f");
        // sc は色の値だけ。前の cs は必要 (色空間が変わる)
        assert_eq!(
            san("/Cs1 cs 1 sc 2 sc 0 0 5 5 re f"),
            "/Cs1 cs 2 sc 0 0 5 5 re f"
        );
        // g の後の sc は値だけを設定する。g は残す
        assert_eq!(san("0 g 1 sc 0 0 5 5 re f"), "0 g 1 sc 0 0 5 5 re f");
        // 塗りと線は別
        assert_eq!(san("1 g 0 G 0 0 5 5 re B"), "1 g 0 G 0 0 5 5 re B");
        assert_eq!(san("0 G 1 0 0 RG 0 0 5 5 re S"), "1 0 0 RG 0 0 5 5 re S");
    }

    #[test]
    fn state_before_a_matched_q_is_dead() {
        assert_eq!(san("q 0 0 5 5 re f 2 w Q"), "q 0 0 5 5 re f Q");
        assert_eq!(
            san("q 0 0 5 5 re f 2 0 0 2 0 0 cm /G1 gs 1 g Q"),
            "q 0 0 5 5 re f Q"
        );
        // q の外側の状態設定は、あとの描画に効くので残す
        assert_eq!(
            san("2 w q 0 0 5 5 re f Q 0 0 5 5 re S"),
            "2 w q 0 0 5 5 re f Q 0 0 5 5 re S"
        );
    }

    #[test]
    fn unmatched_q_is_left_alone() {
        // 対応する q が無い Q は、状態を戻す先が無い。直前の設定は後続に効く
        assert_eq!(san("2 w Q 0 0 5 5 re S"), "2 w Q 0 0 5 5 re S");
        assert_eq!(san("q Q Q 3 w 0 0 5 5 re S"), "Q 3 w 0 0 5 5 re S");
    }

    #[test]
    fn empty_groups_collapse_and_cascade() {
        assert_eq!(san("q Q 0 0 5 5 re f"), "0 0 5 5 re f");
        assert_eq!(san("q q 1 w Q Q 0 0 5 5 re f"), "0 0 5 5 re f");
        assert_eq!(san("BT ET 0 0 5 5 re f"), "0 0 5 5 re f");
        // BT の中に Tf だけがあるものは、状態を設定する (テキスト状態は ET のあとも残る) ので残す
        let keep = "BT /F1 10 Tf ET /F1 10 Tf BT Tj ET";
        assert_eq!(san(keep), keep);
    }

    #[test]
    fn what_must_stay() {
        // gs・クリップ・マーク付きコンテンツ・テキスト位置は触らない
        let keep = "/G1 gs /G2 gs 0 0 5 5 re W n /OC /P1 BDC EMC BT 1 0 0 1 5 5 Tm ET";
        assert_eq!(san(keep), keep);
    }

    // ---------------------------------------------------------------------
    // 描画状態を追跡する小さなインタプリタで、整理の前後の描画が同じことを確かめる。
    // 描画 (線・塗り・文字・画像・クリップ・テキスト位置) の演算子ごとに、その時点の
    // 描画状態 (CTM・状態パラメータ・色・gs の履歴) を記録し、整理の前後で記録が同じかを比べる。
    // ---------------------------------------------------------------------

    #[derive(Clone, Default, PartialEq, Debug)]
    struct State {
        ctm: [i64; 6],
        params: BTreeMap<String, Vec<String>>,
        fill: (String, Vec<String>),
        stroke: (String, Vec<String>),
        gs: Vec<String>,
    }

    fn fmt(o: &Object) -> String {
        match o {
            Object::Integer(i) => i.to_string(),
            Object::Real(r) => format!("{r}"),
            Object::Name(n) => format!("/{}", String::from_utf8_lossy(n)),
            other => format!("{other:?}"),
        }
    }

    fn mul(a: [i64; 6], b: [i64; 6]) -> [i64; 6] {
        // a × b (行列の積、PDF の cm と同じ向き)
        [
            a[0] * b[0] + a[1] * b[2],
            a[0] * b[1] + a[1] * b[3],
            a[2] * b[0] + a[3] * b[2],
            a[2] * b[1] + a[3] * b[3],
            a[4] * b[0] + a[5] * b[2] + b[4],
            a[4] * b[1] + a[5] * b[3] + b[5],
        ]
    }

    fn trace(ops: &[Operation]) -> Vec<(String, State)> {
        let mut st = State {
            ctm: [1, 0, 0, 1, 0, 0],
            fill: ("DeviceGray".into(), vec!["0".into()]),
            stroke: ("DeviceGray".into(), vec!["0".into()]),
            ..Default::default()
        };
        let mut stack: Vec<State> = Vec::new();
        let mut out = Vec::new();
        for o in ops {
            let args: Vec<String> = o.operands.iter().map(fmt).collect();
            let name = o.operator.as_str();
            match name {
                "q" => stack.push(st.clone()),
                "Q" => {
                    if let Some(s) = stack.pop() {
                        st = s;
                    }
                }
                "cm" => {
                    let v: Vec<i64> = o.operands.iter().map(|x| num(x).unwrap() as i64).collect();
                    st.ctm = mul([v[0], v[1], v[2], v[3], v[4], v[5]], st.ctm);
                }
                "w" | "J" | "j" | "M" | "d" | "ri" | "i" | "Tc" | "Tw" | "Tz" | "TL" | "Tf"
                | "Tr" | "Ts" => {
                    st.params.insert(name.to_string(), args);
                }
                "g" => st.fill = ("DeviceGray".into(), args),
                "rg" => st.fill = ("DeviceRGB".into(), args),
                "k" => st.fill = ("DeviceCMYK".into(), args),
                "cs" => st.fill = (args[0].clone(), vec!["init".into()]),
                "sc" | "scn" => st.fill.1 = args,
                "G" => st.stroke = ("DeviceGray".into(), args),
                "RG" => st.stroke = ("DeviceRGB".into(), args),
                "K" => st.stroke = ("DeviceCMYK".into(), args),
                "CS" => st.stroke = (args[0].clone(), vec!["init".into()]),
                "SC" | "SCN" => st.stroke.1 = args,
                "gs" => st.gs.push(args[0].clone()),
                // 描画・クリップ・パス・テキストの表示/位置: その時点の状態を記録する
                _ => {
                    if !matches!(name, "BT" | "ET") {
                        out.push((format!("{name} {}", args.join(" ")), st.clone()));
                    }
                }
            }
        }
        out
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    fn random_ops(r: &mut Rng, len: usize) -> Vec<Operation> {
        let mut ops = Vec::new();
        for _ in 0..len {
            let small = |r: &mut Rng| n(r.below(3) as i64);
            let o = match r.below(34) {
                0 | 1 => op("q", vec![]),
                2 | 3 => op("Q", vec![]),
                4 => op("cm", vec![n(1), n(0), n(0), n(1), n(0), n(0)]),
                5 => op(
                    "cm",
                    vec![
                        n(1 + r.below(2) as i64),
                        n(0),
                        n(0),
                        n(1),
                        small(r),
                        small(r),
                    ],
                ),
                6 => op("w", vec![small(r)]),
                7 => op("J", vec![small(r)]),
                8 => op("j", vec![small(r)]),
                9 => op("M", vec![small(r)]),
                10 => op("d", vec![small(r), small(r)]),
                11 => op("ri", vec![nm(["A", "B"][r.below(2) as usize])]),
                12 => op("i", vec![small(r)]),
                13 => op("Tc", vec![small(r)]),
                14 => op("Tz", vec![small(r)]),
                15 => op("Tf", vec![nm(["F1", "F2"][r.below(2) as usize]), small(r)]),
                16 => op("Tr", vec![small(r)]),
                17 => op("g", vec![small(r)]),
                18 => op("rg", vec![small(r), small(r), small(r)]),
                19 => op("k", vec![small(r), small(r), small(r), small(r)]),
                20 => op("cs", vec![nm(["Cs1", "Cs2"][r.below(2) as usize])]),
                21 => op("sc", vec![small(r)]),
                22 => op("scn", vec![small(r), small(r)]),
                23 => op("G", vec![small(r)]),
                24 => op("RG", vec![small(r), small(r), small(r)]),
                25 => op("CS", vec![nm(["Cs1", "Cs2"][r.below(2) as usize])]),
                26 => op("SC", vec![small(r)]),
                27 => op("gs", vec![nm(["G1", "G2"][r.below(2) as usize])]),
                28 => op("BT", vec![]),
                29 => op("ET", vec![]),
                30 => op("re", vec![small(r), small(r), n(5), n(5)]),
                31 => op(["f", "S", "n", "W"][r.below(4) as usize], vec![]),
                32 => op("Tj", vec![Object::string_literal("a")]),
                _ => op("Do", vec![nm("Im1")]),
            };
            ops.push(o);
        }
        ops
    }

    #[test]
    fn sanitizing_never_changes_the_drawing() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut removed_total = 0usize;
        for case in 0..20_000 {
            let len = 1 + rng.below(40) as usize;
            let ops = random_ops(&mut rng, len);
            let before = trace(&ops);
            let (after_ops, removed) = sanitize_operations(ops.clone());
            removed_total += removed;
            assert_eq!(after_ops.len() + removed, ops.len());
            assert_eq!(
                before,
                trace(&after_ops),
                "case {case}\nbefore: {}\nafter:  {}",
                show(&ops),
                show(&after_ops)
            );
            // 2 回かけても変わらない (固定点まで繰り返している)
            assert_eq!(sanitize_operations(after_ops.clone()).1, 0, "case {case}");
        }
        assert!(
            removed_total > 10_000,
            "the generator should hit the rules often: {removed_total}"
        );
    }
}
