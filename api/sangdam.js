import { kstToday, formatTimeKST } from "./utils.js";

const NOTION_VERSION = "2022-06-28";

async function notionQuery(dbId, token) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: {
        and: [
          {
            property: "상태",
            status: { equals: "예정" },
          },
        ],
      },
      sorts: [{ property: "날짜", direction: "ascending" }],
    }),
  });
  const data = await res.json();
  return data.results ?? [];
}

function getTitle(page) {
  const titleArr = page.properties?.["이름"]?.title;
  if (!titleArr || titleArr.length === 0) return "(제목 없음)";
  return titleArr.map((t) => t.plain_text).join("");
}

function getMultiSelect(page, propName) {
  const items = page.properties?.[propName]?.multi_select;
  if (!items || items.length === 0) return "";
  return items.map((i) => i.name).join("/");
}

async function postSlack(channel, token, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_SANGDAM_DATABASE_ID;
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    const CHANNEL = process.env.SLACK_CHANNEL_ID;

    const today = kstToday();
    const header = `📋 오늘 (${today}) 상담 일정`;
    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    const todays = rows.filter((page) => {
      const dateObj = page.properties?.["날짜"]?.date;
      const start = dateObj?.start;
      return start?.startsWith(today);
    });

    const lines = todays
      .map((p) => {
        const title = getTitle(p);
        const type = getMultiSelect(p, "상담유형");
        const time = formatTimeKST(p.properties["날짜"].date);
        const typeStr = type ? `  [${type}]` : "";
        return `• 🕒 ${time}  ${title}${typeStr}`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 상담이 없습니다.`;

    await postSlack(CHANNEL, SLACK_TOKEN, text);
    res.status(200).json({ ok: true, count: lines.length });
  } catch (e) {
    res.status(500).json({ error: "FAILED", detail: String(e) });
  }
}
