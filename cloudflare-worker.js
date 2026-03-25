/**
 * アネストCRM — Cloudflare Worker
 * Notion API への CORS プロキシ + レスポンス整形エンドポイント
 *
 * 【デプロイ手順】
 * 1. https://workers.cloudflare.com にログイン
 * 2. 「Workers & Pages」→「Create application」→「Create Worker」
 * 3. このコードを貼り付けて「Deploy」
 * 4. Settings → Variables → 「NOTION_TOKEN」を追加（値: Notionのインテグレーショントークン）
 * 5. Worker URL（例: https://anest-crm.xxxxx.workers.dev）をコピーしてHTMLの設定画面に入力
 *
 * 【Notion 商談DB 拡張プロパティ】
 *   MRR            (Number)       — 月額SaaS利用料
 *   初期費用        (Number)       — ハードウェア代等
 *   予定車両数      (Number)       — 導入予定車両台数
 *   対象製品        (Multi-select) — "GrowthBOX", "BSS for ALC", "ドラレコ/デジタコ" 等
 *   販売チャネル    (Select)       — "直販", "代理店経由"
 */

export default {
  async fetch(request, env) {

    // ── CORS ヘッダー ──────────────────────────────────────────
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 整形エンドポイント: /api/deals?db={dbId} ─────────────
    //    Notion の商談DBをクエリし、新スキーマ込みで整形して返す
    if (path === '/api/deals') {
      const dbId = url.searchParams.get('db');
      if (!dbId) {
        return jsonResp({ error: 'db parameter required' }, 400, cors);
      }
      try {
        const pages = await queryAllPages(env, dbId, []);
        const deals = pages.map(page => mapDeal(page));
        return jsonResp({ deals, total: deals.length }, 200, cors);
      } catch (err) {
        return jsonResp({ error: 'Failed to fetch deals', detail: err.message }, 502, cors);
      }
    }

    // ── 整形エンドポイント: /api/customers?db={dbId} ──────────
    if (path === '/api/customers') {
      const dbId = url.searchParams.get('db');
      if (!dbId) {
        return jsonResp({ error: 'db parameter required' }, 400, cors);
      }
      try {
        const pages = await queryAllPages(env, dbId, []);
        const customers = pages.map(page => mapCustomer(page));
        return jsonResp({ customers, total: customers.length }, 200, cors);
      } catch (err) {
        return jsonResp({ error: 'Failed to fetch customers', detail: err.message }, 502, cors);
      }
    }

    // ── 整形エンドポイント: /api/activities?db={dbId} ─────────
    if (path === '/api/activities') {
      const dbId = url.searchParams.get('db');
      if (!dbId) {
        return jsonResp({ error: 'db parameter required' }, 400, cors);
      }
      try {
        const pages = await queryAllPages(env, dbId, [{ property: '活動日', direction: 'descending' }]);
        const activities = pages.map(page => mapActivity(page));
        return jsonResp({ activities, total: activities.length }, 200, cors);
      } catch (err) {
        return jsonResp({ error: 'Failed to fetch activities', detail: err.message }, 502, cors);
      }
    }

    // ── 汎用 Notion プロキシ（既存互換） ─────────────────────
    if (!path.startsWith('/v1/')) {
      return jsonResp({ error: 'Invalid path' }, 400, cors);
    }

    const notionUrl = `https://api.notion.com${path}${url.search}`;
    const body = ['POST', 'PATCH', 'PUT'].includes(request.method)
      ? await request.text()
      : undefined;

    let notionResp;
    try {
      notionResp = await fetch(notionUrl, {
        method:  request.method,
        headers: {
          'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body,
      });
    } catch (err) {
      return jsonResp({ error: 'Notion API connection failed', detail: err.message }, 502, cors);
    }

    const responseText = await notionResp.text();
    return new Response(responseText, {
      status:  notionResp.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};

// ═══════════════════════════════════════════════════════════
//  ヘルパー関数
// ═══════════════════════════════════════════════════════════

function jsonResp(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Notion DB の全ページを取得（ページネーション対応） */
async function queryAllPages(env, dbId, sorts) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100, sorts };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion ${res.status}: ${errText}`);
    }

    const data = await res.json();
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return pages;
}

/** rich_text / title からプレーンテキストを取得 */
function rt(arr) { return arr?.[0]?.plain_text || ''; }

/**
 * 商談ページ → フラット JSON
 * KPIOS連携を見据え、MRR / 初期費用 / 予定車両数 / 対象製品 / 販売チャネル を追加
 */
function mapDeal(page) {
  const p = page.properties;
  return {
    id:              page.id,
    customer:        rt(p['顧客名']?.title),
    product:         p['製品']?.select?.name       || '',
    stage:           p['ステージ']?.select?.name   || 'リード',
    type:            p['種別']?.select?.name       || '新規',
    amount:          p['金額']?.number             || 0,
    vehicles:        p['台数']?.number             || 0,
    assignee:        rt(p['担当者']?.rich_text),
    nextAction:      rt(p['次回アクション']?.rich_text),
    nextDate:        p['次回日']?.date?.start      || '',
    notes:           rt(p['メモ']?.rich_text),

    // ── KPIOS連携用 拡張フィールド ──
    mrr:             p['MRR']?.number              || 0,
    initialCost:     p['初期費用']?.number          || 0,
    plannedVehicles: p['予定車両数']?.number        || 0,
    targetProducts:  (p['対象製品']?.multi_select || []).map(s => s.name),
    salesChannel:    p['販売チャネル']?.select?.name || '',

    createdAt:       page.created_time?.split('T')[0] || '',
    updatedAt:       page.last_edited_time?.split('T')[0] || '',
  };
}

/**
 * 顧客ページ → フラット JSON
 * 車両用途 / 既存機器メーカー / 抱えている課題 を追加
 */
function mapCustomer(page) {
  const p = page.properties;
  return {
    id:              page.id,
    name:            rt(p['会社名']?.title),
    industry:        p['業種']?.select?.name         || '',
    region:          p['地域']?.select?.name         || '',
    fleetSize:       p['保有台数']?.number            || 0,
    contact:         rt(p['担当者名']?.rich_text),
    phone:           rt(p['電話番号']?.rich_text),
    products:        (p['導入済み製品']?.multi_select || []).map(s => s.name),
    notes:           rt(p['メモ']?.rich_text),
    // 拡張フィールド
    vehicleUsage:    (p['車両用途']?.multi_select || []).map(s => s.name),
    existingVendor:  rt(p['既存機器メーカー']?.rich_text),
    challenges:      (p['抱えている課題']?.multi_select || []).map(s => s.name),
    createdAt:       page.created_time?.split('T')[0] || '',
  };
}

/** 活動記録ページ → フラット JSON */
function mapActivity(page) {
  const p = page.properties;
  return {
    id:       page.id,
    customer: rt(p['顧客名']?.title),
    type:     p['種別']?.select?.name  || '📝',
    content:  rt(p['内容']?.rich_text),
    date:     p['活動日']?.date?.start || '',
    assignee: rt(p['担当者']?.rich_text),
  };
}
