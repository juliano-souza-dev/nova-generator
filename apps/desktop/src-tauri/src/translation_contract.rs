use serde::Serialize;
use serde_json::{json, Value};

pub const INPUT_CONTRACT: &str = "nova-generator-editorial-input/1.3";
pub const OUTPUT_CONTRACT: &str = "nova-generator-editorial-suggestions/1.3";

pub const EDITORIAL_RULES: &str = r#"Você executa o contrato editorial do Nova Generator, versão 1.3.
ESCOPO OBRIGATÓRIO: revisão fiel da transcrição, tradução contextual integral para português brasileiro, traduções individuais das palavras e sugestões de unidades semânticas.
NÃO produza marcação pedagógica, mini-aulas, exercícios, exemplos didáticos ou conteúdo para Anki.
Traduza integralmente cada linha. Não resuma, não omita orações, detalhes, negações, condições, causas, consequências, repetições relevantes ou interjeições. Use PT-BR natural sem reduzir o conteúdo.
Use a transcrição completa como contexto, mas produza uma sugestão para cada cue_id solicitado. Preserve todos os IDs e timestamps recebidos. Não crie, remova ou renumere cues ou palavras.
approved_en deve conter a versão revisada da fala no idioma original, sem mudar seu conteúdo. approved_pt deve conter a tradução completa e natural da linha.
Quando predictions.word_translations=true, cada palavra recebida deve aparecer exatamente uma vez em word_translations, preservando word_id, order, leading, surface, start_ms e end_ms. Preencha pt com a tradução contextual da palavra. Quando predictions.semantic_units=true, semantic_units deve conter apenas grupos contíguos de palavras da mesma cue, sem sobreposição. Cada grupo deve ter semantic_group_id único, word_ids em ordem e uma tradução natural completa em pt. Nas palavras agrupadas, registre semantic_group_id e semantic_group_role: a primeira palavra é lead e recebe em pt a tradução completa da unidade; as demais são member e preservam sua tradução individual anterior em pt_original. Não force agrupamentos quando não forem necessários.
trailing deve preservar eventual texto residual não associado a palavra. notes deve registrar apenas observações editoriais relevantes, nunca explicações pedagógicas.
A saída é um rascunho para revisão humana. Não aprove nem publique automaticamente.
Responda exclusivamente com JSON válido no contrato nova-generator-editorial-suggestions/1.3, no formato { "contract": "nova-generator-editorial-suggestions/1.3", "approval": "draft", "source_hash": "hash recebido", "predictions": { "word_translations": true|false, "semantic_units": true|false }, "suggestions": [...] }. Copie source_hash exatamente da entrada e repita exatamente as opções recebidas em predictions."#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPackage {
    pub package_version: String,
    pub contract_id: String,
    pub files: std::collections::BTreeMap<String, String>,
}

pub(crate) fn split_leading(value: &str) -> (String, String) {
    let split = value.char_indices().find(|(_, c)| !c.is_whitespace()).map(|(i, _)| i).unwrap_or(value.len());
    (value[..split].to_string(), value[split..].to_string())
}

pub fn input_hash(input: &Value) -> Result<String, String> {
    let mut canonical = input.clone();
    if let Some(object) = canonical.as_object_mut() { object.remove("source_hash"); }
    let bytes = serde_json::to_vec(&canonical).map_err(|e| e.to_string())?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes { hash ^= byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
    Ok(format!("fnv1a64:{hash:016x}"))
}

pub fn build_editorial_input(
    project_id: &str,
    asset_id: &str,
    cues: &[crate::media::SubtitleCue],
    include_word_translations: bool,
    include_semantic_units: bool,
) -> Result<Value, String> {
    let cue_values = cues.iter().enumerate().map(|(cue_order, cue)| {
        let words = if include_word_translations {
            cue.words.as_deref().unwrap_or(&[]).iter().enumerate().map(|(order, word)| {
                let (leading, surface) = split_leading(&word.text);
                json!({
                    "word_id": format!("{}:word:{:04}", cue.id, order + 1),
                    "order": order + 1,
                    "leading": leading,
                    "surface": surface,
                    "start_ms": word.start_ms,
                    "end_ms": word.end_ms
                })
            }).collect::<Vec<_>>()
        } else { Vec::new() };
        json!({
            "cue_id": cue.id,
            "order": cue_order + 1,
            "start_ms": cue.start_ms,
            "end_ms": cue.end_ms,
            "text": cue.text,
            "words": words
        })
    }).collect::<Vec<_>>();

    let mut input = json!({
        "contract": INPUT_CONTRACT,
        "project_id": project_id,
        "asset_id": asset_id,
        "source_language": "auto",
        "target_language": "pt-BR",
        "predictions": {
            "word_translations": include_word_translations,
            "semantic_units": include_semantic_units
        },
        "cues": cue_values
    });
    input["source_hash"] = json!(input_hash(&input)?);
    Ok(input)
}

pub fn output_schema(include_word_translations: bool, include_semantic_units: bool, source_hash: &str) -> Value {
    let mut suggestion = json!({
        "type": "object",
        "required": ["cue_id", "approved_en", "approved_pt", "trailing", "notes"],
        "properties": {
            "cue_id": {"type":"string"},
            "approved_en": {"type":"string"},
            "approved_pt": {"type":"string"},
            "trailing": {"type":"string"},
            "notes": {"type":"string"}
        }
    });
    if include_word_translations {
        suggestion["required"].as_array_mut().unwrap().push(json!("word_translations"));
        suggestion["properties"]["word_translations"] = json!({
            "type":"array",
            "items":{
                "type":"object",
                "required":["word_id","order","leading","surface","start_ms","end_ms","pt"],
                "properties":{
                    "word_id":{"type":"string"},
                    "order":{"type":"integer"},
                    "leading":{"type":"string"},
                    "surface":{"type":"string"},
                    "start_ms":{"type":"integer"},
                    "end_ms":{"type":"integer"},
                    "pt":{"type":"string"},"semantic_group_id":{"type":"string"},"semantic_group_role":{"enum":["lead","member"]},"pt_original":{"type":"string"}
                }
            }
        });
    }
    if include_semantic_units {
        suggestion["required"].as_array_mut().unwrap().push(json!("semantic_units"));
        suggestion["properties"]["semantic_units"] = json!({
            "type":"array",
            "items":{
                "type":"object",
                "required":["semantic_group_id","word_ids","pt"],
                "properties":{
                    "semantic_group_id":{"type":"string"},
                    "word_ids":{"type":"array","items":{"type":"string"},"minItems":2},
                    "pt":{"type":"string"}
                }
            }
        });
    }
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "type":"object",
        "required":["contract","approval","source_hash","predictions","suggestions"],
        "properties":{
            "contract":{"const":OUTPUT_CONTRACT},
            "approval":{"const":"draft"},
            "source_hash":{"const":source_hash},
            "predictions":{"type":"object","required":["word_translations","semantic_units"],"properties":{"word_translations":{"const":include_word_translations},"semantic_units":{"const":include_semantic_units}}},
            "suggestions":{"type":"array","items":suggestion}
        }
    })
}

pub fn build_external_package(
    project_id: &str,
    asset_id: &str,
    cues: &[crate::media::SubtitleCue],
    include_word_translations: bool,
    include_semantic_units: bool,
) -> Result<ExternalPackage, String> {
    if include_semantic_units && !include_word_translations { return Err("Unidades semânticas dependem das traduções palavra por palavra. Ative as duas predições.".into()); }
    if cues.is_empty() { return Err("Não há trechos de transcrição para preparar o pacote.".into()); }
    if cues.len() > 5000 { return Err("O projeto excede o limite de 5.000 trechos.".into()); }
    if cues.iter().any(|c| c.id.trim().is_empty() || c.text.trim().is_empty() || c.end_ms <= c.start_ms) {
        return Err("A transcrição contém trechos inválidos.".into());
    }
    let input = build_editorial_input(project_id, asset_id, cues, include_word_translations, include_semantic_units)?;
    let schema = output_schema(include_word_translations, include_semantic_units, input["source_hash"].as_str().unwrap_or(""));
    let contract_md = format!("# Contrato editorial Nova Generator 1.3\n\nIdentificador de entrada: `{INPUT_CONTRACT}`\n\nIdentificador de saída: `{OUTPUT_CONTRACT}`\n\n## Regras obrigatórias\n\n{EDITORIAL_RULES}\n\n## Predições selecionadas\n\n- Tradução por palavra: {}\n- Unidades semânticas: {}\n- Revisão humana obrigatória; a resposta deve permanecer em estado `draft`.\n",
        if include_word_translations { "incluída" } else { "não incluída" },
        if include_semantic_units { "incluídas" } else { "não incluídas" });
    let readme = format!("# Pacote editorial para IA externa\n\n1. Leia `CONTRACT.md` integralmente.\n2. Use `input.json` como fonte dos textos, IDs e tempos.\n3. Produza somente um JSON que respeite `output-schema.json`.\n4. Salve a resposta como `output.json`.\n5. Não altere IDs, ordem ou timestamps. Não omita conteúdo.\n6. Não produza conteúdo pedagógico, mini-aulas, exercícios ou Anki.\n7. Mantenha `approval` como `draft`; a aprovação será humana no Nova Generator.\n\nContrato: `{OUTPUT_CONTRACT}`.\n");
    let mut files = std::collections::BTreeMap::new();
    files.insert("CONTRACT.md".into(), contract_md);
    files.insert("README.md".into(), readme);
    files.insert("input.json".into(), serde_json::to_string_pretty(&input).map_err(|e| e.to_string())?);
    files.insert("output-schema.json".into(), serde_json::to_string_pretty(&schema).map_err(|e| e.to_string())?);
    Ok(ExternalPackage { package_version: "1.0".into(), contract_id: OUTPUT_CONTRACT.into(), files })
}

#[tauri::command]
pub fn prepare_external_translation_package(
    project_id: String,
    asset_id: String,
    cues: Vec<crate::media::SubtitleCue>,
    include_word_translations: bool,
    include_semantic_units: bool,
) -> Result<ExternalPackage, String> {
    build_external_package(&project_id, &asset_id, &cues, include_word_translations, include_semantic_units)
}
