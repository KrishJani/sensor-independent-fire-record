import type { UIMessage, UIMessageChunk } from "ai";

/**
 * Final pass over the assistant's streamed text, in code because prompt rules
 * alone did not hold in smoke runs:
 *
 * 1. Spacing at text-part boundaries. Each model step starts a new text part
 *    ("…is still" → tool call → "in…"). Clients that join parts glue words
 *    ("stillin"), so a part that would glue onto the previous one gets a
 *    leading space (same rule as the SDK's TextSegmentJoiner).
 * 2. Link verification. A markdown link survives only if its URL was returned
 *    by web_search or web_fetch in this conversation; otherwise it is unlinked
 *    (the label text stays).
 * 3. "your area" → "this area", unless the user called the area theirs.
 * 4. A "Sources" / "Source facts" heading and the list under it are dropped
 *    when no web tool ran this turn (data tools need no source list, and
 *    without a web result there is nothing outside to cite).
 * 5. Bare URLs (plain text, not a markdown link) that no web tool returned are
 *    removed ("Citation: https://made-up.example"), and a "Citation:" /
 *    "Source:" line left with nothing after it is dropped. Such lines are held
 *    until they are complete so the check sees the whole line.
 *
 * Text is held back only as far as needed to see a link or phrase whole (an
 * unfinished `[…](…)` / `<http…>`, plus the last two words); whitespace inside
 * the text is never changed.
 */

/**
 * How much of `buf` can be processed and sent now. Holds back an unfinished
 * markdown link or autolink, and the last two words (so "your" + " area" split
 * across deltas is still rewritten).
 */
export function safeCut(buf: string): number {
  let limit = buf.length;
  const open = buf.lastIndexOf("[");
  if (open !== -1 && !/^\[[^\]\n]*\]\([^)\s]*\)/.test(buf.slice(open)) && !/^\[[^\]\n]*\](?!\()[\s\S]/.test(buf.slice(open)))
    limit = open;
  const lt = buf.lastIndexOf("<");
  if (lt !== -1 && lt < limit && !buf.includes(">", lt)) limit = lt;
  // Back off to the start of the second-to-last word before `limit`.
  const head = buf.slice(0, limit);
  const m = /\S+\s+\S*$/.exec(head);
  let cut = m ? m.index : /\S*$/.exec(head)!.index;
  // Never split a complete link ("[CAL FIRE](url)" contains a space).
  for (const l of buf.matchAll(/!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>/g)) {
    if (l.index < cut && cut < l.index + l[0].length) cut = l.index;
  }
  return cut;
}

export const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

/** Normalize a URL for comparison: host without www, decoded path without trailing slash; no query/hash. */
export function normUrl(u: string): string {
  try {
    const url = new URL(u);
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep raw path */
    }
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path.replace(/\/+$/, "")}`;
  } catch {
    return u.trim();
  }
}

/** URLs a web tool result vouches for: search result URLs, or the fetched page (if it loaded). */
export function urlsFromWebOutput(toolName: string, output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const o = output as { items?: { url?: unknown }[]; url?: unknown; finalUrl?: unknown; status?: unknown };
  if (toolName === "web_search")
    return (o.items ?? []).map((it) => it?.url).filter((u): u is string => typeof u === "string");
  if (toolName === "web_fetch") {
    if (typeof o.status === "number" && o.status >= 400) return [];
    return [o.url, o.finalUrl].filter((u): u is string => typeof u === "string" && u.length > 0);
  }
  return [];
}

/** All URLs returned by web tools in earlier messages of the conversation. */
export function collectWebUrls(messages: UIMessage[]): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    for (const part of m.parts as { type: string; state?: string; output?: unknown }[]) {
      const name = part.type.startsWith("tool-") ? part.type.slice(5) : "";
      if (WEB_TOOLS.has(name) && part.state === "output-available") urls.push(...urlsFromWebOutput(name, part.output));
    }
  }
  return urls;
}

const OWNS_AREA = /\b(my|our)\s+(own\s+)?(area|district|county|region|town|city|neighbou?rhood|home|community|jurisdiction|place)\b/i;

/** True if the user referred to the area as theirs ("my district", "our county"). */
export function userOwnsArea(messages: UIMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && OWNS_AREA.test((p as { text: string }).text))
  );
}

/** Rewrite "your area" to "this area", keeping the capitalisation of "your". */
export function rewriteYourArea(text: string): string {
  return text.replace(/\b([Yy])our area\b/g, (_m, y: string) => (y === "Y" ? "This area" : "this area"));
}

/** Plain-text URLs (not inside a markdown link or autolink), without trailing punctuation. */
const BARE_URL = /(?<![(<\w/])https?:\/\/[^\s<>()\[\]"'`]+/g;

/** Remove bare URLs that are not in `known` (normalized). Trailing sentence punctuation stays. */
export function removeUnknownBareUrls(text: string, known: Set<string>): string {
  return text.replace(BARE_URL, (raw) => {
    const url = raw.replace(/[.,;:!?*_]+$/, "");
    const tail = raw.slice(url.length);
    return known.has(normUrl(url)) ? raw : tail;
  });
}

/** A line that is only a citation/source label: "Citation:", "- **Source:** ", "Sources: ;". */
const LABEL_ONLY = /^[ \t]*(?:[-*+•][ \t]+)?[*_]*[ \t]*(?:citations?|sources?)[ \t]*[*_]*[ \t]*:?[ \t]*[*_]*[ \t]*[.,;]?[ \t]*$/i;

/**
 * Apply `fix` line by line; a line that `fix` changed and that is left as only a citation/source
 * label is dropped with its newline. Untouched lines (a real "**Sources:**" heading) stay.
 */
export function fixLines(text: string, fix: (line: string) => string): string {
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const body = line.replace(/\r?\n$/, "");
      const fixed = fix(body);
      if (fixed !== body && LABEL_ONLY.test(fixed)) return "";
      return fixed + line.slice(body.length);
    })
    .join("");
}

/** Unlink markdown links and <autolinks> whose URL is not in `known` (normalized). */
export function filterLinks(text: string, known: Set<string>): string {
  return text
    .replace(/(!?)\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (whole, bang: string, label: string, url: string) =>
      bang || known.has(normUrl(url)) ? whole : label
    )
    .replace(/<(https?:\/\/[^>\s]+)>/g, (whole, url: string) => (known.has(normUrl(url)) ? whole : ""));
}

/** Leading "#", list bullet and emphasis before a possible Sources/Citation label. */
const HEADING_LEAD = /^\s*([-+•]\s+|\*\s+(?=\S))?(#{1,6}\s*)?[*_]*\s*/;
/** A whole line that is a "Sources" heading: "## Sources", "**Source facts:**", "Sources: NASA FIRMS…". */
const SOURCES_HEADING = /^\s*(#{1,6}\s*)?[*_]*\s*(sources?|source facts)\s*[*_]*\s*(:.*)?\s*$/i;
/** Lines that belong to the section under the heading: list items, indented continuations, blank lines. */
const SECTION_LINE = /^\s*$|^\s*([-*+•]|\d+[.)])\s|^\s{2,}\S/;

/** Could this unfinished line still turn out to be a Sources heading? */
function couldBeHeading(frag: string): boolean {
  const rest = frag.replace(HEADING_LEAD, "").toLowerCase();
  if (rest === "") return true;
  return (
    "source facts".startsWith(rest) ||
    "sources".startsWith(rest) ||
    "citations".startsWith(rest) ||
    /^(sources?|source facts|citations?)\b/.test(rest)
  );
}

/**
 * Line-aware filter that removes a Sources section. Only holds back a line
 * while it could still be such a heading (or while inside a dropped section);
 * every other line streams through as it arrives.
 */
export class SourcesStripper {
  #pending = "";
  #lineOpen = false; // the current line has already been passed through
  #stripping = false;

  constructor(private readonly enabled: () => boolean) {}

  push(text: string): string {
    let out = "";
    let buf = this.#pending + text;
    this.#pending = "";
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      out += this.#line(buf.slice(0, nl + 1));
      buf = buf.slice(nl + 1);
    }
    if (buf) {
      if (this.#lineOpen) out += buf;
      else if (this.#stripping || couldBeHeading(buf)) this.#pending = buf;
      else {
        out += buf;
        this.#lineOpen = true;
      }
    }
    return out;
  }

  /** End of the text part: decide on whatever is still held. */
  end(): string {
    const rest = this.#pending;
    this.#pending = "";
    const out = rest ? this.#line(rest) : "";
    this.#lineOpen = false;
    this.#stripping = false;
    return out;
  }

  #line(line: string): string {
    if (this.#lineOpen) {
      this.#lineOpen = !line.endsWith("\n");
      return line;
    }
    if (this.#stripping) {
      if (SECTION_LINE.test(line)) return "";
      this.#stripping = false;
    }
    if (SOURCES_HEADING.test(line.replace(/\n$/, "")) && this.enabled()) {
      this.#stripping = true;
      return "";
    }
    return line;
  }
}

export interface PostProcessOptions {
  /** URLs returned by web tools earlier in the conversation. */
  knownUrls?: Iterable<string>;
  /** Rewrite "your area" → "this area" (false when the user said the area is theirs). */
  rewriteArea?: boolean;
}

/** Streaming final pass (see file comment). Non-text chunks pass through untouched and in order. */
export function answerPostProcessor(opts: PostProcessOptions = {}): TransformStream<UIMessageChunk, UIMessageChunk> {
  const known = new Set([...(opts.knownUrls ?? [])].map(normUrl));
  const rewriteArea = opts.rewriteArea ?? true;
  const toolNames = new Map<string, string>();
  const buffers = new Map<string, string>();
  /** Whether the last text sent to the client ended in a non-whitespace character. */
  let lastEndsInWord = false;
  /** Whether the current text part has sent anything yet. */
  const started = new Set<string>();
  /** Whether web_search/web_fetch was called in this turn (Sources sections are kept then). */
  let webThisTurn = false;
  const strippers = new Map<string, SourcesStripper>();
  const stripperFor = (id: string) => {
    let s = strippers.get(id);
    if (!s) strippers.set(id, (s = new SourcesStripper(() => !webThisTurn)));
    return s;
  };

  const process = (s: string) => {
    let out = fixLines(s, (line) => removeUnknownBareUrls(filterLinks(line, known), known));
    if (rewriteArea) out = rewriteYourArea(out);
    return out;
  };

  const emit = (controller: TransformStreamDefaultController<UIMessageChunk>, id: string, raw: string, end = false) => {
    const stripper = stripperFor(id);
    let delta = process(stripper.push(raw) + (end ? stripper.end() : ""));
    if (end) strippers.delete(id);
    if (!delta) return;
    if (!started.has(id)) {
      started.add(id);
      if (lastEndsInWord && !/^\s/.test(delta)) delta = ` ${delta}`;
    }
    lastEndsInWord = /\S$/.test(delta);
    controller.enqueue({ type: "text-delta", id, delta });
  };

  return new TransformStream({
    transform(chunk, controller) {
      switch (chunk.type) {
        case "tool-input-available":
          toolNames.set(chunk.toolCallId, chunk.toolName);
          if (WEB_TOOLS.has(chunk.toolName)) webThisTurn = true;
          break;
        case "tool-output-available": {
          const name = toolNames.get(chunk.toolCallId) ?? "";
          for (const u of urlsFromWebOutput(name, chunk.output)) known.add(normUrl(u));
          break;
        }
        case "text-start":
          buffers.set(chunk.id, "");
          break;
        case "text-delta": {
          const buf = (buffers.get(chunk.id) ?? "") + chunk.delta;
          const cut = safeCut(buf);
          buffers.set(chunk.id, buf.slice(cut));
          if (cut > 0) emit(controller, chunk.id, buf.slice(0, cut));
          return; // re-emitted (processed) above or on flush
        }
        case "text-end": {
          const rest = buffers.get(chunk.id) ?? "";
          buffers.delete(chunk.id);
          emit(controller, chunk.id, rest, true);
          break;
        }
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      // A stream cut off mid-part (abort/error) still delivers what was buffered.
      for (const [id, rest] of buffers) emit(controller, id, rest, true);
      buffers.clear();
    }
  });
}
