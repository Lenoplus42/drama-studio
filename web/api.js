/** Shared client for both mock and MLX servers. Each audio event is a complete WAV. */
export async function* generateScene(baseUrl, lines, signal) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/scene/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") completed = true;
        yield event;
      }
      if (done) break;
    }
    if (pending.trim() || !completed) throw new Error("Audio stream ended before completion");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function audioBytes(event) {
  return Uint8Array.from(atob(event.audio_base64), character => character.charCodeAt(0));
}
