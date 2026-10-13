import { describe, expect, it } from "vitest";
import { parseWhatsAppText, type TextNode } from "../whatsappText";
import { parseTemplateBody } from "../templateMessage";
import { groupMessagesByDay } from "../conversationDays";

const text = (t: string): TextNode => ({ type: "text", text: t });

describe("parseWhatsAppText (the same *bold* _italic_ ~strike~ `code` WhatsApp shows)", () => {
  it("formats each marker", () => {
    expect(parseWhatsAppText("Hello *world*")).toEqual([text("Hello "), { type: "bold", children: [text("world")] }]);
    expect(parseWhatsAppText("_a_ and ~b~ and `c`")).toEqual([{ type: "italic", children: [text("a")] }, text(" and "), { type: "strike", children: [text("b")] }, text(" and "), { type: "code", text: "c" }]);
  });
  it("nests, and keeps what is inside code literal", () => {
    expect(parseWhatsAppText("*bold _both_*")).toEqual([{ type: "bold", children: [text("bold "), { type: "italic", children: [text("both")] }] }]);
    expect(parseWhatsAppText("`*not bold*`")).toEqual([{ type: "code", text: "*not bold*" }]);
  });
  it("leaves alone what only looks like formatting", () => {
    for (const plain of ["snake_case_word", "2 * 3 * 4", "*unclosed", "**", "a * b", "https://x.com/a_b_c", "price is 5*2", "_ _"]) expect(parseWhatsAppText(plain)).toEqual([text(plain)]);
  });
  it("a marker next to punctuation still works", () => {
    expect(parseWhatsAppText("(*note*)")).toEqual([text("("), { type: "bold", children: [text("note")] }, text(")")]);
    expect(parseWhatsAppText("*Hi*, there!")).toEqual([{ type: "bold", children: [text("Hi")] }, text(", there!")]);
  });
  it("plain text and empty text come back as they are", () => {
    expect(parseWhatsAppText("")).toEqual([]);
    expect(parseWhatsAppText("just words")).toEqual([text("just words")]);
  });
});

describe("parseTemplateBody (how WhatsNexus stores a template message)", () => {
  it("takes the header media off the top of the text", () => {
    expect(parseTemplateBody("[IMAGE: https://cdn.example.com/offer.jpg]\nHello Naveen")).toEqual({ header: { kind: "image", url: "https://cdn.example.com/offer.jpg" }, body: "Hello Naveen", buttons: [] });
    expect(parseTemplateBody("[VIDEO: https://cdn.example.com/v.mp4]\nWatch")).toMatchObject({ header: { kind: "video" }, body: "Watch" });
    expect(parseTemplateBody("[DOCUMENT]\nSee attached")).toEqual({ header: { kind: "document", url: null }, body: "See attached", buttons: [] });
  });
  it("only ever links to https media", () => {
    expect(parseTemplateBody("[IMAGE: http://x.example.com/a.jpg]\nHi").header).toEqual({ kind: "image", url: null });
    expect(parseTemplateBody("[IMAGE: javascript:alert(1)]\nHi").header).toEqual({ kind: "image", url: null });
  });
  it("turns [Button: …] lines into buttons, in each of WhatsNexus's formats, and removes them from the text", () => {
    const r = parseTemplateBody("Book today\n[Button: Book now (https://x.example.com/book)]\n[Button: Call us | +919999999999]\n[Button: Yes]");
    expect(r.body).toBe("Book today");
    expect(r.buttons).toEqual([
      { text: "Book now", value: "https://x.example.com/book", type: "url" },
      { text: "Call us", value: "+919999999999", type: "phone" },
      { text: "Yes", value: null, type: "quick_reply" },
    ]);
  });
  it("a button link that is not https is a plain button, not a link", () => {
    expect(parseTemplateBody("Hi\n[Button: Open (javascript:alert(1))]").buttons).toEqual([{ text: "Open", value: null, type: "quick_reply" }]);
  });
  it("drops unfilled {{1}} placeholders and leaves ordinary text alone", () => {
    expect(parseTemplateBody("Hello {{1}}, your visit").body).toBe("Hello , your visit");
    expect(parseTemplateBody("Just a reminder")).toEqual({ header: null, body: "Just a reminder", buttons: [] });
  });
});

describe("groupMessagesByDay", () => {
  const NOW = new Date("2026-10-13T09:00:00.000Z"); // 14:30 on 13 Oct in India
  const at = (iso: string, id: string) => ({ id, sentAt: iso });
  it("groups by the hospital's calendar day and labels Today and Yesterday", () => {
    const g = groupMessagesByDay([at("2026-10-10T08:00:00.000Z", "a"), at("2026-10-12T05:00:00.000Z", "b"), at("2026-10-13T01:00:00.000Z", "c"), at("2026-10-13T08:00:00.000Z", "d")], "Asia/Kolkata", NOW);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([["10 Oct 2026", ["a"]], ["Yesterday", ["b"]], ["Today", ["c", "d"]]]);
  });
  it("uses the hospital's timezone, not the viewer's: just after midnight in India is still the previous day in UTC", () => {
    const g = groupMessagesByDay([at("2026-10-12T17:00:00.000Z", "before"), at("2026-10-12T19:00:00.000Z", "late")], "Asia/Kolkata", NOW);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([["Yesterday", ["before"]], ["Today", ["late"]]]);
  });
  it("keeps order within a day and handles no messages", () => {
    expect(groupMessagesByDay([], "Asia/Kolkata", NOW)).toEqual([]);
    expect(groupMessagesByDay([at("2026-10-13T08:00:00.000Z", "x"), at("2026-10-13T02:00:00.000Z", "y")], "Asia/Kolkata", NOW)[0]!.items.map((i) => i.id)).toEqual(["x", "y"]);
  });
});
