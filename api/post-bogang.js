// api/post-bogang.js

const NOTION_VERSION = "2022-06-28";

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

  const fmt = iso =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));

  return dateObj.end
    ? `${fmt(dateObj.start)} ~ ${fmt(dateObj.end)}`
    : fmt(dateObj.start);
}

function getTitle(page) {
  for (const key of Object.keys(page.properties || {})) {
    const p = page.properties[key];
    if (p.type === "title") {
      return (p.title || []).map(t => t.plain_text).join("");
    }
  }
  return "";
}

function getPeople(page, name) {
  const p = page.properties?.[name];
  if (!p || p.type !== "people") return "";
  return (p.people || []).map(x => x.name).join(", ");
}

async function notionQuery(dbId, token) {
  const resp = await fetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
      }),
    }
  );

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(JSON.stringify(json));
  }
  return json.results || [];
}

async function postSlack(channel, token, text) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });

  const json = await resp.json();
  if (!json.ok) {
    throw new Error(JSON.stringify(json));
  }
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_DATABASE_ID;
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    const CHANNEL = process.env.SLACK_CHANNEL_ID;
    // 🔍 디버깅용 로그 추가
    console.log("=== DEBUG ===");
    console.log("NOTION_TOKEN exists:", !!NOTION_TOKEN);
    console.log("NOTION_TOKEN length:", NOTION_TOKEN?.length);
    console.log("NOTION_TOKEN first 10 chars:", NOTION_TOKEN?.substring(0, 10));
    console.log("DB_ID:", DB_ID);
    console.log("=============");
    const today = kstToday();
    const header = `📅 오늘 (${today}) 보강 일정`;

    const rows = await notionQuery(DB_ID, NOTION_TOKEN);
    // 🔍 디버깅: 전체 데이터 확인
    console.log("=== 전체 rows ===");
    console.log("Total rows:", rows.length);
    
    rows.forEach((page, idx) => {
      const status = page.properties?.["상태"]?.status?.name;
      const dateObj = page.properties?.["보강일"]?.date;
      const start = dateObj?.start;
      const title = getTitle(page);
      
      console.log(`\n[${idx}] ${title}`);
      console.log("  상태:", status);
      console.log("  보강일 start:", start);
      console.log("  필터 통과:", start?.startsWith(today) && status === "확정");
    });
    console.log("=================\n");
    const todays = rows.filter(page => {
      const status = page.properties?.["상태"]?.status?.name;
      const start = page.properties?.["보강일"]?.date?.start;

      if (!start || status !== "확정") return false;
      return start.startsWith(today);
    });

    const lines = todays
      .map(p => {
        const title = getTitle(p);
        const student = getPeople(p, "학생");
        const time = formatTimeKST(p.properties["보강일"].date);

        return `• 🕒 ${time} ${student} · ${title}`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 보강이 없습니다.`;

    await postSlack(CHANNEL, SLACK_TOKEN, text);

    res.status(200).json({ ok: true, count: lines.length });
  } catch (e) {
    res.status(500).json({
      error: "FAILED",
      detail: String(e),
    });
  }
}
