# Brief: update the "Paint-by-Number Studio" deck

Attach these with the brief:
- `Paint-by-Number Studio.pptx.pptx` (the current deck: 13 slides, 16:9)
- every image in `slides-assets/`

## Prompt (paste this into Claude Design)

> Update the attached deck "Paint-by-Number Studio" for a live showcase at the University of Tunis Cultural Days at HIDE on Friday, November 13. The audience comes from many fields, so keep it creative, visual and fun, not technical.
>
> Keep the existing visual identity exactly: the warm paper background, the ink-black text, the coral accent, the handwritten headings, the "Page X of N" footers and the numbered section titles.
>
> Apply the slide-by-slide changes in the brief below. Fill every "[ image placeholder ]" with the matching screenshot from `slides-assets/`. Add the 3 new slides: the gallery, the painting experience, and the 360° sculpture.
>
> Keep text short: at most about 25 words of body copy per slide. Let the screenshots carry each slide. Don't use emojis, and don't invent features that aren't listed.

## Design system (taken from the current deck)

| Token | Value | Use |
|---|---|---|
| Paper | `#FBF6E9`, `#FFFAEF` | slide backgrounds and cards |
| Ink | `#1C1A16` | main text |
| Ink soft | `#5B554B`, muted `#9B9286` | secondary text, labels |
| Coral accent | `#FF7A59`, deep `#D8492A` | highlights, section numbers, "chosen" marks |
| Leaf | `#6AA667`, soft `#DFEEDE` | positive tags |
| Sun | `#F3C55C` | the "Did you know?" badge |
| Sky | `#6FB1D1` | secondary accent |
| Fonts | Gloria Hallelujah (handwritten titles), Open Sans (body), Arial | match the existing slides |

Slide size is 16:9 (20 x 11.25 in). The deck already uses small uppercase kicker labels like "SURFACE · 01" and "OPTION · B · CHOSEN". Reuse that pattern for the new slides.

The 3D screenshots have a dark warm-brown background. On those slides, put the screenshot inside a rounded card on the paper background, like a framed photo, instead of making the whole slide dark.

## What changed in the product

1. **Gallery.** The upload screen has an "Or pick a picture" gallery of ready photos, 5 of them from Tunisia: Sidi Bou Said, El Jem, Carthage, the Medina of Tunis and Djerba. Every photo a visitor uploads joins the gallery, with a "New" badge.
2. **Almost no waiting.**
   - A gallery picture becomes a paintable page in about 0.15 s. An uploaded photo takes under 1 s. It used to take 3 to 7 s, and up to 5 minutes on busy photos.
   - Photos are shrunk in the browser before upload, and gallery pages are prepared in advance.
   - The fun facts arrive a moment after the page, so nobody waits for the AI.
   - During the short wait, the visitor's own photo shimmers on screen as if it were being drawn.
3. **Painting in the app.** Children paint directly in the browser with Brush, Fill (one tap fills a whole numbered region), Eraser and Clear, picking colors from the color guide.
   - The numbers sit on their own layer above the paint, so they stay readable and never get painted over. A "Numbers" button hides or shows them.
   - The downloaded painting has no numbers; the printed page keeps them for coloring on paper.
4. **The 360° sculpture.** One button turns the painting into a 3D object.
   - Every color becomes a solid layer of cut card stacked at its own depth, so the 2D picture becomes a layered paper sculpture on a wooden turntable.
   - Visitors can drag it all the way round, zoom, or let it spin. It has real thickness from the side and a kraft-paper back stamped "Paint-by-Number Studio · Cultural Days · HIDE 2026".
   - It always appears fully painted: the child's own colors are kept, and anything they left blank is filled with the right colors. No numbers appear on it.
5. **"Comes alive."** On the sculpture, colors move by what they are. Blues ripple like water, greens sway like leaves, reds and yellows glow like sunlight, pale colors breathe like clouds, and dark colors stay still. Gold dust floats around it, and the layers rise out of the flat page when it opens.

## Slide-by-slide changes

The deck goes from 13 to 16 slides. Update every "Page X of 13" footer to "of 16".

**Slide 1 (title):** no change.

**Slide 2 (scan me):** no change. The QR code and the URL stay.

**Slide 3 (contents):**
- Add a new item "5. New: gallery, painting and the 360° sculpture" and renumber the items after it.
- Fix the typo "Important distigution!" to "Important distinction!" here and on the slide that has it.

**Slide 4 (key idea):** no change.

**Slide 5 (added value: reduction is violence / invitation):** no change. The sculpture slide answers this slide's thesis, so keep the wording identical.

**Slide 6 (main functionality):**
- Fill "[ image placeholder · 1 of 5 ]" with `slides-assets/01-landing.png`. It shows the upload box and the gallery.
- Add 3 output tiles after "06 / Stylesheet":
  - "07 / New · Gallery: pick a ready picture"
  - "08 / New · Paint it in the app"
  - "09 / New · 360° paper sculpture"

**Slide 7 (what users see):** fill the placeholders.
- Placeholder 2 of 5, coloring page: `slides-assets/02b-coloring-page-half-painted.png`. The left half is painted and the right half is still numbered, so it shows the before and after in one image.
- Placeholder 3 of 5, color guide: `slides-assets/03-color-guide.png`.
- Placeholder 4 of 5, coloring guide: `slides-assets/04-coloring-guide.png`.
- Placeholder 5 of 5, "Did you know?": `slides-assets/05-did-you-know.png`.
- Change the Surface 01 text to: "The page itself. Paint it in the app, download your painting, or print the numbered page on A4."

**New slide A, after slide 7: "No photo? Pick one."**
- Kicker: "NEW · THE GALLERY"
- Image: `slides-assets/06-gallery.png`, large.
- Body: "Ready pictures from Tunisia and around the world. Every visitor's upload joins the wall, so the gallery grows all afternoon."
- Small tag: "Sidi Bou Said · El Jem · Carthage · Medina of Tunis · Djerba".

**New slide B: "Tap, fill, done."**
- Kicker: "NEW · PAINT IN THE APP"
- Images: `slides-assets/02b-coloring-page-half-painted.png` large on the left. On the right, stack `slides-assets/12-loading-shimmer.png` small, captioned "your photo shimmers while it's drawn".
- 3 short points:
  - "Ready in under a second."
  - "Fill paints a whole region in one tap."
  - "Numbers float above the paint, so they're never lost."
- Optional big-number callout: "0.15 s" with the caption "from picture to paintable page".

**New slide C: "From flat page to sculpture."**

This is the wow slide, so make it the most visual one in the deck.
- Kicker: "NEW · 360° SCULPTURE"
- Images:
  - `slides-assets/09-3d-three-quarter.png` as the hero.
  - A row of 3 smaller frames: `08-3d-front.png`, `10-3d-side.png` and `11-3d-back.png`, captioned "front", "side" and "back". Together they show it really turns all the way round.
- Body: "Every color you paint becomes a layer of cut card. Turn it all the way round: it has depth, edges and a back."
- A small legend of 5 color dots, each with a two-word caption:
  - blue: ripples like water
  - green: sways like leaves
  - yellow and red: glows like sunlight
  - pale: breathes like clouds
  - dark: stays still
- Closing line, which links back to slide 5's thesis: "The machine removes. The child adds back. Now what they added stands up."

**Slide 8 (pipeline, end to end):**
- Change the first lane's label "Gemini · image, writes coloring guide" to "Gemini Flash-Lite · reads the photo, writes the coloring guide". It is a text model that looks at the photo; it does not generate images.
- Add one line under the intro: "The page no longer waits for the AI: it appears first, and the guide and facts follow."
- In STEP 3 · RENDER, add: "+ paint in the browser + 360° sculpture".

**Slide 9 (technicality, 8 steps):** keep the 8 steps. Add one callout chip: "5 minutes → under 1 second: smarter clean-up, cached gallery pages, smaller uploads."

**Slide 10 (we do not use AI image generation):**
- Fix the grammar: change "Gemini's image model is limit: 0 on the free tier" to "Gemini's image model has a free-tier limit of 0".
- Otherwise no change. This slide is still true and still important; the sculpture is built from the real posterized photo too.

**Slide 11 (tech stack):** add a fourth group:
- Group title: "3D · THE SCULPTURE"
- Chips: "Three.js", "WebGL", "GLSL shaders", "OrbitControls"
- Use the same chip style as the other groups.

**Slide 12 (where it goes next):** update the list. "Cloud demo" is already done (slide 2 has the live URL), and in-app painting now exists.
- 01 Multilingual guide: keep it as it is.
- 02 QR audio narration: keep it as it is.
- 03 Museum mode: keep it as it is.
- 04 Collective mural (new): "A big picture split into tiles. Each visitor colors one, and the full mural is revealed at the end of the day."
- 05 Paper to screen (new): "Color a printed page with real crayons, show it to the camera, and watch it become a 3D sculpture."

**Slide 13 (thank you):** no change.

## Assets (`slides-assets/`)

All images are 2x retina PNGs, captured from the running app with the Sidi Bou Said door photo.

| File | Shows | Used on |
|---|---|---|
| `01-landing.png` | upload screen with the gallery below | slide 6 |
| `02a-coloring-page-blank.png` | unpainted numbered page | spare |
| `02b-coloring-page-half-painted.png` | half painted, half numbered, numbers above the paint | slide 7, new slide B |
| `02c-coloring-page-numbers-hidden.png` | the same page with the Numbers toggle off | spare |
| `03-color-guide.png` | numbered color guide | slide 7 |
| `04-coloring-guide.png` | coloring guide text card | slide 7 |
| `05-did-you-know.png` | "Did you know?" fun-facts card | slide 7 |
| `06-gallery.png` | gallery grid | new slide A |
| `07-full-result-view.png` | the whole result screen | spare |
| `08-3d-front.png` | sculpture from the front, on the turntable | new slide C |
| `09-3d-three-quarter.png` | sculpture at a three-quarter angle (hero) | new slide C |
| `10-3d-side.png` | sculpture from the side, showing the layer thickness | new slide C |
| `11-3d-back.png` | kraft-paper back with the HIDE 2026 stamp | new slide C |
| `12-loading-shimmer.png` | loading screen with the photo shimmering | new slide B |
