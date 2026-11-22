import { guardApi } from "@/lib/access/locks";
import { getBrowser } from "@/lib/thumbs/render";

export const runtime = "nodejs";
export const maxDuration = 120;

/** 調査用（プレビューだけ。本番には入れない）：Cloudflare の確認がどういう条件で通るかを調べる */
export async function GET(request: Request) {
  const denied = await guardApi(request, "/api/thumbs/debug");
  if (denied) return denied;
  const plan = new URL(request.url).searchParams.get("plan") ?? "A";
  const t0 = Date.now();
  const log: string[] = [];
  const say = (m: string) => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const browser = await getBrowser();
  const ua = (await browser.userAgent()).replace(/Headless/gi, "");
  const open = async (url: string) => {
    const p = await browser.newPage();
    await p.setUserAgent({ userAgent: ua });
    const res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    return { p, status: res?.status() ?? 0, title: (await p.title().catch(() => "")).slice(0, 30) };
  };
  const inPage = (p: Awaited<ReturnType<typeof open>>["p"], url: string) =>
    p
      .evaluate(async (u: string) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          const t = await r.text();
          return `${r.status} len=${t.length}`;
        } catch (e) {
          return `ERR ${String(e).slice(0, 60)}`;
        }
      }, url)
      .catch((e) => `EVALERR ${String(e).slice(0, 60)}`);
  try {
    const first = await open("https://twihub.link/posts?type=realtime");
    say(`open list ${first.status} 「${first.title}」`);
    const html = await first.p.content();
    const posts = [...new Set([...html.matchAll(/\/posts\/([0-9a-f-]{36})/g)].map((m) => `https://twihub.link/posts/${m[1]}`))];
    say(`posts ${posts.length}`);
    let i = 0;
    if (plan === "A") {
      await sleep(70000);
      for (let k = 0; k < 5; k++) say(`fetch#${i} ${await inPage(first.p, posts[i++])}`);
    } else if (plan === "B") {
      while (Date.now() - t0 < 95000) {
        say(`fetch#${i} ${await inPage(first.p, posts[i++ % posts.length])}`);
        await sleep(6000);
      }
    } else if (plan === "C") {
      for (let k = 0; k < 6; k++) {
        const o = await open(posts[i++]);
        say(`newtab#${k} ${o.status} 「${o.title}」`);
        await sleep(1500);
        say(`  after1.5s 「${(await o.p.title().catch(() => "")).slice(0, 30)}」`);
        await o.p.close().catch(() => {});
        await sleep(3000);
      }
    } else if (plan === "D") {
      // 新しいタブで開いたあと、最初のページの中から読む
      const o = await open(posts[i++]);
      say(`newtab ${o.status} 「${o.title}」`);
      for (let k = 0; k < 8; k++) {
        say(`fetch#${i} ${await inPage(first.p, posts[i++])}`);
        await sleep(2000);
      }
      for (let k = 0; k < 4; k++) say(`fetch-from-post-tab#${i} ${await inPage(o.p, posts[i++])}`);
      await o.p.close().catch(() => {});
    }
    if (plan === "G" || plan === "H") {
      // スクリプトの動かないページ（robots.txt）を開いて、その中から投稿ページを読む。G：3 秒おき / H：続けて
      const base = await open("https://twihub.link/robots.txt");
      say(`open robots ${base.status}`);
      for (let k = 0; k < (plan === "G" ? 14 : 20); k++) {
        say(`fetch#${i} ${await inPage(base.p, posts[i++ % posts.length])}`);
        if (plan === "G") await sleep(3000);
      }
      await base.p.close().catch(() => {});
    }
    if (plan === "F") {
      // 確認ページの種類を調べる（自動で済む種類か、人がチェックを入れる種類か）
      const html = await first.p
        .evaluate(async (u: string) => {
          const r = await fetch(u, { credentials: "include" });
          return await r.text();
        }, posts[0])
        .catch((e) => `EVALERR ${String(e)}`);
      const ctype = /cType:\s*['"]([\w-]+)['"]/.exec(html)?.[1];
      say(`challenge cType=${ctype} len=${html.length} turnstile=${/turnstile/i.test(html)} title=${/<title>([^<]*)/.exec(html)?.[1]}`);
      say(html.replace(/\s+/g, " ").slice(0, 700));
    }
    if (plan === "E") {
      // 投稿ページを新しいタブで開いて、何もせずに待つ。題名が変わる（確認が済む）までの時間を測る
      const o = await open(posts[i++]);
      say(`newtab ${o.status} 「${o.title}」`);
      let passedAt = 0;
      while (Date.now() - t0 < 100000) {
        await sleep(3000);
        const title = (await o.p.title().catch(() => "?")).slice(0, 30);
        const frames = o.p.frames().length;
        if (!/just a moment|お待ち/i.test(title)) {
          passedAt = Date.now() - t0;
          say(`PASSED 「${title}」 url=${o.p.url().slice(0, 80)}`);
          break;
        }
        if (Math.round((Date.now() - t0) / 3000) % 4 === 0) say(`waiting 「${title}」 frames=${frames}`);
      }
      if (passedAt) for (let k = 0; k < 4; k++) say(`fetch#${i} ${await inPage(o.p, posts[i++])}`);
      await o.p.close().catch(() => {});
    }
    const cookies = (await browser.cookies()).filter((c) => /twihub/.test(c.domain)).map((c) => c.name);
    say(`cookies ${cookies.join(",")}`);
    await first.p.close().catch(() => {});
  } catch (e) {
    say(`ERROR ${String(e).slice(0, 200)}`);
  }
  return new Response(log.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
