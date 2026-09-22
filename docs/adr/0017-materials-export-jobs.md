# ADR 0017: Review materials against canonical cue audio

## Context

The studio needs to select cards derived from approved cues and show the same WAV and reel
interval that the Anki export uses. Editorial text must remain literal, and a voice profile
must not change under an in-flight export.

## Decision

The material selection flag lives in cue provenance as `anki_included`, defaulting to true.
This does not alter approved text, cue timing, or the Generator–iHub contract. The materials
API reads approved cues and resolves audio through the content-addressed speech cache using
the selected voice profile version. Its audio endpoint streams that cached WAV directly.

Export enqueue freezes the selected cue IDs, approved EN hashes, canonical WAV hashes, and
voice snapshot. The worker rechecks them before calling the existing Anki and reel exporter.
The APKG writer receives those WAV paths, and the manifest records their hashes and reel
intervals. A changed cue, voice file, or missing WAV fails the export with the affected cue
identified. A new export may then be queued after repairing that cue.

The queue and artifacts use existing durable job storage and the configured media cache root.
Artifacts are exposed only for a succeeded export job belonging to the requested project.

## Recovery

Run `python -m nova_generator.worker` with FFmpeg, FFprobe, and the configured local TTS
environment. For a failed audio job, prepare the affected card again. For a failed export,
inspect its job error, repair the named card, and enqueue a fresh export. Completed artifacts
remain under `media_cache/exports/<job-id>/`; clear a failed job's partial directory before
retrying that job, or enqueue a fresh export with a new job ID.
