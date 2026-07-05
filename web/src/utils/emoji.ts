/**
 * Emoji :shortcode: dictionary + helpers for the composer autocomplete.
 *
 * The lookup is DERIVED from the full picker dataset (utils/emojiData.ts):
 * every emoji name becomes a :snake_case: shortcode (e.g. "rolled-up
 * newspaper" → :rolled_up_newspaper:, ~1,700 codes). The ~80 legacy
 * shortcodes that predate the full dataset are layered on top as aliases so
 * existing muscle memory (:thumbsup:, :+1:, :tada:, :check:, …) keeps
 * working unchanged.
 *
 * Export contract (consumed by MessageInput):
 *   EMOJI: Record<string, string>          shortcode → emoji char
 *   emojiSuggestions(prefix, limit)        prefix matches for the : menu
 *   replaceEmojiShortcodes(text)           :code: → char on send
 *   ensureEmojiIndex()                     warm the derived codes (async)
 *
 * The dataset is ~167KB, so it must NOT be imported statically here — this
 * module sits in the main bundle via MessageInput, and a static import drags
 * the whole dataset into first paint. Instead EMOJI starts as the legacy
 * aliases and the derived codes are merged in place once the emojiData chunk
 * (shared with EmojiPicker's lazy load) arrives via ensureEmojiIndex().
 */

/**
 * Legacy hand-picked shortcodes, kept verbatim as aliases. These OVERRIDE any
 * derived code with the same name (e.g. :smile: stays 😄, not a derived
 * match), so nothing that worked before resolves differently now.
 */
const LEGACY_SHORTCODES: Record<string, string> = {
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  joy: "😂",
  rofl: "🤣",
  laughing: "😆",
  wink: "😉",
  blush: "😊",
  yum: "😋",
  sunglasses: "😎",
  heart_eyes: "😍",
  kissing_heart: "😘",
  thinking: "🤔",
  thinking_face: "🤔",
  neutral_face: "😐",
  expressionless: "😑",
  no_mouth: "😶",
  smirk: "😏",
  unamused: "😒",
  rolling_eyes: "🙄",
  grimacing: "😬",
  lying_face: "🤥",
  relieved: "😌",
  pensive: "😔",
  sleepy: "😪",
  drooling_face: "🤤",
  sleeping: "😴",
  mask: "😷",
  hot: "🥵",
  cold: "🥶",
  worried: "😟",
  frowning: "😦",
  anguished: "😧",
  cry: "😢",
  sob: "😭",
  scream: "😱",
  rage: "😡",
  angry: "😠",
  swearing: "🤬",
  exploding_head: "🤯",
  cowboy: "🤠",
  partying: "🥳",
  partying_face: "🥳",
  shushing: "🤫",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  ok_hand: "👌",
  pinched: "🤌",
  pinching: "🤏",
  "v": "✌️",
  crossed_fingers: "🤞",
  love_you: "🤟",
  metal: "🤘",
  call_me: "🤙",
  point_left: "👈",
  point_right: "👉",
  point_up: "☝️",
  point_down: "👇",
  raised_hand: "✋",
  wave: "👋",
  clap: "👏",
  pray: "🙏",
  muscle: "💪",
  brain: "🧠",
  eyes: "👀",
  eye: "👁️",
  ear: "👂",
  nose: "👃",
  heart: "❤️",
  orange_heart: "🧡",
  yellow_heart: "💛",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  black_heart: "🖤",
  white_heart: "🤍",
  broken_heart: "💔",
  sparkling_heart: "💖",
  sparkles: "✨",
  star: "⭐",
  star2: "🌟",
  fire: "🔥",
  boom: "💥",
  zap: "⚡",
  rocket: "🚀",
  tada: "🎉",
  confetti_ball: "🎊",
  balloon: "🎈",
  trophy: "🏆",
  medal: "🏅",
  warning: "⚠️",
  bangbang: "‼️",
  question: "❓",
  exclamation: "❗",
  white_check_mark: "✅",
  check: "✅",
  done: "✅",
  x: "❌",
  no_entry: "⛔",
  prohibited: "🚫",
  recycle: "♻️",
  100: "💯",
  ship: "🚢",
  rocket_ship: "🚀",
  bug: "🐛",
  computer: "💻",
  keyboard: "⌨️",
  mouse_three_button: "🖱️",
  printer: "🖨️",
  iphone: "📱",
  phone: "📞",
  email: "📧",
  envelope: "✉️",
  package: "📦",
  pencil: "✏️",
  memo: "📝",
  page_facing_up: "📄",
  notebook: "📓",
  bookmark: "🔖",
  link: "🔗",
  paperclip: "📎",
  pushpin: "📌",
  round_pushpin: "📍",
  triangular_flag: "🚩",
  hourglass: "⏳",
  alarm_clock: "⏰",
  watch: "⌚",
  bell: "🔔",
  no_bell: "🔕",
  loudspeaker: "📢",
  mute: "🔇",
  speaker: "🔈",
  headphones: "🎧",
  microphone: "🎤",
  movie_camera: "🎥",
  camera: "📷",
  video_camera: "📹",
  film: "🎬",
  art: "🎨",
  game: "🎮",
  pizza: "🍕",
  hamburger: "🍔",
  fries: "🍟",
  taco: "🌮",
  burrito: "🌯",
  sushi: "🍣",
  ramen: "🍜",
  rice: "🍚",
  cookie: "🍪",
  cake: "🍰",
  birthday: "🎂",
  doughnut: "🍩",
  coffee: "☕",
  tea: "🍵",
  beer: "🍺",
  beers: "🍻",
  wine: "🍷",
  champagne: "🍾",
  cheers: "🥂",
  cocktail: "🍸",
  tropical_drink: "🍹",
  shrug: "🤷",
  facepalm: "🤦",
};

/**
 * "rolled-up newspaper" → "rolled_up_newspaper". Output stays within the
 * shortcode charset/length that replaceEmojiShortcodes recognizes
 * ([a-z0-9_+-]{2,32}).
 */
function toShortcode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
}

/** Full shortcode → emoji lookup. Starts as the legacy aliases; the ~1,700
 * derived codes are merged IN PLACE (same object) by ensureEmojiIndex(), so
 * holding a reference to this const always sees the full set once loaded. */
export const EMOJI: Record<string, string> = { ...LEGACY_SHORTCODES };

let indexPromise: Promise<void> | null = null;

/** Load the picker dataset (the same async chunk EmojiPicker lazy-loads) and
 * merge the derived shortcodes into EMOJI. Deduped across calls; never
 * rejects (a failed import logs, clears the promise, and a later call
 * retries). Legacy aliases always win; derived collisions are first-wins
 * (dataset is CLDR-ordered, so the more common emoji comes first). */
export function ensureEmojiIndex(): Promise<void> {
  if (indexPromise === null) {
    indexPromise = import("./emojiData").then(
      (m) => {
        for (const entry of m.EMOJI) {
          const code = toShortcode(entry.name);
          if (code.length >= 2 && !(code in EMOJI)) {
            EMOJI[code] = entry.char;
          }
        }
      },
      (err: unknown) => {
        indexPromise = null;
        console.error("emoji shortcode index failed to load", err);
      },
    );
  }
  return indexPromise;
}

/** Returns matching shortcodes that start with `prefix` (case-insensitive).
 * Shortest names first so common codes surface before long descriptive ones. */
export function emojiSuggestions(prefix: string, limit = 8): { name: string; emoji: string }[] {
  // Self-warming: composers call ensureEmojiIndex() on mount, but if a caller
  // didn't, the first keystroke kicks the load and the next one sees it.
  void ensureEmojiIndex();
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  const out: { name: string; emoji: string }[] = [];
  for (const [name, emoji] of Object.entries(EMOJI)) {
    if (name.startsWith(p)) {
      out.push({ name, emoji });
    }
  }
  out.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** Replace `:shortcode:` occurrences in a string with their emoji. */
export function replaceEmojiShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]{2,32}):/g, (m, name: string) => {
    return EMOJI[name.toLowerCase()] ?? m;
  });
}
