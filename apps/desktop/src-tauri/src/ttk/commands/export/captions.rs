use super::{ExportCaptionWord, ExportMotion};

pub(super) fn estimate_text_width(value: &str, font_size: u32) -> f64 {
    value.chars().map(|character| {
        let factor = match character {
            'i' | 'l' | 'I' | '!' | '.' | ',' | ':' | ';' | '\'' | '|' => 0.28,
            'f' | 't' | 'r' | '(' | ')' | '[' | ']' => 0.36,
            'm' | 'w' | 'M' | 'W' | '@' | '%' => 0.88,
            ' ' => 0.30,
            c if c.is_ascii_uppercase() => 0.66,
            c if c.is_ascii_digit() => 0.56,
            _ => 0.54,
        };
        factor * font_size.max(1) as f64
    }).sum()
}

pub(super) fn wrap_text_for_export(value: &str, font_size: u32) -> String {
    wrap_text_for_export_width(value, font_size, 972.0)
}

pub(super) fn wrap_text_for_export_width(value: &str, font_size: u32, max_width: f64) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let max_width = max_width.max(1.0);

    normalized.split('\n').map(|line| {
        let mut lines = Vec::new();
        let mut current = String::new();

        for word in line.split_whitespace() {
            if !current.is_empty() {
                let candidate = format!("{current} {word}");
                if estimate_text_width(&candidate, font_size) <= max_width {
                    current = candidate;
                    continue;
                }

                lines.push(std::mem::take(&mut current));
            }

            // A long token must also wrap when it is the first item on a line.
            // Previously the empty-line fast path accepted it without checking
            // its width, which let URLs and unbroken strings overflow the frame.
            for character in word.chars() {
                let candidate = format!("{current}{character}");
                if !current.is_empty() && estimate_text_width(&candidate, font_size) > max_width {
                    lines.push(std::mem::take(&mut current));
                }
                current.push(character);
            }
        }

        if !current.is_empty() {
            lines.push(current);
        }

        lines.join("\n")
    }).collect::<Vec<_>>().join("\n")
}

pub(super) fn ass_color(color: &str, alpha: u8) -> String {
    let raw = color.trim().trim_start_matches('#');
    let rgb = u32::from_str_radix(raw, 16).unwrap_or(0xFFFFFF);
    let red = (rgb >> 16) & 0xFF;
    let green = (rgb >> 8) & 0xFF;
    let blue = rgb & 0xFF;
    format!("&H{alpha:02X}{blue:02X}{green:02X}{red:02X}&")
}

pub(super) fn ass_timestamp(milliseconds: u64) -> String {
    let centiseconds = milliseconds / 10;
    let total_seconds = centiseconds / 100;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours}:{minutes:02}:{seconds:02}.{:02}", centiseconds % 100)
}

pub(super) fn ass_escape_text(value: &str) -> String {
    value.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace("\r\n", "\\N")
        .replace('\r', "\\N")
        .replace('\n', "\\N")
}

pub(super) fn ass_caption_script(item: &ExportMotion) -> String {
    let width = (item.caption_width.clamp(60.0, 100.0) * 10.8).round();
    let margin = ((1080.0 - width) / 2.0).round() as u32;
    let font_size = item.font_size.clamp(18, 180);
    let text_margin = margin + (font_size as f64 * 0.55).round() as u32;
    let font_name = if item.font_family.trim().is_empty() { "Arial" } else { item.font_family.trim() };
    let bold = if item.font_weight >= 700 { -1 } else { 0 };
    let primary = ass_color(&item.color, 0);
    let secondary = ass_color(if item.caption_accent.is_empty() { "#65d6c0" } else { &item.caption_accent }, 0);
    let alignment = match item.text_align.as_str() { "left" => 4, "right" => 6, _ => 5 };
    let anchor_x = match item.text_align.as_str() { "left" => text_margin as f64, "right" => 1080.0 - text_margin as f64, _ => 540.0 };
    let anchor_y = (item.y.clamp(0.0, 100.0) / 100.0 * 1920.0).round();
    let style = format!(
        "Style: Caption,{font_name},{font_size},{primary},{secondary},&H00000000&,&H00000000&,{bold},0,0,0,100,100,0,0,1,0,0,{alignment},{text_margin},{text_margin},0,1"
    );
    let words = &item.caption_words;
    let source = if words.is_empty() {
        item.text.split('\n').next().unwrap_or(&item.text).to_string()
    } else {
        words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ")
    };
    let translation = item.text.split('\n').skip(1).collect::<Vec<_>>().join("\n");
    let mut semantic_groups: Vec<(String, String, u64, u64)> = Vec::new();
    for (index, word) in words.iter().enumerate() {
        let text = word.pt.trim();
        if word.pt_group.trim().is_empty() && text.is_empty() { continue; }
        let id = if word.pt_group.trim().is_empty() { format!("__word_{index}") } else { word.pt_group.clone() };
        if let Some(group) = semantic_groups.iter_mut().find(|group| group.0 == id) {
            group.2 = group.2.min(word.start_ms);
            group.3 = group.3.max(word.end_ms);
            if group.1.is_empty() && !text.is_empty() { group.1 = text.to_string(); }
        } else {
            semantic_groups.push((id, text.to_string(), word.start_ms, word.end_ms));
        }
    }
    semantic_groups.retain(|group| !group.1.is_empty());
    if !words.iter().all(|word| !word.pt_group.trim().is_empty() || !word.pt.trim().is_empty()) {
        semantic_groups.clear();
    }
    semantic_groups.sort_by_key(|group| group.2);
    let mut boundaries = vec![item.start_ms, item.end_ms];
    for word in words {
        boundaries.push(word.start_ms.max(item.start_ms).min(item.end_ms));
        boundaries.push(word.end_ms.max(item.start_ms).min(item.end_ms));
    }
    for group in &semantic_groups {
        boundaries.push(group.2.max(item.start_ms).min(item.end_ms));
        boundaries.push(group.3.max(item.start_ms).min(item.end_ms));
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut intervals: Vec<(u64, u64, Option<usize>, Option<usize>)> = Vec::new();
    if words.is_empty() {
        intervals.push((item.start_ms, item.end_ms, None, None));
    } else {
        for pair in boundaries.windows(2) {
            let start = pair[0];
            let end = pair[1];
            if end <= start { continue; }
            let active_word = words.iter().position(|word| start >= word.start_ms && start < word.end_ms);
            let active_group = semantic_groups.iter().position(|group| start >= group.2 && start < group.3);
            intervals.push((start, end, active_word, active_group));
        }
    }
    let mut script = String::from(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n"
    );
    script.push_str(&style);
    script.push_str("\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n");
    for (start_ms, end_ms, active_word, active_group) in intervals {
        if end_ms <= start_ms { continue; }
        let max_text_width = (width - font_size as f64 * 1.1).max(font_size as f64);
        let mut source_markup = String::new();
        if words.is_empty() {
            let wrapped = wrap_text_for_export_width(&source, font_size, max_text_width);
            source_markup.push_str(&ass_escape_text(&wrapped));
        } else {
            let mut current_width = 0.0_f64;
            for (index, word) in words.iter().enumerate() {
                let word_width = estimate_text_width(&word.text, font_size);
                let next_width = if current_width <= 0.0 { word_width } else {
                    current_width + estimate_text_width(" ", font_size) + word_width
                };
                if current_width > 0.0 && next_width > max_text_width {
                    source_markup.push_str("\\N");
                    current_width = 0.0;
                } else if current_width > 0.0 {
                    source_markup.push(' ');
                    current_width += estimate_text_width(" ", font_size);
                }
                if Some(index) == active_word {
                    source_markup.push_str(&format!("{{\\1c{secondary}}}{}{{\\rCaption}}", ass_escape_text(&word.text)));
                } else {
                    source_markup.push_str(&ass_escape_text(&word.text));
                }
                current_width += word_width;
            }
        }
        let translation_markup = if !semantic_groups.is_empty() {
            let translation_size = (font_size as f64 * 0.72).round().max(12.0) as u32;
            let mut markup = String::new();
            let mut current_width = 0.0_f64;
            for (index, group) in semantic_groups.iter().enumerate() {
                let group_width = estimate_text_width(&group.1, translation_size);
                let next_width = if current_width <= 0.0 { group_width } else { current_width + estimate_text_width(" ", translation_size) + group_width };
                if current_width > 0.0 && next_width > max_text_width {
                    markup.push_str("\\N");
                    current_width = 0.0;
                } else if current_width > 0.0 {
                    markup.push(' ');
                    current_width += estimate_text_width(" ", translation_size);
                }
                if Some(index) == active_group {
                    markup.push_str(&format!("{{\\fs{translation_size}\\1c{secondary}}}{}{{\\rCaption}}", ass_escape_text(&group.1)));
                } else {
                    markup.push_str(&format!("{{\\fs{translation_size}\\1c&H00DFD4D8&}}{}{{\\rCaption}}", ass_escape_text(&group.1)));
                }
                current_width += group_width;
            }
            format!("\\N{markup}")
        } else if translation.trim().is_empty() {
            String::new()
        } else {
            let translation_size = (font_size as f64 * 0.72).round().max(12.0) as u32;
            let wrapped_translation = wrap_text_for_export_width(&translation, translation_size, max_text_width);
            format!("\\N{{\\fs{translation_size}\\1c&H00DFD4D8&}}{}{{\\rCaption}}", ass_escape_text(&wrapped_translation))
        };
        let text = format!("{{\\an{alignment}\\pos({anchor_x:.0},{anchor_y:.0})}}{source_markup}{translation_markup}");
        script.push_str(&format!(
            "Dialogue: 0,{},{},Caption,,0,0,0,,{}\n",
            ass_timestamp(start_ms), ass_timestamp(end_ms), text
        ));
    }
    script
}

pub(super) fn ffmpeg_escape_filter_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

pub(super) fn caption_background_geometry(item: &ExportMotion) -> Option<(f64, f64, f64, f64, String)> {
    let opacity = item.caption_background_opacity.clamp(0.0, 1.0);
    if opacity <= 0.0 { return None; }
    let width = item.caption_width.clamp(60.0, 100.0) * 10.8;
    let x = (1080.0 - width) / 2.0;
    let font_size = item.font_size.clamp(18, 180);
    let max_text_width = (width - font_size as f64 * 1.1).max(font_size as f64);
    let source = if item.caption_words.is_empty() {
        item.text.split('\n').next().unwrap_or(&item.text)
    } else { "" };
    let source_owned = if item.caption_words.is_empty() { source.to_string() } else {
        item.caption_words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ")
    };
    let source_lines = wrap_text_for_export_width(&source_owned, font_size, max_text_width).lines().count().max(1) as f64;
    let translation = item.text.split('\n').skip(1).collect::<Vec<_>>().join(" ");
    let translation_lines = if translation.trim().is_empty() { 0.0 } else {
        wrap_text_for_export_width(&translation, (font_size as f64 * 0.72).round() as u32, max_text_width).lines().count().max(1) as f64
    };
    let padding = item.caption_padding_em.clamp(0.0, 1.0) * font_size as f64;
    let height = (source_lines * font_size as f64 * 1.18 + translation_lines * font_size as f64 * 0.72 * 1.18 + padding * 2.0).max(font_size as f64);
    let anchor_y = item.y.clamp(0.0, 100.0) / 100.0 * 1920.0;
    let y = (anchor_y - height / 2.0).clamp(0.0, (1920.0 - height).max(0.0));
    let raw_color = item.caption_background_color.trim().trim_start_matches('#');
    let color = if raw_color.len() == 6 && u32::from_str_radix(raw_color, 16).is_ok() {
        format!("0x{raw_color}@{opacity:.3}")
    } else { format!("black@{opacity:.3}") };
    Some((x, y, width, height.min(1920.0), color))
}

pub(super) fn ffmpeg_escape_expression(value: &str) -> String {
    value.replace(',', "\\,")
}

pub(super) fn ffmpeg_escape_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "'\\''")
        .replace(':', "\\:")
        .replace('%', "\\%")
        .replace(',', "\\,")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('\r', "")
}


#[cfg(test)]
mod wrapping_tests {
    use super::{estimate_text_width, wrap_text_for_export_width};

    #[test]
    fn wraps_a_long_unbroken_token_even_at_the_start_of_a_line() {
        let wrapped = wrap_text_for_export_width("abcdefghij", 10, 20.0);
        assert!(wrapped.contains('\n'));
        assert!(wrapped.lines().all(|line| estimate_text_width(line, 10) <= 20.0));
    }

    #[test]
    fn wraps_words_to_the_available_width() {
        let wrapped = wrap_text_for_export_width("one two three", 10, 30.0);
        assert_eq!(wrapped, "one\ntwo\nthree");
    }

    #[test]
    fn preserves_explicit_and_blank_line_breaks() {
        let wrapped = wrap_text_for_export_width("first\n\nsecond", 10, 500.0);
        assert_eq!(wrapped, "first\n\nsecond");
    }
}
