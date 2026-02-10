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
        filter: {
          property: "상태",
          status: {
            equals: "확정"
          }
        },
        sorts: [
          {
            property: "보강일",
            direction: "descending"
          }
        ],
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

    const today = kstToday();
    const header = `📅 오늘 (${today}) 보강 일정`;
    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    const todays = rows.filter(page => {
      const start = page.properties?.["보강일"]?.date?.start;
      if (!start) return false;
      return start.startsWith(today);
    });

    const lines = todays
      .map(p => {
        const title = getTitle(p);
        const student = getPeople(p, "학생");
        const teacher = getPeople(p, "보강T");
        const time = formatTimeKST(p.properties["보강일"].date);

            // 🔍 디버깅
    console.log("제목:", title);
    console.log("학생:", student);
    console.log("보강T:", teacher);
    console.log("속성 목록:", Object.keys(p.properties));
    console.log("---");
        
        return `• 🕒 ${time} ${student} · ${title} (${teacher})`;
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
