# Find It First — challenge library

Planning catalog for a configurable 2–6-player expo race. The event starts at 45 seconds by default (configurable from 5–180 seconds); seeded creative prompts use 60 seconds, and any prompt may override the event timer. The exact prompt stays hidden until the shared GO signal, after the roster locks. The runnable app defaults prompts to AI-assisted image review and also offers a repeated-frame color detector, operator judging, and audience ballots. This is a candidate bank for booth testing, not a promise that every prompt works under every camera and lighting condition.

## Ground rules

- Players stay in their marked spot. Objects must be within arm's reach; nobody runs, opens a drink, takes an item from another attendee, or shows a badge, business card, document, or private screen.
- Give each player the same small, cleaned prop kit for any prompt that needs a specific item. A prompt is ineligible when its props or judging model are unavailable for **any** locked player. The wall can still invite the audience to suggest or cheer for matches.
- Show every prompt as large text plus an icon and announce it aloud. Offer a non-gesture alternative or omit gesture and finger-count rounds when a participant cannot comfortably make the movement. Do not treat a skipped accessibility prompt as a loss.
- “Launch candidate” means suitable for an initial automatic-judging dry run. It becomes a live prompt only after testing on actual show phones, booth lighting, and camera positions. “Pilot” requires more controlled props or validation. “Audience vote” is deliberately subjective and never awards a first-match win.

### Candidate judging primitives

The table below describes possible calibrated detectors for future prompt-specific pilots. The current app implements `C(color)` for simple “SHOW/FIND SOMETHING [COLOR]” clues, using new evidence after GO and three of four sampled frames spanning at least 0.5 seconds. Other categories use optional AI image review or an operator; the app does not claim to run the specialized detectors below. The official verification time is the server receipt time of qualifying evidence, before inference processing. A model score is a screening signal, not a guarantee of correctness.

| Code | Acceptance rule |
| --- | --- |
| `C(color)` | A newly entered, contiguous foreground region has a target-color HSV blob covering at least 10% of the center guide and at least 55% of that region's visible area. Reject low saturation, blown-out, or very dark frames; tune hue bands under booth lighting. |
| `O(label)` | A trained object detector returns the specified class above its calibrated class threshold. Its box center is in the guide, its box covers at least 8% of the guide, and it was absent from the neutral baseline. |
| `G(gesture)` | The hand-gesture model returns the specified canned label for a hand in the guide. The neutral baseline cannot already contain that gesture. |
| `S(shape)` | A supplied, high-contrast shape card enters the guide. Detect its card border and classify only the shape printed *inside* it: triangle = three corners; square = four near-equal sides; rectangle = four corners with long/short side ratio at least 1.5; circle = circularity at least 0.8; star and heart use a tested template classifier. |
| `T(token)` | OCR reads the exact uppercase token, ignoring case and surrounding whitespace, inside a supplied bordered card. Text elsewhere in the frame, including the booth screen, is ignored. |
| `N(item, k)` | At least `k` distinct visible items satisfy the item primitive simultaneously in the center guide. Distinct object/card boxes must not substantially overlap; repeated detections of one item are merged. |
| `F(k)` | Hand landmarks show exactly `k` extended fingers on one hand in the guide, using a calibrated palm-orientation rule. |
| `A + B` | Both primitives pass in the same verification window. For `C(color inside O(label))`, compute color only inside the detected object's box, excluding the hand and background. For `left of`/`above`, use separated item centers. |

The numerical area and stability values are **starting rules for a pilot**, not universal accuracy claims. A flat color swatch can pass `C(color)`; a tiny logo should fail the area rule. A color mask cannot prove that the pixels came from a physical object rather than a screen or wall, nor can an object detector prove a prop's material, ownership, or contents. Staff enforce those house rules. Props should be held steady and close enough to fill the guide. Automatic feedback can say “Move closer” or “Hold steady” before it says “Verified.”

## Prompt bank — 50 prompts

### Color (6)

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| C01 | SHOW SOMETHING RED | Launch candidate | `C(red)` | Easy to find; show a labeled red swatch and spoken cue for color-vision access. |
| C02 | SHOW SOMETHING BLUE | Launch candidate | `C(blue)` | Easy to find; supply a blue card at every spot and a non-color cue. |
| C03 | SHOW SOMETHING YELLOW | Launch candidate | `C(yellow)` | Supply a saturated yellow card; pale yellow can wash out under stage lights. |
| C04 | SHOW SOMETHING GREEN | Launch candidate | `C(green)` | Supply a green card; allow the card so players need not search the venue. |
| C05 | SHOW SOMETHING ORANGE | Launch candidate | `C(orange)` | Supply a vivid orange card; test separation from red/yellow under warm lights. |
| C06 | SHOW SOMETHING PURPLE | Launch candidate | `C(purple)` | Supply a vivid purple card; test phones with different white balance. |

### Common objects (7)

These labels exist in the cited COCO object-detector vocabulary; a label's existence does not establish that a specific prop will be recognized reliably. Each player needs the same lightweight prop or an equivalent item immediately available.

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| O01 | SHOW A CUP | Launch candidate | `O(cup)` | Supply an empty, unbreakable cup; no liquid or hot drinks. |
| O02 | SHOW A BOTTLE | Launch candidate | `O(bottle)` | Supply a light, closed bottle; do not require anyone to lift a full bottle. |
| O03 | SHOW A BOOK | Launch candidate | `O(book)` | Supply a small paperback; have players show its cover, not private notes. |
| O04 | SHOW A BACKPACK | Pilot | `O(backpack)` | Large to frame; set a lightweight sample bag at every spot or omit. |
| O05 | SHOW A BALL | Pilot | `O(sports ball)` | Use a soft foam ball in each kit; test this specific prop because the model class is “sports ball.” Holding only, never throwing. |
| O06 | SHOW A TEDDY BEAR | Pilot | `O(teddy bear)` | Supply identical small plush toys; small toys may need a close camera view. |
| O07 | SHOW A FRISBEE | Pilot | `O(frisbee)` | Supply a soft disc; keep it in hand and face the disc toward the camera. |

### Hand gestures (5)

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| G01 | GIVE A THUMBS UP | Launch candidate | `G(Thumb_Up)` | One hand; provide an equivalent printed gesture card or skip for motor access. |
| G02 | MAKE A PEACE SIGN | Launch candidate | `G(Victory)` | One hand; printed equivalent or skip if finger separation is uncomfortable. |
| G03 | SHOW AN OPEN PALM | Launch candidate | `G(Open_Palm)` | One hand; printed equivalent or skip for limited hand mobility. |
| G04 | POINT UP | Launch candidate | `G(Pointing_Up)` | One hand; spoken cue helps, and a printed equivalent should be available. |
| G05 | MAKE A FIST | Launch candidate | `G(Closed_Fist)` | One hand; printed equivalent or skip if gripping is uncomfortable. |

The printed equivalent needs its **own** tested card detector and must be scored under the same timing rule. If that alternate is not built, omit these rounds for an inclusive mixed roster.

### Flat shapes (6)

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| S01 | FIND THE CIRCLE | Pilot | `S(circle)` | Identical high-contrast card decks at each spot; speak the shape name. |
| S02 | FIND THE TRIANGLE | Pilot | `S(triangle)` | Use a large solid shape; small outlines are hard to see and detect. |
| S03 | FIND THE SQUARE | Pilot | `S(square)` | Keep square and rectangle cards visibly different in size and ratio. |
| S04 | FIND THE RECTANGLE | Pilot | `S(rectangle)` | Use a distinctly long rectangle; avoid borderline near-squares. |
| S05 | FIND THE STAR | Pilot | `S(star)` | Use a supplied card and tested template; free-form star objects vary too much. |
| S06 | FIND THE HEART | Pilot | `S(heart)` | Use a supplied card; a hand-heart can compete only in the vote rounds. |

### Printed text and numbers (5)

All targets are printed on large, non-personal cards in the same prop kit. OCR must be confined to the card crop so a camera pointed at the prompt on the wall cannot qualify. These are optional when reading language or vision makes a text race unfair for the roster.

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| T01 | FIND THE WORD TWILIO | Pilot | `T(TWILIO)` | Large uppercase card; announce the word and show a matching icon. |
| T02 | FIND THE WORD API | Pilot | `T(API)` | Short token needs strict card-border detection to avoid signage false positives. |
| T03 | FIND THE WORD CODE | Pilot | `T(CODE)` | Large uppercase card; test OCR in booth glare. |
| T04 | FIND THE WORD WEBHOOK | Pilot | `T(WEBHOOK)` | Long token needs a wide card and close framing. |
| T05 | FIND THE NUMBER 404 | Pilot | `T(404)` | Familiar tech numeral; test that OCR reads all three digits in the chosen font. |

### Counts (6)

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| N01 | SHOW TWO RED CARDS | Pilot | `N(red bordered card, 2)` using two separate `C(red)` card crops | Put at least two red cards in each kit; overlapping cards do not count. |
| N02 | SHOW THREE BLUE CARDS | Pilot | `N(blue bordered card, 3)` | Put three blue cards in each kit; small hands may need a tabletop setup. |
| N03 | SHOW TWO CIRCLE CARDS | Pilot | `N(S(circle), 2)` | Supply two circles per kit; allow cards to rest on a table. |
| N04 | SHOW TWO CUPS | Pilot | `N(O(cup), 2)` | Supply two empty unbreakable cups at each spot; never ask players to carry drinks. |
| N05 | HOLD UP THREE FINGERS | Pilot | `F(3)` | A hand-mobility task; use a printed numeral-card equivalent or omit. |
| N06 | HOLD UP FOUR FINGERS | Pilot | `F(4)` | A hand-mobility task; use a printed numeral-card equivalent or omit. |

### Combinations and position (8)

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| M01 | SHOW A RED CUP | Pilot | `O(cup) + C(red inside cup box)` | Give every player the same red empty cup; a red backdrop cannot qualify. |
| M02 | SHOW A BLUE BOTTLE | Pilot | `O(bottle) + C(blue inside bottle box)` | Supply a blue, light, closed bottle at every spot. |
| M03 | SHOW A YELLOW BALL | Pilot | `O(sports ball) + C(yellow inside ball box)` | Use identical yellow foam balls; no throwing. |
| M04 | SHOW A GREEN BOOK | Pilot | `O(book) + C(green inside book box)` | Supply a green-covered book; judge the cover, not the page text. |
| M05 | SHOW A CUP AND A BOOK | Pilot | `O(cup) + O(book)` in two distinct boxes | Both props must fit together in the guide; tabletop display is allowed. |
| M06 | SHOW A BOTTLE AND A TEDDY BEAR | Pilot | `O(bottle) + O(teddy bear)` in two distinct boxes | Both props provided; test the small plush in a two-object frame. |
| M07 | PUT RED LEFT OF BLUE | Pilot | Two supplied color cards pass `C(red)` and `C(blue)`; red card center is left of blue card center with a visible gap | Mirror the camera preview consistently; allow cards on a tabletop. |
| M08 | PUT CIRCLE ABOVE TRIANGLE | Pilot | `S(circle) + S(triangle)`; circle center is above triangle center with a visible gap | Two high-contrast cards per kit; explain “above” in the camera preview. |

### Creative audience-vote rounds (7)

These rounds use the event's configured duration or a prompt-specific override, then a short vote from spectators' phones. Show only the active players' final frames together. Accept one vote per spectator session and exclude linked player sessions from voting for their own frame. Exclusion across unlinked SMS, WhatsApp, and web identities is only best effort, so this mode is unsuitable for valuable prizes. A host can remove unsafe or privacy-revealing submissions. AI may suggest finalists, but the visible result is the audience's choice.

| ID | Screen prompt | Tier | Judging rule | Availability and access caution |
| --- | --- | --- | --- | --- |
| V01 | MAKE A TINY TROPHY FROM THE PROP KIT | Audience vote | Most audience votes after the creation window | Supply light props; seated/tabletop builds count equally. |
| V02 | SHOW YOUR BEST VICTORY POSE | Audience vote | Most audience votes | Accept a hand, face, object, or seated pose; no full-body movement required. |
| V03 | MAKE A HEART WITH HANDS OR PROPS | Audience vote | Most audience votes | Prop-based heart is an equal option for limited hand mobility. |
| V04 | MAKE THE MOST COLORFUL PROP COMBO | Audience vote | Most audience votes | Same card palette for all; do not make color recognition the only way to play. |
| V05 | MAKE A LETTER T USING PROPS | Audience vote | Most audience votes | Tabletop arrangement is allowed; no need to hold a body pose. |
| V06 | BUILD A FUNNY STILL LIFE WITH THREE PROPS | Audience vote | Most audience votes | Same prop kit for all; humor is never judged from a person's appearance. |
| V07 | SHOW THE MOST SURPRISING SAFE PROP COMBO | Audience vote | Most audience votes | Props only; no personal documents, sharp items, food, or borrowed belongings. |

## Hidden prompt, roster lock, and the first verified match

1. **Attract and queue.** The wall runs teaser animations and a QR code. The next challenge is held server-side, absent from phone bundles and pre-round messages. Players see their own camera preview and a ready control, not the prompt.
2. **Ready check.** A ready player has accepted live display, granted camera access, a visible preview, a stable connection, and the relevant models loaded. Give players a brief neutral-frame check with the guide empty. Configure a minimum and maximum from 2–6, plus one start rule: full roster, join deadline, operator start, or whichever comes first. An operator can start any mode once the minimum is ready. If a deadline expires below the minimum, wait for enough players instead of starting an empty race. Others remain in the next-round queue.
3. **Lock, countdown, reveal.** Freeze the roster and snapshot the selected challenge and effective duration. Select only a challenge whose props and alternate access path are available to all locked players. Keep the exact challenge sealed during a shared three-second countdown. At the scheduled server time `T0`, reveal it on the wall and all locked player phones together and start the configured clock. Late arrivals enter the next-round queue. Prompt or timer edits saved during a heat apply to the next heat.
4. **Evidence, then verification.** The phone can run a local detector to provide immediate “closer/hold steady” feedback. A controlled booth referee subscribes to the active Twilio Video feeds and sends downscaled, evenly sampled post-`T0` frames to the game backend. The backend stamps each frame on receipt, evaluates the published predicate and stability rule, and announces a verified result. A player's phone cannot award itself a win. Discard evidence frames after adjudication unless the participant separately opts into a saved souvenir.
5. **Fair result.** Rank by `verifiedAt`, not by a single model guess, inference completion order, or an unauthenticated client clock. This defines “first verified at the server,” which is measurable but can differ from who physically found an item first because network and device delays vary. Treat candidates inside a calibrated uncertainty window as co-winners, or let staff review a close prize result. Show the recognized item and rule on the wall so the decision is understandable. Staff can correct a clear false positive or missed valid match.
6. **No-match path.** At the configured deadline, either celebrate all verified matches or show a playful “no match” outcome and advance. The operator can override an AI proposal, award any one player, award multiple co-winners, or declare no winner, with a reason recorded. Log per-prompt false positives, false negatives, manual overrides, verification delay, and no-match rate; pause prompts that repeatedly fail. Do not retry a failed judgment by silently changing the rule mid-round.

### Live prompt controls

The operator can add, edit, enable, disable, and queue prompts without changing code. Each prompt stores its text, category, detector or judging lane, required props, accessibility alternative, and optional duration override. Validate these fields and preview the public text before saving. A revisioned save confirms success or reports a conflict; the active heat keeps its locked snapshot. The next heat reads the updated pack. For a live event, roles and an audit trail protect these changes; the browser mockup uses local storage only.

Before launch, test each candidate with positive and negative examples across the booth's actual lighting, signage, participant distances, phone models, skin tones, and backgrounds. For a materially valuable prize, use controlled stations and human review of close calls. A generic vision model cannot reliably decide “most creative” or authenticate that a screen image is a physical object, so these cases stay in the vote or staff-review lane.

## Primary CV references

- [Google MediaPipe Object Detector for web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js) and [model details](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector): video-frame detection yields labels, scores, and boxes; the recommended model is trained on COCO's 80 labels.
- [TensorFlow.js COCO-SSD class list](https://github.com/tensorflow/tfjs-models/blob/master/coco-ssd/src/classes.ts): check available object labels before writing a prompt. A detector trained only on these labels does not automatically know a pen, hat, or custom branded prop.
- [Google MediaPipe Gesture Recognizer](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer): supported built-in gestures and hand landmarks.
- [OpenCV HSV color thresholding](https://docs.opencv.org/5.0/tutorials/imgproc/threshold_inRange/threshold_inRange.html) and [contour approximation](https://docs.opencv.org/4.11.0/dd/d49/tutorial_py_contour_features.html): starting points for color and flat-shape predicates.
- [Tesseract.js](https://github.com/naptha/tesseract.js/) and [Google Cloud Vision OCR](https://docs.cloud.google.com/vision/docs/ocr): browser and server OCR options for deliberately printed text cards.
- [MediaPipe custom object detector guidance](https://developers.google.com/edge/mediapipe/solutions/customization/object_detector): train and validate on a bespoke prop set if the default 80-class model is insufficient.
