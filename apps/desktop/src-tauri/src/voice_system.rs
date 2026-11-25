use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelOption {
    id: &'static str,
    repository: &'static str,
    label: &'static str,
    installation: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineOption {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    recommended: bool,
    voice_modes: &'static [&'static str],
    languages: &'static [&'static str],
    models: Vec<ModelOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectParameter {
    id: &'static str,
    label: &'static str,
    default: f32,
    min: f32,
    max: f32,
    step: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectOption {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    parameters: Vec<EffectParameter>,
}

#[tauri::command]
pub fn list_voice_engines() -> Vec<EngineOption> {
    vec![
        EngineOption {
            id: "qwen3-tts-base",
            name: "Qwen3-TTS Base",
            description: "Clonagem de voz a partir de áudio de referência.",
            recommended: true,
            voice_modes: &["cloned"],
            languages: &["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
            models: vec![ModelOption {
                id: "qwen3-tts-1.7b-base",
                repository: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
                label: "1.7B Base",
                installation: "on-demand",
            }],
        },
        EngineOption {
            id: "qwen3-tts-custom-voice",
            name: "Qwen3-TTS CustomVoice",
            description: "Vozes predefinidas com controle de estilo por instruções.",
            recommended: false,
            voice_modes: &["preset"],
            languages: &["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
            models: vec![
                ModelOption {
                    id: "qwen3-tts-custom-voice-1.7b",
                    repository: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
                    label: "1.7B CustomVoice",
                    installation: "on-demand",
                },
                ModelOption {
                    id: "qwen3-tts-custom-voice-0.6b",
                    repository: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                    label: "0.6B CustomVoice",
                    installation: "on-demand",
                },
            ],
        },
        EngineOption {
            id: "qwen3-tts-voice-design",
            name: "Qwen3-TTS VoiceDesign",
            description: "Criação de vozes a partir de descrições textuais.",
            recommended: true,
            voice_modes: &["designed"],
            languages: &["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
            models: vec![ModelOption {
                id: "qwen3-tts-voice-design-1.7b",
                repository: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
                label: "1.7B VoiceDesign",
                installation: "on-demand",
            }],
        },
        EngineOption {
            id: "piper",
            name: "Piper",
            description: "Síntese local leve com vozes baixáveis individualmente.",
            recommended: true,
            voice_modes: &["preset"],
            languages: &["en", "pt", "es", "de", "fr"],
            models: vec![],
        },
    ]
}

#[tauri::command]
pub fn list_voice_effects() -> Vec<EffectOption> {
    vec![
        EffectOption {
            id: "chorus",
            name: "Chorus / Flanger",
            description: "Modulação de atraso para adicionar largura e movimento à voz.",
            parameters: vec![
                EffectParameter { id: "rate_hz", label: "Velocidade", default: 1.0, min: 0.01, max: 20.0, step: 0.01 },
                EffectParameter { id: "depth", label: "Profundidade", default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
                EffectParameter { id: "feedback", label: "Feedback", default: 0.0, min: 0.0, max: 0.95, step: 0.01 },
                EffectParameter { id: "centre_delay_ms", label: "Atraso central", default: 7.0, min: 0.5, max: 50.0, step: 0.1 },
                EffectParameter { id: "mix", label: "Mistura", default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
            ],
        },
        EffectOption {
            id: "reverb",
            name: "Reverb",
            description: "Ambiência e sensação de espaço.",
            parameters: vec![
                EffectParameter { id: "room_size", label: "Tamanho do ambiente", default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
                EffectParameter { id: "damping", label: "Amortecimento", default: 0.5, min: 0.0, max: 1.0, step: 0.01 },
                EffectParameter { id: "wet_level", label: "Sinal processado", default: 0.33, min: 0.0, max: 1.0, step: 0.01 },
                EffectParameter { id: "dry_level", label: "Sinal original", default: 0.4, min: 0.0, max: 1.0, step: 0.01 },
                EffectParameter { id: "width", label: "Largura estéreo", default: 1.0, min: 0.0, max: 1.0, step: 0.01 },
            ],
        },
        EffectOption {
            id: "delay",
            name: "Delay",
            description: "Repetições temporizadas do sinal.",
            parameters: vec![
                EffectParameter { id: "delay_seconds", label: "Tempo", default: 0.3, min: 0.01, max: 2.0, step: 0.01 },
                EffectParameter { id: "feedback", label: "Feedback", default: 0.3, min: 0.0, max: 0.95, step: 0.01 },
                EffectParameter { id: "mix", label: "Mistura", default: 0.3, min: 0.0, max: 1.0, step: 0.01 },
            ],
        },
        EffectOption {
            id: "compressor",
            name: "Compressor",
            description: "Controla a dinâmica e mantém o volume mais consistente.",
            parameters: vec![
                EffectParameter { id: "threshold_db", label: "Limiar", default: -20.0, min: -60.0, max: 0.0, step: 0.5 },
                EffectParameter { id: "ratio", label: "Proporção", default: 4.0, min: 1.0, max: 20.0, step: 0.1 },
                EffectParameter { id: "attack_ms", label: "Ataque", default: 10.0, min: 0.1, max: 100.0, step: 0.1 },
                EffectParameter { id: "release_ms", label: "Liberação", default: 100.0, min: 10.0, max: 1000.0, step: 1.0 },
            ],
        },
        EffectOption {
            id: "gain",
            name: "Ganho",
            description: "Ajuste de volume em decibéis.",
            parameters: vec![EffectParameter { id: "gain_db", label: "Ganho", default: 0.0, min: -40.0, max: 40.0, step: 0.5 }],
        },
        EffectOption {
            id: "highpass",
            name: "Filtro passa-altas",
            description: "Remove frequências abaixo do corte.",
            parameters: vec![EffectParameter { id: "cutoff_frequency_hz", label: "Frequência de corte", default: 80.0, min: 20.0, max: 8000.0, step: 1.0 }],
        },
        EffectOption {
            id: "lowpass",
            name: "Filtro passa-baixas",
            description: "Remove frequências acima do corte.",
            parameters: vec![EffectParameter { id: "cutoff_frequency_hz", label: "Frequência de corte", default: 8000.0, min: 200.0, max: 20000.0, step: 1.0 }],
        },
        EffectOption {
            id: "pitch_shift",
            name: "Alteração de tom",
            description: "Transpõe a voz em semitons.",
            parameters: vec![EffectParameter { id: "semitones", label: "Semitons", default: 0.0, min: -12.0, max: 12.0, step: 0.5 }],
        },
    ]
}
