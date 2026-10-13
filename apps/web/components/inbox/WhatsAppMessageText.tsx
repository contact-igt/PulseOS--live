import { Fragment } from "react";
import { parseWhatsAppText, type TextNode } from "./whatsappText";

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,!?;:)\]])/g;

/** Plain text with links made clickable (https/http only, opened safely). Everything is a React node: nothing is ever injected as HTML. */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary-700 underline underline-offset-2">{part}</a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Node({ node }: { node: TextNode }) {
  switch (node.type) {
    case "text":
      return <Linked text={node.text} />;
    case "code":
      return <code className="rounded bg-black/5 px-1 font-mono text-[0.92em]">{node.text}</code>;
    case "bold":
      return <strong className="font-semibold">{node.children.map((c, i) => <Node key={i} node={c} />)}</strong>;
    case "italic":
      return <em>{node.children.map((c, i) => <Node key={i} node={c} />)}</em>;
    case "strike":
      return <s>{node.children.map((c, i) => <Node key={i} node={c} />)}</s>;
  }
}

/** A message's words, with WhatsApp's own formatting (*bold*, _italic_, ~strike~, `code`) and clickable links. Line breaks are kept. */
export function WhatsAppText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {parseWhatsAppText(line).map((n, j) => <Node key={j} node={n} />)}
        </Fragment>
      ))}
    </div>
  );
}
