# Day 4 · Deep Listening

## Purpose

Day 4 develops the learner's ability to understand natural spoken English with less visual support. The learner listens without subtitles, retrieves missing information, notices connected speech, and follows rhythm and meaningful phrase groups.

## Source and constraints

Nova Generator exports transcript cues with exact cue order, timestamps, and word-level timing when available. The TXT does not embed audio. External AI must not claim to have listened to the recording or infer measured speed, volume, accent, stress, or pronunciation details from text alone.

Every task points to exactly one original cue. The excerpt must be copied from that cue, and the target must occur inside the excerpt. The original audio is played by iHub when the learner performs the activity.

## Four required task modes

1. **no-subtitles**: listen to the original cue without subtitles and answer one focused gist or detail question.
2. **gap-fill**: listen and complete exactly one meaningful gap. The completed sentence must reproduce the source excerpt.
3. **connected-speech**: focus on a consecutive phrase that illustrates a plausible connection, contraction, or common reduction. Do not invent phonetic spellings or present unverified acoustic claims as facts.
4. **rhythm**: divide the original excerpt into consecutive thought groups. Preserve every word in its original order. Use word timestamps to support grouping; do not invent stress or intonation claims.

## AI round trip and review

- Input: `nova-generator-deep-listening-input/1.0`
- Output: `nova-generator-deep-listening-output/1.0`
- Target: 8 tasks, normally 2 per mode; importer accepts 4–12.
- All four modes are required.
- Ranking uses exactly seven score keys, totaling 100: auditory_depth 20, source_fidelity 20, listening_skill 15, clarity 15, pedagogical_value 10, level_fit 10, variety 10.
- Candidates must score at least 70, use one of the exact difficulty values, and be sorted from highest to lowest score.
- Import validates source hash, unique IDs, cue references, exact source excerpt, target phrase, mode-specific answer structure, and score arithmetic.
- Imported tasks start approved. The editor can reject individual tasks. Only approved tasks are included in the final journey package.

## iHub handoff

The Day 4 tasks are stored in the Learning Journey package under `days[3].tasks`. The complete journey export requires approved tasks in all four modes. Saving the preparation does not publish it.
