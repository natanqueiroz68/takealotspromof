// api/cron.js
// Automated daily order status email dispatcher.
// Evaluates every active order in Upstash Redis, calculates exact days elapsed
// in Africa/Johannesburg timezone, and sends the corresponding daily tracking update.
//
// Guaranteed:
// 1. Zero date failure: derived from order.received_date and order.delivery_date in SA timezone.
// 2. Idempotent: strictly 1 email per day per order (tracked via order.last_daily_email_date).
// 3. Automated via Vercel Cron or manual GET /api/cron?secret=...

'use strict';

const fs = require('fs');
const path = require('path');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL
  || process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_URL
  || process.env.REDIS_URL
  || 'https://engaging-gibbon-246981.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.KV_REST_API_TOKEN
  || process.env.REDIS_TOKEN
  || 'gQAAAAAAA8TFAAIgcDJmMjljODQzODc4NWU0MGM0OWUzOTA0M2JkZDFlNTUyNg';
const SA_TIMEZONE = 'Africa/Johannesburg';

const VISIONSPY_KEY = process.env.VISIONSPY_API_KEY
  || process.env.VISION_SPY_API_KEY
  || process.env.VISIONSPY_KEY
  || 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
const SENDER_ID = process.env.VISIONSPY_SENDER_ID || 'd86d0b35-3472-4aac-af74-4bd52308ea07';

async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  return res.ok;
}

async function getAllOrderKeys() {
  if (!REDIS_URL || !REDIS_TOKEN) return [];
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['KEYS', 'order:*']),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.result) ? data.result : [];
}

function formatSADate(dateInput, type = 'short') {
  if (!dateInput) return '–';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '–';
  const options = {
    timeZone: SA_TIMEZONE,
    weekday: type === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: type === 'long' ? 'long' : 'short',
    year: 'numeric'
  };
  return new Intl.DateTimeFormat('en-GB', options).format(d);
}

function getSADateIso(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function getTodaySAIso() {
  return getSADateIso(new Date());
}

function calculateSADaysElapsed(receivedDateInput, nowInput = new Date()) {
  const pIso = getSADateIso(receivedDateInput);
  const nowIso = getSADateIso(nowInput);
  if (!pIso || !nowIso) return 0;
  const [py, pm, pd] = pIso.split('-').map(Number);
  const [ny, nm, nd] = nowIso.split('-').map(Number);
  const pUtc = Date.UTC(py, pm - 1, pd);
  const nowUtc = Date.UTC(ny, nm - 1, nd);
  return Math.floor((nowUtc - pUtc) / 86400000);
}

function loadEmailTemplate() {
  const candidates = [
    path.join(process.cwd(), 'email.index'),
    path.join(__dirname, '..', 'email.index'),
    path.join(__dirname, 'email.index'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (_) {}
  }
  return null;
}

// 8 distinct daily tracking stages corresponding to days 1..8
const DAILY_STAGES = {
  1: {
    status: 'IN_TRANSIT',
    subject: (id) => `Order Update: #${id} is Packed & Ready for Dispatch 📦`,
    header: 'Order Packed & Ready',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your Takealot order <strong class="email-heading" style="color: #111827;">${id}</strong> has been carefully packed and verified at our fulfillment center.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        It is now in the queue for pickup by our express courier partner. Your estimated delivery date remains on schedule for <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Your Takealot order ${id} has been packed at our fulfillment center and is ready for courier collection. Scheduled delivery: ${delDate}.`
  },
  2: {
    status: 'IN_TRANSIT',
    subject: (id) => `Your Takealot Order #${id} Has Shipped! 🚚`,
    header: 'Order Shipped & In Transit',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Great news! Your Takealot order <strong class="email-heading" style="color: #111827;">${id}</strong> has departed our main warehouse and is in transit.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your parcel is travelling via express road freight. Expected delivery date: <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Great news! Your Takealot order ${id} has shipped from our main warehouse and is on its way. Estimated delivery: ${delDate}.`
  },
  3: {
    status: 'IN_TRANSIT',
    subject: (id) => `In Transit: Order #${id} is on Route to Regional Hub 🚛`,
    header: 'In Transit: Hub Transfer',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your package for order <strong class="email-heading" style="color: #111827;">${id}</strong> is progressing smoothly along the inter-provincial transit corridor.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Next stop is the regional sorting hub. Delivery is guaranteed on track for <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Order ${id} is currently moving smoothly along the transit corridor towards your regional hub. Delivery date: ${delDate}.`
  },
  4: {
    status: 'IN_TRANSIT',
    subject: (id) => `Transit Update: Order #${id} Arrived at Regional Hub 🏢`,
    header: 'Arrived at Regional Hub',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your Takealot order <strong class="email-heading" style="color: #111827;">${id}</strong> has safely arrived at the regional sorting facility.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        It is now being sorted and prepared for transfer to the local distribution depôt. Estimated delivery: <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Takealot order ${id} has arrived at the regional sorting facility and is being prepped for local transfer. Scheduled delivery: ${delDate}.`
  },
  5: {
    status: 'IN_TRANSIT',
    subject: (id) => `Tracking Update: Order #${id} Cleared Sorting Facility 📋`,
    header: 'Cleared Regional Sorting',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        All sorting checks for order <strong class="email-heading" style="color: #111827;">${id}</strong> have passed successfully.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your parcel is loaded on the local freight connection heading directly to your local delivery depôt. Expected delivery: <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Order ${id} has cleared sorting and is heading on the local connection to your area. Delivery scheduled for ${delDate}.`
  },
  6: {
    status: 'IN_TRANSIT',
    subject: (id) => `Almost There: Order #${id} Arrived at Local Depôt 📍`,
    header: 'Arrived at Local Depôt',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your parcel for order <strong class="email-heading" style="color: #111827;">${id}</strong> has checked in at the final local courier depôt nearest to your address.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        The courier routing team is scheduling the final delivery run. Guaranteed delivery date: <strong class="email-heading" style="color: #111827;">${delDate}</strong>.
      </p>`,
    plain: (name, id, delDate) => `Your order ${id} has arrived at the local courier depôt nearest to your delivery address. Delivery date: ${delDate}.`
  },
  7: {
    status: 'IN_TRANSIT',
    subject: (id) => `Scheduled for Tomorrow: Takealot Order #${id} ⏰`,
    header: 'Scheduled for Tomorrow',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Exciting news! Your Takealot order <strong class="email-heading" style="color: #111827;">${id}</strong> is assigned to tomorrow's delivery route.
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Delivery will occur tomorrow, <strong class="email-heading" style="color: #16a34a;">${delDate}</strong>. You will receive an SMS when the driver departs with your parcel.
      </p>`,
    plain: (name, id, delDate) => `Your Takealot order ${id} is assigned to tomorrow's delivery route (${delDate}). You will receive an SMS on delivery day.`
  },
  8: {
    status: 'DELIVERED',
    subject: (id) => `Delivered: Your Takealot Order #${id} 📦`,
    header: 'Order Delivered',
    message: (name, id, delDate) => `
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Hi <strong class="email-heading" style="color: #111827;">${name}</strong>,
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Your Takealot order <strong class="email-heading" style="color: #111827;">${id}</strong> has been successfully delivered!
      </p>
      <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        Package delivered on <strong class="email-heading" style="color: #16a34a;">${delDate}</strong>.
      </p>
      <p class="email-text" style="margin: 0 0 24px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
        We hope you enjoy your new purchase! If you have any feedback or questions, our customer care team is always here to assist.
      </p>`,
    plain: (name, id, delDate) => `Your Takealot order ${id} has been successfully delivered on ${delDate}! We hope you enjoy your purchase.`
  }
};

function renderDailyEmail(order, stageInfo) {
  const template = loadEmailTemplate();
  if (!template) {
    console.error('[cron-daily] Failed to load email.index template');
    return null;
  }

  const orderDateShort = formatSADate(order.received_date, 'short');
  const deliveryDateLong = formatSADate(order.delivery_date, 'long');
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const isDelivered = stageInfo.status === 'DELIVERED';

  let html = template
    .replace(/Payment Confirmation/g, stageInfo.header)
    .replace(/Manage Order/g, isDelivered ? 'View Order Details' : 'Track Your Package')
    .replace(/\{\{customer_name\}\}/g, customerName)
    .replace(/\{\{order_number\}\}/g, orderNumber)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, formatSADate(order.delivery_date, 'short'))
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{variant\}\}/g, order.variant || 'Space Grey');

  const regexMsg = /<!-- 3\. MAIN MESSAGE BODY -->[\s\S]*?<!-- BULLETPROOF MANAGE ORDER BUTTON -->/;
  const customMessage = stageInfo.message(customerName, orderNumber, deliveryDateLong);
  const replacement = `<!-- 3. MAIN MESSAGE BODY -->\n          <tr>\n            <td class="mobile-padding" style="padding: 26px 24px 18px 24px;">\n${customMessage}\n              <!-- BULLETPROOF MANAGE ORDER BUTTON -->`;
  html = html.replace(regexMsg, replacement);

  return html;
}

function renderDailyPlainText(order, stageInfo) {
  const orderDateShort = formatSADate(order.received_date, 'short');
  const deliveryDateLong = formatSADate(order.delivery_date, 'long');
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const trackUrl = `https://takelaotpromosi.vercel.app/track.html?order=${orderNumber}`;

  return [
    `TAKEALOT DAILY ORDER UPDATE`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${customerName},`,
    ``,
    stageInfo.plain(customerName, orderNumber, deliveryDateLong),
    ``,
    `TRACK YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery Date: ${deliveryDateLong}`,
    `- Delivery Method: Courier`,
    ``,
    `ITEMS IN THIS ORDER:`,
    `- 1x ${order.product_name || '15.6-inch Laptop N5095 16GB RAM 256GB SSD Intel Quad Windows 11'} - R ${order.product_price || 999}.00`,
    ``,
    `Need help? Find answers at https://takelaotpromosi.vercel.app`,
    ``,
    `Regards,`,
    `The Takealot Team`,
    `----------------------------------------------------------------------`,
    `Takealot Online (Pty) Ltd • Cape Town, South Africa`,
  ].join('\n');
}

module.exports = async function handler(req, res) {
  const startTime = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  const todayIso = getTodaySAIso();

  // Optional CRON_SECRET verification (supports both Vercel cron automated auth and manual tests)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'] || '';
    const querySecret = req.query.secret || '';
    if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: invalid cron secret' });
    }
  }

  const keys = await getAllOrderKeys();
  if (keys.length === 0) {
    return res.status(200).json({
      ok: true,
      today_sa: todayIso,
      total_orders_evaluated: 0,
      sent_count: 0,
      already_sent_today: 0,
      skipped_day_zero: 0,
      already_delivered: 0,
      elapsed_ms: Date.now() - startTime,
      message: 'No orders found in database',
      results: []
    });
  }

  const results = [];
  let sentCount = 0;
  let alreadySentCount = 0;
  let skippedDayZeroCount = 0;
  let alreadyDeliveredCount = 0;
  const now = new Date();

  for (const k of keys) {
    try {
      const order = await kv_get(k);
      if (!order || !order.customer_email || !order.received_date) continue;

      // Fallback: If legacy order lacks delivery_date, ensure 8 days in SA timezone
      if (!order.delivery_date) {
        const rTime = new Date(order.received_date).getTime();
        order.delivery_date = new Date(rTime + 8 * 86400000).toISOString();
      }

      // Calculate days elapsed from original purchase midnight to today midnight in SA timezone
      const daysElapsed = calculateSADaysElapsed(order.received_date, now);

      // If order was placed today (day 0), confirmation email was already handled by purchase flow
      if (daysElapsed <= 0) {
        skippedDayZeroCount++;
        results.push({
          order_id: order.order_id,
          days_elapsed: daysElapsed,
          today: todayIso,
          action: 'SKIPPED_DAY_ZERO',
          note: 'Day 0 is handled on order creation / checkout'
        });
        continue;
      }

      // If already delivered and completed, do not send further emails
      if (daysElapsed > 8 && (order.status === 'DELIVERED' || order.email_delivered_status === 'SENT')) {
        alreadyDeliveredCount++;
        results.push({
          order_id: order.order_id,
          days_elapsed: daysElapsed,
          today: todayIso,
          action: 'ALREADY_DELIVERED'
        });
        continue;
      }

      // Idempotency: verify if an email was already sent today for this order
      if (order.last_daily_email_date === todayIso && req.query.force !== '1') {
        alreadySentCount++;
        results.push({
          order_id: order.order_id,
          stage: Math.min(Math.max(daysElapsed, 1), 8),
          days_elapsed: daysElapsed,
          today: todayIso,
          action: 'ALREADY_SENT_TODAY',
          last_sent: order.last_daily_email_date
        });
        continue;
      }

      // Select stage (capped at day 8)
      const stageDay = Math.min(Math.max(daysElapsed, 1), 8);
      const stageInfo = DAILY_STAGES[stageDay];
      if (!stageInfo) continue;

      const html = renderDailyEmail(order, stageInfo);
      const text = renderDailyPlainText(order, stageInfo);
      const subject = stageInfo.subject(order.order_id);

      // Dispatch via VisionSpy
      const vsRes = await fetch('https://visionspyads.com/api/public/v1/email/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VISIONSPY_KEY.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Takealot-Order-Notification/1.0',
        },
        body: JSON.stringify({
          sender_id: SENDER_ID,
          to: order.customer_email,
          subject,
          html,
          text,
        }),
      });

      const vsData = await vsRes.json().catch(() => null);
      if (vsRes.ok && vsData && (vsData.ok !== false && vsData.success !== false)) {
        order.last_daily_email_date = todayIso;
        order.status = stageInfo.status;
        order.daily_emails_sent = (order.daily_emails_sent || []).concat([{
          day: stageDay,
          date: todayIso,
          message_id: vsData.id || null
        }]);

        if (stageDay === 2 || stageDay === 1) {
          order.email_shipped_status = 'SENT';
          order.email_shipped_at = new Date().toISOString();
        }
        if (stageDay === 8) {
          order.email_delivered_status = 'SENT';
          order.email_delivered_at = new Date().toISOString();
        }

        await kv_set(k, order);
        sentCount++;
        results.push({
          order_id: order.order_id,
          stage: stageDay,
          sent: true,
          to: order.customer_email,
          subject,
          message_id: vsData.id || null
        });
      } else {
        results.push({
          order_id: order.order_id,
          stage: stageDay,
          sent: false,
          error: vsData
        });
      }
    } catch (e) {
      results.push({ key: k, error: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    today_sa: todayIso,
    total_orders_evaluated: keys.length,
    sent_count: sentCount,
    already_sent_today: alreadySentCount,
    skipped_day_zero: skippedDayZeroCount,
    already_delivered: alreadyDeliveredCount,
    elapsed_ms: Date.now() - startTime,
    results
  });
};
