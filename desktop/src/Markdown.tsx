import type { ReactNode } from "react";

/** Small, safe Markdown renderer: builds React elements, never raw HTML. */
export function Markdown({ text, onLink }: { text: string; onLink: (url: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={blocks.length} code={code.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], onLink);
      blocks.push(level <= 2 ? <h3 key={blocks.length}>{content}</h3> : <h4 key={blocks.length}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""), onLink)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map(c => c.trim()));
        i++;
      }
      blocks.push(<div className="md-table" key={blocks.length}><TableTools rows={rows} /><table><tbody>{rows.map((row, r) =>
        <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c}>{inline(cell, onLink)}</th> : <td key={c}>{inline(cell, onLink)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={blocks.length}>{inline(quote.join(" "), onLink)}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+|\s*\||\s*>)/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={blocks.length}>{paragraph.flatMap((part, index) => index ? [<br key={"b" + index} />, ...inline(part, onLink)] : inline(part, onLink))}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}

function inline(text: string, onLink: (url: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?]|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const key = parts.length;
    if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]("));
      const url = token.slice(token.indexOf("](") + 2, -1);
      parts.push(<a key={key} href={url} onClick={event => { event.preventDefault(); onLink(url); }}>{label}</a>);
    } else if (token.startsWith("http")) {
      parts.push(<a key={key} href={token} onClick={event => { event.preventDefault(); onLink(token); }}>{token}</a>);
    } else parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function CodeBlock({ code }: { code: string }) {
  return <div className="md-code">
    <button type="button" onClick={() => void navigator.clipboard?.writeText(code)}>Копировать</button>
    <pre><code>{code}</code></pre>
  </div>;
}

export function downloadText(name: string, text: string, mime = "text/plain") {
  const blob = new Blob([mime === "text/csv" ? "\ufeff" + text : text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const plain = (cell: string) => cell.replace(/\*\*|`/g, "");

/** Tables from Malenia go to Excel in one click: paste-ready copy or a CSV file. */
function TableTools({ rows }: { rows: string[][] }) {
  return <div className="table-tools">
    <button type="button" title="Скопировать — вставляется в Excel и Google Таблицы по ячейкам"
      onClick={() => void navigator.clipboard?.writeText(rows.map(row => row.map(plain).join("\t")).join("\n"))}>Копировать для Excel</button>
    <button type="button" title="Скачать как CSV (открывается в Excel)"
      onClick={() => downloadText("таблица.csv", rows.map(row => row.map(cell => `"${plain(cell).replace(/"/g, '""')}"`).join(";")).join("\r\n"), "text/csv")}>Скачать CSV</button>
  </div>;
}
