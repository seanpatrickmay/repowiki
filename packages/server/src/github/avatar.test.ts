import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, avatarSource, avatarType, fetchAvatar } from "./avatar.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);
const URL_ = "https://avatars.githubusercontent.com/u/101?v=4";
const serving =
  (body: Uint8Array | ReadableStream<Uint8Array>, init: ResponseInit = {}): typeof fetch =>
  async () =>
    new Response(body as BodyInit, init);

describe("avatarType (ADR-0013)", () => {
  it("knows PNG, JPEG, GIF and WebP by their magic bytes, and nothing else", () => {
    expect(avatarType(PNG)).toBe("image/png");
    expect(avatarType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(avatarType(ascii("GIF89a..."))).toBe("image/gif");
    expect(avatarType(ascii("GIF87a..."))).toBe("image/gif");
    expect(avatarType(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(avatarType(ascii("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(avatarType(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(avatarType(bytes())).toBeNull();
  });
});

describe("avatarSource (ADR-0013)", () => {
  it("accepts only https URLs on GitHub's avatar host", () => {
    expect(avatarSource(URL_)).toBe(URL_);
    for (const url of [
      undefined,
      "",
      "http://avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com.evil.test/u/1",
      "https://user@avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com:8443/u/1",
      "https://evil.test/u/1",
      "not a url",
    ]) {
      expect(avatarSource(url), String(url)).toBeNull();
    }
  });
});

describe("fetchAvatar (ADR-0013)", () => {
  it("returns the image and its type", async () => {
    expect(await fetchAvatar(serving(PNG), URL_)).toEqual({ bytes: PNG, contentType: "image/png" });
  });

  it("asks for no redirect and gives up after a timeout", async () => {
    let seen: RequestInit | undefined;
    const spy: typeof fetch = async (_url, init) => {
      seen = init;
      return new Response(PNG);
    };
    await fetchAvatar(spy, URL_);
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses more than 1 MB, whatever the length header says", async () => {
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    expect(await fetchAvatar(serving(big), URL_)).toBeNull();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG);
        controller.enqueue(new Uint8Array(AVATAR_MAX_BYTES));
        controller.close();
      },
    });
    expect(
      await fetchAvatar(serving(stream, { headers: { "content-length": "10" } }), URL_),
    ).toBeNull();
  });

  it("is null for an error status, an unknown type or a failed request", async () => {
    expect(await fetchAvatar(serving(PNG, { status: 404 }), URL_)).toBeNull();
    expect(await fetchAvatar(serving(ascii("<svg/>")), URL_)).toBeNull();
    const failing: typeof fetch = async () => {
      throw new TypeError("network");
    };
    expect(await fetchAvatar(failing, URL_)).toBeNull();
  });
});
