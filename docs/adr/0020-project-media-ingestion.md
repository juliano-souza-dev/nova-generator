# ADR 0020: Project-scoped source ingestion

## Context

The project UI could queue a generic `download_youtube` job, but the worker did not process it.
The cut editor used a placeholder duration and waveform, and no safe route served the verified
source or the project cut. The existing downloader, cutter, waveform generator and ASR adapter
needed a production path without accepting filesystem paths from the browser.

## Decision

`/projects/{id}/media` exposes the verified source duration, job state, the latest successful
cut, waveform and ASR candidate. The browser submits only a project ID, cut times and language.
The API validates the range against the verified cache metadata and freezes the source hash in
the job input. The worker resolves the source from the global YouTube cache and writes each cut
under `project_root/<project-id>/cuts/<job-id>.mp4`. It checks project ownership, source ID and
hash again before work. These IDs are parsed as UUIDs or validated YouTube IDs; client paths
never reach FFmpeg. Streaming routes serve only a verified source or successful project job.

`ingest_scene_media` stores waveform and ASR candidate in durable job output. It does not
modify approved editorial text. The output includes source and cut timing so editorial review
can import the candidate separately. A heartbeat renews the job lease during long download,
FFmpeg and ASR calls. An identical source can be reused across projects while cuts remain local.

## Recovery

Run `python -m nova_generator.worker` with yt-dlp, FFmpeg/FFprobe and the ASR extra installed.
If download fails, inspect the job error and retry or requeue from the media screen. If cut or
ASR fails, correct the source or range and enqueue a new job. A retry of the same ingest job
replaces only its own cut file; prior successful cuts remain available. No migration or public
Generator–iHub contract changes are required.
