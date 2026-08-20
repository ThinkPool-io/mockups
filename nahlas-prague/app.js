import {
  acceptRoute,
  buildHotspotDossiers,
  caseSnapshot,
  closeByAuthority,
  corroborateCase,
  createEvidenceLoop,
  recordObservedRecheck,
  reportCase,
  routeCase,
} from "./domain.mjs";
import { copy, reportOptions, seedCases } from "./data.mjs";

const PRIMARY_CASE_ID = seedCases[0].id;
const LOCALES = new Set(["ru", "cs", "en"]);
const $ = (selector) => document.querySelector(selector);
const normalizeLocation = (value) => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("cs-CZ").trim();
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const formatDate = (value, locale) => new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : locale === "ru" ? "ru-RU" : "en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(value));

function replayFixture() {
  let state = createEvidenceLoop();
  for (const fixture of seedCases) {
    const [first, ...rest] = fixture.corroborations;
    state = reportCase(state, {
      id: fixture.id,
      category: fixture.category,
      location: fixture.location,
      witnessId: `fixture-witness-${fixture.id}-0`,
      evidenceId: `fixture-evidence-${fixture.id}-0`,
      observedAt: first?.at ?? fixture.createdAt,
      source: "public-fixture",
    });
    rest.forEach((record, index) => {
      state = corroborateCase(state, fixture.id, {
        witnessId: `fixture-witness-${fixture.id}-${index + 1}`,
        evidenceId: `fixture-evidence-${fixture.id}-${index + 1}`,
        observedAt: record.at,
        source: "public-fixture",
      });
    });
    fixture.receipts.forEach((receipt) => {
      state = routeCase(state, fixture.id, {
        destination: receipt.destination,
        channel: receipt.channel,
        sentAt: receipt.sentAt,
        payload: { caseId: fixture.id, category: fixture.category, location: fixture.location },
        externalReference: receipt.externalReference,
        source: "public-fixture",
      });
      if (receipt.state === "accepted") {
        state = acceptRoute(state, fixture.id, `${fixture.id}:route:1`, {
          acceptedAt: receipt.sentAt,
          externalReference: receipt.externalReference,
          source: "public-fixture",
        });
      }
    });
    if (fixture.authorityState === "closed") {
      const closure = fixture.timeline.find(({ type }) => type === "authority_closed");
      state = closeByAuthority(state, fixture.id, {
        closedAt: closure?.at ?? fixture.createdAt,
        source: "public-fixture"
      });
    }
    const failedRecheck = fixture.timeline.find(({ type }) => type === "recheck_failed");
    if (failedRecheck) {
      state = recordObservedRecheck(state, fixture.id, {
        witnessId: `fixture-recheck-witness-${fixture.id}`,
        evidenceId: `fixture-recheck-evidence-${fixture.id}`,
        checkedAt: failedRecheck.at,
        passed: false,
        source: "public-fixture"
      });
    }
    if (fixture.observedState === "fixed") {
      state = recordObservedRecheck(state, fixture.id, {
        witnessId: `fixture-recheck-witness-${fixture.id}`,
        evidenceId: `fixture-recheck-evidence-${fixture.id}`,
        checkedAt: fixture.createdAt,
        passed: true,
        source: "public-fixture",
      });
    }
  }
  return buildHotspotDossiers(state, { threshold: 3, builtAt: "2026-08-20T10:00:00.000Z", source: "public-fixture" });
}

let state = replayFixture();
let locale = localeFromLocation();

function localeFromLocation() {
  const requested = new URL(window.location.href).searchParams.get("lang");
  const pathLocale = window.location.pathname.split("/").filter(Boolean).find((part) => LOCALES.has(part));
  if (LOCALES.has(requested)) return requested;
  return LOCALES.has(pathLocale) ? pathLocale : "ru";
}

function t() { return copy[locale]; }

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function localizeStatic() {
  document.documentElement.lang = locale;
  document.title = `NAHLAS. ${t().report}`;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = t()[node.dataset.i18n];
    if (value !== undefined) node.innerHTML = value;
  });
  document.querySelectorAll("[data-locale]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.locale === locale));
  });
}

function eventLabel(event) {
  const labels = {
    "case.reported": { ru: "Опубликовано первое сообщение", cs: "Zveřejněn první podnět", en: "First report published" },
    "case.corroborated": { ru: "Добавлено подтверждение жителя", cs: "Přidáno potvrzení obyvatele", en: "Resident corroboration added" },
    "route.sent": { ru: "Создана квитанция маршрута", cs: "Vytvořen doklad o směrování", en: "Routing receipt created" },
    "route.accepted": { ru: "Маршрут принят службой", cs: "Směrování přijato úřadem", en: "Route accepted by authority" },
    "authority.closed": { ru: "Служба закрыла свой тикет", cs: "Úřad uzavřel svůj tiket", en: "Authority closed its ticket" },
    "observed.rechecked": { ru: "Повторная проверка улицы", cs: "Opakovaná kontrola ulice", en: "Street recheck recorded" },
  };
  return labels[event.type]?.[locale] ?? event.type;
}

function renderReceipt(snapshot) {
  const receipt = snapshot.routes.at(-1);
  const fields = receipt ? [
    [t().destination, receipt.destination],
    [t().channel, receipt.channel],
    [t().sentAt, formatDate(receipt.sentAt, locale)],
    [t().payloadHash, receipt.payloadHash],
    [t().externalRef, receipt.externalReference ?? ""],
    [t().status.sent, t().status.sent],
    [t().status.accepted, receipt.status === "accepted" ? t().status.accepted : t().status.sent],
  ] : [];
  $("#route-receipt").innerHTML = fields.map(([label, value]) => `<div><dt>${label}</dt><dd class="${label === t().status.accepted ? "route-status" : ""}">${value}</dd></div>`).join("");
}

function renderCase() {
  const fixture = seedCases.find(({ id }) => id === PRIMARY_CASE_ID);
  const snapshot = caseSnapshot(state, PRIMARY_CASE_ID);
  setText("#case-id", fixture.id);
  setText("#case-category", fixture.categoryLabel[locale]);
  setText("#case-days", `${fixture.documentedDays} ${t().days}`);
  setText("#case-heading", fixture.title[locale]);
  setText("#case-location", fixture.location);
  setText("#authority-state", t().status[snapshot.authorityStatus]);
  setText("#observed-state", t().status[snapshot.observedStatus]);
  const corroborationCount = state.events.filter((event) =>
    event.caseId === PRIMARY_CASE_ID && ["case.reported", "case.corroborated"].includes(event.type)
  ).length;
  setText("#corroboration-count", `${corroborationCount} ${t().witnesses}`);
  const button = $("#corroborate-action");
  const wasCorroborated = button.dataset.corroborated === "true";
  button.disabled = wasCorroborated;
  button.textContent = wasCorroborated ? t().corroborated : t().corroborate;
  renderReceipt(snapshot);
  $("#case-timeline").innerHTML = state.events
    .filter((event) => event.caseId === PRIMARY_CASE_ID)
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map((event) => `<li><time datetime="${event.at}">${formatDate(event.at, locale)}</time><span>${eventLabel(event)}</span></li>`)
    .join("");
}

function renderHotspot() {
  const dossier = Object.values(state.hotspotDossiers).find(({ status }) => status === "grouped");
  if (!dossier) return;
  setText("#hotspot-heading", dossier.location);
  setText("#hotspot-count", dossier.memberCaseIds.length);
  setText("#hotspot-members", dossier.memberCaseIds.join(" · "));
}

function renderReportOptions() {
  $("#report-category").innerHTML = reportOptions.categories.map(({ value, label }) => `<option value="${value}">${label[locale]}</option>`).join("");
  $("#report-district").innerHTML = reportOptions.districts.map((district) => `<option value="${district}">${district}</option>`).join("");
}

function render() {
  localizeStatic();
  renderCase();
  renderHotspot();
  renderReportOptions();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 3400);
}

function corroborate() {
  const button = $("#corroborate-action");
  if (button.disabled) return;
  state = corroborateCase(state, PRIMARY_CASE_ID, {
    witnessId: "session-witness-001",
    evidenceId: "session-evidence-001",
    observedAt: "2026-08-20T10:30:00.000Z",
    source: "browser-session",
  });
  button.dataset.corroborated = "true";
  renderCase();
  showToast(t().corroborated);
}

function openReport() {
  const dialog = $("#report-dialog");
  $("#match-result").hidden = true;
  dialog.showModal();
  $("#report-category").focus();
}

function showMatch() {
  const category = $("#report-category").value;
  const district = $("#report-district").value;
  const location = normalizeLocation($("#report-location").value);
  const match = seedCases.find((item) =>
    item.category === category && item.district === district && normalizeLocation(item.location) === location
  );
  const result = $("#match-result");
  result.hidden = false;
  result.innerHTML = match
    ? `<h3>${t().matchFound}</h3><p><strong>${match.title[locale]}</strong><br />${match.location}</p><button class="button button-dark" id="match-corroborate" type="button">${t().matchAction}</button>`
    : `<p>${t().noMatch}</p>`;
  $("#match-corroborate")?.addEventListener("click", () => {
    $("#report-dialog").close();
    corroborate();
    $("#case-list").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    $("#corroborate-action").focus();
  });
}

function changeLocale(nextLocale, updateHistory = true) {
  if (!LOCALES.has(nextLocale)) return;
  locale = nextLocale;
  if (updateHistory) {
    const url = new URL(window.location.href);
    const parts = url.pathname.split("/").filter(Boolean);
    const localeIndex = parts.findIndex((part) => LOCALES.has(part));
    if (localeIndex >= 0) {
      parts[localeIndex] = locale;
      url.pathname = `/${parts.join("/")}`;
      url.searchParams.delete("lang");
    } else {
      url.searchParams.set("lang", locale);
    }
    history.pushState({ locale }, "", url);
  }
  render();
}

document.querySelectorAll("[data-locale]").forEach((button) => button.addEventListener("click", () => changeLocale(button.dataset.locale)));
$("#report-action").addEventListener("click", openReport);
$("#corroborate-action").addEventListener("click", corroborate);
$("#close-dialog").addEventListener("click", () => $("#report-dialog").close());
$("#report-form").addEventListener("submit", (event) => { event.preventDefault(); showMatch(); });
window.addEventListener("popstate", () => changeLocale(localeFromLocation(), false));

render();
