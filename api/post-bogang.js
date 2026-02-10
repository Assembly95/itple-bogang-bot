// api/post-bogang.js
// Vercel Serverless Function (Node 18+ has built-in fetch)

const NOTION_VERSION = "2022-06-28";

function kstParts(date = new Date()) {
  const tz = "Asia/Seoul";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return { y, m, d, today: `${y}-${m}-${d}` };
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

async function notionQuery(dbId, token) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    // ✅ 날짜 필터 빼고 상태만 필터링 (날짜는 코드에서 직접 처리)
    body: JSON.stringify({
      filter: {
        property: "상태",
        status: { equals: "확정" },
      },
      // 최신 일정이 위로 오도록 정렬(필요 없으면 빼도 됨)
      sorts: [{ property: "보강일", direction: "ascending" }],
      page_size: 100,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`Notion query failed: ${JSON.stringify(json)}`);
  }
  return json.results || [];
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
  if (!json.ok) {
    throw new Error(`Slack post failed: ${JSON.stringify(json)}`);
  }
  return json;
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID = process.env.NOTION_DATABASE_ID;
    const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
    const CHANNEL = process.env.SLACK_CHANNEL_ID;

    // env 체크
    const missing = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]
      .filter(k => !process.env[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing env vars: ${missing.join(", ")}` });
    }

    const { y, m, d, today } = kstParts();
    const header = `📅 오늘 (${y}/${m}/${d}) 보강 일정`;

    // 1) 노션에서 확정된 일정 가져오기
    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    // 2) "오늘" 일정만 필터링 (range date도 start 기준으로 잡힘)
    const todays = rows.filter(page => {
      const start = page.properties?.["보강일"]?.date?.start;
      if (!start) return false;
      // start가 ISO이므로 앞부분 YYYY-MM-DD 비교
      return String(start).startsWith(today);
    });

    // 3) 슬랙 메시지 구성
    const lines = todays
      .map(page => {
        const title = getTitle(page);                // 예: 사과력/헬로메이플
        const student = getPeople(page, "학생");     // 예: 이다원
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
    // 에러를 최대한 그대로 보여주기 (원인 파악용)
    return res.status(500).json({ error: "INTERNAL_ERROR", detail: String(e) });
  }
}
