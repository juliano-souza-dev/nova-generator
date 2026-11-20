# Day 2 · Listening Recall

## Ownership

- Nova Generator is the content supplier. It exports a source-bound instruction package for external AI, validates the returned JSON, and keeps all generated activities in draft until the editor approves them.
- iHubEnglish is the learner-facing consumer. It plays the original audio cue, renders the activity, evaluates the answer, and records learner progress.
- Day 1 remains the existing Explore & Understand experience. This workflow does not regenerate or alter Day 1.

## Four activity types

1. **identify**: listen to the original cue and identify the word, expression, or short utterance that was spoken.
2. **word-recognition**: recognize a target word or compact expression from plausible alternatives.
3. **gap**: listen and complete one meaningful gap in the original wording.
4. **reconstruct**: use a shuffled word bank to rebuild a short excerpt in its original order.

Every activity references one or more one-based cue orders. iHub resolves those references to the original media timeline and plays the source audio. The external AI receives transcript text and timing metadata, not the audio recording; its instructions explicitly prohibit claims about acoustic analysis or invented pronunciation details.

## External AI round trip

1. Nova builds nova-generator-listening-recall-input/1.0 from the selected asset, current source signature, transcript cues, timestamps, and word alignment when available.
2. Nova exports a TXT instruction file containing the pedagogical brief, output schema, quality rubric, source hash, and source cues.
3. The external AI returns only JSON using nova-generator-listening-recall-output/1.0.
4. Nova checks the source hash, activity IDs, cue references, type-specific structure, exact source wording, answer consistency, score threshold, and presence of all four activity types.
5. Imported activities are drafts. The editor may include, reject, reopen, or approve each item. Only approved and included items are sent in the journey export.

## Quality rubric

- Auditory-learning value: 20
- Fidelity to source wording and cue: 20
- Clarity of task and answer: 15
- Pedagogical usefulness: 15
- Level appropriateness: 10
- Distractor/response quality: 10
- Variety and non-redundancy: 10

Candidates below 70 are rejected during import. The AI should aim for 8–12 activities, normally 2–3 per type, but must prefer quality over padding the set.

## iHub learner behavior

- Choice activities display the original audio control and options.
- Gap activities display the original sentence with a missing word or expression and accept the validated answer.
- Reconstruction activities render a clickable word bank. Learners assemble the spoken sequence and can remove selected words before checking.
- Correct and incorrect feedback is authored per activity in Brazilian Portuguese.
- Only approved activities are shown when the package contains review metadata. Legacy packages without review metadata remain compatible.

## Publication

The iHub admin publishing service validates the seven-day package, checks that Day 2 includes all four activity types, validates activity structures and cue references, and stores the journey. The learner's progress remains owned by iHub and is stored per user, Kit, day, and activity.

The complete seven-day journey is exported/published only after the remaining days are ready. Day 2 can be authored, reviewed, and persisted in Nova independently while Days 3–7 continue through their own production steps.
