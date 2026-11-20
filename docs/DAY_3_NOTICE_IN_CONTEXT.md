# Day 3 · Notice in Context

## Purpose

Day 3 teaches learners to notice how English communicates meaning in a specific situation. It moves beyond recognizing a phrase: the learner identifies contextual meaning, communicative intention, reusable patterns, and how the same construction works in other situations.

## Source material

Nova Generator exports a source-bound instruction TXT for external AI. The source includes:
- reviewed transcript cues with one-based cue order and exact timestamps;
- approved Anki material cards, with their expression, contextual meaning, explanation, and examples;
- the single selected Smart Learning Moment, when one exists, including its approved lesson and source excerpt.

The selected Smart Learning Moment is the preferred anchor. The AI must preserve its insight and may create complementary lessons only when they teach distinct points. It must not duplicate the same expression or invent source speech.

## Learning sequence per micro-lesson

1. Show the exact excerpt from the original scene and highlight the target expression.
2. Explain what the speaker means in that situation.
3. Identify the communicative intention (suggesting, requesting, softening, reacting, disagreeing, and so on).
4. Explain the reusable pattern in beginner-friendly Portuguese.
5. Present at least two natural examples in different situations, with Brazilian Portuguese translations.
6. Open at least two context branches showing when else the learner can use the expression.
7. Finish with a short contextual choice and explanatory feedback.

The learner can replay the original cue. The lesson does not claim to teach acoustic recognition or pronunciation; those belong to other days.

## AI round trip and curation

- Contract: `nova-generator-notice-in-context-input/1.0` → `nova-generator-notice-in-context-output/1.0`.
- Aim for 4–8 strong lessons, but never pad the result. The import accepts 1–12 candidates.
- Ranking weights (100 points): contextual meaning 20, communicative value 20, transferability 15, source fidelity 15, instructional clarity 10, level fit 10, practice quality 10.
- Candidates below 70 are rejected. The score breakdown must use the exact seven keys and sum to the final score.
- The importer checks the source hash, unique IDs, cue references, exact source excerpt, target expression, required lesson sections, difficulty vocabulary, and score arithmetic.
- Imported candidates start as drafts. The editor can change the lesson copy, include or exclude it from iHub, approve it, or reject it.
- Only approved and included lessons are emitted in the final journey package.

## Persistence and publication

The complete Day 3 draft is saved inside the per-asset Learning Journey in Materials. Saving Day 3 does not publish it. The complete seven-day package remains subject to the journey's full readiness checks before export.
