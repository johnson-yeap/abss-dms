/*
 * Every word the donor app says, in its three languages.
 *
 * One table rather than three files, so a string added in English and
 * forgotten in the other two is visible on the same screen as the omission
 * rather than in a file nobody opened. check() below turns that from a thing
 * somebody might notice into a thing the harness says out loud.
 *
 * Simplified and Traditional are not a character conversion of one another
 * here. They are written separately because the vocabulary differs where it
 * matters to this audience — 联络/聯絡, 号码/號碼 — and because running one
 * through a converter produces text that is technically Traditional and reads
 * as though it was not written by anyone.
 *
 * Nothing in this table is interpolated into markup. Every value reaches the
 * page through textContent; the few that need a number take it as {n}, which
 * fill() replaces after the text is already a string in a text node.
 */

export const LOCALES = ["zh-Hans", "zh-Hant", "en"];
export const DEFAULT_LOCALE = "zh-Hans";

// What the toggle says. Each in its own script rather than in the current
// language: somebody who has landed on the wrong one is looking for the
// writing they recognise, not for a translated label they cannot read.
export const LOCALE_NAMES = {
  "zh-Hans": "简体",
  "zh-Hant": "繁體",
  "en": "EN",
};

export const STRINGS = {
  "zh-Hans": {
    "app.donations": "捐款",
    "app.loading": "载入中…",
    "app.retry": "重新载入",
    "app.back": "返回",
    "app.error": "无法载入，请稍后再试。",

    "list.title": "捐款活动",
    "list.intro": "请选择您想参与的捐款活动。",
    "list.empty": "目前没有正在进行的捐款活动。",
    "list.donate": "我要捐款",

    "campaign.period": "捐款期间",
    "campaign.event": "活动日期",
    "campaign.closed": "此捐款活动已结束。",
    "campaign.missing": "找不到此捐款活动。",

    "form.title": "捐款表格",
    "form.name": "姓名",
    "form.namePlaceholder": "请填写您的姓名",
    "form.phone": "联络号码",
    "form.phonePlaceholder": "例如 9123 4567",
    "form.contact": "希望我们如何联络您？",
    "form.contactOptional": "可选，可多选",
    "form.whatsapp": "WhatsApp",
    "form.sms": "短信",
    "form.call": "电话",
    "form.amount": "捐款金额",
    "form.choose": "请选择",
    "form.recipients": "受福者姓名",
    "form.recipientsOptional": "可选，可填多位",
    "form.recipientsHint": "如需为家人或亲友祈福，请填写其姓名。",
    "form.recipientsPlaceholder": "受福者姓名",
    "form.recipientAdd": "添加一位",
    "form.recipientRemove": "删除此位",
    "form.wishes": "祝愿",
    "form.wishesOptional": "可选",
    "form.wishesPlaceholder": "愿以此功德…",
    "form.wishesLeft": "尚可输入 {n} 字",
    "form.payBy": "付款方式",
    "form.paynow": "PayNow",
    "form.cash": "现金",
    "form.submit": "立即捐款",
    "form.submitting": "处理中…",
    "form.required": "必填",

    "error.name.required": "请填写姓名。",
    "error.name.too-long": "姓名过长。",
    "error.phone.required": "请填写联络号码。",
    "error.phone.invalid": "联络号码格式不正确。",
    "error.amount.invalid": "请选择捐款金额。",
    "error.recipients.too-many": "受福者最多 10 位。",
    "error.recipients.too-long": "受福者姓名过长。",
    "error.wishes.too-long": "祝愿不可超过 100 字。",
    "error.payBy.invalid": "请选择付款方式。",
    "error.form": "请检查以上内容。",
    "error.closed": "此捐款活动已结束，无法提交。",
    "error.tooMany": "提交次数过多，请稍后再试。",
    "error.send": "提交失败，请稍后再试。",

    "done.thanks": "感恩您的布施",
    "done.reference": "捐款编号",
    "done.amount": "捐款金额",
    "done.paynow.title": "请扫描以下 PayNow 二维码付款",
    "done.paynow.reference": "付款时请在「备注 / Reference」栏填写以上捐款编号，以便我们核对您的捐款。",
    "done.paynow.save": "请截图保存此页面。",
    "done.cash.title": "请到寺务处缴付现金",
    "done.cash.body": "请携带以上捐款编号到寺务处缴付现金。",
    "done.home": "返回捐款活动",
  },

  "zh-Hant": {
    "app.donations": "捐款",
    "app.loading": "載入中…",
    "app.retry": "重新載入",
    "app.back": "返回",
    "app.error": "無法載入，請稍後再試。",

    "list.title": "捐款活動",
    "list.intro": "請選擇您想參與的捐款活動。",
    "list.empty": "目前沒有正在進行的捐款活動。",
    "list.donate": "我要捐款",

    "campaign.period": "捐款期間",
    "campaign.event": "活動日期",
    "campaign.closed": "此捐款活動已結束。",
    "campaign.missing": "找不到此捐款活動。",

    "form.title": "捐款表格",
    "form.name": "姓名",
    "form.namePlaceholder": "請填寫您的姓名",
    "form.phone": "聯絡號碼",
    "form.phonePlaceholder": "例如 9123 4567",
    "form.contact": "希望我們如何聯絡您？",
    "form.contactOptional": "可選，可多選",
    "form.whatsapp": "WhatsApp",
    "form.sms": "簡訊",
    "form.call": "電話",
    "form.amount": "捐款金額",
    "form.choose": "請選擇",
    "form.recipients": "受福者姓名",
    "form.recipientsOptional": "可選，可填多位",
    "form.recipientsHint": "如需為家人或親友祈福，請填寫其姓名。",
    "form.recipientsPlaceholder": "受福者姓名",
    "form.recipientAdd": "新增一位",
    "form.recipientRemove": "刪除此位",
    "form.wishes": "祝願",
    "form.wishesOptional": "可選",
    "form.wishesPlaceholder": "願以此功德…",
    "form.wishesLeft": "尚可輸入 {n} 字",
    "form.payBy": "付款方式",
    "form.paynow": "PayNow",
    "form.cash": "現金",
    "form.submit": "立即捐款",
    "form.submitting": "處理中…",
    "form.required": "必填",

    "error.name.required": "請填寫姓名。",
    "error.name.too-long": "姓名過長。",
    "error.phone.required": "請填寫聯絡號碼。",
    "error.phone.invalid": "聯絡號碼格式不正確。",
    "error.amount.invalid": "請選擇捐款金額。",
    "error.recipients.too-many": "受福者最多 10 位。",
    "error.recipients.too-long": "受福者姓名過長。",
    "error.wishes.too-long": "祝願不可超過 100 字。",
    "error.payBy.invalid": "請選擇付款方式。",
    "error.form": "請檢查以上內容。",
    "error.closed": "此捐款活動已結束，無法提交。",
    "error.tooMany": "提交次數過多，請稍後再試。",
    "error.send": "提交失敗，請稍後再試。",

    "done.thanks": "感恩您的布施",
    "done.reference": "捐款編號",
    "done.amount": "捐款金額",
    "done.paynow.title": "請掃描以下 PayNow 二維碼付款",
    "done.paynow.reference": "付款時請在「備註 / Reference」欄填寫以上捐款編號，以便我們核對您的捐款。",
    "done.paynow.save": "請截圖保存此頁面。",
    "done.cash.title": "請到寺務處繳付現金",
    "done.cash.body": "請攜帶以上捐款編號到寺務處繳付現金。",
    "done.home": "返回捐款活動",
  },

  "en": {
    "app.donations": "Donations",
    "app.loading": "Loading…",
    "app.retry": "Try again",
    "app.back": "Back",
    "app.error": "Could not load. Please try again.",

    "list.title": "Donation campaigns",
    "list.intro": "Choose the campaign you would like to take part in.",
    "list.empty": "There are no campaigns open at the moment.",
    "list.donate": "Donate",

    "campaign.period": "Donation period",
    "campaign.event": "Event dates",
    "campaign.closed": "This campaign has closed.",
    "campaign.missing": "This campaign could not be found.",

    "form.title": "Donation form",
    "form.name": "Name",
    "form.namePlaceholder": "Your name",
    "form.phone": "Contact number",
    "form.phonePlaceholder": "e.g. 9123 4567",
    "form.contact": "How may we contact you?",
    "form.contactOptional": "Optional, choose any",
    "form.whatsapp": "WhatsApp",
    "form.sms": "SMS",
    "form.call": "Phone call",
    "form.amount": "Donation amount",
    "form.choose": "Please choose",
    "form.recipients": "Blessing recipient(s)",
    "form.recipientsOptional": "Optional, more than one allowed",
    "form.recipientsHint": "Names of family or friends this donation is offered for.",
    "form.recipientsPlaceholder": "Recipient's name",
    "form.recipientAdd": "Add another",
    "form.recipientRemove": "Remove this name",
    "form.wishes": "Your wishes",
    "form.wishesOptional": "Optional",
    "form.wishesPlaceholder": "May this merit…",
    "form.wishesLeft": "{n} characters left",
    "form.payBy": "Payment method",
    "form.paynow": "PayNow",
    "form.cash": "Cash",
    "form.submit": "Donate",
    "form.submitting": "Sending…",
    "form.required": "Required",

    "error.name.required": "Please enter your name.",
    "error.name.too-long": "That name is too long.",
    "error.phone.required": "Please enter a contact number.",
    "error.phone.invalid": "That does not look like a contact number.",
    "error.amount.invalid": "Please choose an amount.",
    "error.recipients.too-many": "At most 10 recipients can be named.",
    "error.recipients.too-long": "That recipient's name is too long.",
    "error.wishes.too-long": "Wishes cannot be longer than 100 characters.",
    "error.payBy.invalid": "Please choose a payment method.",
    "error.form": "Please check the details above.",
    "error.closed": "This campaign has closed and cannot accept donations.",
    "error.tooMany": "Too many attempts. Please wait a moment and try again.",
    "error.send": "Could not send. Please try again.",

    "done.thanks": "Thank you for your generosity",
    "done.reference": "Reference",
    "done.amount": "Amount",
    "done.paynow.title": "Scan this PayNow code to pay",
    "done.paynow.reference": "Please enter the reference above in PayNow's reference field, so the office can match your gift to your name.",
    "done.paynow.save": "Please keep a screenshot of this page.",
    "done.cash.title": "Please pay at the office",
    "done.cash.body": "Please bring the reference above to the temple office to pay in cash.",
    "done.home": "Back to campaigns",
  },
};

/**
 * @param {string} locale - One of LOCALES.
 * @param {string} key - A key of STRINGS.
 * @returns {string} The phrase, or the key if it is missing.
 */
export function t(locale, key) {
  const table = STRINGS[locale] || STRINGS[DEFAULT_LOCALE];
  // Falls back through the default rather than to English: a Traditional
  // reader missing a string is better served by Simplified than by a language
  // they may not read at all.
  return table[key] || STRINGS[DEFAULT_LOCALE][key] || key;
}

/**
 * @param {string} phrase - A phrase containing {n}.
 * @param {number|string} n - What to put in it.
 * @returns {string} The filled phrase.
 */
export function fill(phrase, n) {
  return String(phrase).replace("{n}", String(n));
}

/**
 * Reports keys that exist in one language and not another.
 *
 * Exported so the local harness can shout about it. A missing key is not a
 * crash — t() falls back — which is exactly why it needs something to say so,
 * or the app quietly serves Simplified Chinese to an English reader for as
 * long as nobody looks.
 *
 * @returns {Array<string>} Complaints, empty when the three agree.
 */
export function check() {
  const complaints = [];
  const keys = new Set();
  for (const locale of LOCALES) {
    Object.keys(STRINGS[locale]).forEach((key) => keys.add(key));
  }
  for (const locale of LOCALES) {
    for (const key of keys) {
      if (!(key in STRINGS[locale])) {
        complaints.push(`${locale} is missing ${key}`);
      }
    }
  }
  return complaints;
}
