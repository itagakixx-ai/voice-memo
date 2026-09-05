import { buildPushPayload } from "@block65/webcrypto-web-push";

const ALLOWED_ORIGIN = "https://itagakixx-ai.github.io";
const VAPID_PUBLIC_KEY =
  "BC-AyMEf4PMy0h7LKiIHvTMBvW7PDLGlJAtKBoHoxSYknOQXGkhKjeC_qCpqbE6X5_qO1iZME7tipMF1rnlyy_I";
const VAPID_SUBJECT = "https://itagakixx-ai.github.io/voice-memo/";

function corsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (request.headers.get("Origin") === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }

  return headers;
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders(request),
    },
  });
}

async function secureTokenMatches(candidate, expected) {
  if (
    typeof candidate !== "string" ||
    typeof expected !== "string" ||
    candidate.length === 0 ||
    expected.length === 0 ||
    candidate.length > 1024
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;

  for (let index = 0; index < candidateBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ expectedBytes[index];
  }

  return difference === 0;
}

async function isPushTestAuthorized(request, expectedToken) {
  const authorization = request.headers.get("Authorization") || "";
  const prefix = "Bearer ";

  if (!authorization.startsWith(prefix)) {
    return false;
  }

  return secureTokenMatches(authorization.slice(prefix.length), expectedToken);
}

async function sendPushNotifications(env, payload) {
  if (typeof env.VAPID_PRIVATE_KEY !== "string" || env.VAPID_PRIVATE_KEY.length === 0) {
    throw new Error("Missing VAPID configuration");
  }
  const query = await env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id",
  ).all();
  const summary = { ok: true, attempted: query.results.length, succeeded: 0,
    invalidRemoved: 0, failed: 0, networkErrors: 0, failuresByStatus: {} };
  const vapid = { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY };
  const payloadData = JSON.stringify(payload);

  for (const subscription of query.results) {
    try {
      const requestOptions = await buildPushPayload(
        { data: payloadData, options: { ttl: 60 } },
        { endpoint: subscription.endpoint, expirationTime: null,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        vapid,
      );
      const response = await fetch(subscription.endpoint, requestOptions);
      if (response.ok) summary.succeeded += 1;
      else if (response.status === 404 || response.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
          .bind(subscription.id).run();
        summary.invalidRemoved += 1;
      } else {
        summary.failed += 1;
        const status = String(response.status);
        summary.failuresByStatus[status] = (summary.failuresByStatus[status] || 0) + 1;
      }
    } catch {
      summary.failed += 1;
      summary.networkErrors += 1;
    }
  }
  summary.ok = summary.failed === 0;
  return summary;
}

async function extractReminderMemos(controller, env) {
  const period = controller.cron === "30 23 * * *" ? "morning"
    : controller.cron === "30 8 * * *" ? "evening" : null;
  if (!period) return;
  console.log(`${period} reminder triggered`);

  try {
    const jstOffset = 9 * 60 * 60 * 1000;
    const day = 24 * 60 * 60 * 1000;
    const time = controller.scheduledTime;
    if (typeof time !== "number" || !Number.isFinite(time)) {
      throw new Error("Invalid scheduled time");
    }
    const start = Math.floor((time + jstOffset) / day) * day - jstOffset;
    const startIso = new Date(start).toISOString();
    const endIso = new Date(start + day).toISOString();
    // Compare instants rather than text so ISO offsets and milliseconds work.
    const condition = period === "morning"
      ? "completed = 0 AND julianday(created_at) < julianday(?)"
      : "completed = 0 AND julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)";
    const bounds = period === "morning" ? [startIso] : [startIso, endIso];
    const queries = [env.DB.prepare(`SELECT COUNT(*) AS count FROM memos WHERE ${condition}`).bind(...bounds)];
    // Opt in only during local verification; production defaults to counts only.
    const preview = env.REMINDER_DEBUG_PREVIEW === "true";
    if (preview) {
      queries.push(env.DB.prepare(`SELECT substr(text, 1, 100) AS text FROM memos WHERE ${condition} ORDER BY julianday(created_at), id LIMIT 5`).bind(...bounds));
    }
    const results = await env.DB.batch(queries);
    if (results.some((result) => result.success === false)) throw new Error("Query failed");
    const count = results[0].results[0].count;
    console.log("reminder memo count", { period, count });
    if (preview) console.log("reminder memo preview", { period, texts: results[1].results.map((memo) => memo.text) });
    return { period, count };
  } catch {
    console.error("reminder memo extraction failed", { period });
    // Mark the scheduled invocation failed without exposing the original error.
    throw new Error("Reminder memo extraction failed");
  }
}

export default {
  async scheduled(controller, env) {
    const reminder = await extractReminderMemos(controller, env);
    if (!reminder || reminder.count === 0) return;
    const body = reminder.period === "morning"
      ? `未対応メモが${reminder.count}件あります`
      : `今日の未対応メモが${reminder.count}件あります`;
    const summary = await sendPushNotifications(env, { title: "声メモ", body, url: "./" });
    console.log("scheduled Web Push completed", { period: reminder.period,
      memoCount: reminder.count, attempted: summary.attempted,
      succeeded: summary.succeeded, invalidRemoved: summary.invalidRemoved,
      failed: summary.failed, networkErrors: summary.networkErrors });
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return jsonResponse(request, { error: "Origin not allowed" }, 403);
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/memos") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT
            id,
            text,
            completed,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM memos
          ORDER BY created_at DESC`,
        ).all();

        const memos = results.map((memo) => ({
          ...memo,
          completed: Boolean(memo.completed),
        }));

        return jsonResponse(request, memos);
      } catch (error) {
        console.error("D1 GET /memos error", error);
        return jsonResponse(request, { error: "Database error" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/memo") {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return jsonResponse(request, { error: "Origin not allowed" }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(request, { error: "Invalid JSON" }, 400);
      }

      const { text, completed, createdAt } = body;
      if (
        typeof text !== "string" ||
        text.trim() === "" ||
        typeof completed !== "boolean" ||
        typeof createdAt !== "string" ||
        createdAt.trim() === ""
      ) {
        return jsonResponse(request, { error: "Invalid memo data" }, 400);
      }

      try {
        const result = await env.DB.prepare(
          `INSERT INTO memos (text, completed, created_at, updated_at)
           VALUES (?, ?, ?, NULL)`,
        )
          .bind(text.trim(), completed ? 1 : 0, createdAt)
          .run();

        return jsonResponse(
          request,
          { ok: true, id: result.meta.last_row_id },
          201,
        );
      } catch (error) {
        console.error("D1 POST /memo error", error);
        return jsonResponse(request, { error: "Database error" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/push/subscribe") {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return jsonResponse(request, { error: "Origin not allowed" }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(request, { error: "Invalid JSON" }, 400);
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse(request, { error: "Invalid subscription data" }, 400);
      }

      const { endpoint, p256dh, auth } = body;
      let endpointUrl;
      try {
        endpointUrl = new URL(endpoint);
      } catch {
        return jsonResponse(request, { error: "Invalid subscription data" }, 400);
      }

      const isBase64Url = (value, maxLength) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= maxLength &&
        /^[A-Za-z0-9_-]+$/.test(value);

      if (
        typeof endpoint !== "string" ||
        endpoint.length > 4096 ||
        endpointUrl.protocol !== "https:" ||
        !isBase64Url(p256dh, 256) ||
        !isBase64Url(auth, 256)
      ) {
        return jsonResponse(request, { error: "Invalid subscription data" }, 400);
      }

      const now = new Date().toISOString();

      try {
        await env.DB.prepare(
          `INSERT INTO push_subscriptions (
            endpoint,
            p256dh,
            auth,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            updated_at = excluded.updated_at`,
        )
          .bind(endpoint, p256dh, auth, now, now)
          .run();

        return jsonResponse(request, { ok: true });
      } catch (error) {
        console.error("D1 POST /push/subscribe error", error);
        return jsonResponse(request, { error: "Database error" }, 500);
      }
    }

    // Temporary, fail-closed diagnostic route; expires without another deploy.
    if (request.method === "POST" && url.pathname === "/push/auth-check") {
      const expiresAt = Date.parse(env.PUSH_AUTH_CHECK_EXPIRES_AT || "");
      if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        return jsonResponse(request, { error: "Not found" }, 404);
      }
      const authorization = request.headers.get("Authorization");
      const extracted = typeof authorization === "string" &&
        authorization.startsWith("Bearer ") && authorization.length > 7;
      const candidate = extracted ? authorization.slice(7) : "";
      const expected = env.PUSH_TEST_TOKEN;
      const secretLength = typeof expected === "string" ? expected.length : null;
      const response = jsonResponse(request, {
        authorizationPresent: authorization !== null,
        bearerExtracted: extracted,
        candidateLength: candidate.length,
        secretLength,
        lengthsMatch: secretLength === candidate.length,
        comparisonMatches: await secureTokenMatches(candidate, expected),
      });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (request.method === "POST" && url.pathname === "/push/test") {
      if (!(await isPushTestAuthorized(request, env.PUSH_TEST_TOKEN))) {
        return jsonResponse(request, { error: "Unauthorized" }, 401);
      }

      try {
        const summary = await sendPushNotifications(env, {
          title: "声メモ", body: "テスト通知です", url: "./",
        });
      console.info("Web Push test completed", {
        attempted: summary.attempted,
        succeeded: summary.succeeded,
        invalidRemoved: summary.invalidRemoved,
        failed: summary.failed,
      });
      return jsonResponse(request, summary);
      } catch {
        console.error("Web Push test failed");
        return jsonResponse(request, { error: "Push delivery error" }, 500);
      }
    }

    const memoIdMatch = url.pathname.match(/^\/memos\/(\d+)$/);
    if (request.method === "PATCH" && memoIdMatch) {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return jsonResponse(request, { error: "Origin not allowed" }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(request, { error: "Invalid JSON" }, 400);
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse(request, { error: "Invalid memo data" }, 400);
      }

      const hasText = Object.prototype.hasOwnProperty.call(body, "text");
      const hasCompleted = Object.prototype.hasOwnProperty.call(
        body,
        "completed",
      );

      if (!hasText && !hasCompleted) {
        return jsonResponse(request, { error: "No update fields provided" }, 400);
      }

      if (
        (hasText && (typeof body.text !== "string" || body.text.trim() === "")) ||
        (hasCompleted && typeof body.completed !== "boolean")
      ) {
        return jsonResponse(request, { error: "Invalid memo data" }, 400);
      }

      const id = Number(memoIdMatch[1]);
      const updatedAt = new Date().toISOString();

      try {
        const assignments = [];
        const values = [];

        if (hasText) {
          assignments.push("text = ?");
          values.push(body.text.trim());
        }
        if (hasCompleted) {
          assignments.push("completed = ?");
          values.push(body.completed ? 1 : 0);
        }
        assignments.push("updated_at = ?");
        values.push(updatedAt, id);

        const updateResult = await env.DB.prepare(
          `UPDATE memos
           SET ${assignments.join(", ")}
           WHERE id = ?`,
        )
          .bind(...values)
          .run();

        if (updateResult.meta.changes === 0) {
          return jsonResponse(request, { error: "Memo not found" }, 404);
        }

        const memo = await env.DB.prepare(
          `SELECT
            id,
            text,
            completed,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM memos
          WHERE id = ?`,
        )
          .bind(id)
          .first();

        if (!memo) {
          return jsonResponse(request, { error: "Memo not found" }, 404);
        }

        return jsonResponse(request, {
          ...memo,
          completed: Boolean(memo.completed),
        });
      } catch (error) {
        console.error("D1 PATCH /memos/:id error", error);
        return jsonResponse(request, { error: "Database error" }, 500);
      }
    }

    if (request.method === "DELETE" && memoIdMatch) {
      if (origin && origin !== ALLOWED_ORIGIN) {
        return jsonResponse(request, { error: "Origin not allowed" }, 403);
      }

      const id = Number(memoIdMatch[1]);

      try {
        const deleteResult = await env.DB.prepare(
          "DELETE FROM memos WHERE id = ?",
        )
          .bind(id)
          .run();

        if (deleteResult.meta.changes === 0) {
          return jsonResponse(request, { error: "Memo not found" }, 404);
        }

        return jsonResponse(request, { ok: true, id });
      } catch (error) {
        console.error("D1 DELETE /memos/:id error", error);
        return jsonResponse(request, { error: "Database error" }, 500);
      }
    }

    return jsonResponse(request, { error: "Not found" }, 404);
  },
};
