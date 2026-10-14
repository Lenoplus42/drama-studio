// Script model, presets, validation and the paste-a-script parser.

// The server currently accepts speaker 0 or 1 (server/app.py, Line.speaker).
// Raise this together with the server's Literal if Drama3 handles more voices.
// NEXT_PUBLIC_DRAMA_MAX_VOICES=3 once the server accepts speaker 2.
export const MAX_CAST = Math.min(4, Math.max(2, Number(process.env.NEXT_PUBLIC_DRAMA_MAX_VOICES) || 2));
export const MAX_LINES = 12;
export const MAX_CHARS = 300;

export const EMOTIONS = [
  { id: "neutral", label: "Neutral", direction: "" },
  { id: "anxious", label: "Anxious", direction: "anxious" },
  { id: "laughs", label: "Laughs", direction: "laughing" },
  { id: "whispers", label: "Whispers", direction: "whispering" },
  { id: "sighs", label: "Sighs", direction: "sighing" },
];

export const CAST_COLORS = ["var(--role-0)", "var(--role-1)", "var(--role-2)", "var(--role-3)"];

let counter = 0;
export const newId = () => `l${Date.now().toString(36)}${(counter++).toString(36)}`;

const line = (role, text, emotion = "neutral") => ({ id: newId(), role, text, emotion });

export const PRESETS = [
  {
    id: "short-secret",
    title: "The Secret",
    note: "2 lines, short demo",
    cast: ["Alice", "Bob"],
    lines: () => [
      line(0, "Did you tell him our secret?"),
      line(1, "He knew before we even met."),
    ],
  },
  {
    id: "short-heist",
    title: "The Heist",
    note: "2 lines, short demo",
    cast: ["Alex", "Sam"],
    lines: () => [
      line(0, "Please tell me you got it."),
      line(1, "Yes, but we should leave now."),
    ],
  },
  {
    id: "box-box",
    title: "Box this lap",
    note: "team radio",
    cast: ["Engineer", "Driver"],
    lines: () => [
      line(0, "Box this lap, box this lap. We're switching to softs."),
      line(1, "Softs? The rear tyres are already on fire."),
      line(0, "Trust the strategy. Gap to the car behind is two point one."),
      line(1, "You said that last race, and we finished in the gravel."),
      line(0, "Then don't brake in the gravel this time."),
      line(1, "Copy. Pushing now."),
    ],
  },
];

export function sceneFromPreset(preset) {
  return {
    presetId: preset.id,
    title: preset.title,
    cast: preset.cast.map((name) => ({ name })),
    lines: preset.lines(),
  };
}

/** Problems that stop a scene from being sent, as user-facing sentences. */
export function validate(scene) {
  const problems = [];
  if (!scene.lines.length) problems.push("Add at least one line.");
  if (scene.lines.length > MAX_LINES) problems.push(`Keep the scene to ${MAX_LINES} lines or fewer.`);
  if (scene.cast.length > MAX_CAST) {
    problems.push(`This scene has ${scene.cast.length} voices, but the voice server takes ${MAX_CAST}. Enable speaker ${MAX_CAST} on the server and set NEXT_PUBLIC_DRAMA_MAX_VOICES=${scene.cast.length}.`);
  }
  scene.lines.forEach((item, index) => {
    const text = item.text.trim();
    if (!text) problems.push(`Line ${index + 1} is empty.`);
    else if (text.length > MAX_CHARS) problems.push(`Line ${index + 1} is over ${MAX_CHARS} characters.`);
    if (text.includes("<|")) problems.push(`Line ${index + 1} contains "<|"; pick the speaker with the name button instead.`);
  });
  return problems;
}

/** Shape the request body exactly as server/app.py's Scene/Line expect. */
export function toRequestLines(scene) {
  return scene.lines.map((item) => ({
    speaker: item.role,
    text: item.text.trim(),
    emotion: item.emotion,
  }));
}

const EMOTION_WORDS = {
  anxious: ["anxious", "焦急"],
  laughs: ["laughs", "laughing", "laugh", "tight laugh", "chuckles", "笑", "大笑", "笑着"],
  whispers: ["whispers", "whispering", "whisper", "低语", "小声", "耳语"],
  sighs: ["sighs", "sighing", "sigh", "long pause", "叹气", "叹息"],
};

function emotionFrom(word) {
  const clean = word.trim().toLowerCase();
  for (const [id, words] of Object.entries(EMOTION_WORDS)) if (words.includes(clean)) return id;
  return null;
}

/**
 * Parse "Name: line" text. Accepts ： or :, and a stage direction like
 * (laughs) （笑） [whispers] right after the colon.
 * Returns { cast, lines, warnings } or throws with a user-facing message.
 */
export function parseScript(raw) {
  const names = [];
  const lines = [];
  const warnings = [];
  let skipped = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    const match = text.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
    if (!match) { skipped++; continue; }
    const name = match[1].replace(/^[*_#\s]+|[*_\s]+$/g, "");
    let body = match[2].replace(/^[*_]+\s*/, "").trim();
    let emotion = "neutral";
    const direction = body.match(/^[(（\[【]([^)）\]】]{1,12})[)）\]】]\s*/);
    if (direction) {
      const found = emotionFrom(direction[1]);
      if (found) emotion = found;
      body = body.slice(direction[0].length).trim();
    }
    body = body.replace(/\s*[(（](beat|pause|long pause)[)）]\s*/gi, " ").trim();
    if (!body) continue;
    let role = names.indexOf(name);
    if (role < 0) {
      if (names.length >= MAX_CAST) {
        if (!warnings.some((w) => w.startsWith("Only"))) warnings.push(`Only ${MAX_CAST} voices are available, so lines from ${name} and later new characters were skipped.`);
        continue;
      }
      names.push(name);
      role = names.length - 1;
    }
    lines.push({ id: newId(), role, text: body.slice(0, MAX_CHARS), emotion });
  }
  if (!lines.length) throw new Error("No lines found. Write one line per row as  Name: what they say");
  if (lines.length > MAX_LINES) {
    warnings.push(`Kept the first ${MAX_LINES} lines; the server accepts up to ${MAX_LINES} per take.`);
    lines.length = MAX_LINES;
  }
  if (skipped) warnings.push(`Skipped ${skipped} row${skipped > 1 ? "s" : ""} without a "Name:" prefix.`);
  while (names.length < Math.min(2, MAX_CAST)) names.push(names.length ? "Second voice" : "First voice");
  return { cast: names.map((name) => ({ name })), lines, warnings };
}

/** Render the scene back to paste format (used to prefill the paste box). */
export function toPlainScript(scene) {
  return scene.lines
    .map((item) => {
      const emotion = EMOTIONS.find((e) => e.id === item.emotion);
      const direction = emotion && emotion.id !== "neutral" ? `(${emotion.id}) ` : "";
      return `${scene.cast[item.role]?.name ?? "?"}: ${direction}${item.text}`;
    })
    .join("\n");
}

/** Parse the AI writer's output: an optional "Title:" row, then "Name: line" rows. */
export function parseWrittenScene(text) {
  const rows = text.replace(/```[a-z]*\n?|```/g, "").split(/\r?\n/);
  let title = "";
  const rest = [];
  for (const row of rows) {
    const match = row.trim().match(/^\**(title|标题)\**\s*[:：]\s*(.+)$/i);
    if (match && !title) title = match[2].replace(/\*+/g, "").trim();
    else rest.push(row);
  }
  return { title, ...parseScript(rest.join("\n")) };
}

/** Shrink a picture to fit `max` px on its long side and return a JPEG data URL. */
export async function imageToDataUrl(file, max = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That file isn't a picture this browser can read."));
      img.src = url;
    });
    const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
