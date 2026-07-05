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
 */

import { EMOJI as EMOJI_DATA } from "./emojiData";

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

function buildLookup(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const entry of EMOJI_DATA) {
    const code = toShortcode(entry.name);
    // First-wins on the rare name collision (dataset is in CLDR order, so
    // the more common emoji comes first).
    if (code.length >= 2 && !(code in table)) {
      table[code] = entry.char;
    }
  }
  // Legacy aliases override derived codes of the same name.
  for (const [code, char] of Object.entries(LEGACY_SHORTCODES)) {
    table[code] = char;
  }
  return table;
}

/** Full shortcode → emoji lookup (~1,700 derived codes + legacy aliases). */
export const EMOJI: Record<string, string> = buildLookup();

/** Returns matching shortcodes that start with `prefix` (case-insensitive).
 * Shortest names first so common codes surface before long descriptive ones. */
export function emojiSuggestions(prefix: string, limit = 8): { name: string; emoji: string }[] {
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
