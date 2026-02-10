// api/post-bogang.js
// Vercel Serverless Function


const NOTION_VERSION = "2022-06-28";

function todayRangeKST() {
  const tz = "Asia/Seoul";
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;

  const start = `${y}-${m}-${d}T00:00:00+09:00`;

  const tomorrow = new Date(`${y}-${m}-${d}T00:00:00+09:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const y2 = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(tomorrow);
  const m2 = new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit" }).format(tomorrow);
  const d2 = new Intl.DateTimeFormat("en-CA", { timeZone: tz, day: "2-digit" }).format(tomorrow);

  const end = `${y2}-${m2}-${d2}T00:00:00+09:00`;

  return { start, end, y, m, d };
}

function formatTime(dateObj) {
  if (!dateObj?.start) return "";

  const fmt = iso =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));

  if (dateObj.end) return `${fmt(dateObj.start)} ~ ${fmt(dateObj.end)}`;
  return fmt(dateObj.start);
}

function getTitle(page) {
  const props = page.properties;
  for (const key in props) {
    if (props[key].type === "title") {
      return props[key].title.map(t => t.plain_text).join("");
    }
  }
  return "";
}

function getPeople(page, name) {
  const p = page.properties[name];
  if (!p || p.type !== "people") return "";
  return p.people.map(x => x.name).join(", ");
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_DATABASE_ID;
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    const CHANNEL = process.env.SLACK_CHANNEL_ID;

    const { start, end, y, m, d } = todayRangeKST();

    const notionResp = await fetch(
      `https://api.notion.com/v1/databases/${DB_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "상태", status: { equals: "확정" } },
              {
                property: "보강일",
                date: { on_or_after: start, before: end },
              },
            ],
          },
          sorts: [{ property: "보강일", direction: "ascending" }],
        }),
      }
    );

    const notionData = await notionResp.json();
    const rows = notionData.results || [];

    const header = `📅 오늘 (${y}/${m}/${d}) 보강 일정`;

    let lines = [];

    for (const page of rows) {
      const title = getTitle(page);
      const student = getPeople(page, "학생");
      const dateObj = page.properties["보강일"]?.date;

      const time = formatTime(dateObj);

      if (time)
        lines.push(`• 🕒 ${time} ${student || ""} ${title || ""}`);
    }

    const text =
      lines.length > 0
        ? `${header}\n\n${lines.join("\n")}`
        : `${header}\n\n오늘 예정된 보강이 없습니다.`;

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: CHANNEL,
        text,
      }),
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
