# Live Scavenger Hunt: vision judging recommendation

## Decision

Use **prompt-specific computer vision for the fast race**, **OpenAI vision for selected ambiguous frames**, and an **operator who can always finalize or change the result**. The game's public wording should be **“first verified match”**: no camera system can prove the exact moment a visitor first held an item in physical space. The first result should be provisional until the selected judging policy completes.

Twilio Video carries the 2–6 live camera tracks to the wall and a controlled referee subscriber. The referee application, not Twilio's selective forwarding unit, runs the detection. [Twilio Video technical overview](https://www.twilio.com/docs/video/overview) · [Twilio Video app components](https://www.twilio.com/docs/video/video-app-components)

| Prompt type | Best first-pass judge | Example | Publication policy |
| --- | --- | --- | --- |
| Color, simple shape | OpenCV color range / contour rule | SHOW SOMETHING RED; FIND THE TRIANGLE | Automatic after stable evidence; override remains available. |
| Known object or hand gesture | MediaPipe object detector / gesture recognizer, with an approved model and threshold | SHOW A CUP; MAKE A PEACE SIGN | Automatic only after venue testing; otherwise operator confirmation. |
| Printed tech word | OCR, exact word match inside the supplied card region | FIND THE WORD **TWILIO**, **API**, **CODE**, **WEBHOOK**, or **404** | Automatic only with a controlled card crop; avoid the wall clue itself qualifying. |
| Object + attribute or open-ended prompt | Fast detector proposes a crop; OpenAI vision checks the crop | SHOW A RED CUP; FIND SOMETHING A DEVELOPER WOULD USE | AI proposes; operator confirms for a prize or close race. |
| Creative composition | Operator or audience vote | MAKE A TINY TROPHY | Human or audience judging, not a speed race. |

OpenCV documents HSV `inRange` for color thresholding. MediaPipe's web Object Detector returns classes, scores, and boxes from video frames, while Gesture Recognizer reports hand landmarks and gesture categories; both web guides warn that synchronous inference can block the UI thread, so run it in a worker or a dedicated referee process. Cloud Vision OCR can return recognized words and bounding boxes. These are building blocks, not out-of-the-box guarantees for every object or booth condition. [OpenCV color thresholding](https://docs.opencv.org/4.13.0/da/d97/tutorial_threshold_inRange.html) · [MediaPipe Object Detector for web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js) · [MediaPipe Gesture Recognizer for web](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js) · [Google Cloud Vision OCR](https://docs.cloud.google.com/vision/docs/ocr)

## What the referee should actually do

1. **Freeze the rules at GO.** Save the event, heat, prompt text/version, accepted target, detector version, threshold, duration, judging policy, and server `T0`. New admin edits apply to the next heat.
2. **Sample every feed on the same schedule.** A booth referee subscriber receives all Twilio Video tracks and takes small, evenly spaced post-`T0` frames. Stamp frames at this common observer, before any model request. Do not rank competitors by when a model call returns: concurrent API requests and networks finish in different orders.
3. **Require stable evidence.** Only a configured region and repeated positive frames qualify. For a combination prompt, the attribute must be inside the detected object box. For a word card, use an exact normalized match inside the card guide. A single low-confidence frame is an “almost,” not a win.
4. **Resolve close calls.** Compare the first *qualifying evidence* timestamps. If candidates are closer than a tolerance established by the sampling cadence and venue pilot, offer a tie or operator review. For material prizes, preserve a short, consented evidence clip for dispute review only if the event's policy permits it.
5. **Record the final decision.** Store provisional candidate(s), final winner IDs as an array (including multiple winners or no winner), judge source, operator ID, reason for change, and timestamps. Publish a correction animation when an override changes an already displayed result. Keep this audit separate from lead data.

This ranking design is an engineering recommendation. Video packet delay, decode delay, lighting, and sampling can all affect the observed order, so pilot it with six real phones on the venue network before offering a “fastest wins” prize.

## Where OpenAI fits

The OpenAI Responses API accepts image inputs and can answer questions about objects, shapes, colors, and visible text. It can inspect multiple images, but each image uses input tokens; its own documentation also warns about mistakes, small/rotated text, precise spatial tasks, and approximate counts. Use it on a **small set of cropped candidate frames or a short evidence sequence**, rather than every frame from every player. Have it return a constrained record such as `{verdict: "match"|"no_match"|"uncertain", visible_evidence: "..."}`. Structured Outputs enforce the response shape; they do **not** establish that a visual claim is correct, and refusals/incomplete responses still need handling. [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision) · [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

OpenAI can be the configured AI judge for an AI-assisted heat, but its result should normally create a **provisional candidate** while the wall enters a short review beat. The operator can approve one player, select multiple players as a tie, choose a different winner, or award no winner. For lower-stakes rounds, an event may allow automatic publication after a tested detector + AI agreement; the operator can still correct it. Avoid using an LLM's self-reported numeric confidence as the sole decision threshold. Measure real false positives and p95 adjudication time with the actual prompt set before enabling that policy.

No API key is needed for the visual prototype. In a live build, call OpenAI from the application server; **never place the key in the player page, wall, or operator browser**. OpenAI explicitly recommends routing client requests through a backend. Review its current data controls for each event and set `store: false` when response state is unnecessary; that setting does not, by itself, mean all platform logs are instantly deleted. [OpenAI API key safety](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) · [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

## Operator configuration and guardrails

- Each prompt stores category, exact displayed text, allowed detector, per-prompt timer override, enabled state, and judging mode: **automatic**, **AI-assisted**, **audience**, or **operator**. A new free-text prompt defaults to operator review until a tested detector profile is attached.
- Event settings choose player minimum/maximum, start rule, join deadline, default round duration, winner policy, and optional tie tolerance. Save changes with a revision and an audit entry; active heat snapshots remain unchanged.
- If a model times out, a camera drops, or the evidence is unclear, pause for the operator rather than manufacturing a winner. The operator always has explicit **approve**, **override**, **tie**, and **no winner** controls.
- Keep cloud recording off by default, discard transient frames after judging, and ask separately for any saved souvenir. Tell participants their camera appears on the public wall and when third-party AI analysis is enabled. Twilio recording is a separate opt-in room capability. [Twilio Video recording rules](https://www.twilio.com/docs/video/api/recording-rules)

**Recommended first pilot:** eight to twelve pretested prompts spanning color, a few supplied objects, printed tech words, and a gesture; 2–6 players; operator-confirmed AI as an optional lane. Track match rate, false-positive corrections, ties, overrides, and detection latency per prompt, then promote only reliable prompts to automatic judging.
