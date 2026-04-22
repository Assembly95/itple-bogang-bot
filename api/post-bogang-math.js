// api/post-bogang.js
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

function getRollup(page, name) {
  const p = page.properties?.[name];
  if (!p || p.type !== "rollup") return "";

  if (p.rollup?.type === "array") {
    return p.rollup.array
      .map((item) => {
        if (item.title) return item.title.map((t) => t.plain_text).join("");
        if (item.rich_text) return item.rich_text.map((t) => t.plain_text).join("");
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }

  return "";
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
  or: [
    { property: "상태", status: { equals: "확정" } },
    { property: "상태", status: { equals: "안내 완료" } },
  ],
      },
      // 오늘 일정만 뽑을 거라면 ascending이 보통 더 보기 좋음
      sorts: [{ property: "보강일", direction: "ascending" }],
      page_size: 100,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(json));
  return json.results || [];
}

/**
 * JANDI Incoming Webhook으로 메시지 전송
 * env: JANDI_WEBHOOK_URL
 * 참고: body 필드에 메시지 텍스트를 넣는 방식
 */
async function postJandi(webhookUrl, text) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.tosslab.jandi-v2+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: text,
      // connectColor: "#3A7BFF", // 선택 옵션 (원하면 주석 해제)
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`JANDI_WEBHOOK_FAILED: ${t}`);
  }
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_MATH_DATABASE_ID;
    const JANDI_WEBHOOK_URL = process.env.JANDI_MATH_WEBHOOK_URL;

    if (!NOTION_TOKEN) throw new Error("ENV_MISSING: NOTION_TOKEN");
    if (!DB_ID) throw new Error("ENV_MISSING: NOTION_DATABASE_ID");
    if (!JANDI_WEBHOOK_URL) throw new Error("ENV_MISSING: JANDI_WEBHOOK_URL");

    const today = kstToday();
    const header = `📅 오늘 (${today}) 보강 일정`;

    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    const todays = rows.filter((page) => {
      const start = page.properties?.["보강일"]?.date?.start;
      return !!start && start.startsWith(today);
    });

    const lines = todays
      .map((p) => {
        const title = getTitle(p);
        const student = getRollup(p, "학생명") || "미정";
        const teacher = getRollup(p, "보강선생님명") || "미정";
        const time = formatTimeKST(p.properties?.["보강일"]?.date);

        // 필요하면 Vercel 로그에서 디버깅 가능
        console.log("제목:", title);
        console.log("학생:", student);
        console.log("보강T:", teacher);
        console.log("속성 목록:", Object.keys(p.properties || {}));
        console.log("---");

        if (!time) return "";
        return `• 🕒 ${time} ${student} · ${title} (${teacher})`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 보강이 없습니다.`;

    await postJandi(JANDI_WEBHOOK_URL, text);

    res.status(200).json({ ok: true, target: "jandi", count: lines.length });
  } catch (e) {
    res.status(500).json({
      error: "FAILED",
      detail: String(e),
    });
  }
}
