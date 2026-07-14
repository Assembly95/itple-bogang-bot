const NOTION_VERSION = "2025-09-03";

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

  return dateObj.end
    ? `${fmt(dateObj.start)} ~ ${fmt(dateObj.end)}`
    : fmt(dateObj.start);
}

function getTitle(page) {
  for (const key of Object.keys(page.properties || {})) {
    const property = page.properties[key];

    if (property.type === "title") {
      return (property.title || [])
        .map((item) => item.plain_text)
        .join("");
    }
  }

  return "";
}

function getMultiSelect(page, propertyName) {
  const property = page.properties?.[propertyName];

  if (!property || property.type !== "multi_select") return "";

  return (property.multi_select || [])
    .map((item) => item.name)
    .filter(Boolean)
    .join("/");
}

async function getDataSourceId(databaseId, token) {
  const resp = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
    }
  );

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(
      `DATABASE_RETRIEVE_FAILED: ${JSON.stringify(json)}`
    );
  }

  const dataSourceId = json.data_sources?.[0]?.id;

  if (!dataSourceId) {
    throw new Error("DATA_SOURCE_ID_NOT_FOUND");
  }

  return dataSourceId;
}

async function notionQuery(databaseId, token) {
  const envDataSourceId =
    process.env.NOTION_ENGLISH_SANGDAM_DATASOURCE_ID;

  const dataSourceId =
    envDataSourceId ||
    (await getDataSourceId(databaseId, token));

  const resp = await fetch(
    `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
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
            equals: "예정",
          },
        },
        sorts: [
          {
            property: "날짜",
            direction: "ascending",
          },
        ],
        page_size: 100,
      }),
    }
  );

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(
      `DATA_SOURCE_QUERY_FAILED: ${JSON.stringify(json)}`
    );
  }

  return json.results || [];
}

async function postJandi(webhookUrl, text) {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.tosslab.jandi-v2+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: text,
    }),
  });

  if (!resp.ok) {
    const responseText = await resp.text();

    throw new Error(
      `JANDI_WEBHOOK_FAILED: ${resp.status} ${responseText}`
    );
  }
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DB_ID =
      process.env.NOTION_ENGLISH_SANGDAM_DATABASE_ID;
    const JANDI_WEBHOOK_URL =
      process.env.JANDI_ENGLISH_WEBHOOK_URL;

    if (!NOTION_TOKEN) {
      throw new Error("ENV_MISSING: NOTION_TOKEN");
    }

    if (!DB_ID) {
      throw new Error(
        "ENV_MISSING: NOTION_ENGLISH_SANGDAM_DATABASE_ID"
      );
    }

    if (!JANDI_WEBHOOK_URL) {
      throw new Error(
        "ENV_MISSING: JANDI_ENGLISH_WEBHOOK_URL"
      );
    }

    const today = kstToday();
    const header = `📋 오늘 (${today}) 영어 상담 일정`;

    const rows = await notionQuery(DB_ID, NOTION_TOKEN);

    const todays = rows.filter((page) => {
      const start =
        page.properties?.["날짜"]?.date?.start;

      return Boolean(start) && start.startsWith(today);
    });

    const lines = todays
      .map((page) => {
        const title = getTitle(page);
        const type = getMultiSelect(page, "상담유형");
        const time = formatTimeKST(
          page.properties?.["날짜"]?.date
        );

        if (!time) return "";

        const typeText = type ? ` [${type}]` : "";

        return `• 🕒 ${time} ${title}${typeText}`;
      })
      .filter(Boolean);

    const text = lines.length
      ? `${header}\n\n${lines.join("\n")}`
      : `${header}\n\n오늘 예정된 영어 상담이 없습니다.`;

    await postJandi(JANDI_WEBHOOK_URL, text);

    res.status(200).json({
      ok: true,
      target: "jandi-english-sangdam",
      count: lines.length,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "FAILED",
      detail: String(error),
    });
  }
}
