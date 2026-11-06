
const NOTION_VERSION = "2025-09-03";
const NOTION_API = "https://api.notion.com/v1";

// 코딩 보강 일정 Data Source ID
const DATA_SOURCE_ID =
  "5230ba27-9cf8-4c9c-87de-b9fa28d74e0b";

// 오늘 날짜 (한국 시간)
function kstToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const p = Object.fromEntries(
    parts.map((item) => [item.type, item.value])
  );

  return `${p.year}-${p.month}-${p.day}`;
}

// Notion 날짜 문자열 변환
function parseDate(iso) {
  if (!iso || !iso.includes("T")) return null;

  const hasTimezone = /(Z|[+-]\d{2}:\d{2})$/.test(iso);
  return new Date(hasTimezone ? iso : `${iso}+09:00`);
}

// KST 날짜 비교
function kstDateKey(iso) {
  if (!iso) return "";
  if (!iso.includes("T")) return iso.slice(0, 10);

  const date = parseDate(iso);
  if (!date || isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.map((item) => [item.type, item.value])
  );

  return `${p.year}-${p.month}-${p.day}`;
}

// 기존 잔디 시간 형식 유지
function formatTimeKST(dateObj) {
  if (!dateObj?.start) return "";

  const fmt = (iso) => {
    const date = parseDate(iso);
    if (!date || isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  };

  const start = fmt(dateObj.start);
  const end = dateObj.end ? fmt(dateObj.end) : "";

  return end ? `${start} ~ ${end}` : start;
}

// 한글 속성 이름 정규화
function getProperty(page, name) {
  const props = page.properties || {};

  const key = Object.keys(props).find(
    (k) => k.normalize("NFC") === name.normalize("NFC")
  );

  return key ? props[key] : null;
}

// 페이지 제목
function getTitle(page) {
  const prop = Object.values(page.properties || {})
    .find((p) => p.type === "title");

  return (prop?.title || [])
    .map((item) => item.plain_text || "")
    .join("");
}

// 속성에서 문자열 추출
function extractText(item) {
  if (!item) return "";

  if (Array.isArray(item.title)) {
    return item.title
      .map((t) => t.plain_text || "")
      .join("");
  }

  if (Array.isArray(item.rich_text)) {
    return item.rich_text
      .map((t) => t.plain_text || "")
      .join("");
  }

  if (item.rollup?.type === "array") {
    return (item.rollup.array || [])
      .map(extractText)
      .filter(Boolean)
      .join(", ");
  }

  if (item.rollup?.type === "number") {
    return item.rollup.number == null
      ? ""
      : String(item.rollup.number);
  }

  return "";
}

// Notion API 요청 공통 함수
async function notionRequest(path, token, options = {}) {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `NOTION_API_FAILED (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}

// 롤업 조회 (학생명 / 보강선생님명)
async function getRollup(page, name, token) {
  const prop = getProperty(page, name);

  if (!prop || prop.type !== "rollup") {
    console.warn(`[롤업 없음] ${name}, 페이지: ${page.id}`);
    return "";
  }

  // 1차: 일반 페이지 응답의 롤업
  const direct = extractText(prop);
  if (direct) return direct;

  // 2차: 속성 전용 API로 조회
  if (!prop.id) return "";

  let cursor = null;
  const values = [];

  do {
    const query = cursor
      ? `?start_cursor=${encodeURIComponent(cursor)}`
      : "";

    const data = await notionRequest(
      `/pages/${page.id}/properties/${encodeURIComponent(prop.id)}${query}`,
      token
    );

    if (data.object === "list") {
      values.push(
        ...(data.results || []).map(extractText)
      );

      cursor = data.has_more ? data.next_cursor : null;
    } else {
      values.push(extractText(data));
      cursor = null;
    }
  } while (cursor);

  const result = values.filter(Boolean).join(", ");

  if (!result) {
    console.warn(`[롤업 값 비어 있음] ${name}, 페이지: ${page.id}`);
  }

  return result;
}

// 관계형 대상 페이지 제목 조회
async function getRelatedTitle(id, token, cache) {
  if (!cache.has(id)) {
    const promise = notionRequest(`/pages/${id}`, token)
      .then((page) => getTitle(page))
      .catch((error) => {
        console.error(`[관계형 조회 실패] ${id}`, error);
        return "";
      });

    cache.set(id, promise);
  }

  return cache.get(id);
}

// 롤업이 비었을 경우 관계형을 통해 이름 조회
async function getRelationNames(page, name, token, cache) {
  const prop = getProperty(page, name);

  if (!prop || prop.type !== "relation") {
    console.warn(`[관계형 없음] ${name}, 페이지: ${page.id}`);
    return "";
  }

  const ids = (prop.relation || []).map((r) => r.id);

  if (!ids.length) {
    console.warn(`[관계형 값 비어 있음] ${name}, 페이지: ${page.id}`);
    return "";
  }

  const names = await Promise.all(
    ids.map((id) => getRelatedTitle(id, token, cache))
  );

  return names.filter(Boolean).join(", ");
}

// 오늘 보강 일정 조회
async function notionQuery(token) {
  const results = [];
  let cursor = null;

  do {
    const body = {
      filter: {
        or: [
          {
            property: "상태",
            status: { equals: "확정" },
          },
          {
            property: "상태",
            status: { equals: "안내 완료" },
          },
        ],
      },
      sorts: [
        {
          property: "보강일",
          direction: "ascending",
        },
      ],
      page_size: 100,
    };

    if (cursor) body.start_cursor = cursor;

    const data = await notionRequest(
      `/data_sources/${DATA_SOURCE_ID}/query`,
      token,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return results;
}

// 보강 일정 하나를 메시지로 변환
async function formatSchedule(page, token, cache) {
  const title = getTitle(page) || "제목 없음";

  const date = getProperty(page, "보강일")?.date;
  const time = formatTimeKST(date);

  // 학생명 롤업 우선
  let student = await getRollup(page, "학생명", token);

  // 없으면 학생 관계형에서 실제 페이지 제목 조회
  if (!student) {
    student = await getRelationNames(
      page, "학생", token, cache
    );
  }

  // 선생님명 롤업 우선
  let teacher = await getRollup(
    page, "보강선생님명", token
  );

  // 없으면 보강T 관계형에서 실제 페이지 제목 조회
  if (!teacher) {
    teacher = await getRelationNames(
      page, "보강T", token, cache
    );
  }

  // 디버깅 로그
  console.log("[보강 조회]", {
    pageId: page.id,
    studentRollupType: getProperty(page, "학생명")?.type,
    teacherRollupType: getProperty(page, "보강선생님명")?.type,
    studentRelationCount:
      getProperty(page, "학생")?.relation?.length ?? 0,
    teacherRelationCount:
      getProperty(page, "보강T")?.relation?.length ?? 0,
    studentResolved: !!student,
    teacherResolved: !!teacher,
  });

  student = student || "미정";
  teacher = teacher || "미정";

  return `• 🕒 ${time} ${student} · ${title} (${teacher})`;
}

// 기존 잔디 웹훅
async function postJandi(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.tosslab.jandi-v2+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: text }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`JANDI_WEBHOOK_FAILED: ${detail}`);
  }
}

// Vercel Handler
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const JANDI_WEBHOOK_URL = process.env.JANDI_WEBHOOK_URL;

    if (!NOTION_TOKEN) {
      throw new Error("ENV_MISSING: NOTION_TOKEN");
    }

    if (!JANDI_WEBHOOK_URL) {
      throw new Error("ENV_MISSING: JANDI_WEBHOOK_URL");
    }

    const today = kstToday();
    const header = `📅 오늘 (${today}) 보강 일정`;

    const rows = await notionQuery(NOTION_TOKEN);

    const todays = rows.filter((page) => {
      const start = getProperty(page, "보강일")?.date?.start;
      return kstDateKey(start) === today;
    });

    const cache = new Map();

    const lines = await Promise.all(
      todays.map((page) =>
        formatSchedule(page, NOTION_TOKEN, cache)
      )
    );

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 보강이 없습니다.`;

    console.log(`코딩 보강: ${lines.length}건`);

    await postJandi(JANDI_WEBHOOK_URL, text);

    return res.status(200).json({
      ok: true,
      target: "jandi",
      date: today,
      count: lines.length,
    });
  } catch (error) {
    console.error("보강봇 실행 실패:", error);

    return res.status(500).json({
      error: "FAILED",
      detail: String(error),
    });
  }
}
