function normalizeText(value) {
  return String(value || "").trim();
}

export function stripAnsi(value = "") {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

export function parseDeviceAuthProgress(output = "") {
  const text = stripAnsi(output);
  const verificationUriMatch = text.match(/https:\/\/auth\.openai\.com\/codex\/device\b/i);
  const verificationUri = verificationUriMatch ? verificationUriMatch[0] : "";
  const lines = text
    .split(/\r?\n/g)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const userCode =
    lines.find((line) => /^[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+$/.test(line)) || "";

  let expiresInMinutes = 0;
  const expiresMatch = text.match(/expires in\s+(\d+)\s+minutes?/i);
  if (expiresMatch) {
    const parsed = Number.parseInt(expiresMatch[1] || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      expiresInMinutes = parsed;
    }
  }

  return {
    verificationUri,
    userCode,
    expiresInMinutes,
  };
}
