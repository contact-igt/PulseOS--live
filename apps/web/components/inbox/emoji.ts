export interface EmojiGroup {
  key: string;
  /** Spoken name of the tab. */
  label: string;
  /** The emoji shown on the tab. */
  icon: string;
  emojis: string[];
}

/** A compact, curated set: what staff actually use with patients (greetings, reassurance, health, time, places). */
export const EMOJI_GROUPS: EmojiGroup[] = [
  { key: "smileys", label: "Smileys", icon: "😀", emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😋", "😛", "😜", "🤗", "🤔", "🤝", "😐", "😶", "🙄", "😏", "😌", "😔", "😴", "🤒", "🤕", "😷", "🥺", "😢", "😭", "😮", "😲", "😎"] },
  { key: "gestures", label: "Gestures and people", icon: "👍", emojis: ["👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "👏", "🙌", "🤲", "🙏", "👋", "🤚", "✋", "👈", "👉", "👆", "👇", "💪", "🤙", "☝️", "🫶", "🫡", "🧑‍⚕️", "👨‍⚕️", "👩‍⚕️", "🧑‍💼", "👨‍👩‍👧", "👶", "👵"] },
  { key: "health", label: "Health", icon: "🏥", emojis: ["🏥", "🩺", "💊", "💉", "🩹", "🩻", "🧪", "🔬", "🌡️", "🚑", "👁️", "👓", "🕶️", "🦷", "🧠", "🫀", "🫁", "🦴", "🩸", "🧴", "🧼", "😷", "⚕️", "♿", "🍎", "🥗", "💧", "🧘", "🛌", "🏃"] },
  { key: "hearts", label: "Hearts and symbols", icon: "❤️", emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💕", "💞", "💓", "💗", "💖", "✨", "⭐", "🌟", "💯", "✅", "☑️", "✔️", "❌", "⚠️", "❗", "❓", "ℹ️", "➕", "➡️", "⬅️", "🔔", "📌"] },
  { key: "time", label: "Time, places and travel", icon: "🕒", emojis: ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "⏰", "⏳", "📅", "🗓️", "📍", "🗺️", "🏢", "🏠", "🚗", "🚕", "🚌", "🚆", "✈️", "🅿️", "☀️", "🌙", "🌧️", "⛅", "🌈", "❄️"] },
  { key: "things", label: "Objects", icon: "📞", emojis: ["📞", "📱", "☎️", "💬", "📝", "📋", "📎", "📄", "📁", "📷", "🎤", "🎧", "💻", "🔑", "🔒", "🔓", "💳", "💰", "🧾", "📦", "🎁", "🎉", "🎊", "🕯️", "🔍", "💡", "🔔", "📢", "📩", "✉️"] },
  { key: "nature", label: "Nature and food", icon: "🌿", emojis: ["🌿", "🌱", "🌸", "🌼", "🌻", "🌹", "🍀", "🌳", "🍃", "🐶", "🐱", "🐦", "🦋", "🐝", "🍎", "🍌", "🍊", "🍇", "🍉", "🥭", "🥕", "🍚", "🍞", "☕", "🍵", "🥛", "🍽️", "🥤", "🍪", "🎂"] },
];

/** Put `insert` where the caret (or selection) is. Positions are clamped, a reversed selection is read the right way round. */
export function insertAtCursor(value: string, selStart: number, selEnd: number, insert: string): { value: string; caret: number } {
  const clamp = (n: number) => Math.max(0, Math.min(value.length, n));
  const a = clamp(Math.min(selStart, selEnd));
  const b = clamp(Math.max(selStart, selEnd));
  return { value: value.slice(0, a) + insert + value.slice(b), caret: a + insert.length };
}

/** Recently used emojis: newest first, no repeats, at most `max`. */
export function pushRecent(recent: readonly string[], emoji: string, max = 16): string[] {
  return [emoji, ...recent.filter((e) => e !== emoji)].slice(0, max);
}
