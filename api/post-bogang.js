// api/post-bogang.js
// Vercel Serverless Function (Node 18+ has built-in fetch)

const NOTION_VERSION = "2022-06-28";

function formatDateKST(iso) {
  // iso(또는 Date)를 KST 기준 YYYY-MM-DD 로 변환
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function kstTodayParts(date = new Date()) {
  const today = formatDateKST(date); // YYYY-MM-DD
  const [y, m, d] = today.split("-");
  return { y, m, d, today };
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

  return dateObj.end ? `${fmt(dateObj.start)} ~ ${fmt(dateObj.end)}` : fmt(dateObj.start);
}

function getTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key].type === "title") {
      return (props[key].title || []).map(t => t.plain_text).join("").trim();
    }
  }
  return "";
}

function getPeople(page, propName) {
  const p = page.properties?.[propName];
  if (!p || p.type !== "people") return "";
  return (p.people || []).map(x => x.name).join(", ").trim();
}

function getStatusName(page, propName = "상태") {
  const p = page.properties?.[propName];
  if (!p) return "";
  if (p.type === "status") return (p.status?.name || "").trim();
  if (p.type === "select") return (p.select?.name || "").trim(); // 혹시 select인 경우도 커버
  return "";
}

async function notionQueryAll(dbId, token) {
  // 최대 100개씩 페이지네이션
  let results = [];
  let cursor = undefined;

  while (true) {
    const body = {
      page_size: 100,
      sorts: [{ property: "보강일", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;

    const resp = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!resp.ok) throw new Error(`Notion query failed: ${JSON.stringify(json)}`);

    results = results.concat(json.results || []);
    if (!json.has_more) break;
    cursor = json.next_cursor;
    if (!cursor) break;
  }

  return results;
}

async function postToSlack(channel, token, text) {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const json = await resp.json();
  if (!json.ok) throw new Error(`Slack post failed: ${JSON.stringify(json)}`);
  return json;
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_DATABASE_ID;
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    const CHANNEL = process.env.SLACK_CHANNEL_ID;

    const missing = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]
      .filter(k => !process.env[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing env vars: ${missing.join(", ")}` });
    }

    const { y, m, d, today } = kstTodayParts();
    const header = `📅 오늘 (${y}/${m}/${d}) 보강 일정`;

    // 1) DB 전체(또는 보강일 정렬된 것) 읽기
    const rows = await notionQueryAll(DB_ID, NOTION_TOKEN);

    // 2) 코드에서 "확정" + "오늘"만 필터
    const todays = rows.filter(page => {
      const statusName = getStatusName(page, "상태");
      if (statusName !== "확정") return false;

      const start = page.properties?.["보강일"]?.date?.start;
      if (!start) return false;

      const startDateKST = formatDateKST(start); // YYYY-MM-DD
      return startDateKST === today;
    });

    // 디버그 모드: ?debug=1
    if (req.query?.debug === "1") {
      const sample = rows.slice(0, 5).map(p => ({
        title: getTitle(p),
        status: getStatusName(p, "상태"),
        bogangStart: p.properties?.["보강일"]?.date?.start || null,
        bogangStartDateKST: p.properties?.["보강일"]?.date?.start
          ? formatDateKST(p.properties["보강일"].date.start)
          : null,
      }));
      return res.status(200).json({
        ok: true,
        today,
        total_rows: rows.length,
        today_rows: todays.length,
        sample,
      });
    }

    // 3) 메시지 만들기
    const lines = todays
      .map(page => {
        const title = getTitle(page);
        const student = getPeople(page, "학생");
        const dateObj = page.properties?.["보강일"]?.date;
        const time = formatTimeKST(dateObj);

        if (!time) return null;
        const who = student ? ` ${student}` : "";
        const what = title ? ` · ${title}` : "";
        return `• 🕒 ${time}${who}${what}`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 보강이 없습니다.`;

    // 4) 슬랙 전송
    const slackResp = await postToSlack(CHANNEL, SLACK_TOKEN, text);

    return res.status(200).json({
      ok: true,
      count_today: lines.length,
      slack: { ts: slackResp.ts, channel: slackResp.channel },
    });
  } catch (e) {
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: String(e) });
  }
}
