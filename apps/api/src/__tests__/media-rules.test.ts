import { describe, expect, it } from "vitest";
import { MEDIA_LIMIT_BYTES, checkMediaFile, mediaKindForFile } from "@pulseos/types";

const MB = 1024 * 1024;

describe("mediaKindForFile: which kind of attachment a chosen file is", () => {
  it("goes by the MIME type, ignoring codec parameters", () => {
    expect(mediaKindForFile({ mimeType: "image/png", fileName: "a.png" })).toBe("image");
    expect(mediaKindForFile({ mimeType: "video/mp4", fileName: "a.mp4" })).toBe("video");
    expect(mediaKindForFile({ mimeType: "audio/webm;codecs=opus", fileName: "voice.webm" })).toBe("audio");
    expect(mediaKindForFile({ mimeType: "application/pdf", fileName: "r.pdf" })).toBe("document");
  });
  it("falls back to the extension when the browser gives no type, and refuses what it cannot place", () => {
    expect(mediaKindForFile({ mimeType: "", fileName: "scan.JPG" })).toBe("image");
    expect(mediaKindForFile({ mimeType: "application/octet-stream", fileName: "notes.docx" })).toBe("document");
    expect(mediaKindForFile({ mimeType: "application/x-msdownload", fileName: "setup.exe" })).toBeNull();
    expect(mediaKindForFile({ mimeType: "", fileName: "noextension" })).toBeNull();
  });
});

describe("checkMediaFile", () => {
  const ok = (kind: Parameters<typeof checkMediaFile>[0]["kind"], mimeType: string, fileName: string, sizeBytes = 1 * MB) => checkMediaFile({ kind, mimeType, fileName, sizeBytes });

  it("accepts what WhatsApp takes, at the limits WhatsNexus enforces", () => {
    expect(ok("image", "image/jpeg", "a.jpg", MEDIA_LIMIT_BYTES.image)).toEqual({ ok: true });
    expect(ok("video", "video/mp4", "a.mp4", MEDIA_LIMIT_BYTES.video)).toEqual({ ok: true });
    expect(ok("audio", "audio/mpeg", "a.mp3", MEDIA_LIMIT_BYTES.audio)).toEqual({ ok: true });
    expect(ok("audio", "audio/webm;codecs=opus", "voice.webm")).toEqual({ ok: true }); // a recording: converted on the way
    expect(ok("document", "application/pdf", "r.pdf", MEDIA_LIMIT_BYTES.document)).toEqual({ ok: true });
  });

  it("says plainly when a file is too large, with the limit", () => {
    const r = ok("image", "image/png", "big.png", 6 * MB);
    expect(r).toEqual({ ok: false, reason: "file_too_large", message: "This image is too large. Images can be up to 5 MB." });
    expect(ok("video", "video/mp4", "v.mp4", 17 * MB)).toMatchObject({ ok: false, reason: "file_too_large" });
    expect(ok("document", "application/pdf", "r.pdf", 26 * MB)).toMatchObject({ ok: false, reason: "file_too_large" });
  });

  it("refuses an empty file and a type that does not belong to the chosen kind", () => {
    expect(ok("image", "image/png", "a.png", 0)).toMatchObject({ ok: false, reason: "empty_file" });
    expect(ok("image", "application/pdf", "a.pdf")).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(ok("document", "application/x-msdownload", "setup.exe")).toMatchObject({ ok: false, reason: "unsupported_type" });
    // WhatsApp takes mp4 video only; a webm clip would be refused after upload, so it is refused now
    expect(ok("video", "video/webm", "clip.webm")).toMatchObject({ ok: false, reason: "unsupported_type" });
  });
});
