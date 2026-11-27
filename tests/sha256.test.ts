import { describe, test, expect } from "claude-code/testing";
import { hmacSha256Bytes, hmacSha256Hex, sha256Hex, toHex, utf8Bytes } from "../core/sha256.ts";

describe("sha256", () => {
  test("FIPS 180 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  test("padding boundaries around block edges", () => {
    // 55 bytes fit one block with the length; 56 spill into a second; 64 and 119/120 sit on the next edges.
    expect(sha256Hex("a".repeat(55))).toBe("9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
    expect(sha256Hex("a".repeat(56))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
    expect(sha256Hex("a".repeat(64))).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
    expect(sha256Hex("a".repeat(119))).toBe("31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb");
    expect(sha256Hex("a".repeat(120))).toBe("2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  test("non-ASCII and astral characters hash as UTF-8", () => {
    expect([...utf8Bytes("\u00e9\u20ac\u{1f600}")]).toEqual([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
    expect(sha256Hex("\u00e9\u20ac\u{1f600}")).toBe("df9226927fd572c1ee66eec85de1bb139497614899f36e4e90474cb71f6ef9d0");
    // A lone surrogate encodes as U+FFFD, like TextEncoder.
    expect([...utf8Bytes("\ud800x")]).toEqual([0xef, 0xbf, 0xbd, 0x78]);
    expect(sha256Hex("\ud800x")).toBe("a87ce46793cc659b79bd187e998f8488635f707d5be0957e1d565981efd2b04b");
    // Astral char written as an explicit surrogate pair is the same text.
    expect(sha256Hex("\ud83d\ude00")).toBe(sha256Hex("\u{1f600}"));
  });

  test("HMAC: RFC 4231 case 2", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("HMAC: RFC 4231 cases 6 and 7, key longer than the 64-byte block", () => {
    const key = new Uint8Array(131).fill(0xaa);
    expect(toHex(hmacSha256Bytes(key, utf8Bytes("Test Using Larger Than Block-Size Key - Hash Key First")))).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    expect(toHex(hmacSha256Bytes(key, utf8Bytes("This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.")))).toBe(
      "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    );
  });

  test("HMAC of a non-ASCII message matches an independent implementation", () => {
    expect(hmacSha256Hex("k", "salt-\u00e9\u{1f600}")).toBe("7e78145e7ad178b93674b5dd39670e952c3b9ada59327962d9d64f4d3b08ef76");
  });
});
