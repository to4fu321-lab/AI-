/**
 * 連絡の本文を「読む文章」ではなく「拾える情報」として出す。
 *
 * 現場は作業の合間に、立ったまま数秒だけ画面を見る。
 * 長い段落が続くと、どこが守るべき内容なのか探すところから始まってしまう。
 * 行頭が「・」の行はまとめて箇条書きブロックに切り出し、
 * 地の文と視覚的に分けることで、要点だけを拾えるようにしている。
 */

type Block =
  | { kind: "text"; lines: string[] }
  | { kind: "list"; items: string[] };

/** 本文を、地の文のかたまりと箇条書きのかたまりに分ける */
export function splitNoticeBody(body: string): Block[] {
  const blocks: Block[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // 「・」でも「･」でも「- 」でも、現場が書いた箇条書きとして扱う
    const bullet = line.match(/^[・･\-—]\s*(.+)$/);
    const last = blocks[blocks.length - 1];

    if (bullet) {
      if (last?.kind === "list") last.items.push(bullet[1]);
      else blocks.push({ kind: "list", items: [bullet[1]] });
    } else if (last?.kind === "text") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "text", lines: [line] });
    }
  }

  return blocks;
}

export function NoticeBody({ body }: { body: string }) {
  const blocks = splitNoticeBody(body);

  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) =>
        block.kind === "list" ? (
          <ul key={index} className="space-y-1.5 rounded-lg bg-canvas px-3.5 py-3">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex gap-2 text-body text-ink">
                <span aria-hidden className="mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span className="font-bold">{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={index} className="text-body text-ink">
            {block.lines.join("\n")}
          </p>
        ),
      )}
    </div>
  );
}
