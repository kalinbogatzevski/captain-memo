# Captain Memo — Logo Generation Prompts

Three image-generation prompts for the project mascot/logo. Pick one direction (or remix), generate variants, then refine. All prompts work with Midjourney, DALL-E 3, Stable Diffusion XL, Imagen, Flux, etc. — image generators converge on the same descriptive vocabulary.

The logo needs to work at three sizes:
- **Favicon (32×32 px)** — must be readable at thumbnail scale
- **GitHub repo avatar (96×96 px)** — small but breathing room
- **README banner (1200×400 px)** — the project's first impression

Pick a prompt, generate ~4 variants, ideally export as **SVG** or transparent **PNG**.

---

## Direction A — Friendly cartoon captain (most marketable)

This is the Octocat / Husky / Tux pattern: a memorable cartoon character with personality. Best for an open-source project that wants community recognition.

```
A friendly cartoon captain mascot for a developer tool, flat modern vector
illustration style. The captain is a young, smiling figure in a navy-blue
captain's coat with two rows of brass buttons, white captain's hat with a
small brass anchor emblem, holding an open leather-bound logbook in both
hands. The logbook has a quill pen tucked in the spine and faintly visible
handwritten lines on the page. Slightly oversized round head, simple dot
eyes, gentle smile — character design in the spirit of Octocat, Tux, the Go
gopher: instantly recognizable, low-detail, friendly. Strong silhouette that
reads at 32px. Centered composition on transparent background. Limited
palette: navy blue, brass gold, off-white, warm parchment. No text in the
image. Vector / flat design / modern / clean lines / no shading gradients.
```

**Variants to try:**
- Replace "leather-bound logbook" with "scroll being unfurled" for a more dynamic feel.
- Add "tiny anchor pendant on chest" for extra recognition detail.
- Try "in profile view, sitting at a small desk writing in the log" for a more storytelling pose.

---

## Direction B — Symbolic monogram (most professional)

A geometric mark that combines the captain/maritime theme with the "memo/notebook" theme. No character. Best for a serious-tools-vibe brand.

```
A flat geometric vector logo for a software project named "Captain Memo".
Combine two symbols into one mark: a stylized open book or notebook seen
from above, with an anchor as the spine of the book — the anchor's vertical
shaft running down the book's center binding, the anchor's curved arms
forming the top of the book's pages. Clean modern geometric design with
strong line weight, monochromatic or two-color palette (deep navy + brass,
or simply solid black). Reads cleanly at 32px favicon size. Centered on
transparent background, generous negative space. No text. Style: minimal,
geometric, flat icon, modern logo design, line-art / filled-shape hybrid,
inspired by classic 1960s monogram logos and modern dev-tool icons.
```

**Variants to try:**
- "Compass rose forming the cover of a closed book" — different metaphor.
- "Quill pen passing through an anchor ring" — simpler shape.
- "Lighthouse silhouette with a scroll wrapped around the base" — leans into the "guides you back" angle.

---

## Direction C — Hybrid badge (best of both)

Combines Direction A's character recognizability with Direction B's professional shape. The captain mascot inside a circular maritime badge.

```
A circular badge logo for a developer tool. Inside the circle: a small
flat-vector cartoon captain (round head, simple dot eyes, gentle smile, navy
captain's hat with brass anchor) shown from the chest up, holding an open
logbook in front of them. The captain is centered. Around the circular
border: a stylized rope or chain border, with the project name "CAPTAIN
MEMO" in small clean uppercase serif letters at the bottom of the rim, and
two small anchor symbols at the left/right of the rim. Limited palette:
deep navy blue, brass gold accents, off-white interior, warm parchment
shading on the logbook. Modern flat-vector style — no photorealism, no
heavy gradients, clean lines. Center reads at 32px favicon size if the rim
text is removed; full badge reads at 96px+. Transparent background outside
the circle.
```

**Variants to try:**
- Replace the "rope/chain" rim with "compass-rose tick marks at 8 cardinal points" for a more nautical-instrument feel.
- Try a "horizontal rectangular badge" instead of circular — better for README banner.
- Remove the captain entirely and just keep the badge with anchor + open book inside — fastest professional iteration.

---

## Style notes that apply to all three

When you generate, append any combination of these to tighten the output:

```
…flat modern vector design / clean lines / no photorealism / no AI artifacts /
no extra text / instantly recognizable silhouette / works at 32px and at
1200px / professional open-source software logo / minimalist / geometric /
limited color palette / SVG-friendly / centered composition / transparent
background.
```

**Avoid prompt:**
```
no realistic photo style, no 3D rendering, no extreme detail, no busy
background, no gradients (or very minimal), no text overlays, no signatures,
no watermarks.
```

**For Midjourney specifically:** add `--style raw --no signature watermark text`.

**For DALL-E / GPT-image-1:** the model often adds tiny illegible text — explicitly request "no text in image" multiple times.

**For SVG output:** use Recraft or SVG-specific generators; alternatively, generate a clean PNG and have a tool like Vectorizer.AI convert to SVG.

---

## Recommendation

Direction **A (friendly cartoon captain)** has the highest open-source marketing leverage — Octocat, Husky, the Go gopher, Tux — every successful open-source mascot follows this pattern. Repo avatar, README banner, sticker swag, error messages ("Captain Memo says..."), all work better with a character.

Direction B is the safer, more professional fallback if you want to keep the brand serious.

Direction C splits the difference but generates more inconsistent results across image generators because of the rim-text rendering issue.

Generate Direction A first; if results don't land within ~6 attempts, fall back to B.
