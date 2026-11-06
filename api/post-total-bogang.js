
const NOTION_VERSION = "2025-09-03";
const NOTION_API = "https://api.notion.com/v1";

// 노션에서 확인한 실제 Data Source ID
const SUBJECTS = [
  {
    name: "영어",
    id: "3859b623-cbb1-80de-8183-000bdbc34183",
    dateProperty: "보강일자/시간",
    statusProperty: "진행상태",
    statuses: ["보강예정"],
  },
  {
    name: "수학",
    id: "3439b623-cbb1-8060-b841-000b30a16582",
    dateProperty: "보강일",
    statusProperty: "상태",
    statuses: ["확정", "안내 완료"],
  },
  {
    name: "코딩",
    id: "5230ba27-9cf8-4c9c-87de-b9fa28d74e0b",
    dateProperty: "보강일",
    statusProperty: "상태",
    statuses: ["확정", "안내 완료"],
  },
];

// YYYY-MM-DD (KST)
function kstToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((p) => [p.type, p.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

// 날짜를 한국 시간으로 해석
function parseNotionDate(iso) {
  if (!iso || !iso.includes("T")) return null;

  // 시간대가 없는 경우 KST로 간주
  const hasTimezone = /(Z|[+-]\d{2}:\d{2})$/.test(iso);
  return new Date(hasTimezone ? iso : `${iso}+09:00`);
}

function kstDateKey(iso) {
  if (!iso) return "";

  // 날짜만 있는 Notion 속성
  if (!iso.includes("T")) return iso.slice(0, 10);

  const date = parseNotionDate(iso);
  if (!date || isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.map((x) => [x.type, x.value])
  );

  return `${p.year}-${p.month}-${p.day}`;
}

// 15:00 또는 15:00 ~ 17:00
function formatTimeKST(dateObj) {
  if (!dateObj?.start) return "시간 미정";

  const fmt = (iso) => {
    const date = parseNotionDate(iso);
    if (!date || isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  };

  const start = fmt(dateObj.start);
  const end = dateObj.end ? fmt(dateObj.end) : "";

  if (!start) return "시간 미정";
  return end ? `${start} ~ ${end}` : start;
}

// 노션 속성 이름 비교 (한글 자모 차이도 처리)
function getProperty(page, name) {
  const props = page.properties || {};

  const key = Object.keys(props).find(
    (k) => k.normalize("NFC") === name.normalize("NFC")
  );

  return key ? props[key] : null;
}

// 제목 속성 추출
function getTitle(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === "title") {
      return (p.title || [])
        .map((t) => t.plain_text)
        .join("");
    }
  }
  return "";
}

// 롤업 속성 추출 (학생명, 보강선생님명)
function getRollup(page, name) {
  const p = getProperty(page, name);
  if (!p || p.type !== "rollup") return "";

  if (p.rollup?.type !== "array") return "";

  return (p.rollup.array || [])
    .map((item) => {
      if (item.title) {
        return item.title.map((t) => t.plain_text).join("");
      }
      if (item.rich_text) {
        return item.rich_text
          .map((t) => t.plain_text)
          .join("");
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

// 노션 API 요청
async function notionRequest(path, token, options = {}) {
  const resp = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(
      `NOTION_API_FAILED (${resp.status}): ${JSON.stringify(json)}`
    );
  }

  return json;
}

// 관계형 속성의 페이지 제목 조회를 위한 캐시
const nameCache = new Map();

async function getRelatedPageName(id, token) {
  if (!nameCache.has(id)) {
    const promise = notionRequest(`/pages/${id}`, token)
      .then(getTitle)
      .catch((err) => {
        console.error("관계형 페이지 조회 실패:", id, err);
        return "";
      });

    nameCache.set(id, promise);
  }

  return nameCache.get(id);
}

// Relation 속성의 연결 페이지 이름 추출
async function getRelationNames(page, name, token) {
  const p = getProperty(page, name);
  if (!p || p.type !== "relation") return "";

  const names = await Promise.all(
    (p.relation || []).map((r) =>
      getRelatedPageName(r.id, token)
    )
  );

  return names.filter(Boolean).join(", ");
}

// 과목별 오늘 보강 일정 조회
async function notionQuery(subject, token, today) {
  const statusFilters = subject.statuses.map((status) => ({
    property: subject.statusProperty,
    status: { equals: status },
  }));

  const filter = {
    and: [
      {
        property: subject.dateProperty,
        date: { equals: today },
      },
      {
        or: statusFilters,
      },
    ],
  };

  const results = [];
  let cursor;

  do {
    const body = {
      filter,
      sorts: [
        {
          property: subject.dateProperty,
          direction: "ascending",
        },
      ],
      page_size: 100,
    };

    if (cursor) body.start_cursor = cursor;

    const json = await notionRequest(
      `/data_sources/${subject.id}/query`,
      token,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    results.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);

  // KST 기준으로 한 번 더 확인
  return results.filter((page) => {
    const date = getProperty(page, subject.dateProperty)?.date;
    return kstDateKey(date?.start) === today;
  });
}

// 일정 하나를 메시지용 문자열로 가공
async function formatSchedule(page, subject, token) {
  const title = getTitle(page) || "제목 없음";

  const date = getProperty(page, subject.dateProperty)?.date;
  const time = formatTimeKST(date);

  let student = getRollup(page, "학생명");
  let teacher = getRollup(page, "보강선생님명");

  // 롤업이 없다면 관계형 속성에서 추출
  if (!teacher) {
    teacher = await getRelationNames(page, "보강T", token);
  }

  if (!student && subject.name !== "영어") {
    student = await getRelationNames(page, "학생", token);
  }

  teacher = teacher || "담당 미정";

  // 영어는 제목 자체에 학생명이 들어 있음
  if (subject.name === "영어") {
    return `• ${time} | ${title} (${teacher})`;
  }

  return `• ${time} | ${student || "학생 미확인"} · ${title} (${teacher})`;
}

// JANDI Incoming Webhook
async function postJandi(webhookUrl, payload) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.tosslab.jandi-v2+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const message = await resp.text();
    throw new Error(`JANDI_WEBHOOK_FAILED: ${message}`);
  }
}

// Vercel API Handler
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const JANDI_WEBHOOK_URL = process.env.JANDI_TOTAL_WEBHOOK_URL;
    const CRON_SECRET = process.env.CRON_SECRET;

    if (!NOTION_TOKEN) {
      throw new Error("ENV_MISSING: NOTION_TOKEN");
    }

    if (!JANDI_WEBHOOK_URL) {
      throw new Error("ENV_MISSING: JANDI_WEBHOOK_URL");
    }

    // 선택적 인증: CRON_SECRET을 설정했다면 헤더 필수
    if (
      CRON_SECRET &&
      req.headers["x-cron-secret"] !== CRON_SECRET
    ) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const today = kstToday();

    const dateLabel = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(new Date());

    // 영어, 수학, 코딩 DB 병렬 조회
    const results = await Promise.all(
      SUBJECTS.map(async (subject) => {
        const pages = await notionQuery(
          subject,
          NOTION_TOKEN,
          today
        );

        const lines = await Promise.all(
          pages.map((page) =>
            formatSchedule(page, subject, NOTION_TOKEN)
          )
        );

        console.log(`${subject.name}: ${lines.length}건`);

        return {
          name: subject.name,
          count: lines.length,
          lines,
        };
      })
    );

    const total = results.reduce(
      (sum, item) => sum + item.count,
      0
    );

    // 잔디 메시지 구성
    const payload = {
      body: `📅 오늘의 보강 일정 (${dateLabel})\n총 ${total}건`,
      connectColor: "#3A7BFF",
      connectInfo: results.map((item) => ({
        title: `${item.name} (${item.count}건)`,
        description: item.count
          ? item.lines.join("\n")
          : "오늘 예정된 보강이 없습니다.",
      })),
    };

    // 세 과목을 합쳐 딱 한 번 전송
    await postJandi(JANDI_WEBHOOK_URL, payload);

    return res.status(200).json({
      ok: true,
      date: today,
      total,
      counts: Object.fromEntries(
        results.map((item) => [item.name, item.count])
      ),
    });
  } catch (err) {
    console.error("보강 알림 오류:", err);

    return res.status(500).json({
      error: "FAILED",
      detail: String(err),
    });
  }
}
