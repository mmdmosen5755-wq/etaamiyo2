// Post management from the group's single "⚙️ مدیریت پست" button, and the group / supervisor settings screen.
import { extract } from "./bot";
import { dec } from "./crypto";
import { PostRow, UserRow, clearSession, getUser, now, setSession } from "./db";
import * as eitaa from "./eitaa";
import { Env } from "./env";
import { clearSupervisor, dropGroup, getGroup, getPub, kvGet, lessonNote, markGroup, removeFromGroup, report, saveGroup, sendCopy, setSupervisor, setVerdict, supToken } from "./group";
import { addLesson, learnFromError } from "./review";
import { loadMedia } from "./scheduler";
import * as tg from "./tg";
import { Btn, TgCallback, TgMessage, ikb } from "./tg";
import { esc } from "./util";

type Ctx = { env: Env; wait: (p: Promise<unknown>) => void };
const MAX_CAPTION = 1000;
const back = (id: number): Btn[] => [["↩️ برگشت", `pm:back:${id}`]];

const getPost = (env: Env, id: number) => env.DB.prepare("SELECT * FROM ea_posts WHERE id=?").bind(id).first<PostRow & { eitaa_message_id?: string }>();
const ACTIVE = new Set(["pending", "sending", "sent", "held", "failed", "draft"]);
const STATUS: Record<string, string> = { pending: "⏳ در صف ارسال", sending: "⏳ در حال ارسال", sent: "✅ در ایتا منتشر شده", held: "⏸ نگه‌داشته شد (در ایتا نیست)", failed: "❌ ارسال ناموفق", draft: "📝 پیش‌نویس", deleted: "🗑 حذف شده", replaced: "♻️ جایگزین شده", canceled: "🚫 لغو شده" };

// ------------------------------------------------------------------ the manage screen
export async function open(c: Ctx, u: UserRow, postId: number): Promise<void> {
  const { env } = c;
  await clearSession(env, u.id);
  const p = await getPost(env, postId);
  if (!p || p.user_id !== u.id) return void (await tg.send(env, u.id, "این پست پیدا نشد یا مال شما نیست."));
  try {
    let file = null;
    if (p.kind === "file") { try { file = await loadMedia(env, p); } catch { /* preview without the file */ } }
    await sendCopy(env, { chat: u.id }, p, file);
  } catch (e) { await tg.send(env, u.id, `<i>(پیش‌نمایش پست ممکن نشد: ${esc((e as Error).message)})</i>\n${esc(p.text.slice(0, 1500))}`); }
  const pub = await getPub(env, p.id);
  const next = pub?.note?.startsWith("replaced_by:") ? Number(pub.note.split(":")[1]) : 0;
  const st = `${STATUS[p.status] || p.status}${p.status === "held" || p.status === "failed" ? `\n<i>${esc(p.error)}</i>` : ""}`;
  if (!ACTIVE.has(p.status)) {
    return void (await tg.send(env, u.id, `<b>پست #${p.id}</b>\n${st}${next ? "\nنسخه‌ی جدید: #" + next : ""}`, next ? ikb([[["📄 باز کردن نسخه‌ی جدید", `pm:open:${next}`]]]) : undefined));
  }
  await tg.send(env, u.id, `<b>پست #${p.id}</b> · ${st}\n\nچه کاری می‌خواهید انجام دهید؟`, ikb([
    [["🚩 گزارش خطا", `pm:err:${p.id}`], ["✏️ تصحیح", `pm:fix:${p.id}`]],
    [["🗑 حذف پیام", `pm:del:${p.id}`], ["🖼 افزودن عکس/ویدیو و ارسال مجدد", `pm:media:${p.id}`]],
  ]));
}

// ------------------------------------------------------------------ removing / replacing
/** Removes the group copy and (best effort) the Eitaa message. Eitaayar's API documents no delete method, so Eitaa deletion may be impossible. */
export async function removePost(env: Env, p: PostRow & { eitaa_message_id?: string }, status: "deleted" | "replaced" | "canceled"): Promise<{ eitaa: "removed" | "manual" | "none"; error: string }> {
  await removeFromGroup(env, p.id);
  let eitaaRes: "removed" | "manual" | "none" = "none", error = "";
  if (p.status === "sent") {
    const user = await getUser(env, p.user_id), ch = await env.DB.prepare("SELECT chat_id FROM ea_channels WHERE id=?").bind(p.channel_id).first<{ chat_id: string }>();
    const token = user ? await dec(env.SECRET_KEY, user.eitaa_token_enc) : "";
    if (token && ch) { const r = await eitaa.deleteMessage(env, token, ch.chat_id, p.eitaa_message_id || ""); eitaaRes = r.ok ? "removed" : "manual"; error = r.error; }
    else eitaaRes = "manual";
  }
  await env.DB.prepare("UPDATE ea_posts SET status=? WHERE id=?").bind(status, p.id).run();
  return { eitaa: eitaaRes, error };
}
const eitaaNote = async (env: Env, p: PostRow & { eitaa_message_id?: string }, r: { eitaa: string; error: string }): Promise<string> => {
  if (r.eitaa !== "manual") return "";
  const ch = await env.DB.prepare("SELECT chat_id, title FROM ea_channels WHERE id=?").bind(p.channel_id).first<{ chat_id: string; title: string }>();
  return `\n\n⚠️ ایتایار در API خود «حذف پیام» ندارد، پس نسخه‌ی قبلی هنوز در ایتا مانده${p.eitaa_message_id ? ` (پیام ${esc(p.eitaa_message_id)})` : ""}${ch ? ` — لطفاً آن را در کانال «${esc(ch.title)}» دستی حذف کنید` : ""}.${r.error ? `\n<i>${esc(r.error.slice(0, 120))}</i>` : ""}`;
};

type Patch = Partial<Pick<PostRow, "text" | "kind" | "file_id" | "file_name" | "src_url">> & { keepJob?: boolean };
/** Creates the replacement post (same channel/options), removes the old one, and lets the cron deliver the new one: group first, then the supervisor, then Eitaa. */
export async function replacePost(env: Env, old: PostRow & { eitaa_message_id?: string }, patch: Patch): Promise<{ id: number; note: string }> {
  const n = { ...old, ...patch };
  const r = await env.DB.prepare("INSERT INTO ea_posts(user_id,channel_id,kind,text,file_id,file_name,title,silent,pin,view_delete,run_at,status,created_at,src_url,job_id,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,'')")
    .bind(old.user_id, old.channel_id, n.kind, n.text, n.file_id, n.file_name, old.title, old.silent, old.pin, old.view_delete, now(), now(), n.src_url, patch.keepJob ? old.job_id : null).run();
  const id = r.meta.last_row_id as number;
  const rm = await removePost(env, old, "replaced");
  await setVerdict(env, old.id, old.user_id, "replaced", `replaced_by:${id}`);
  return { id, note: await eitaaNote(env, old, rm) };
}

// ------------------------------------------------------------------ callbacks
export async function onCallback(c: Ctx, u: UserRow, q: TgCallback, act: string, arg: string): Promise<void> {
  const { env } = c, id = Number(arg);
  await tg.answer(env, q.id);
  if (act === "open" || act === "back") return open(c, u, id);
  const p = await getPost(env, id);
  if (!p || p.user_id !== u.id) return void (await tg.send(env, u.id, "این پست پیدا نشد."));
  if (!ACTIVE.has(p.status)) return open(c, u, id);
  switch (act) {
    case "err": await setSession(env, u.id, "pm_err", { id }); return void (await tg.send(env, u.id, "🚩 لطفاً خطا را بنویسید (مثلاً: «آخر متن آیدی کانال دیگری مانده» یا «تاریخ اشتباه است»).\nاز روی آن یک قانون یاد می‌گیرم تا تکرار نشود و اگر بشود درستش می‌کنم.", ikb([back(id)])));
    case "fix": await setSession(env, u.id, "pm_fix", { id }); return void (await tg.send(env, u.id, "✏️ متن و/یا عکس و ویدیوی جدید را بفرستید تا جایگزین شود.\n• فقط متن ← رسانه‌ی قبلی می‌ماند\n• فقط عکس/ویدیو ← متن قبلی می‌ماند\n• هر دو (عکس/ویدیو با کپشن) ← هر دو عوض می‌شود", ikb([back(id)])));
    case "media": await setSession(env, u.id, "pm_media", { id }); return void (await tg.send(env, u.id, "🖼 عکس یا ویدیو را بفرستید. پیام قبلی پاک می‌شود و پست جدید (با همان متن و این رسانه) بارگذاری می‌شود.", ikb([back(id)])));
    case "del": return void (await tg.send(env, u.id, `🗑 پست #${id} حذف شود؟${p.status === "sent" ? "\n(از گروه پاک می‌شود؛ حذف از ایتا بستگی به پشتیبانی ایتایار دارد)" : ""}`, ikb([[["✅ بله، حذف کن", `pm:dy:${id}`], ["↩️ برگشت", `pm:back:${id}`]]])));
    case "dy": {
      const r = await removePost(env, p, "deleted");
      await setVerdict(env, id, u.id, "deleted");
      return void (await tg.send(env, u.id, `🗑 پست #${id} حذف شد.${r.eitaa === "removed" ? " (از ایتا هم پاک شد)" : ""}${await eitaaNote(env, p, r)}`));
    }
    case "force": {
      const media = (await getPub(env, id))?.verdict === "held_media";
      if (p.status !== "held") return void (await tg.send(env, u.id, "این پست در حال حاضر نگه‌داشته نشده است."));
      if (media && p.kind === "file") {
        if (!p.text.trim()) return void (await tg.send(env, u.id, "این پست متنی ندارد؛ از «🖼 افزودن عکس/ویدیو» یا «✏️ تصحیح» استفاده کنید."));
        await env.DB.prepare("UPDATE ea_posts SET kind='text', file_id='', src_url='', file_name='' WHERE id=?").bind(id).run();
      }
      await setVerdict(env, id, u.id, "forced");
      await env.DB.prepare("UPDATE ea_posts SET status='pending', run_at=?, error='' WHERE id=?").bind(now(), id).run();
      return void (await tg.send(env, u.id, `🚀 پست #${id} ${media ? "فقط با متن " : ""}در صف ارسال قرار گرفت (تا یک دقیقه‌ی دیگر).`));
    }
  }
}

// ------------------------------------------------------------------ text/media answers
export async function onMessage(c: Ctx, u: UserRow, state: string, d: Record<string, any>, m: TgMessage): Promise<void> {
  const { env } = c, id = Number(d.id);
  const p = await getPost(env, id);
  if (!p || p.user_id !== u.id || !ACTIVE.has(p.status)) { await clearSession(env, u.id); return void (await tg.send(env, u.id, "این پست دیگر قابل تغییر نیست.")); }
  const text = (m.text || "").trim();

  if (state === "pm_err") {
    if (!text) return void (await tg.send(env, u.id, "خطا را با متن بنویسید.", ikb([back(id)])));
    await clearSession(env, u.id);
    const wait = await tg.send(env, u.id, "🔎 در حال بررسی خطا…");
    const own = (await env.DB.prepare("SELECT footer FROM agent_jobs WHERE id=?").bind(p.job_id || 0).first<{ footer: string }>())?.footer || "";
    let lesson = "", fixed: string | null = null, why = "";
    try {
      const r = await learnFromError(env, u.id, p.text, text, p.kind === "file", own);
      lesson = r.rule; fixed = r.fixed; why = r.why;
    } catch { lesson = `از این خطا جلوگیری کن: ${text.slice(0, 200)}`; why = "مدل هوش مصنوعی الان در دسترس نبود؛ خطا فقط ثبت شد."; }
    const learned = lesson ? await addLesson(env, u.id, lesson, text) : false;
    if (learned) await lessonNote(env, u.id, `📌 <b>درس تازه</b> (از گزارش پست #${id})\n${esc(lesson)}`);
    await report(env, u.id, `🚩 <b>گزارش خطا</b> · پست #${id}\n${esc(text.slice(0, 300))}${lesson ? `\n\n🧠 یاد گرفتم: ${esc(lesson)}` : ""}`);
    if (fixed && (p.kind === "text" || fixed.length <= MAX_CAPTION)) {
      const r = await replacePost(env, p, { text: fixed, keepJob: true });
      const msg = `✅ خطا اصلاح شد و پست جدید #${r.id} ساخته شد.\nاول در گروه، بعد از بررسی ناظر در ایتا منتشر می‌شود (تا یک دقیقه).${lesson ? `\n\n🧠 یاد گرفتم: ${esc(lesson)}` : ""}${r.note}`;
      if (wait) await tg.edit(env, u.id, wait, msg); else await tg.send(env, u.id, msg);
      return;
    }
    const msg = `😕 نتوانستم خودکار درستش کنم${why ? `: ${esc(why)}` : "."}\nپست جدیدی ارسال نشد و پست قبلی دست‌نخورده ماند.${lesson ? `\n\n🧠 ولی یاد گرفتم: ${esc(lesson)}` : ""}\n\nخودتان تصمیم بگیرید 👇`;
    const kb = ikb([[["✏️ تصحیح", `pm:fix:${id}`], ["🖼 افزودن عکس/ویدیو", `pm:media:${id}`]], [["🗑 حذف پیام", `pm:del:${id}`]]]);
    if (wait) await tg.edit(env, u.id, wait, msg, kb); else await tg.send(env, u.id, msg, kb);
    return;
  }

  const r = extract(m);
  if ("error" in r) return void (await tg.send(env, u.id, "❌ " + r.error, ikb([back(id)])));
  let patch: Patch;
  if (state === "pm_fix") {
    if (r.kind === "text") patch = { text: r.text };                                                       // media stays
    else patch = { kind: "file", file_id: r.file_id, file_name: r.file_name, src_url: "", text: r.text || p.text };
  } else {
    if (r.kind === "text") return void (await tg.send(env, u.id, "یک عکس یا ویدیو بفرستید (نه متن).", ikb([back(id)])));
    patch = { kind: "file", file_id: r.file_id, file_name: r.file_name, src_url: "", text: p.text };
  }
  const finalKind = patch.kind || p.kind, finalText = patch.text ?? p.text;
  if (finalKind === "file" && finalText.length > MAX_CAPTION) return void (await tg.send(env, u.id, `❌ متن همراه عکس/ویدیو حداکثر ${MAX_CAPTION} نویسه است (الان ${finalText.length}). متن کوتاه‌تری بفرستید.`, ikb([back(id)])));
  if (!finalText.trim() && finalKind === "text") return void (await tg.send(env, u.id, "متن خالی است.", ikb([back(id)])));
  await clearSession(env, u.id);
  const res = await replacePost(env, p, patch);
  await tg.send(env, u.id, `♻️ پیام قبلی کنار رفت و پست جدید #${res.id} ساخته شد.\nاول در گروه، بعد از بررسی ناظر در ایتا منتشر می‌شود (تا یک دقیقه).${res.note}`);
}

// ------------------------------------------------------------------ group + supervisor settings screen
const GUIDE = "<b>📖 اتصال گروه</b>\n\n1️⃣ یک گروه تلگرام بسازید و در تنظیمات آن «Topics» (تاپیک) را روشن کنید.\n2️⃣ همین ربات را عضو گروه و <b>ادمین</b> کنید (دسترسی‌های «مدیریت تاپیک‌ها» و «حذف پیام‌ها» لازم است).\n3️⃣ داخل گروه بفرستید: <code>/eagroup</code>\n\nربات تاپیک‌های «مطالب»، «گزارشات»، «چت با ایجنت» و «آموخته‌ها» را می‌سازد.\n\n🛡 <b>ربات ناظر (اختیاری)</b>: در BotFather یک ربات جدید بسازید، توکنش را از دکمه‌ی «ثبت ربات ناظر» بفرستید و آن را هم در گروه ادمین کنید؛ گزارش‌ها با نام او می‌آید. (بدون آن، همین ربات گزارش می‌دهد.)";

export async function home(env: Env, u: UserRow): Promise<void> {
  const g = await getGroup(env, u.id), sup = await supToken(env, u.id), supName = await kvGet(env, `supname:${u.id}`);
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM ea_lessons WHERE user_id=?").bind(u.id).first<{ n: number }>())?.n || 0;
  const t = `<b>👥 گروه و ناظر</b>\n\n👥 گروه: ${g ? `✅ ${esc(g.title || g.chat)}${g.forum ? " · تاپیک‌ها " + (Object.keys(g.topics).length ? "✅" : "❌") : " · بدون تاپیک"}` : "❌ متصل نیست"}\n` +
    `🛡 بررسی ناظر پیش از ایتا: ${g ? (g.review ? "روشن" : "خاموش") : "—"}\n🤖 ربات ناظر: ${sup ? "✅" + (supName ? " @" + esc(supName) : "") : "ندارد (همین ربات گزارش می‌دهد)"}\n🧠 آموخته‌ها: ${n}`;
  const rows: Btn[][] = [[["📖 راهنمای اتصال گروه", "gp:help"]]];
  if (g) rows.push([[g.review ? "🛡 خاموش‌کردن بررسی" : "🛡 روشن‌کردن بررسی", "gp:rev"], ["🔌 قطع گروه", "gp:off"]]);
  rows.push([[sup ? "🔑 تغییر ربات ناظر" : "🔑 ثبت ربات ناظر", "gp:sup"], ["🧠 آموخته‌ها", "gp:les"]]);
  if (sup) rows.push([["🗑 حذف ربات ناظر", "gp:supdel"]]);
  await tg.send(env, u.id, t, ikb(rows));
}
export async function onGroupCallback(c: Ctx, u: UserRow, q: TgCallback, act: string, arg: string): Promise<void> {
  const { env } = c;
  await tg.answer(env, q.id);
  const g = await getGroup(env, u.id);
  switch (act) {
    case "help": return void (await tg.send(env, u.id, GUIDE));
    case "rev": if (g) { g.review = !g.review; await saveGroup(env, u.id, g); } return home(env, u);
    case "off": await dropGroup(env, u.id); return void (await tg.send(env, u.id, "🔌 گروه قطع شد؛ پست‌ها مستقیم به ایتا می‌روند."));
    case "sup": await setSession(env, u.id, "gp_sup", {}); return void (await tg.send(env, u.id, "🔑 توکن ربات ناظر را بفرستید (از BotFather).\n🧹 پیام شما بعد از خواندن پاک می‌شود. لغو: /cancel"));
    case "supdel": await clearSupervisor(env, u.id); return home(env, u);
    case "les": {
      const rows = (await env.DB.prepare("SELECT id, rule FROM ea_lessons WHERE user_id=? ORDER BY id DESC LIMIT 15").bind(u.id).all<{ id: number; rule: string }>()).results;
      if (!rows.length) return void (await tg.send(env, u.id, "🧠 هنوز چیزی یاد نگرفته‌ام. وقتی «🚩 گزارش خطا» بزنید، از آن یک قانون می‌سازم."));
      for (const r of rows) await tg.send(env, u.id, `🧠 ${esc(r.rule)}`, ikb([[["🗑 فراموش کن", `gp:ld:${r.id}`]]]));
      return;
    }
    case "ld": await env.DB.prepare("DELETE FROM ea_lessons WHERE id=? AND user_id=?").bind(Number(arg), u.id).run(); if (q.message) await tg.edit(env, u.id, q.message.message_id, "🗑 فراموش شد."); return;
  }
}
export async function gotSupervisorToken(c: Ctx, u: UserRow, m: TgMessage, text: string): Promise<void> {
  const { env } = c;
  await tg.del(env, u.id, m.message_id);
  const token = text.trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) return void (await tg.send(env, u.id, "❌ قالب توکن درست نیست (مثل 123456:ABC…). دوباره بفرستید یا /cancel."));
  const r = await setSupervisor(env, u.id, token);
  if (!r.ok) return void (await tg.send(env, u.id, `❌ تلگرام توکن را نپذیرفت: ${esc(r.error)}`));
  await clearSession(env, u.id);
  await tg.send(env, u.id, `✅ ربات ناظر ثبت شد: @${esc(r.name)}${r.inGroup === false ? "\n⚠️ هنوز در گروه نیست؛ آن را به گروه اضافه و ادمین کنید (تا آن موقع همین ربات گزارش می‌دهد)." : r.inGroup ? "\n✅ در گروه عضو است." : "\nبعد از اتصال گروه، آن را در گروه ادمین کنید."}`);
}
