# Lyrics match scorer: measurements and design (2026-08-01)

Grounding for the scorer in `src/lib/lyrics/score.ts` and the primitives in
`src/lib/lyrics/match.ts`. Produced by probing the live LRCLIB API across
five categories of hard track (version qualifiers, non-latin titles, artist
credit mismatches, title collisions, duration behaviour).

Read section 4 before changing anything here: it lists the rules that look
obviously right and are refuted by real data.

## Where the implementation deliberately differs

- **`album_name` is not sent to LRCLIB `/search`.** A wrong album returns
  zero results and YTM disagrees with LRCLIB about albums constantly. It
  stays on `/get`, where strictness is the point.
- **R7 is not a hard reject.** An LRC that overruns the audio suppresses the
  timings and serves the plain text, rather than dropping the record and
  falling back separately. Same outcome, one mechanism.
- **The confidence floor does not reject the EARFQUAKE set**, and cannot: the
  `0.55 + 0.45 x duration` envelope floors a perfect title-and-artist match
  at exactly the floor value. Rejecting there would be wrong anyway, since a
  duration mismatch on the right song affects the timings, not the words.
- **Tempo rescaling is not implemented**, per section 5.
- The instrumental outcome stays a plain-text marker rather than a new
  `Lyrics` kind; the scorer already stops those reporting as "not found".

Numbers in section 1.3 were recomputed by hand and match; the probe agents'
own Korean figures were wrong in the unsafe direction.

---

I have the measurements I need - including two places where the probe's own numbers are wrong. Writing up.

# Lyrics matching: one scorer design + regression corpus

Everything below that carries a number is either quoted from the probe or was recomputed locally against the probe's literal strings. **Where I recomputed and disagree with the probe, I say so** - there are two such cases and one of them moves a threshold.

---

## 0. What the five categories actually agree on

Stripping the disagreements, the five probes converge on four claims:

1. **The parenthetical is the signal, not noise.** `normalizeForMatch`'s `.replace(/\(.*?\)|\[.*?\]/g, " ")` is named as the single most damaging rule by three of the five categories independently (version-qualifiers, non-latin, title-collisions).
2. **Overlap-over-the-smaller-set is broken for titles and correct for artists.** Same function, opposite verdicts, because titles need length sensitivity and artists need order-free subset tolerance.
3. **Duration is a ranking term that lies in both directions**, and the only *testable* statement a record makes about its own recording is its last LRC timestamp.
4. **`hasSynced` as a pre-filter causes losses no scorer can recover** (Postmodern Jukebox, Tremor, bare-`Alone`).

Everything in this design is downstream of those four.

---

## 1. SIMILARITY

### 1.1 The metric, per script

| Case | Metric | Why |
|---|---|---|
| Same-script, any script | **Character-bigram Dice** on the *repaired* string | Length-sensitive (kills `Stay Stay Stay`), works on 2-char CJK, gives a usable middle band for simplified/traditional variants |
| Cross-script (Dice == 0) | Separate branch: decide on artist + duration only, mark low confidence, and prefer same-script candidates when any exist | `Dice('Группа крови','Gruppa Krovi') = 0.000` yet same recording |
| Mixed-script single string | Repaired into *variants*, then max-Dice over the variant cross-product - but only when the bracket body is in a **different script** from the base | `Through the Night (밤편지)` → 1.000; `Hurt Niggas (Hurt)` stays at 0.462 |

I use one metric for both scripts. There is no branch on "is this CJK" - the branch is on **whether Dice came out 0**, which is a measured property, not a guessed script classification.

### 1.2 Why not the alternatives (recomputed)

| pair | old `tokenOverlap` | bigram overlap-coeff | **bigram Dice** | truth |
|---|---|---|---|---|
| `Звезда по имени Солнце` / `Звезда` | 1.000 | 1.000 | **0.385** | different song |
| `Звезда по имени Солнце` / `Звезда По Имени Солнце` | 1.000 | 1.000 | **1.000** | same |
| `좋은 날` / `운수 좋은 날` | 1.000 | 1.000 | **0.750** | different song |
| `周杰伦` / `周杰倫` | 0.000 | 0.500 | **0.500** | same artist |
| `周杰伦` / `林俊杰` | 0.000 | 0.000 | **0.000** | different artist |
| `Stay` / `Stay Stay Stay` | 1.000 | 1.000 | **0.375** | different song |

Token overlap is binary on exactly the cases that matter. The overlap coefficient re-creates the min()-denominator bug. Dice is the only one of the three with a usable middle.

### 1.3 ⚠️ Correction to the probe's numbers

**The non-latin probe's Korean Dice values are wrong, and the error is in the unsafe direction.**

| pair | probe claims | I measure | 
|---|---|---|
| `좋은 날` / `이렇게 좋은 날` | 0.571 | **0.692** |
| `좋은 날` / `햇살 좋은 날` | 0.545 | **0.720** |
| `좋은 날` / `운수 좋은 날` | - | **0.750** |
| `밤편지` / `Through the Night (밤편지)` (raw) | 0.250 | **0.438** |
| `아이유` / `IU (아이유)` (raw) | 0.667 | **0.769** |

(Keeping vs stripping whitespace before bigramming moves these by ≤0.05, so that is not the explanation; the probe's arithmetic is simply off.)

**Consequence:** a Dice floor of 0.6 - which the probe's numbers would have licensed - admits *three different Korean songs*. The measured stranger ceiling across the whole corpus is **0.750** (`운수 좋은 날`), not 0.571.

### 1.4 Exact algorithm

```
normalizeForScore(s):
  1. NFKC
  2. lowercase
  3. delete C0 controls (U+0000-U+001F), U+FEFF, U+FFFE
  4. apply the explicit fold table (see below)
  5. NFD, delete \p{M}+, (recompose not needed)
  6. replace [^\p{L}\p{N}]+ with a single space; trim; collapse runs

FOLD TABLE (required - NFD does NOT decompose these):
  ø Ø → o    ł Ł → l    đ Đ → d    ß → ss
  ı → i      æ Æ → ae   œ Œ → oe   ð → d      þ → th
```
`Høld On` is a real, correct, synced Justin Bieber row at the correct 171s. Without the fold it scores 0.857; with it, **1.000**. That single character is why NFD-plus-strip-marks is not sufficient.

```
bigrams(t):            # t already normalizeForScore'd; whitespace KEPT
  if len(t) == 1: return {t: 1}          # 1-char titles degrade to equality
  multiset of t[i:i+2] for i in 0..len-2  # MULTISET, not set

dice(a, b) = 2 * |bag(a) ∩ bag(b)| / (|bag(a)| + |bag(b)|)      # ∩ = min of counts
```

Multiset, not set: `Alone Alone` has the bigram `al` twice and `Alone` once; a set would silently discard the repetition that is the whole signal.

### 1.5 Title repair, in strict order (all of it happens before Dice)

```
parseTitle(raw, artistHint) -> { base, qualifiers[], altTitles[] }

 (a) COLLAPSE SELF-JOIN
     split on U+001F, then on ";" - no surrounding whitespace allowed.
     if >1 part and all trimmed parts are byte-identical, keep one.
     'Hurt\u001fHurt' -> 'Hurt'      'One Kiss;One Kiss' -> 'One Kiss'
     MUST NOT touch ', ' or ' ' repetition - 'Stay Stay Stay' is a real song.

 (b) STRIP UPLOAD FURNITURE (reuse cleanTrackTitle, plus:)
     - remove '_<6+ digits>'
     - remove a leading '<artist> - ' or trailing ' - <artist>'
     - if the title splits on ' - ' into parts whose first and last are equal
       after normalisation, keep the first     ('Levels - Avicii - Levels' -> 'Levels')
     - remove a trailing ' | lyrics…' tail

 (c) BRACKET SCAN, left to right, over ( ) [ ] { }
     unbalanced open  -> everything after it IS the bracket body (do not
                         leave the text in base). This is what rescues the
                         real row 'Sticky (feat. GloRilla, Sexyy Red'.
     for each body:
       classify -> HARD | SOFT | null
       HARD/SOFT  -> qualifiers[]
       null       -> altTitles[]

 (d) DASH-FORM QUALIFIER
     base matching /^(.*?)\s+[---]\s+(.+)$/ where group 2 classifies
     -> 'Hotel California - 2013 Remaster'

 (e) WHITESPACE-FORM QUALIFIER
     raw matching /^(.*?)\s{3,}(\S.*)$/ where group 2 classifies
     -> 'Everlong                     Acoustic'

 (f) ALT FILTER - this is the rule that makes variant-splitting safe
     keep an alt only if  norm(alt) != norm(base)  AND  script(alt) ∩ script(base) = ∅
```

Step (f) is the load-bearing one and the probe does not state it. **Unguarded variant-max Dice is dangerous:** it lifts the *stranger* `Hurt Niggas (Hurt)` to **1.000** against `Hurt`, and it lifts `Die For You (Remix)` to **1.000** against `Die For You`, erasing the exact distinction section 3 depends on. Gating alts on cross-script disagreement gives:

| pair | raw Dice | ungated variant-max | **script-gated** | truth |
|---|---|---|---|---|
| `밤편지` / `Through the Night (밤편지)` | 0.438 | 1.000 | **1.000** | same ✓ |
| `아이유` / `IU (아이유)` | 0.769 | 1.000 | **1.000** | same ✓ |
| `Группа крови` / `Группа крови ( Gruppa Krovi )` | 0.629 | 1.000 | **1.000** | same ✓ |
| `Hurt` / `Hurt Niggas (Hurt)` | 0.375 | 1.000 | **0.462** | different ✓ |
| `Die For You` / `Die For You (Remix)` | 0.762 | 1.000 | **1.000 base + HARD-qual mismatch** | different, caught on the qualifier axis ✓ |

An echo bracket (`Numb (Numb)`, `Creep (Acoustic) [Creep]`) fails the `!= base` test and is dropped as noise with no penalty, which is what the data asks for.

### 1.6 The identity floor: 0.85

Measured after full repair:

**Legitimate variants - all 1.000.** `Hurt`/`Hurt␟Hurt`, `Alone`/`Alone;Alone`, `Numb`/`Numb (Numb)`, `Hold On`/`Høld On`, `Sticky`/`Sticky (feat. GloRilla, Sexyy Red`, `Levels`/`Levels - Avicii - Levels`, `Alone`/`Marshmello - Alone (Official Music Video)`, `Alone`/`Alone (Original Mix)_264023874 - marshmello`, `밤편지`/`Through the Night (밤편지)`, `Wild Thoughts`/`Wild thoughts`, `稻香`/`稻香`, `Hotel California (Live on MTV, 1994)`/`Hotel California - Live On MTV, 1994`.

**Strangers - ceiling 0.750.**

| stranger pair | Dice |
|---|---|
| `좋은 날` / `운수 좋은 날` | **0.750** ← worst |
| `좋은 날` / `햇살 좋은 날` | 0.720 |
| `좋은 날` / `이렇게 좋은 날` | 0.692 |
| `晴天` / `晴天娃娃` | 0.500 |
| `Hurt` / `Hurt Niggas (Hurt)` | 0.462 |
| `Sweater Weather` / `…432Hz` junk | 0.418 |
| `Alone` / `ALONE ALONE ALONE` | 0.400 |
| `Звезда по имени Солнце` / `Звезда` | 0.385 |
| `Stay` / `Stay Stay Stay` | 0.375 |
| `Hurt` / `Hurt People Hurt` | 0.333 |
| `On` / `On, On, On, On...` | 0.182 |

**Measured empty band: 0.750 → 1.000.** I pick **0.85**.

**Say it plainly:** 0.85 is a judgement call inside a measured gap, not a measurement. The probe claimed the band was 0.455→0.857 and that 0.90 would be safe; on my numbers 0.90 is also safe but 0.80 is only 0.05 above a real stranger. 0.85 leaves headroom on both sides. Synthetic near-misses land at `Fast Car`/`Fast Cars` 0.933 and `Sweater Weather`/`Sweater Wheather` 0.897, both above the floor; `Numb`/`Numbs` at 0.857 is uncomfortably close and is the case that would break first if the floor moved to 0.90.

### 1.7 Mixed-script strings

Three distinct situations, deliberately handled differently:

1. **Dual-script one title** (`Through the Night (밤편지)`) - the alt filter handles it. Not "mixed script", just two titles in one field.
2. **Query and candidate in different scripts, Dice == 0** (`Группа крови` / `Gruppa Krovi`) - do *not* reject. Enter the cross-script branch: identity is unavailable, so require `artistScore ≥ 0.85`, apply the duration term, and cap the result's confidence. Cross-script candidates are only ever ranked when **no same-script candidate passes**.
3. **The trap on the other side** (`アイドル` / `Idol`) - artist 1.000, duration Δ0, and the body is a 4212-char English lyric. This is *not* solvable at the scorer. It is solvable at the query layer: **never issue a transliterated or translated fallback query.** `Blood Type`/`Kino` and `Dao Xiang`/`Jay Chou` are the same failure. The scorer's contribution is only the "prefer same script" preference; the real fix is not asking the question.

---

## 2. ARTIST COMPARISON

### 2.1 The rule in one line

**Never split a credit into names for comparison. Tokenize, compare token sets in both directions, and take the max.**

### 2.2 The safe separator set - token boundaries only

```
whitespace   ,   ;   /   \   |   +   &   -
U+0000 (NUL)   U+001F (US)   U+FEFF (BOM)   U+FFFE
U+3001 、      U+FF0C ，      U+30FB ・
```

Plus: drop the credit words `feat  ft  featuring  with  vs  versus  prod  presents  and` from both sides. Plus: un-escape `\,` → `,` before tokenizing.

These are the delimiters **the corpus actually contains** for one recording ("Sticky", seven encodings of one credit): bare spaces, comma, semicolon, fullwidth comma U+FF0C, backslash-escaped `Tyler\, The Creator`, slash, and `Tyler/ The Creator/GloRilla/…` where the name's *internal comma* was itself rewritten as a delimiter.

### 2.3 Why "Tyler, The Creator" forbids splitting

The comma is inside a single artist's name. Every candidate separator is inside *some* name:

| name | contains |
|---|---|
| `Tyler, The Creator` | comma |
| `Earth, Wind & Fire` | comma **and** ampersand |
| `Dimitri Vegas & Like Mike` | ampersand |
| `D-Block Europe` | hyphen |
| `Florence + The Machine` | plus |

And the corruption is already in the database, so a splitting scorer must *also* match its own output:
- 20 LRCLIB rows with `artistName = "Earth, Wind"` - one albumed `The Essential Earth, Wind`
- `artistName = "The Creator"` is the **only correct** EARFQUAKE record (album IGOR, 190.0s)
- `artistName = "Tyler"` alone - three real rows, album CHROMAKOPIA
- `Tyler/ The Creator/GloRilla/…` - a naive comma split, committed, then re-encoded with slashes

Splitting on ` & ` is refuted in one string: `Dimitri Vegas & Like Mike & Martin Garrix` - first ampersand internal, second a separator, nothing distinguishes them. Splitting yields three names from that row and two from `Dimitri Vegas & Like Mike, Martin Garrix`, **the same recording**.

Tokenizing sidesteps all of it: every one of those strings tokenizes to a set whose intersection behaves correctly.

### 2.4 The score

```
artistScore(reqArtist, hitArtist, durationDelta):
  R = tokens(reqArtist);  H = tokens(hitArtist)          # deduped by Set
  if R empty or H empty: return 0
  shared = |R ∩ H|
  coverage = max(shared/|R|, shared/|H|)                 # BOTH directions
  charDice = dice(reqArtist, hitArtist)                  # CJK / script-variant rescue
  s = max(coverage, charDice)

  # pseudoNames: best-effort split on , ; / \ | & only. Used ONLY for the three
  # adjustments below - NEVER to decide identity.
  rn = pseudoNames(req);  hn = pseudoNames(hit)

  (1) EXTRA-NAME  −0.35 per name, capped at 2
      a hit name counts as extra iff NONE of its tokens appear in R
      AND dice(that name, every req name) < 0.5
  (2) TRUNCATION  −0.15
      a hit name is a proper prefix of a req name on a space boundary,
      is not itself a complete req name,
      AND that req name is not fully covered by H overall
  (3) SINGLE-TOKEN CREDIT  −0.40
      |H| == 1 and |R| > 1 and |durationDelta| > 5s (or duration unknown)

  return clamp(s, 0, 1)
```

**Cross-product rule:** `max(shared/|R|, shared/|H|)`. The min()-denominator in the existing `tokenOverlap` is **directionally correct for artists**; the defect is that it is consumed as a boolean with no floor and no ranking. Both directions are required by real data:

- **hit ⊂ req** (the common correct form): `Rich Flex`→`Drake`, `Wild Thoughts`→`Rihanna` (the *featured* artist; the billed lead is absent), `Tremor`→`Martin Garrix` (the *last*-listed), `HEAT`→`SUKHA`, `EARFQUAKE`→`The Creator`.
- **hit ⊃ req**: `DJ Khaled, Rihanna, Bryson Tiller, Rihanna & Bryson Tiller` - a duplicated superset, and correct at 204s.

Since the surviving credit can be the first, last, or a middle name, **no positional rule is available**. Subset must be free.

### 2.5 Measured output

| req | hit | score | truth |
|---|---|---|---|
| `Drake, 21 Savage` | `Drake & 21 Savage␀Drake␀21 Savage` | **1.000** | ✓ correct |
| `Drake, 21 Savage` | `Drake` (Δ0s) | **1.000** | ✓ correct |
| `Tyler, The Creator` | `The Creator` | **1.000** | ✓ correct |
| `Tyler, …, Lil Wayne` | `Tyler` (Δ76s) | **0.600** | ✓ demoted |
| `Tyler, …, Lil Wayne` | `Tyler/ The Creator/GloRilla/…` | **1.000** | ✓ correct |
| `Earth, Wind & Fire` | `Earth, Wind` | **1.000** | ✓ correct |
| `Earth, Wind & Fire` | `Earth, Wind & Fire, Earth, Wind & Fire` | **1.000** | ✓ correct |
| `DJ Khaled, Rihanna, Bryson Tiller` | `Rihanna` (Δ0s) | **1.000** | ✓ correct |
| `Dimitri Vegas & Like Mike, Martin Garrix` | `Dimitri Vegas & Like Mike & Martin Garrix` | **1.000** | ✓ correct |
| `The Kid LAROI, Justin Bieber` | `THE KID LAROI/JUSTIN BIEBER/THE KID LAROI/JUSTIN BIEBER` | **1.000** | ✓ correct |
| `Dean Martin` | `Martin, Dean` | **1.000** | ✓ correct (reordered) |
| `cassö, RAYE, D-Block Europe` | `Cassö, RAYE, D-Block Europe` | **1.000** | ✓ correct |
| `아이유` | `IU (아이유)` | **1.000** | ✓ correct |
| `周杰伦` | `周杰倫` | **0.500** | ✓ script variant |
| `Linkin Park` | `Linkin` (Δ2.04s) | **0.850** | ✗ demoted below the real rows |
| `Dua Lipa` | `Dua Lipa, DaBaby` | **0.650** | ✗ demoted (extra name) |
| `周杰伦` | `林俊杰` | **0.000** | ✗ rejected |
| `Marshmello` | `Parkway Drive` | **0.000** | ✗ rejected |
| `The Weeknd` | `Teddy Swims` | **0.000** | ✗ rejected |

**Gate: reject at `artistScore < 0.45`.** Justified by the band: same-artist 1.000, script-variant 0.500, different-artist 0.000. 0.45 sits below the script-variant floor and above zero. No probed correct row lands between 0.000 and 0.500.

### 2.6 Two residuals I cannot close, stated honestly

**(a) `Levitating` - solved, but only by a tiebreak.** Same title, same duration (203 vs 204), `Future Nostalgia` on both. `Dua Lipa, DaBaby` req vs `Dua Lipa` hit scores 1.000 - indistinguishable from `Rich Flex`→`Drake`, which is correct. The extra-name penalty fixes only the *solo-request* direction (0.650). The remix direction is fixed by a **tiebreak on shared-token count descending**: `Dua Lipa DaBaby` shares 3 tokens, `Dua Lipa` shares 2. That closes both directions, but it is a tiebreak, not a gate, so it only works when the two rows are otherwise near-equal - which here they are.

**(b) `Numb` / `Linkin`.** A one-token hit credit that is a prefix of the request artist and sits 2.04s from target cannot be *rejected* on available evidence. The truncation penalty drops it to 0.850, below the genuine `Linkin Park` rows at 1.000, so ranking saves us **only because those rows are present**. If LRCLIB ever returned the `Linkin` row alone, this design would take it. I see no fix that does not also break `Rich Flex`→`Drake`.

**(c) `Sticky`+`Tyler`.** The probe is right that artist text cannot separate this from `Rich Flex`+`Drake`. Rule (3) defers to duration: 180 vs 256 → 0.600; 255.92 vs 256 → 1.000 (and that row is album CHROMAKOPIA, so accepting it is not a loss).

---

## 3. THE SCORER

```ts
type Query = {
  title: string;            // cleanTrackTitle output
  artist?: string;          // lyricsArtist output - may be undefined
  durationSec?: number;     // may be undefined
  artistWasDropped: boolean;// true if this candidate set came from an
                            // artist-less retry of a query that HAD an artist
};

type Candidate = {
  trackName?: string; artistName?: string; albumName?: string;
  duration?: number | null;
  syncedLyrics?: string | null; plainLyrics?: string | null;
  instrumental?: boolean;
};

type Verdict = { score: number; reject: boolean; reason: string };

function scoreCandidate(q: Query, c: Candidate): Verdict
```

### 3.1 HARD REJECTS, in evaluation order

Each returns immediately with `score: 0`.

| # | Rule | Threshold | Probed case that demands it |
|---|---|---|---|
| **R1** | No usable body: `instrumental !== true` and both `syncedLyrics` and `plainLyrics` are absent or empty **strings** | `.trim() !== ""`, not truthiness | 밤편지/IU: the three highest-scoring rows (`밤편지 (Through the Night)`) have *both* fields empty |
| **R2** | `artistWasDropped === true` | absolute | `좋은 날`+`아이유` → 0 hits; the title-only retry returns 20 rows, **none** by IU. The probe calls this "the single most dangerous change available" |
| **R3** | Artist unknown **and** the repaired base title is a single Latin token, or fewer than 3 CJK characters | `tokens ≥ 2` (latin) / `chars ≥ 3` (CJK) | Bare `On` → 0/14 rows titled On. Bare `Go` → 0/12. Bare `Stay` → 0/12, all Taylor Swift's `Stay Stay Stay` |
| **R4** | Identity Dice `< 0.85` (same-script only) | **0.85** | measured empty band 0.750 → 1.000 (§1.6) |
| **R5** | Both artists known and `artistScore < 0.45` | **0.45** | band: same 1.000 / script-variant 0.500 / different 0.000 |
| **R6** | Cross-script (`identity == 0`) and `artistScore < 0.85` | **0.85** | `Группа крови`/`Gruppa Krovi` must survive; `アイドル`/`Idol` must be reachable only as a last resort |
| **R7** | **LRC internal consistency**: `lastTimestamp(syncedLyrics) > q.durationSec + 5` | **+5s** | 38/193 synced records (20%) fail this against their *own* stored duration. Get Lucky 12/20, One More Time 11/20, Thriller 7/20 |
| **R8** | `c.duration > 1.60 × q.durationSec` | **1.60**, upper side only | rejects 781/388, 499/274, 400/226, 694/240, 2515/226. Keeps 266/204 (1.30) for demotion, not rejection |
| **R9** | Artist unknown and **more than one distinct normalized artist** appears among all candidates that cleared R4 | absolute | bare `Hurt` → 8 artists; bare `Creep` → 4 incl. TLC's different song; bare `Blinding Lights` → Teddy Swims cover at 199 vs real at 200/202, **a 1-second margin** |

**R8 is deliberately one-sided.** A symmetric 0.60 lower bound rejects Thriller's only correct record (358s vs the 822s official video, ratio 0.436). The lower side is handled by R7 plus the duration score. A candidate *longer* than the audio guarantees overhang; a candidate shorter does not.

**R9 is stricter than the probe strictly proves.** The probe says "refuse when the title is a single token"; I extend refusal to *any* artist-less lookup where candidates disagree on artist. The Blinding Lights control is why: a distinctive two-token title still cannot separate a cover from the original when the margin is 1s and LRCLIB's own variance for the same recording is 200/202/202/202. This is a judgement call in the direction of refusing.

### 3.2 Score, when nothing rejected

```
score = identity
      × artistFactor
      × qualifierFactor
      × (0.55 + 0.45 × durationScore)
      × bodyFactor
```

**`identity`** - script-gated variant-max bigram Dice, ∈ [0.85, 1.00] by R4.

**`artistFactor`** - §2.4 score, or **0.80** when the artist is unknown and R3/R9 both passed (an unverified-artist result is never as good as a verified one).

**`durationScore = 1 / (1 + (Δ/12)²)`**, Δ = |round(c.duration) − round(q.durationSec)|:

| Δ | 0 | 2 | 3 | 5 | 8 | 12 | 15 | 20 | 30 | 79 |
|---|---|---|---|---|---|---|---|---|---|---|
| score | 1.000 | 0.973 | 0.941 | 0.852 | 0.692 | 0.500 | 0.390 | 0.265 | 0.138 | 0.023 |

Anchored on the measured same-recording spread: `bad guy` 17/20 within 2s, `Shape of You` 15/20 within 3s, `Thriller` 13/20 within 2s, `Faded` 12/20 within 2s; and on genuine version gaps: Metallica studio 388 vs live 379/380/384 (Δ8), Everlong electric 251 vs acoustic 281 (Δ30), Sweater Weather 240 vs sped 219 (Δ21).

`c.duration == null` → `durationScore = 0.30` (not 0, not 1). `q.durationSec` unknown → `durationScore = 0.50` uniformly, so it stops discriminating rather than picking the 4-second stub.

**The `0.55 + 0.45×` envelope caps duration's total influence at 0.45.** This is what prevents the probed failure mode "a 256s request lands on Drake's 247s row" - an artist mismatch (factor 0.00-0.65) can never be outvoted by a perfect duration.

**`qualifierFactor`** - compare the two HARD qualifier sets (canonicalized to tokens; SOFT qualifiers are ignored entirely):

| situation | factor | evidence |
|---|---|---|
| HARD sets equal, or both empty | 1.00 | |
| SOFT-only difference | **1.00** | every correct `Hotel California (2013 Remaster)` is 391s, *identical* to the unqualified studio rows, and the plain search returns **zero** remaster-tagged trackNames. Penalizing this rejects the entire correct set |
| request HAS a hard qual, candidate has none | **0.75** | correct rows are often bare: all 8 Metallica live takes, all 3 live `Levitating` rows have completely bare trackNames. Must be a downrank, never a veto |
| candidate HAS a hard qual, request has none | **0.55** | asymmetric on purpose: an explicit wrong-version tag is stronger evidence than a missing one. Fixes `Dao Xiang (Live)` @222.0 beating the studio @222.697 |
| both non-empty and disjoint | **0.35** | `Die For You` vs `Die For You (Remix)` |
| qualifier and duration disagree | **×0.85** additional | `Sweater Weather (Sped Up)` @240.43 (original length); six `Everlong (Acoustic)` @251 (electric length); four `Hotel California - Live On MTV` @386-395 (studio length). Both fields lie; downrank rather than picking a winner |

HARD vocabulary: `remix, live, acoustic, unplugged, sped up, slowed, reverb, nightcore, demo, instrumental, karaoke, cover, radio edit, extended, club mix, 8d, 432hz, tiktok`.
SOFT: `remaster/remastered [year], explicit, clean, single version, album version, original mix, stereo, mono, deluxe, anniversary, bonus track, edition, official (music) video/audio, mv, bare <year>`.

*Judgement call:* I classify `Original Mix` as SOFT. Marshmello's 274s "Original Mix" genuinely differs from the 200s single edit, so a case exists for HARD - but the tag is far more often just an album-version label, and duration already separates 274 from 200 (Δ74 → 0.026).

**`bodyFactor`** - `1.00` synced, `0.92` plain-only. **Not a filter.**
0.92 chosen so a plain row of the right recording (0.92) beats a synced row 12s off (`0.55+0.45×0.500 = 0.775`) but loses to a synced row within 5s (`0.55+0.45×0.852 = 0.933`). Judgement call; the constraint it must satisfy is Postmodern Jukebox `Creep` - 8/8 rows correct, 8/8 `syncedLyrics = null` - where a filter returns empty and then tempts a title-only broaden onto Radiohead.

### 3.3 Selection over the candidate set

1. **Group by lyric-body hash first.** 20 rows collapse to 1-4 distinct bodies (Get Lucky 20→1, One More Time 20→2, Shape of You 20→2). The real decision is *which body*; choosing among clones by duration is theatre.
2. Score every candidate. Take the best-scoring **group**.
3. Within the winning group, pick the record whose duration is nearest the group's **modal** duration cluster, not the single nearest record. Modes are unambiguous: `bad guy` 194×14, `Shape of You` 234×11, `Thriller` 358×7, `Levels` 200×6.
4. Tiebreak when scores are within 0.02: (i) higher shared artist-token count, (ii) synced over plain, (iii) longer lyric body. **Never** LRCLIB rank - it is anti-correlated (Adelitas Way above Johnny Cash; wrong-artist `Linkin` at rank 0; the only correct-duration Marshmello row at rank 4).
5. **Absolute confidence floor: 0.55.** Below it, return "no match" rather than the argmax. EARFQUAKE needs this - 20 artist-identical rows spanning 225-271s, none near the real 190s.
6. If the best group survives R1-R9 but every synced record in it fails R7, **serve `plainLyrics` and suppress the LRC.** Get Lucky radio edit, One More Time radio edit, any nightcore. Unsynced text is a correct answer; a highlight 68s out is a visible bug.
7. `instrumental === true` on a candidate that clears R4/R5 → return the distinct outcome **"instrumental"**, not "not found". Darude Sandstorm: 20/20 instrumental, and the current pipeline reports a lookup failure.

### 3.4 Worked traces

| case | winner | why the runner-up loses |
|---|---|---|
| `Die For You`+`The Weeknd` @260 | idx 3, 260s → **1.000** | idx 0 (233s, the Ariana remix, LRCLIB's top hit): identity 1.0, no quals either side, Δ27 → `0.55+0.45×0.165` = **0.624** |
| `Die For You (Remix)` @233 | idx 3, 233s → **1.000** | 4s stubs: Δ229 → 0.002 |
| `Hotel California (2013 Remaster)` @391 | idx 1, 391s → **1.000** | idx 0 (206s, exact title+album equality - the probe's trap): SOFT qual ignored, Δ185 → **0.554** |
| `Everlong (Acoustic)` @281 | idx 9, 281.12s → **~1.000** | six `(Acoustic)` rows @251 (electric length): hard-qual match but Δ30 → **0.612**, ×0.85 qual/duration conflict → **0.520** |
| `Nothing Else Matters` @388 | idx 0, 388s → **1.000** | live @379: Δ9 → 0.838. Live @384: Δ4 → 0.958 - *close*, and only the exact-388 row's presence saves it |
| `Sweater Weather (Sped Up)` @219 | idx 4, 219s → **1.000** | idx 1 `(Sped Up)` @240.43: Δ21.4 → 0.66; idx 9 (432Hz junk): identity 0.418 → **R4 reject** |
| `Dao Xiang`+`Jay Chou` @222 | idx 0, 223s → **0.993** | `Dao Xiang (Live)` @222.0: qualifierFactor 0.55 → **0.550**. Fixes the probed inversion |
| `밤편지`+`IU` @253 | idx 7, 253s synced → **1.000** | idx 4/8 (`밤편지 (Through the Night)`, best raw text): **R1 reject**, both bodies empty |
| `Get Lucky` radio edit @248 | **none** | all 20 rows one body, lastTS 315.71 > 248+5 → **R7 rejects every one**. Falls to plainLyrics |
| bare `Alone` @274 | **none** | **R9**: Parkway Drive / Heart / the brilliant green disagree on artist. The probe's confidently-wrong Parkway Drive @271 never gets scored |
| `Numb`+`Linkin Park` @187 | idx 0 `Numb (Numb)` @187 → **1.000** | `Linkin` @184.96: artist 0.850, Δ2 → **0.844**. Correct by ranking only (§2.6b) |
| `Creep`+`Postmodern Jukebox` @247 | idx 0 @247.46 plain → **0.919** | nothing - the set is 100% correct and 0% synced. Old pipeline returned empty |

---

## 4. WHAT NOT TO DO

Each of these is a rule someone will reach for. Each has a counterexample in the probe.

### Title / similarity

| Tempting rule | Counterexample |
|---|---|
| **"Strip all parentheticals before comparing"** (what `match.ts` does today) | `Through the Night (밤편지)` → `through the night`, sharing zero characters with `밤편지`. That is the **only** hit LRCLIB has for 밤편지+아이유 and the current `hitMatches` returns **false**. Also makes `Die For You` == `Die For You (Remix)`, `Everlong` == `Everlong (Acoustic)`, `Creep` == `Creep (Acoustic)` |
| "Token overlap is fine, just tune the threshold" | 20/20 candidates score exactly 1.000 in six separate probes. No threshold exists. `Set('stay stay stay')` dedupes to `{stay}` |
| "Use the bigram overlap coefficient so short CJK titles aren't penalized" | Returns 1.000 for `Звезда по имени Солнце`→`Звезда` (wrong song) **and** →`Звезда По Имени Солнце` (right). It re-creates the exact min()-denominator bug |
| "Bigram Dice ≥ 0.5 means match" | The correct `Through the Night (밤편지)` scores **raw 0.438** against `밤편지`. Dice only works *after* variant splitting |
| **"Variant-max Dice, unguarded"** *(my addition - the probe recommends this without a guard)* | Lifts the stranger `Hurt Niggas (Hurt)` to **1.000** and erases `Die For You (Remix)` to **1.000**. The alt must be gated on cross-script disagreement |
| "Title score of 0 → reject" | `Dice('Группа крови','Gruppa Krovi') = 0.000` - same recording, correct Cyrillic body |
| "Title score 0 but artist matches → accept" | `Dice('アイドル','Idol') = 0.000`, artist 1.000, Δduration 0s - and the body is a 4212-char **English** lyric |
| "Collapse any doubled title `X X` → `X`" | Merges `Stay Stay Stay`, `On, On, On, On...`, `Go Go Go Go`, `Alone, Alone`, `ALONE ALONE ALONE` into the titles they must stay distinct from. Collapse **only** on U+001F and `;` with no surrounding space |
| "Just strip non-alphanumerics - that handles the weird separators" | Turns `Hurt␟Hurt` into `hurt hurt`, which then fails the length-sensitive floor at 0.444 and takes the canonical Johnny Cash row with it. A real interaction between two individually-correct rules |
| "Reject candidates whose title is longer than the query" | Kills `Marshmello - Alone`, `Numb (Numb)`, `Alone (Original Mix)_264023874 - marshmello` - all correct |
| "NFD + strip combining marks handles accents" | Does nothing to `ø`. `Høld On` is a real correct synced row at the correct 171s |
| "Short titles are suspicious - stricter threshold below N chars" | `晴天` and `稻香` are 2 characters and are the complete correct titles of major hits |
| "A high title floor makes the artist optional" | The 0.85 floor that correctly rejects bare-`Stay` (0.375) simultaneously **accepts** Heart's `Alone;Alone` at 1.000 when the user is playing Marshmello |

### Artist

| Tempting rule | Counterexample |
|---|---|
| **"Split on commas and compare name sets"** | 20 LRCLIB rows exist with `artistName = "Earth, Wind"` - a tagger that did exactly this. Plus `The Creator` (the only correct EARFQUAKE row) and `Tyler` alone |
| "Also split on ` & `" | `Dimitri Vegas & Like Mike & Martin Garrix` - internal and separator ampersand in one string |
| "Split on `/` or `;` - unambiguous machine separators" | `Tyler/ The Creator/GloRilla/…` uses `/` as both the separator **and** the replacement for the name's internal comma |
| "Require the primary (first) artist to appear" | The correct `Wild Thoughts` row is credited to **Rihanna alone**; DJ Khaled, the billed lead, is absent. 20 such rows |
| "Then require the last/featured artist" | `Rich Flex`→`Drake` (20 rows, 21 Savage absent). Neither end is reliable |
| "Require every credited artist" | `Sukha, Prodgk, Tegi Pannu` returns literally **zero** hits; the correct record is `Sukha & Prodgk` |
| "Penalize subset credits as suspicious" | Subset is the single most common **correct** storage form: Drake / Rihanna / Martin Garrix / SUKHA / The Creator |
| "Drop `the` as a stopword" | `The Creator` is the only correct EARFQUAKE record; stripping `the` leaves one generic token. Same exposure: `The Weeknd`, `Florence + The Machine` |
| "Drop `dj` as a noise prefix" | `DJ Khaled` and `DJ Snake` both lose half their tokens; `Khaled` and `Snake` then collide broadly |
| "The separator carries meaning - `&` = one act, `,` = separate credits" | The same recording appears both ways on the same result page: Rich Flex, Lean On, Tremor all do this |
| "Boost hits whose artist string is longer / contains more" | The longest strings in the entire probe are `Earth, Wind & Fire, Earth, Wind & Fire`, the no-synced-lyrics `DJ Khaled, Rihanna & Bryson Tiller, DJ Khaled, Rihanna, Bryson Tiller`, and `Calvin Harris & Dua Lipa;Calvin Harris & Dua Lipa`. Length correlates with bad tagging |
| "Exact artist-string match is decisive" | `Wild Thoughts` [6] matches both fields byte-for-byte and is 283s on an album called `Shawty` - 79s off |
| "Exact artist **and** exact duration is decisive" | `Prada` [0]: lowercase `cassö` matching exactly, 132.0s hitting the target dead on, album `Prada … [Alok Remix]` |
| "Artist can be a soft tiebreak that duration outvotes" | Drake's `Sticky` (240s) and Tyler's `Sticky` (256s) are unrelated songs 16s apart |
| "Use the same metric for title and artist" | Opposite requirements. `The Kid Laroi, Justin Bieber, The Kid LAROI & Justin Bieber` has edit-similarity **0.66** against a correct query, and `Martin, Dean` vs `Dean Martin` needs order-insensitivity - while titles need length sensitivity |
| "Trust the artist field because LRCLIB filters strictly" | It filters by **containment**: `artist_name=Linkin` returns a distinct artist `Linkin` at **rank 0**. It also credits uploader channels - `7clouds` on a genuine Marshmello track |

### Duration

| Tempting rule | Counterexample |
|---|---|
| **"Filter to synced, then nearest duration"** (shipped today) | `/api/get?track_name=Get Lucky&artist_name=Daft Punk&duration=248` returns **200**, id=986804, storedDuration 248.0, **lastTS 315.71** - zero delta, 68s of lyrics past the end |
| "LRCLIB's ±2s window means the timing is right" | Both probes inside that window were internally impossible. The endpoint validates the metadata field, not the body |
| "Reject if |Δ| > N seconds" | No N works. N=15 discards correct rows; N=60 still discards Insomnia's 514/522/526; Thriller needs N>460. And no N excludes the wrong rows, because they sit at **Δ0** |
| "Widen to ±15s to be forgiving" | Around Metallica's 388 it swallows live takes at 379, 380, 384 |
| "Tighten to ±2s to be precise" | The same recording spreads wider: Hotel California studio 386/389/390/391/392/395, Everlong electric 245-252, Die For You remix 231-235 |
| "Reject if `lastTS / duration < 0.7`" | **Levels/Avicii scores 0.475-0.594 on every correct record** (lyrics span 83.28→113.48 in a 200s track). Deletes correct lyrics for most instrumental-heavy dance music. Penalize overhang only, never undershoot |
| "Wide duration spread means several versions exist" | Insomnia spans 161-526s and has **2** bodies; Get Lucky spans 31-370s and has **1**. The spread is tag noise |
| "Longer = extended mix, shorter = radio edit" | Insomnia's 514/522/526s rows carry the same 200.87s radio-edit body |
| "Records with junk durations (3s, 30s, 694s) are junk records" | `bad guy` @3.0, `Shape of You` @30, `Get Lucky` @31/32, `Sweater Weather` @694 and @138, `Faded` @142 all carry complete correct bodies. **Drop the duration, not the record** |
| "Missing duration → treat as 0 / as infinity" | `Math.abs(null - 240)` is 240; `Math.abs(undefined - 240)` is **NaN**, and a comparator returning NaN gives implementation-defined sort order. Two correct Sweater Weather records get ranked by a coin flip |
| "Duration matches exactly, so skip title/artist" | ~1500 plausible integer values shared by tens of millions of tracks |

### Pipeline

| Tempting rule | Counterexample |
|---|---|
| **"If track+artist returns nothing, retry with the title alone"** | Marshmello `Alone` (274s) → Parkway Drive's metalcore `Alone` (271.0s, synced). Rihanna `Stay` (240s) → Taylor Swift's `Stay Stay Stay` (238.0s, synced). Both score **1.000** under the current matcher |
| "Filter to `syncedLyrics` first" | Postmodern Jukebox `Creep`: 8/8 correct, 8/8 unsynced → empty. Tremor: 20/20 exact matches, all unsynced → empty. Bare `Alone`: the filter **deletes** the Boz Scaggs cluster and concentrates the survivors down to four strangers, *raising* the odds of a confident wrong answer |
| "Test `if (r.syncedLyrics)`" | Three 밤편지 rows have `syncedLyrics: ""` and `plainLyrics: ""`. Must test for a non-empty **string** |
| "Take the top LRCLIB hit / trust relevance order" | Wrong at rank 0 in: bare `Hurt` (Adelitas Way above Johnny Cash), `Numb`+`Linkin`, `Lean On` (Fuvi Clan cover), `Prada` (Alok remix), `One Kiss` (`One Kiss;One Kiss`), `Hotel California` (206s truncation), `Die For You` (the remix), アイドル (217s; true 213s at index **12**) |
| "Confirm with albumName" | Luke Combs has 165s, 247s and 265s all under *Gettin' Old*; Justin Bieber has 30s and 110s under *Justice*; Linkin Park has a 5s row under *Meteora*. Album values observed include view counts (`878M plays`), runtimes (`7:13`), `null`, `[Unknown Album]`, and a Swift debug dump `Optional("The Studio Albums…")` |
| "Detect live via `live` in albumName" | False negatives: five Metallica live rows are albumed with bare dates. False positives: `Unplugged Acoustic Rock` and `Acoustic Rock` are on **studio** Hotel California rows; `Radical Optimism Tour - Canada` is on a **studio-duration** Levitating row |
| "OR the qualifier from trackName and albumName together" | The Die For You row on album `Die for You (Remix) - Single` has duration **260** - the original length. Album-derived qualifiers need lower weight *and* the duration cross-check |
| "A row with syncedLyrics is a real recording" | The 4.0s Marshmello, 5.0s Linkin Park (*Meteora*), 30s Justin Bieber (*Justice*) and 82s Ken Jeong rows all have synced lyrics |
| "Score title and artist independently and add them" | For Levitating the title term is 1.00 and the duration term ~1.00 for every candidate, diluting the only informative term to a third. Hence multiplicative gating |
| "If the request has no qualifier, prefer candidates with none" | Every Metallica live take and all three live `Levitating` rows have completely bare trackNames |
| "Any qualifier mismatch is a penalty" | Every correct `Hotel California (2013 Remaster)` is 391s, identical to the unqualified rows, and the plain search returns **zero** remaster-tagged trackNames |
| "The trackName qualifier tells you which recording it is" | Refuted four ways: `(Sped Up)` @240.43 (original length); six `(Acoustic)` @251 (electric length); `Skin and Bones` @251.2 (electric); four `- Live On MTV, 1994` @386-395 (studio) |
| "Duration is objective, trust it over the tags" | `Hotel California - Live On MTV, 1994` @**391** (studio length) contains genuinely **live** lyrics - first line `[02:08.55]` vs the studio LRC's `[00:52.76]`, 61 lines vs 43 |

---

## 5. TEMPO RESCALING

**Recommendation: do not ship it.** Not behind a flag, not "approximate", not at all.

### The measurement

Four real pairs where both the original and the tempo-shifted LRC exist:

| pair | true lyric-derived scale | duration-ratio estimate | error | drift at last line |
|---|---|---|---|---|
| Sweater Weather sped 219s | 0.92983 | 0.91250 | **−1.86 %** | **−3.82 s** |
| Sweater Weather sped 218s | 0.93010 | 0.90833 | **−2.34 %** | **−4.78 s** |
| Sweater Weather slowed 282s | 1.18922 | 1.17500 | **−1.20 %** | **−3.14 s** |
| Sweater Weather slowed 301s | 1.27535 | 1.25417 | **−1.66 %** | **−4.42 s** |

**The error is negative in all four cases, in both stretch directions.** That is systematic bias, not noise - the duration field includes head/tail padding that does not get tempo-scaled - so it does not average out and more samples will not fix it. A 3-5 s error at the end of a song is two or three lines wrong: worse than showing unsynced text, because it looks like it is working.

The residual spread across the four is only 1.1 percentage points, so a fitted correction constant would still leave ~2-3 s. Not enough.

### Why a constant offset is not a substitute

Same pair: the offset needed to align the **first** lyric is −0.575 s; the offset needed to align the **last** is −15.941 s. The best single constant (−8.26 s) leaves the first line 7.68 s late and the last 7.68 s early. A tempo change is `t' = a·t + b` with **b measured at −0.090, −0.132, −0.072, −0.366 s** - b is effectively zero and `a ≠ 1`. No constant satisfies two points on a line of slope ≠ 1.

Conversely, Thriller's official long-form video **is** a pure constant offset (the 358 s song displaced inside 822 s of footage) and a scale factor is exactly the wrong tool there.

**These are two different transforms and must not collapse into one "sync offset" knob.** Shipping one control that users nudge to fix both is how you get bug reports that cannot be reproduced.

### What to do instead

1. Gate the candidate pool on the qualifier (§3.2) so a genuinely re-timed sped-up record is *found* when one exists - Sweater Weather has three, spans 6.33→209.94 vs the original's 6.905→225.881.
2. When none exists - nightcore returns **0 rows** for `Faded (Nightcore)`; the fallback's 20 rows all carry the 212 s original timing - apply R7, reject the synced bodies, and **serve plain lyrics**.
3. Keep the existing `[offset:±ms]` LRC tag handling in `parse-lrc.ts:21`. That is a constant the *file author* asserted, which is a different thing from one we inferred.

---

## 6. REGRESSION CORPUS

All fixtures are literal `LrclibRecord[]` arrays copied from the probe - **no network**. Suggested location: `src/lib/lyrics/fixtures/` (one module per case, exported as a named const) plus `src/lib/lyrics/score.test.ts`.

`lastTS` is needed for R7 cases only; store a stub `syncedLyrics` whose final timestamp is the probed value.

### 6.1 Similarity units (pure functions, no fixtures)

| id | input | assert |
|---|---|---|
| `sim-01` | `dice('Звезда по имени Солнце','Звезда')` | `≈ 0.385`, `< 0.85` |
| `sim-02` | `dice('Звезда по имени Солнце','Звезда По Имени Солнце')` | `=== 1` |
| `sim-03` | `dice('좋은 날','운수 좋은 날')` | `≈ 0.750`, `< 0.85` **(worst stranger; pins the floor)** |
| `sim-04` | `dice('周杰伦','周杰倫')` | `=== 0.5` |
| `sim-05` | `dice('周杰伦','林俊杰')` | `=== 0` |
| `sim-06` | `identity('Hurt','Hurt\u001fHurt')` | `=== 1` (self-join collapse) |
| `sim-07` | `identity('Hurt','Hurt People Hurt')` | `≈ 0.333` |
| `sim-08` | `identity('Hurt','Hurt Niggas (Hurt)')` | `≈ 0.462` **(guards against ungated variant-max)** |
| `sim-09` | `identity('밤편지','Through the Night (밤편지)')` | `=== 1` |
| `sim-10` | `identity('밤편지','밤편지 (Through the Night)')` | `=== 1` (both orderings agree) |
| `sim-11` | `identity('Hold On','Høld On')` | `=== 1` (fold table) |
| `sim-12` | `identity('Sticky','Sticky (feat. GloRilla, Sexyy Red')` | `=== 1` (unbalanced paren) |
| `sim-13` | `identity('Levels','Levels - Avicii - Levels', 'Avicii')` | `=== 1` |
| `sim-14` | `identity('Alone','Alone (Original Mix)_264023874 - marshmello','Marshmello')` | `=== 1` |
| `sim-15` | `identity('Sweater Weather', <the 432Hz title>)` | `≈ 0.418`, `< 0.85` |
| `sim-16` | `identity('Stay','Stay Stay Stay')` | `≈ 0.375` |
| `sim-17` | `identity('稻香','稻香')` / `identity('晴天','晴天娃娃')` | `1` / `0.5` |
| `sim-18` | `parseTitle('Hotel California [2013 Remaster]')` etc. | all three of `(…)`, `[…]`, `- …` yield base `hotel california` + one SOFT qual |
| `sim-19` | `parseTitle('Everlong                     Acoustic')` | base `everlong` + HARD `acoustic` |
| `sim-20` | `collapseSelfJoin('Alone, Alone')` | **unchanged** (must not collapse `, `) |

### 6.2 Artist units

| id | req / hit | assert |
|---|---|---|
| `art-01` | `Drake, 21 Savage` / `Drake & 21 Savage\u0000Drake\u000021 Savage` | `1.000` |
| `art-02` | `Tyler, The Creator` / `The Creator` | `1.000` |
| `art-03` | `Earth, Wind & Fire` / `Earth, Wind` | `1.000` |
| `art-04` | `Earth, Wind & Fire` / `Earth, Wind & Fire, Earth, Wind & Fire` | `1.000` |
| `art-05` | `DJ Khaled, Rihanna, Bryson Tiller` / `Rihanna` (Δ0) | `1.000` |
| `art-06` | `Dimitri Vegas & Like Mike, Martin Garrix` / `Dimitri Vegas & Like Mike & Martin Garrix` | `1.000` |
| `art-07` | `Tyler, …, Lil Wayne` / all seven Sticky encodings | all `1.000` |
| `art-08` | `The Kid LAROI, Justin Bieber` / `\uFEFFThe Kid LAROI, Justin Bieber` | `1.000` |
| `art-09` | `Dean Martin` / `Martin, Dean` | `1.000` (**no** truncation penalty) |
| `art-10` | `Linkin Park` / `Linkin` (Δ2) | `0.850` (`< 1.0`, `> 0.45`) |
| `art-11` | `Dua Lipa` / `Dua Lipa, DaBaby` | `0.650` (extra-name) |
| `art-12` | `Tyler, …, Lil Wayne` / `Tyler` (Δ76) | `0.600` |
| `art-13` | `周杰伦` / `周杰倫` | `0.500` |
| `art-14` | `Marshmello` / `Parkway Drive` | `0.000` → R5 |
| `art-15` | `The Weeknd` / `Teddy Swims` | `0.000` → R5 |
| `art-16` | `cassö, RAYE, D-Block Europe` / `Cassö, RAYE, D-Block Europe` | `1.000` |

### 6.3 End-to-end selection (fixtures = the probe's candidate arrays verbatim)

| id | query | expected |
|---|---|---|
| `e2e-die-original` | `Die For You` / `The Weeknd` / 260 | **winner idx 3** (260s). idx 0 (233s remix, LRCLIB rank 0) must score `< 0.70` |
| `e2e-die-remix` | `Die For You (Remix)` / `The Weeknd, Ariana Grande` / 233 | **winner idx 3**; all four 4 s stubs score `< 0.10` |
| `e2e-hotel-remaster` | `Hotel California (2013 Remaster)` / `Eagles` / 391 | **winner idx 1**; idx 0 (206s, exact title+album) `< 0.60`; a bare `Hotel California` @391 candidate must **not** be penalized for the missing SOFT qual |
| `e2e-hotel-live` | `Hotel California (Live on MTV, 1994)` / `Eagles` / 432 | **winner idx 1**; idx 5 (391s, studio length) demoted |
| `e2e-metallica` | `Nothing Else Matters` / `Metallica` / 388 | **winner idx 0**; the 3 s `S&M` stub rejected; live @379 `< 0.90` |
| `e2e-everlong` | `Everlong (Acoustic)` / `Foo Fighters` / 281 | **winner idx 9** (281.12); the six 251 s rows `< 0.65` |
| `e2e-sweater-sped` | `Sweater Weather (Sped Up)` / 219 | **winner idx 4**; idx 1 (240.43) `< 0.75`; idx 9 (432Hz) **rejected R4** |
| `e2e-levitating-solo` | `Levitating` / `Dua Lipa` / 204 | **winner idx 0**; any `Dua Lipa, DaBaby` candidate demoted by extra-name |
| `e2e-levitating-remix` | `Levitating` / `Dua Lipa, DaBaby` / 203 | **winner idx 5**; tiebreak = shared-token count |
| `e2e-aidoru` | `アイドル` / `YOASOBI` / 213 | **winner idx 6** (213s); the 3/50/80/122 s rows **rejected R7** (shared body lastTS 211.6) |
| `e2e-idol-english` | `Idol` / `YOASOBI` / 213 | **no automatic winner** - documents that this query must never be issued as a fallback for アイドル |
| `e2e-joeun-nal` | `좋은 날` / `아이유` / 234, candidates = the **title-only** set | **all rejected (R2)**; specifically 멜로망스 @330 must not win |
| `e2e-bampyeonji-1` | `밤편지` / `아이유` / 253, single candidate | **accepted** - the flagship false negative today |
| `e2e-bampyeonji-2` | `밤편지` / `IU` / 253 | **winner idx 7**; idx 4/8 **rejected R1** (empty bodies) |
| `e2e-daoxiang` | `Dao Xiang` / `Jay Chou` / 222 | **winner idx 0** (223); `Dao Xiang (Live)` @222.0 loses on `qualifierFactor 0.55` |
| `e2e-zvezda` | `Звезда` / `Кино` / 271 | **winner idx 0**; the 1081 s row rejected R8 |
| `e2e-zvezda-solntse` | `Звезда по имени Солнце` / `Кино` / 226 | **winner idx 2**; the 2515 s row rejected R8 |
| `e2e-gruppa-latin` | `Gruppa krovi` / `Kino` / 286 | **winner idx 2** (286.04); cross-script branch, idx 5 accepted via variant |
| `e2e-earfquake` | `EARFQUAKE` / `Tyler, The Creator` / 190 | **no match** - best score `< 0.55`. Must not emit the 225 s argmax |
| `e2e-earfquake-frag` | `EARFQUAKE` / `The Creator` / 190 | **winner idx 0** (190.0) |
| `e2e-september` | `September` / `Earth, Wind & Fire` / 215 | **winner idx 1**; idx 0 (self-concatenated) must not win |
| `e2e-sticky-tyler` | `Sticky` / `Tyler, The Creator, GloRilla, Sexyy Red, Lil Wayne` / 256 | **winner idx 12**; the null-duration idx 5 must not crash or rank first |
| `e2e-sticky-drake` | `Sticky` / `Drake` / 240 | **winner idx 4** (240) - must not reach Tyler's 256 s song |
| `e2e-richflex` | `Rich Flex` / `Drake, 21 Savage` / 239 | **winner idx 0**; null-duration idx 3 handled |
| `e2e-wildthoughts` | `Wild Thoughts` / `DJ Khaled, Rihanna, Bryson Tiller` / 204 | **winner idx 5** (202); idx 6 (exact both fields, 283s) `< 0.60` |
| `e2e-tremor` | `Tremor` / `Dimitri Vegas & Like Mike, Martin Garrix` / 294 | **winner idx 4**, `kind: "plain"` - 20/20 unsynced, must not return empty |
| `e2e-leanon` | `Lean On` / `Major Lazer, DJ Snake` / 176 | **winner idx 1**; idx 0 (rank 0, exact artist, 204 s Fuvi Clan cover) `< 0.70` |
| `e2e-onekiss` | `One Kiss` / `Calvin Harris, Dua Lipa` / 214 | **winner idx 1**; idx 0 (`One Kiss;One Kiss`, Δ0) must **not** win - self-join collapse then duration |
| `e2e-prada` | `Prada` / `cassö, RAYE, D-Block Europe` / 132 | idx 0 (exact artist, Δ0, `[Alok Remix]` album) must not be the confident pick - **document the limit**: the scorer demotes it only via the album HARD-qualifier term |
| `e2e-marshmello` | `Alone` / `Marshmello` / 274 | **winner idx 4** (274); the 4 s and 499 s rows rejected |
| `e2e-alone-bare` | `Alone` / *no artist* / 274 | **rejected R9** - Parkway Drive @271 must never win |
| `e2e-stay-bare` | `Stay` / *no artist* / 240 | **rejected R3** (single token) |
| `e2e-on-bare` / `e2e-go-bare` | `On` / `Go`, no artist | **rejected R3** |
| `e2e-blinding-bare` | `Blinding Lights` / *no artist* / 200 | **rejected R9** (4 distinct artists) - the control that kills "a distinctive title makes the artist optional" |
| `e2e-hurt-cash` | `Hurt` / `Johnny Cash` / 216 | **winner idx 1** (`Hurt\u001fHurt`, 216.533) - rejected by any length-sensitive floor without collapse |
| `e2e-hurt-nin` | `Hurt` / `Nine Inch Nails` / 373 | **winner idx 0**; the 441-515 s live rows `< 0.60` |
| `e2e-hurt-bare` | `Hurt` / *no artist* / 216 | **rejected R9** (8 distinct artists) |
| `e2e-numb` | `Numb` / `Linkin Park` / 187 | **winner idx 0** (`Numb (Numb)`); the null-duration idx 6 and 5 s idx 9 handled |
| `e2e-numb-truncated` | `Numb` / `Linkin` / 187 | **winner idx 1** (`Linkin Park` @187) - idx 0 (`Linkin`, rank 0, 184.96) demoted to 0.850 |
| `e2e-numb-nonexistent` | `Numb` / `Qqxzzw Nonexistent Band` | empty candidates → `null`, **no broaden** |
| `e2e-pmj-creep` | `Creep` / `Postmodern Jukebox` / 247 | **winner idx 0**, `kind: "plain"` - must not return empty |
| `e2e-creep-bare` | `Creep` / *no artist* / 238 | **rejected R9** |
| `e2e-fastcar` | `Fast Car` / `Luke Combs` / 265 | **winner idx 0**; the 165 s and 247 s rows (same album) demoted |
| `e2e-laroi` | `Stay` / `The Kid LAROI, Justin Bieber` / 141 | **all ten accepted**, winner idx 0 - positive control, no artist encoding may be rejected |
| `e2e-getlucky-radio` | `Get Lucky` / `Daft Punk` / 248, bodies lastTS 315.71 | **every synced candidate rejected R7**; result is plain, `kind: "plain"` |
| `e2e-getlucky-album` | `Get Lucky` / `Daft Punk` / 369 | **winner idx 0** (370) |
| `e2e-levels` | `Levels` / `Avicii` / 200, lastTS 113.48 | **winner idx 5** - must **not** be rejected for low lyric coverage (0.567) |
| `e2e-sandstorm` | `Sandstorm` / `Darude` / 226, `instrumental: true` | outcome `"instrumental"`, **not** "not found" |
| `e2e-thriller` | `Thriller` / `Michael Jackson` / 822, candidate 358 lastTS 344.5 | **winner idx 1** - must survive despite ratio 0.436 (R8 is upper-side only) |
| `e2e-faded-nightcore` | `Faded` / `Alan Walker` / 170, all bodies lastTS 194.22 | **all synced rejected R7**; must not pick idx 6 (142 s) |
| `e2e-insomnia` | `Insomnia` / `Faithless` / 214 | **winner idx 3** (214); the 514/522/526 s rows rejected R8 |
| `e2e-badguy` | `bad guy` / `Billie Eilish` / 194 | **winner** a 194 s row; the 3 s row rejected |
| `e2e-shapeofyou` | `Shape of You` / `Ed Sheeran` / 234 | **winner idx 2**; the 30 s preview-tag row (full body) **not** rejected outright, just outranked |
| `e2e-null-duration` | any fixture with `duration: null` | no `NaN`, deterministic order, `durationScore === 0.30` |
| `e2e-no-target-duration` | `Alone` / `Marshmello` / `undefined` | must **not** return the 4 s row; `durationScore` uniform 0.50 |

### 6.4 Tempo-drift unit (guards §5)

| id | assert |
|---|---|
| `tempo-01` | `durationRatio(219,240.43) = 0.91250` vs `lyricScale = 0.92983` → error `−1.86 %`, predicted last line **3.82 s early**. The test asserts the scorer does **not** rescale |

---

## 7. WIRING

### `src/lib/lyrics/match.ts` - rewrite, keep the module

Delete `hitMatches` entirely (both callers change). Keep `normalizeForMatch` **only** as a deprecated re-export for `lrclib.ts:sameRecording`, or better, delete it too (see below).

New exports:

```ts
export function normalizeForScore(s: string): string
export function foldSpecialLatin(s: string): string        // the ø/ł/đ/ß/ı table
export function dice(a: string, b: string): number         // char-bigram multiset
export function collapseSelfJoin(s: string): string        // U+001F and ';' only
export function parseTitle(raw: string, artistHint?: string): ParsedTitle
export function titleIdentity(q: ParsedTitle, c: ParsedTitle): number
export function artistTokens(s: string): Set<string>
export function artistScore(req: string, hit: string, durDelta?: number): number
export function qualifierFactor(q: ParsedTitle, c: ParsedTitle): number
export function durationScore(delta: number | null): number
export function lastTimestamp(lrc: string): number | null  // reuse parseLRC
```

`tokenOverlap` **stays**, but its docstring must change: it is correct for artists (the `min()` denominator expresses "credit subset") and forbidden for titles. Re-export it from the artist path only.

### `src/lib/lyrics/score.ts` - new file

Holds `scoreCandidate`, the reject enum, the HARD/SOFT qualifier vocabularies, and `selectBest(candidates, query)` implementing §3.3 (body-hash grouping, modal duration, tiebreaks, the 0.55 confidence floor). Provider-agnostic - it takes a normalized `Candidate`, so `musixmatch.ts` and `genius.ts` can feed it too.

### `src/lib/lyrics/match.test.ts` - two assertions must be **inverted**

**(1) `match.test.ts:11` - `expect(normalizeForMatch("Track [Live]")).toBe("track")`**

This pins the parenthetical strip, which three of the five probe categories independently name as the most damaging rule in the file. It is the reason `Through the Night (밤편지)` → `through the night` and the only LRCLIB hit for that track is rejected today; it is also why `Dao Xiang (Live)` beats the studio cut.

Invert to: `parseTitle("Track [Live]")` yields `{ base: "track", qualifiers: [{ text: "Live", cls: "hard" }] }` - the qualifier **survives** as structured data.

Note the sibling assertion on line 10, `normalizeForMatch("Song (Remastered) feat. Someone") === "song"`, is *not* inverted in outcome - `(Remastered)` is SOFT and correctly ignored for identity - but it must be re-expressed against `parseTitle`, since the qualifier now has to be *classified* rather than deleted. Keeping it as-is would let a future refactor re-delete HARD qualifiers unnoticed.

**(2) `match.test.ts:51-55` - `"tolerates featurings / parentheticals via normalization"`, asserting `hitMatches("blinding lights", "the weeknd", "blinding lights remix", "the weeknd x") === true`**

This asserts that a **remix is an acceptable match for an unqualified request**. Directly refuted by `Die For You` (original 260s, remix 233s, 27s apart) and by `Dao Xiang (Live)` @222.0 beating the studio @222.697 in the probe's own simulation.

Invert to: `qualifierFactor` for that pair is **0.55**, and in a candidate set containing both `Blinding Lights` and `Blinding Lights (Remix)` at comparable durations, the unqualified row wins. The featuring half of the assertion stays true - `feat.` handling is unchanged and correct.

**Additionally re-scoped, not inverted:** `match.test.ts:22` - `tokenOverlap("a", "a b c") === 1` "is measured over the smaller set". The behaviour is correct and must stay; the test needs a comment that this is the **artist** semantic, plus a new companion asserting that the *title* path does not use it (`titleIdentity("stay", "stay stay stay") ≈ 0.375`).

### `src/lib/lyrics/lrclib.ts` - the largest change

- **`lrclibSearch` (lines 193-217): replace the whole selector.** Delete `results.filter(r => r.syncedLyrics)` (line 209) - that pre-filter empties Tremor and Postmodern Jukebox and concentrates bare-`Alone` onto strangers. Delete the `reduce` closest-duration pick (212-216) - `(best.duration ?? 0)` coerces null to 0 and returns the 4-second stub. Return `selectBest(results, query)`.
- **`lrclibSearch` must return the full record array**, not one record, so the scorer sees the whole set (grouping and R9 both need it).
- **`pickRecord` (163-171):** `/get` no longer wins by default. Score both and take the higher; `/get`'s ±2s window is not evidence of correct timing - the probe's live `duration=248` call returned a 200 whose lyrics run 68s past the end.
- **`sameRecording` (139-148)** uses `normalizeForMatch` and therefore treats a remix as the same recording. Rewrite against `titleIdentity ≥ 0.85 && qualifierFactor === 1 && artistScore ≥ 0.45`.
- **`mapRecord` (219-233):** add the `instrumental` outcome as a distinct `Lyrics` kind rather than the `"🎵 Instrumental"` plain string, so the UI can say "this track is instrumental" instead of it looking like lyrics.
- **New:** when the winning group's synced bodies all fail R7, return `plainLyrics` and suppress the LRC.
- **Do not add an artist-less retry.** If one ever is added, it must set `artistWasDropped: true` and R2 must reject everything.

### `src/lib/lyrics/musixmatch.ts` - add verification

`findTrackId` (241-275) takes the first `has_subtitles === 1` hit with **zero** checking. Score all 5 hits with `titleIdentity` + `artistScore` and require the same R4/R5 thresholds. Musixmatch does not return duration in `track.search`, so the duration term is unavailable here - set `durationScore = 0.50` uniformly and raise the confidence floor for this provider (I'd suggest 0.70, a judgement call, since it has one fewer signal). Also drop the `has_subtitles`-first preference in favour of scoring, for the same reason the LRCLIB synced pre-filter goes.

### `src/lib/lyrics/genius.ts` - swap the gate

`findSongUrl` (100-108) calls `hitMatches` and takes the first passing hit. Replace with: score every usable hit, take the argmax above the floor. Genius has no duration and no synced lyrics, so it is title+artist only - the artist gate carries everything, and R3/R9 apply with full force when `p.artist` is undefined.

### `src/lib/lyrics/sources.ts` - two changes

- **Bump `LOOKUP_VERSION` from `"v2"` to `"v3"` (line 41).** Lyrics persist to IndexedDB for 24 h; without the bump every user keeps a day of answers picked by the old selector.
- The `best` selection loop (159-173) currently prefers `kind: "timed"` from **any** source over `kind: "plain"` from a better one. With R7 in play, a provider that honestly downgraded to plain because the timings do not fit will now lose to a provider that shipped a mistimed LRC. Change to: prefer timed *within* a source's own answer, but keep `SOURCE_ORDER` as the outer loop. Musixmatch and Genius have no duration and therefore cannot run R7 at all, which is a second reason not to let their synced output jump the queue.

### `src/lib/track-meta.ts` - small additions

`cleanTrackTitle` (85-102) is already correct in leaving version qualifiers alone (the header comment says so explicitly and the data agrees). Two additions, both required by §1.5(b) and both currently missing:

- strip `_<6+ digits>` (`Alone (Original Mix)_264023874 - marshmello`)
- strip a leading `<artist> - ` / trailing ` - <artist>` given the artist, and collapse `X - Y - X` → `X` (`Levels - Avicii - Levels`)

These need the artist, which `cleanTrackTitle` does not currently take - add an optional second parameter rather than a new function, so both the lyrics path and the Last.fm path get it.

Also: **`cleanTrackTitle` must be run over the candidate title too**, not just the YTM title. `Marshmello - Alone (Official Music Video)` is a correct LRCLIB row scoring 0.22 raw and 1.000 after cleaning.

### Files that do **not** change

`parse-lrc.ts` - correct as written; `lastTimestamp` can be implemented as `parseLRC(lrc).at(-1)?.start`, reusing the existing offset handling. `http.ts`, `ytmusic.ts` (matched by videoId, structurally immune to this whole bug class), `types.ts` (unless the instrumental outcome gets its own kind, which I recommend).

---

## Summary of the judgement calls

Flagged plainly, because they are the places this design could be wrong:

| decision | status |
|---|---|
| Identity floor **0.85** | measured empty band 0.750→1.000; 0.85 is a choice inside it |
| Artist gate **0.45** | measured band 0.000/0.500/1.000; sits in a real gap |
| Duration curve **/12** | fits the measured Δ distributions; the exact constant is taste |
| Duration influence capped at **0.45** of the product | chosen to satisfy `Sticky`+Drake-vs-Tyler; not independently measured |
| `qualifierFactor` **0.75 / 0.55 / 0.35** | ordinal relationships are forced by the data; the magnitudes are taste |
| `bodyFactor` **0.92** | chosen to satisfy one inequality (plain-correct beats synced-12s-off) |
| Confidence floor **0.55** | forced to exist by EARFQUAKE; the value is a guess |
| **R9** (refuse when artist-less candidates disagree on artist) | stricter than the probe proves; I chose refusal over the 1-second Blinding Lights margin |
| `Original Mix` as SOFT | arguable; Marshmello is a counterexample, duration covers it |
| Musixmatch floor **0.70** | it has one fewer signal; unmeasured |

And the two places I contradict the source data outright: **the probe's Korean Dice values are too low** (real stranger ceiling 0.750, not 0.571 - a 0.6 floor would admit three different songs), and **unguarded variant-max Dice, which the probe recommends, scores the stranger `Hurt Niggas (Hurt)` at 1.000 and erases `(Remix)`** - it needs the cross-script gate in §1.5(f).