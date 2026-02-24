// api/post-sangdam.js
const NOTION_VERSION = "2022-06-28";

/** YYYY-MM-DD (KST) */
function kstToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatTimeKST(dateObj) {
  if (!dateObj?.start) return "";
  const fmt = (iso) =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));

  return dateObj.end ? `${fmt(dateObj.start)} ~ ${fmt(dateObj.end)}` : fmt(dateObj.start);
}

function getTitle(page) {
  for (const key of Object.keys(page.properties || {})) {
    const p = page.properties[key];
    if (p.type === "title") {
      return (p.title || []).map((t) => t.plain_text).join("");
    }
  }
  return "";
}

function getMultiSelect(page, propName) {
  const items = page.properties?.[propName]?.multi_select;
  if (!items || items.length === 0) return "";
  return items.map((i) => i.name).join("/");
}

async function notionQuery(dbId, token) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: {
        property: "상태",
        status: { equals: "예정" },
      },
      sorts: [{ property: "날짜", direction: "ascending" }],
      page_size: 100,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(json));
  return json.results || [];
}

/** JANDI Incoming Webhook (코딩 토픽용 1개로 통일) */
async function postJandi(webhookUrl, text) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.tosslab.jandi-v2+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: text,
      // connectColor: "#3A7BFF", // 옵션(원하면 사용)
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`JANDI_WEBHOOK_FAILED: ${resp.status} ${t}`);
  }
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_SANGDAM_DATABASE_ID;

    // ✅ 코딩 토픽 Incoming Webhook URL (보강/상담 공용)
    const JANDI_WEBHOOK_URL = process.env.JANDI_WEBHOOK_URL;

    if (!NOTION_TOKEN) throw new Error("ENV_MISSING: NOTION_TOKEN");
    if (!DB_ID) throw new Error("ENV_MISSING: NOTION_SANGDAM_DATABASE_ID");
    if (!JANDI_WEBHOOK_URL) throw new Error("ENV_MISSING: JANDI_WEBHOOK_URL");

    const today = kstToday();
    const header = `📋 오늘 (${today}) 상담 일정`;
    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    const todays = rows.filter((page) => {
      const start = page.properties?.["날짜"]?.date?.start;
      return !!start && start.startsWith(today);
    });

    const lines = todays
      .map((p) => {
        const title = getTitle(p);
        const type = getMultiSelect(p, "상담유형");
        const time = formatTimeKST(p.properties?.["날짜"]?.date);
        const typeStr = type ? `  [${type}]` : "";
        if (!time) return "";
        return `• 🕒 ${time}  ${title}${typeStr}`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 상담이 없습니다.`;

    await postJandi(JANDI_WEBHOOK_URL, text);

    res.status(200).json({ ok: true, target: "jandi", count: lines.length });
  } catch (e) {
    res.status(500).json({ error: "FAILED", detail: String(e) });
  }
}
