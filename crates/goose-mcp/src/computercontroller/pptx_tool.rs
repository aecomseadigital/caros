//! Minimal pure-Rust PPTX (PowerPoint OOXML) support.
//!
//! A `.pptx` is an OPC package — a ZIP of XML parts. There is no mature
//! `python-pptx` equivalent on crates.io, so this module hand-rolls the small
//! subset needed for the common "generate / extend a deck from content" flow:
//! create a deck, append a slide, and extract slide text. Each slide is modeled
//! as a title plus a list of bullet lines.
//!
//! Scope: this is a text-level generator. `add_slide` rebuilds the package from
//! the extracted slide model, so decks authored elsewhere keep their text but may
//! lose rich formatting (transitions, custom layouts, charts) on round-trip.

use rmcp::model::{Content, ErrorCode, ErrorData};
use std::borrow::Cow;
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// A single slide modeled as a title and bullet lines.
#[derive(Debug, Clone, Default)]
pub struct Slide {
    pub title: String,
    pub bullets: Vec<String>,
}

fn pptx_error(message: impl Into<String>) -> ErrorData {
    ErrorData {
        code: ErrorCode::INTERNAL_ERROR,
        message: Cow::from(message.into()),
        data: None,
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

// 16:9 slide in EMUs (1 inch = 914400 EMU).
const SLIDE_CX: u64 = 12192000;
const SLIDE_CY: u64 = 6858000;

fn content_types_xml(slide_count: usize) -> String {
    let mut overrides = String::new();
    for i in 1..=slide_count {
        overrides.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>{overrides}</Types>"#
    )
}

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;

fn presentation_xml(slide_count: usize) -> String {
    let mut slide_ids = String::new();
    for i in 0..slide_count {
        // slide r:ids start at rId2 (rId1 is the slide master).
        slide_ids.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
            256 + i,
            2 + i
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx="{SLIDE_CX}" cy="{SLIDE_CY}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
    )
}

fn presentation_rels(slide_count: usize) -> String {
    let mut rels = String::from(
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
    );
    for i in 0..slide_count {
        rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{}.xml\"/>",
            2 + i,
            1 + i
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
    )
}

fn slide_master_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"#
    )
}

const SLIDE_MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;

fn slide_layout_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#
    )
}

const SLIDE_LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;

const SLIDE_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#;

fn theme_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="{NS_A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#
    )
}

fn slide_xml(slide: &Slide) -> String {
    let title = esc(&slide.title);

    let mut body_paras = String::new();
    if slide.bullets.is_empty() {
        body_paras.push_str("<a:p><a:endParaRPr lang=\"en-US\"/></a:p>");
    } else {
        for bullet in &slide.bullets {
            body_paras.push_str(&format!(
                "<a:p><a:pPr><a:buChar char=\"\u{2022}\"/></a:pPr><a:r><a:rPr lang=\"en-US\" sz=\"2000\"/><a:t>{}</a:t></a:r></a:p>",
                esc(bullet)
            ));
        }
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="365125"/><a:ext cx="10820400" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="4400" b="1"/><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1825625"/><a:ext cx="10820400" cy="4351338"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{body_paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
    )
}

/// Build a complete PPTX package from the slide model and write it to `path`.
pub fn write_deck(path: &str, slides: &[Slide]) -> Result<(), ErrorData> {
    if slides.is_empty() {
        return Err(ErrorData {
            code: ErrorCode::INVALID_PARAMS,
            message: Cow::from("A presentation must have at least one slide"),
            data: None,
        });
    }

    let mut buf = Vec::new();
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buf));

        let mut put = |name: &str, data: &str| -> Result<(), ErrorData> {
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file(name, opts)
                .map_err(|e| pptx_error(format!("Failed to add {name} to PPTX: {e}")))?;
            zip.write_all(data.as_bytes())
                .map_err(|e| pptx_error(format!("Failed to write {name}: {e}")))
        };

        put("[Content_Types].xml", &content_types_xml(slides.len()))?;
        put("_rels/.rels", ROOT_RELS)?;
        put("ppt/presentation.xml", &presentation_xml(slides.len()))?;
        put(
            "ppt/_rels/presentation.xml.rels",
            &presentation_rels(slides.len()),
        )?;
        put("ppt/slideMasters/slideMaster1.xml", &slide_master_xml())?;
        put(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            SLIDE_MASTER_RELS,
        )?;
        put("ppt/slideLayouts/slideLayout1.xml", &slide_layout_xml())?;
        put(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            SLIDE_LAYOUT_RELS,
        )?;
        put("ppt/theme/theme1.xml", &theme_xml())?;

        for (i, slide) in slides.iter().enumerate() {
            let n = i + 1;
            put(&format!("ppt/slides/slide{n}.xml"), &slide_xml(slide))?;
            put(&format!("ppt/slides/_rels/slide{n}.xml.rels"), SLIDE_RELS)?;
        }

        zip.finish()
            .map_err(|e| pptx_error(format!("Failed to finalize PPTX: {e}")))?;
    }

    std::fs::write(path, &buf).map_err(|e| pptx_error(format!("Failed to write PPTX file: {e}")))
}

/// Pull the text of every `<a:t>` element out of a slide XML part.
fn extract_text_runs(xml: &str) -> Vec<String> {
    xml.split("<a:t>")
        .skip(1)
        .filter_map(|chunk| chunk.split_once("</a:t>"))
        .map(|(text, _)| unescape(text))
        .collect()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Read a PPTX into the (lossy) title + bullets slide model, in presentation order.
pub fn read_slides(path: &str) -> Result<Vec<Slide>, ErrorData> {
    let file =
        std::fs::File::open(path).map_err(|e| pptx_error(format!("Failed to open PPTX: {e}")))?;
    let mut archive = ZipArchive::new(file).map_err(|e| {
        pptx_error(format!(
            "Failed to read PPTX (not a valid Office Open XML package?): {e}"
        ))
    })?;

    // Collect (slide_number, xml) for every ppt/slides/slideN.xml part.
    let mut slides: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| pptx_error(format!("Failed to read PPTX entry: {e}")))?;
        let name = entry.name().to_string();
        if let Some(num) = slide_number(&name) {
            let mut xml = String::new();
            entry
                .read_to_string(&mut xml)
                .map_err(|e| pptx_error(format!("Failed to read {name}: {e}")))?;
            slides.push((num, xml));
        }
    }
    slides.sort_by_key(|(n, _)| *n);

    Ok(slides
        .into_iter()
        .map(|(_, xml)| parse_slide(&xml))
        .collect())
}

/// Parse a slide: text in the title placeholder shape becomes `title`, the rest become bullets.
fn parse_slide(xml: &str) -> Slide {
    let mut title = String::new();
    let mut bullets = Vec::new();

    for sp in xml.split("<p:sp>").skip(1) {
        let sp = sp.split("</p:sp>").next().unwrap_or(sp);
        let runs = extract_text_runs(sp);
        if runs.is_empty() {
            continue;
        }
        if sp.contains("type=\"title\"") || sp.contains("type=\"ctrTitle\"") {
            title = runs.join(" ");
        } else {
            bullets.extend(runs);
        }
    }

    Slide { title, bullets }
}

/// Return `N` for a `ppt/slides/slideN.xml` part name (and not its `_rels`), else `None`.
fn slide_number(name: &str) -> Option<usize> {
    let stem = name.strip_prefix("ppt/slides/slide")?;
    let num = stem.strip_suffix(".xml")?;
    num.parse().ok()
}

/// `extract_text` operation: human-readable rendering of all slides.
pub fn extract_text(path: &str) -> Result<Vec<Content>, ErrorData> {
    let slides = read_slides(path)?;
    if slides.is_empty() {
        return Ok(vec![Content::text("No slides found.")]);
    }
    let mut out = String::new();
    for (i, slide) in slides.iter().enumerate() {
        out.push_str(&format!("Slide {}:\n", i + 1));
        if !slide.title.is_empty() {
            out.push_str(&format!("  Title: {}\n", slide.title));
        }
        for bullet in &slide.bullets {
            out.push_str(&format!("  - {}\n", bullet));
        }
        out.push('\n');
    }
    Ok(vec![Content::text(out.trim_end().to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn test_create_and_extract_roundtrip() {
        let path = tmp("caros_pptx_roundtrip.pptx");
        let slides = vec![
            Slide {
                title: "Welcome to Caros".into(),
                bullets: vec!["First point".into(), "Second & <special>".into()],
            },
            Slide {
                title: "Next Slide".into(),
                bullets: vec!["Only bullet".into()],
            },
        ];

        write_deck(path.to_str().unwrap(), &slides).expect("write should succeed");
        assert!(path.exists());

        let read = read_slides(path.to_str().unwrap()).expect("read should succeed");
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].title, "Welcome to Caros");
        assert_eq!(read[0].bullets, vec!["First point", "Second & <special>"]);
        assert_eq!(read[1].title, "Next Slide");
        assert_eq!(read[1].bullets, vec!["Only bullet"]);

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn test_add_slide_preserves_existing() {
        let path = tmp("caros_pptx_append.pptx");
        write_deck(
            path.to_str().unwrap(),
            &[Slide {
                title: "One".into(),
                bullets: vec!["a".into()],
            }],
        )
        .unwrap();

        let mut slides = read_slides(path.to_str().unwrap()).unwrap();
        slides.push(Slide {
            title: "Two".into(),
            bullets: vec!["b".into()],
        });
        write_deck(path.to_str().unwrap(), &slides).unwrap();

        let read = read_slides(path.to_str().unwrap()).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].title, "One");
        assert_eq!(read[1].title, "Two");

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn test_extract_text_format() {
        let path = tmp("caros_pptx_extract.pptx");
        write_deck(
            path.to_str().unwrap(),
            &[Slide {
                title: "Hdr".into(),
                bullets: vec!["x".into(), "y".into()],
            }],
        )
        .unwrap();

        let content = extract_text(path.to_str().unwrap()).unwrap();
        let text = content[0].as_text().unwrap();
        assert!(text.text.contains("Slide 1:"));
        assert!(text.text.contains("Title: Hdr"));
        assert!(text.text.contains("- x"));
        assert!(text.text.contains("- y"));

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn test_empty_deck_rejected() {
        let path = tmp("caros_pptx_empty.pptx");
        assert!(write_deck(path.to_str().unwrap(), &[]).is_err());
    }

    // S6.1 (CAROS_SECURITY_REVIEW): reading an untrusted .pptx must not be
    // vulnerable to zip-slip. The reader matches only `ppt/slides/slideN.xml`
    // and reads entries in memory — it never writes any entry to disk by name —
    // so a `../`-traversal entry is simply ignored.
    #[test]
    fn test_read_ignores_path_traversal_entries() {
        let path = tmp("caros_pptx_zipslip.pptx");
        let slide = "<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr>\
            <p:ph type=\"title\"/></p:nvPr></p:nvSpPr><a:t>Safe</a:t></p:sp>\
            </p:spTree></p:cSld></p:sld>";

        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            // Malicious traversal entry that must never be acted upon.
            zip.start_file("../../../caros_pptx_evil.xml", opts)
                .unwrap();
            zip.write_all(b"<evil/>").unwrap();
            zip.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zip.write_all(slide.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        std::fs::write(&path, buf.into_inner()).unwrap();

        let evil = std::env::temp_dir().join("caros_pptx_evil.xml");
        std::fs::remove_file(&evil).ok();

        let read = read_slides(path.to_str().unwrap()).expect("read should succeed");
        assert_eq!(read.len(), 1, "only the legitimate slide entry is parsed");
        assert_eq!(read[0].title, "Safe");
        assert!(
            !evil.exists(),
            "no entry is ever written to the filesystem by name"
        );

        std::fs::remove_file(path).ok();
    }
}
