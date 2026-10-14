// Writes a short two-voice scene from an idea and/or an image, through Vercel AI Gateway.
// Returns plain "Name: (direction) line" text that the client feeds to parseScript().

const GATEWAY_URL = process.env.DRAMA_WRITER_BASE_URL || "https://ai-gateway.vercel.sh/v1";
const MODEL = process.env.DRAMA_WRITER_MODEL || "anthropic/claude-opus-5";
const MAX_IMAGE_CHARS = 3_000_000; // data URL length; Vercel caps request bodies at 4.5 MB

export const maxDuration = 60;

function gatewayKey(request) {
  return (
    process.env.AI_GATEWAY_API_KEY ||
    request?.headers.get("x-vercel-oidc-token") ||
    process.env.VERCEL_OIDC_TOKEN ||
    ""
  );
}

const SYSTEM = (language) => `You write short scenes for a dialogue text-to-speech model that voices exactly two characters.

Output only this format, nothing else:
Title: <a short title>
<Name>: <line>
<Name>: (<direction>) <line>

Rules:
- Exactly two named characters, alternating naturally. 5 to 8 lines in total.
- Each line is something a person says out loud, under 120 characters. No narration, no actions, no sound effects, no emoji.
- A line may start with one direction, only from: (anxious) (laughs) (whispers) (sighs). Use them where they fit the moment, at most three in the scene. Leave neutral lines without a direction.
- Give the scene a small turn or punchline at the end.
- Write the title, names and lines in ${language === "zh" ? "Simplified Chinese (names in Chinese too; keep the directions in English)" : "English"}.`;

export async function GET(request) {
  return Response.json({ enabled: Boolean(gatewayKey(request)), model: MODEL });
}

export async function POST(request) {
  const key = gatewayKey(request);
  if (!key) {
    return Response.json(
      { error: "The scene writer isn't set up. Add AI_GATEWAY_API_KEY to the environment (Vercel → AI Gateway → API keys)." },
      { status: 501 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON with an idea and/or an image." }, { status: 400 });
  }
  const idea = typeof body.idea === "string" ? body.idea.trim().slice(0, 600) : "";
  const image = typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : null;
  const language = body.language === "zh" ? "zh" : "en";
  if (!idea && !image) return Response.json({ error: "Describe the scene or add a picture." }, { status: 400 });
  if (image && image.length > MAX_IMAGE_CHARS) return Response.json({ error: "That picture is too large. Try a smaller one." }, { status: 413 });

  const prompt = image
    ? `Write a scene between two people inspired by this picture.${idea ? ` Direction from the writer: ${idea}` : ""}`
    : `Write a scene: ${idea}`;
  const content = image
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }]
    : prompt;

  let response;
  try {
    response = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM(language) },
          { role: "user", content },
        ],
        max_tokens: 900,
        temperature: 0.9,
        stream: false,
      }),
    });
  } catch (error) {
    return Response.json({ error: `Couldn't reach AI Gateway: ${error.message}` }, { status: 502 });
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    return Response.json({ error: `The writer model returned HTTP ${response.status}.`, detail }, { status: 502 });
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((part) => part.text || "").join("") : String(raw || "");
  if (!text.trim()) return Response.json({ error: "The writer model returned an empty scene. Try again." }, { status: 502 });
  return Response.json({ text, model: data.model || MODEL });
}
