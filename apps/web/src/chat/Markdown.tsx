import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown subset rendered as React elements (never as HTML): paragraphs,
 * headings, bullet and numbered lists, **bold**, *italic*, `code`, [links](https://…)
 * and <https://autolinks>. Enough for the copilot's answers and their source links.
 */

const INLINE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^>\s]+)>|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])/g;

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const key = `${keyBase}-${n++}`;
    const [, label, href, auto, bold1, bold2, code, em1, em2] = m;
    if (label !== undefined && href) out.push(<Link key={key} href={href}>{inline(label, key)}</Link>);
    else if (auto) out.push(<Link key={key} href={auto}>{auto}</Link>);
    else if (bold1 ?? bold2) out.push(<strong key={key}>{inline(bold1 ?? bold2, key)}</strong>);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else out.push(<em key={key}>{inline(em1 ?? em2 ?? '', key)}</em>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], key: string): ReactNode[] {
  return lines.flatMap((l, i) => [
    ...(i ? [<br key={`${key}-br${i}`} />] : []),
    <Fragment key={`${key}-l${i}`}>{inline(l, `${key}-${i}`)}</Fragment>,
  ]);
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const key = `b${k++}`;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key} className="md-heading">
          {inline(heading[2], key)}
        </p>,
      );
      i++;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].replace(re, ''));
        i++;
      }
      const lis = items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key}>{withBreaks(para, key)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
